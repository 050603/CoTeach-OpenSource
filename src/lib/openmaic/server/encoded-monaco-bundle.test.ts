import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, gunzipSync, brotliDecompressSync, constants } from 'node:zlib';
import bundle from '@/lib/browser/monaco-browser-bundle-manifest.json';
import modules from '../../../../scripts/lib/monaco-browser-bundle-modules.json';
import { createEncodedMonacoBundle } from './encoded-monaco-bundle';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let directory: string;
let original: Buffer;
let serve: ReturnType<typeof createEncodedMonacoBundle>;
const parts = [bundle.version, bundle.bundleSha256, 'vs', bundle.file];
const request = (headers: Record<string, string> = {}, method = 'GET', signal?: AbortSignal) =>
  serve(new Request('http://localhost/bundle', { method, headers, signal }), parts, 'application/javascript; charset=utf-8');

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'monaco-bundle-protocol-'));
  original = Buffer.concat((await Promise.all(modules.modules.map(async item =>
    [await readFile(path.join(process.cwd(), 'node_modules/monaco-editor/min', `${item.id}.js`)), Buffer.from('\n;\n')]))).flat());
  expect(hash(original)).toBe(bundle.bundleSha256); expect(original.length).toBe(bundle.bytes);
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const encoding of ['identity', 'gzip', 'br']) {
    const bytes = encoding === 'identity' ? original : encoding === 'gzip' ? gzipSync(original)
      : brotliCompressSync(original, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
    const file = path.join(directory, ...(encoding === 'identity' ? ['vs'] : ['encoded', encoding]), bundle.file);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    files[encoding] = { bytes: bytes.length, sha256: hash(bytes) };
  }
  await writeFile(path.join(directory, 'encoded-manifest.json'), JSON.stringify({ schemaVersion: 1,
    version: bundle.version, sourceTreeSha256: bundle.bundleSha256, files: { [bundle.file]: files } }));
  serve = createEncodedMonacoBundle(directory);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('pinned browser bundle uses the original streaming protocol', () => {
  it.each(['identity', 'gzip', 'br'])('serves exact %s and HEAD/304 without changing source bytes', async encoding => {
    const headers = { 'accept-encoding': `${encoding};q=1,*;q=0` };
    const response = await request(headers); const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(hash(encoding === 'gzip' ? gunzipSync(bytes) : encoding === 'br' ? brotliDecompressSync(bytes) : bytes)).toBe(bundle.bundleSha256);
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(response.headers.get('cache-control')).toContain('immutable, no-transform');
    const head = await request(headers, 'HEAD'); expect(head.headers).toEqual(response.headers); expect(await head.text()).toBe('');
    const conditional = await request({ ...headers, 'if-none-match': response.headers.get('etag')! });
    expect(conditional.status).toBe(304); expect(await conditional.text()).toBe('');
  });

  it('honors range/q rejection and leaves another stream intact after cancellation', async () => {
    const controller = new AbortController();
    const first = await request({}, 'GET', controller.signal); const reader = first.body!.getReader();
    expect((await reader.read()).value!.length).toBeGreaterThan(0); controller.abort();
    await reader.cancel().catch(() => undefined);
    const range = await request({ range: 'bytes=3-20' });
    expect(range.status).toBe(206); expect(Buffer.from(await range.arrayBuffer())).toEqual(original.subarray(3, 21));
    expect((await request({ 'accept-encoding': '*;q=0' })).status).toBe(406);
    const complete = await request(); expect(hash(Buffer.from(await complete.arrayBuffer()))).toBe(bundle.bundleSha256);
  });

  it('never chooses an arbitrary fingerprint or file from the request', async () => {
    for (const invalid of [[bundle.version, 'a'.repeat(64), 'vs', bundle.file],
      [bundle.version, bundle.bundleSha256, 'vs', 'loader.js'],
      [bundle.version, bundle.bundleSha256, 'vs', '..', bundle.file]]) {
      const response = await serve(new Request('http://localhost/invalid'), invalid, 'application/javascript');
      expect(response.status).toBe(404); expect(response.headers.get('cache-control')).toContain('no-store');
    }
  });
});
