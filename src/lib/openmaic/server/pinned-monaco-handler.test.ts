// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '@/lib/browser/monaco-runtime-manifest.json';
import bundle from '@/lib/browser/monaco-browser-bundle-manifest.json';
import { MONACO_BUNDLE_RUNTIME_BASE, MONACO_STATIC_RUNTIME_BASE } from '@/lib/browser/runtime-asset-versions';
import * as treeCore from './encoded-monaco-runtime';
import * as bundleCore from './encoded-monaco-bundle';
import { servePinnedMonaco, type PinnedMonacoTarget } from './pinned-monaco-handler';

function targetFor(base: string, file: string): PinnedMonacoTarget {
  return base === MONACO_BUNDLE_RUNTIME_BASE
    ? { kind: 'bundle', parts: [bundle.version, bundle.bundleSha256, 'vs', ...file.split('/')] }
    : { kind: 'tree', parts: [manifest.version, manifest.treeSha256, 'vs', ...file.split('/')] };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('shared pinned Monaco handler', () => {
  it.each(['GET', 'HEAD'])('passes the original %s request and response through the selected core without cloning', async method => {
    for (const [base, createSpy] of [
      [MONACO_STATIC_RUNTIME_BASE, () => vi.spyOn(treeCore, 'encodedMonacoRuntime')],
      [MONACO_BUNDLE_RUNTIME_BASE, () => vi.spyOn(bundleCore, 'encodedMonacoBundle')],
    ] as const) {
      const target = targetFor(base, bundle.file);
      const controller = new AbortController();
      const request = new Request('http://localhost/unrelated-rewrite-url', { method, signal: controller.signal,
        headers: { 'accept-encoding': 'br,gzip', range: 'bytes=3-5', 'if-range': '"real"', 'if-none-match': '"previous"' } });
      const response = new Response(method === 'HEAD' ? null : 'abc', { status: 206,
        headers: { 'content-range': 'bytes 3-5/10', etag: '"real"', 'cache-control': 'public, immutable, no-transform',
          vary: 'Accept-Encoding', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin' } });
      const spy = createSpy().mockResolvedValueOnce(response);
      expect(await servePinnedMonaco(request, target)).toBe(response);
      expect(spy).toHaveBeenCalledWith(request, target.parts, 'application/javascript; charset=utf-8');
      expect(request.signal.aborted).toBe(false); controller.abort(); expect(request.signal.aborted).toBe(true);
      await response.body?.cancel();
    }
  });

  it.each([
    ['editor.css', 'text/css; charset=utf-8'], ['schema.json', 'application/json; charset=utf-8'],
    ['worker.mjs', 'text/javascript; charset=utf-8'], ['types.d.ts', 'application/octet-stream'],
  ])('keeps the route MIME for %s', async (file, mime) => {
    const spy = vi.spyOn(treeCore, 'encodedMonacoRuntime').mockResolvedValueOnce(new Response(null, { status: 404 }));
    const target = targetFor(MONACO_STATIC_RUNTIME_BASE, file);
    await servePinnedMonaco(new Request('http://localhost/static'), target);
    expect(spy).toHaveBeenCalledWith(expect.any(Request), target.parts, mime);
  });

  it('leaves authoritative missing-file rejection with the same pinned factory', async () => {
    const target = targetFor(MONACO_STATIC_RUNTIME_BASE, 'missing.js');
    expect(target.kind).toBe('tree');
    const missing = new Response(null, { status: 404, headers: { 'cache-control': 'no-store, no-transform' } });
    const spy = vi.spyOn(treeCore, 'encodedMonacoRuntime').mockResolvedValueOnce(missing);
    expect(await servePinnedMonaco(new Request('http://localhost/static'), target)).toBe(missing);
    expect(spy).toHaveBeenCalledOnce();
  });

  it.each(['tree', 'bundle'] as const)('retains the original 502 body and public error headers for %s exceptions', async kind => {
    const error = new Error('missing pinned metadata');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    if (kind === 'tree') vi.spyOn(treeCore, 'encodedMonacoRuntime').mockRejectedValueOnce(error);
    else vi.spyOn(bundleCore, 'encodedMonacoBundle').mockRejectedValueOnce(error);
    const target = targetFor(kind === 'tree' ? MONACO_STATIC_RUNTIME_BASE : MONACO_BUNDLE_RUNTIME_BASE, bundle.file);
    const response = await servePinnedMonaco(new Request('http://localhost/static'), target);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe('Failed to load interactive runtime asset');
    expect(Object.fromEntries(response.headers)).toEqual({
      'access-control-allow-origin': '*', 'cache-control': 'no-store, no-transform',
      'content-type': 'text/plain;charset=UTF-8', 'cross-origin-resource-policy': 'cross-origin', vary: 'Accept-Encoding',
    });
    expect(log).toHaveBeenCalledExactlyOnceWith('[interactive-runtime] Failed to serve asset', {
      runtime: 'monaco', path: target.parts.join('/'), error,
    });
  });

  it('does not dispatch unsupported methods even with an explicit target', async () => {
    const spy = vi.spyOn(treeCore, 'encodedMonacoRuntime');
    const target = targetFor(MONACO_STATIC_RUNTIME_BASE, 'editor/editor.main.js');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await servePinnedMonaco(new Request('http://localhost/static', { method }), target);
      expect(response.status).toBe(405); expect(response.body).toBeNull();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
