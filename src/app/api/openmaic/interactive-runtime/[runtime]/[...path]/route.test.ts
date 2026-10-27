// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { GET, HEAD } from './route';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { INTERACTIVE_RUNTIME_VERSIONS } from '@/lib/browser/runtime-asset-versions';
import { streamFileBytes } from '@/lib/uploads/file-stream';
import { readSmallRuntimeAsset } from '@/lib/openmaic/server/runtime-asset-cache';
import bundle from '@/lib/browser/monaco-browser-bundle-manifest.json';
import * as encodedBundle from '@/lib/openmaic/server/encoded-monaco-bundle';
vi.mock('@/lib/uploads/file-stream', { spy: true });
vi.mock('@/lib/openmaic/server/runtime-asset-cache', { spy: true });
vi.mock('node:fs/promises', { spy: true });

function request(runtime: string, parts: string[], init?: RequestInit) {
  const handler = init?.method === 'HEAD' ? HEAD : GET;
  return handler(new Request('http://localhost/api/openmaic/interactive-runtime/test', init), {
    params: Promise.resolve({ runtime, path: parts }),
  });
}

describe('interactive runtime assets', () => {
  it('keeps the shared pinned error contract when route params differ from the request URL', async () => {
    const spy = vi.spyOn(encodedBundle, 'encodedMonacoBundle').mockRejectedValueOnce(new Error('fixture read failure'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await request('monaco', [bundle.version, bundle.bundleSha256, 'vs', bundle.file]);
      expect(response.status).toBe(502);
      expect(await response.text()).toBe('Failed to load interactive runtime asset');
      expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(response.headers.get('vary')).toBe('Accept-Encoding');
      expect(log).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); log.mockRestore(); }
  });
  it('dispatches only the pinned browser bundle through its separately bounded representation handler', async () => {
    const spy = vi.spyOn(encodedBundle, 'encodedMonacoBundle');
    try {
      const parts = [bundle.version, bundle.bundleSha256, 'vs', bundle.file];
      for (const method of ['GET', 'HEAD']) {
        spy.mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"bundle"' } }));
        const response = await request('monaco', parts, { method, headers: { 'if-none-match': '"bundle"' } });
        expect(response.status).toBe(304);
        expect(spy).toHaveBeenLastCalledWith(expect.any(Request), parts, 'application/javascript; charset=utf-8');
      }
      const before = spy.mock.calls.length;
      expect((await request('monaco', [bundle.version, 'a'.repeat(64), 'vs', bundle.file])).status).toBe(404);
      expect(spy).toHaveBeenCalledTimes(before);
    } finally { spy.mockRestore(); }
  });
  it('serves pinned Three.js and addon dependencies to opaque-origin sandbox frames', async () => {
    for (const file of ['build/three.module.js', 'examples/jsm/controls/OrbitControls.js', 'examples/jsm/renderers/SVGRenderer.js', 'examples/jsm/renderers/Projector.js']) {
      const response = await request('three', ['0.160.0', ...file.split('/')]);
      expect(response.status, file).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/javascript');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(response.headers.get('cache-control')).toContain('immutable');
      expect((await response.text()).length).toBeGreaterThan(1_000);
    }
  });

  it('rejects unsupported Three.js versions and non-browser assets', async () => {
    expect((await request('three', ['0.161.0', 'build', 'three.module.js'])).status).toBe(404);
    expect((await request('three', ['0.160.0', 'package.json'])).status).toBe(404);
    expect((await request('three', ['0.160.0', 'build', 'three.cjs'])).status).toBe(404);
    expect((await request('three', ['0.160.0', '..', 'package.json'])).status).toBe(400);
  });

  it('keeps legacy CodeMirror URLs usable with revalidation', async () => {
    const response = await request('codemirror', ['lib', 'codemirror.js']);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(await response.text()).toContain('CodeMirror');
  });

  it('serves the self-hosted Monaco editor and its Chinese messages', async () => {
    const loader = await request('monaco', ['loader.js']);
    const messages = await request('monaco', ['nls', 'lang', 'zh-cn.js']);

    expect(loader.status).toBe(200);
    expect(loader.headers.get('cache-control')).toContain('must-revalidate');
    expect(await loader.text()).toContain('define.amd');
    expect(messages.status).toBe(200);
    expect(Number(messages.headers.get('content-length'))).toBeGreaterThan(1_000);
    await messages.body?.cancel();
  });

  it('shares a small public file read across concurrent and subsequent clients', async () => {
    const filePath = path.resolve('node_modules/monaco-editor/min/vs/editor/editor.main.js');
    const inspect = vi.mocked(open); inspect.mockClear();
    const parts = [INTERACTIVE_RUNTIME_VERSIONS.monaco, 'editor', 'editor.main.js'];
    const responses = await Promise.all(Array.from({ length: 30 }, () => request('monaco', parts)));
    const contents = await Promise.all(responses.map(response => response.text()));
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(contents.every(text => text === contents[0])).toBe(true);
    expect(contents[0].length).toBeGreaterThan(1_000);
    const subsequent = await request('monaco', parts);
    expect(await subsequent.text()).toBe(contents[0]);
    expect(inspect.mock.calls.filter(([file]) => file === filePath)).toHaveLength(1);
  });

  it('validates small-file GET and HEAD without loading bodies and retains legacy headers', async () => {
    const parts = ['editor', 'editor.main.js'];
    const first = await request('monaco', parts, { method: 'HEAD' });
    expect(first.status).toBe(200); expect(first.body).toBeNull();
    expect(first.headers.get('cache-control')).toContain('must-revalidate');
    expect(first.headers.get('etag')).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    const etag = first.headers.get('etag')!;
    vi.mocked(readSmallRuntimeAsset).mockClear(); vi.mocked(streamFileBytes).mockClear();
    for (const headers of [
      { 'If-None-Match': etag }, { 'If-None-Match': etag.slice(2) },
      { 'If-None-Match': `"quoted,comma", ${etag}` }, { 'If-None-Match': '*' },
    ]) {
      const response = await request('monaco', parts, { headers });
      expect(response.status).toBe(304); expect(response.body).toBeNull();
      expect(response.headers.get('etag')).toBe(etag);
      expect(response.headers.get('content-length')).toBe(first.headers.get('content-length'));
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    }
    expect((await request('monaco', parts, { method: 'HEAD', headers: { 'If-None-Match': etag } })).status).toBe(304);
    expect((await request('monaco', parts, { method: 'HEAD' })).body).toBeNull();
    expect(readSmallRuntimeAsset).not.toHaveBeenCalled(); expect(streamFileBytes).not.toHaveBeenCalled();
    for (const invalid of [`${etag} extra`, `${etag}, *`, `${etag}, "unterminated`]) {
      const response = await request('monaco', parts, { headers: { 'If-None-Match': invalid } });
      expect(response.status).toBe(200); await response.body?.cancel();
    }
    expect((await request('monaco', ['does-not-exist.js'], { headers: { 'If-None-Match': '*' } })).status).toBe(404);
    expect((await request('monaco', ['999.0.0', 'loader.js'], { headers: { 'If-None-Match': '*' } })).status).toBe(404);
  });

  it('returns large-file 304 and HEAD without opening a body stream', async () => {
    const parts = [INTERACTIVE_RUNTIME_VERSIONS.pyodide, 'pyodide.asm.wasm'];
    vi.mocked(streamFileBytes).mockClear(); vi.mocked(readSmallRuntimeAsset).mockClear();
    const head = await request('pyodide', parts, { method: 'HEAD' });
    expect(head.status).toBe(200); expect(head.body).toBeNull();
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(1_000_000);
    const cached = await request('pyodide', parts, { headers: { 'If-None-Match': head.headers.get('etag')! } });
    expect(cached.status).toBe(304); expect(cached.body).toBeNull();
    expect(cached.headers.get('cache-control')).toContain('immutable');
    expect(streamFileBytes).not.toHaveBeenCalled(); expect(readSmallRuntimeAsset).not.toHaveBeenCalled();
  });

  it('keeps shared small bytes available when one client cancels or aborts', async () => {
    const parts = [INTERACTIVE_RUNTIME_VERSIONS.monaco, 'nls', 'lang', 'zh-cn.js'];
    const controller = new AbortController();
    const [aborted, cancelled, successful] = await Promise.all([
      request('monaco', parts, { signal: controller.signal }), request('monaco', parts), request('monaco', parts),
    ]);
    controller.abort(); await cancelled.body?.cancel();
    await expect(aborted.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });
    const contents = await successful.text(); expect(Number(successful.headers.get('content-length'))).toBeGreaterThan(64 * 1024);
    expect(await (await request('monaco', parts)).text()).toBe(contents);
  });

  it.each([
    ['monaco', 'loader.js'], ['codemirror', 'lib/codemirror.js'], ['katex', 'contrib/auto-render.min.js'], ['pyodide', 'pyodide.js'],
  ])('serves immutable versioned %s assets and rejects unsupported versions', async (name, file) => {
    const installed = JSON.parse(await readFile(`node_modules/${name === 'monaco' ? 'monaco-editor' : name}/package.json`, 'utf8')) as { version: string };
    const version = INTERACTIVE_RUNTIME_VERSIONS[name];
    expect(version).toBe(installed.version);
    const response = await request(name, [version, ...file.split('/')]);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect((await response.text()).length).toBeGreaterThan(1_000);
    expect((await request(name, ['999.0.0', ...file.split('/')])).status).toBe(404);
  });

  it('serves the packaged Pyodide loader and WASM binary', async () => {
    const loader = await request('pyodide', ['pyodide.js']);
    const wasm = await request('pyodide', ['pyodide.asm.wasm']);

    expect(loader.status).toBe(200);
    expect(await loader.text()).toContain('loadPyodide');
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
    expect(Number(wasm.headers.get('content-length'))).toBeGreaterThan(1_000_000);
    await wasm.body?.cancel();
  });

  it('streams 30 simultaneous large Monaco assets without retaining complete file buffers', async () => {
    const root = path.resolve('node_modules/monaco-editor/min/vs');
    const files = await readdir(root);
    const sizes = await Promise.all(files.map(async file => ({ file, info: await stat(path.join(root, file)) })));
    const asset = sizes.find(({ file, info }) => file.endsWith('.js') && info.isFile() && info.size > 512 * 1024)!;
    expect(asset).toBeDefined();
    const read = vi.spyOn(fs, 'readFile'); vi.mocked(streamFileBytes).mockClear();
    const responses: Response[] = [];
    try {
      responses.push(...await Promise.all(Array.from({ length: 30 }, () => request('monaco', [INTERACTIVE_RUNTIME_VERSIONS.monaco, asset.file]))));
      expect(responses.every(response => response.status === 200 && Number(response.headers.get('content-length')) === asset.info.size)).toBe(true);
      expect(responses[0].headers.get('cache-control')).toContain('immutable');
      expect(responses[0].headers.get('access-control-allow-origin')).toBe('*');
      expect(vi.mocked(streamFileBytes).mock.calls.filter(([file]) => file === path.join(root, asset.file))).toHaveLength(30);
      expect(read.mock.calls.some(([file]) => file === path.join(root, asset.file))).toBe(false);
      const first = await responses[0].arrayBuffer();
      read.mockRestore();
      const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
      expect(digest(new Uint8Array(first))).toBe(digest(await readFile(path.join(root, asset.file))));
    } finally { read.mockRestore(); await Promise.all(responses.filter(response => !response.bodyUsed).map(response => response.body?.cancel())); }
  });

  it('keeps legacy full-body Range semantics and propagates disconnects to a large file stream', async () => {
    const ranged = await request('pyodide', ['pyodide.asm.wasm'], { headers: { Range: 'bytes=0-3' } });
    expect(ranged.status).toBe(200); expect(Number(ranged.headers.get('content-length'))).toBeGreaterThan(1_000_000);
    expect(ranged.headers.get('content-range')).toBeNull(); await ranged.body?.cancel();
    const controller = new AbortController();
    const response = await request('pyodide', ['0.25.0', 'pyodide.asm.wasm'], { signal: controller.signal });
    controller.abort();
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('serves KaTeX assets used by generated code explanations', async () => {
    const response = await request('katex', ['contrib', 'auto-render.min.js']);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/javascript');
    expect(await response.text()).toContain('renderMathInElement');
  });

  it('rejects unknown runtimes and unsafe paths', async () => {
    expect((await request('other', ['thing.js'])).status).toBe(404);
    expect((await request('codemirror', ['..', 'package.json'])).status).toBe(400);
    expect((await request('pyodide', ['not-a-real-package.whl'])).status).toBe(404);
  });
});
