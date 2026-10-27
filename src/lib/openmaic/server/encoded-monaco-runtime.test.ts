// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from 'node:zlib';
import manifest from '@/lib/browser/monaco-runtime-manifest.json';
import { createEncodedMonacoRuntime, monacoEncodingQuality } from './encoded-monaco-runtime';
import { register } from '@/lib/observability/metrics';

const original = Buffer.from('const editor = "真实编码与完整字节";\n'.repeat(40000));
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const parts = [manifest.version, manifest.treeSha256, 'vs', 'editor.js'];
let directory: string; let serve: ReturnType<typeof createEncodedMonacoRuntime>;
let encoded: Record<string, Buffer>;
const request = (headers: Record<string, string> = {}, method = 'GET', signal?: AbortSignal) =>
  serve(new Request('http://localhost/runtime', { method, headers, signal }), parts, 'application/javascript; charset=utf-8');

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'encoded-monaco-'));
  encoded = { identity: original, br: brotliCompressSync(original), gzip: gzipSync(original) };
  const representations = Object.fromEntries(Object.entries(encoded).map(([key, bytes]) => [key, { bytes: bytes.length, sha256: hash(bytes) }]));
  const files = Object.fromEntries(Array.from({ length: manifest.fileCount }, (_, i) => [i === 0 ? 'editor.js' : i === 1 ? 'parallel.js' : `unused-${i}.js`, representations]));
  await writeFile(path.join(directory, 'encoded-manifest.json'), JSON.stringify({ schemaVersion: 1, version: manifest.version, sourceTreeSha256: manifest.treeSha256, files }));
  for (const [key, bytes] of Object.entries(encoded)) {
    const file = path.join(directory, ...(key === 'identity' ? [manifest.version, manifest.treeSha256, 'vs'] : ['encoded', manifest.treeSha256, key]), 'editor.js');
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes);
    await writeFile(path.join(path.dirname(file), 'parallel.js'), bytes);
  }
  serve = createEncodedMonacoRuntime(directory);
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('build-pinned encoded Monaco transfer', () => {
  it.each([
    [null, { identity: 1, gzip: 0, br: 0 }],
    ['gzip;q=0, br;q=1, identity;q=0', { identity: 0, gzip: 0, br: 1 }],
    ['*;q=0', { identity: 0, gzip: 0, br: 0 }],
    ['*;q=0.5, gzip;q=0', { identity: 1, gzip: 0, br: .5 }],
    ['br;q=bad,gzip;q=1.001,identity;q=0', { identity: 0, gzip: 0, br: 0 }],
    ['br;q=1,br;q=0', { identity: 1, gzip: 0, br: 0 }],
  ])('respects explicit/rejected encoding quality %s', (header, expected) => {
    expect(monacoEncodingQuality(header as string | null)).toEqual(expected);
  });

  it.each(['br', 'gzip', 'identity'])('transmits exact independent %s representation, HEAD and conditional cache', async encoding => {
    const headers = { 'accept-encoding': `${encoding};q=1,${encoding === 'identity' ? '*' : 'identity'};q=0` };
    const response = await request(headers); expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer()); expect(bytes.equals(encoded[encoding])).toBe(true);
    expect((encoding === 'br' ? brotliDecompressSync(bytes) : encoding === 'gzip' ? gunzipSync(bytes) : bytes).equals(original)).toBe(true);
    expect(response.headers.get('content-encoding')).toBe(encoding === 'identity' ? null : encoding);
    expect(response.headers.get('vary')).toBe('Accept-Encoding');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(Number(response.headers.get('content-length'))).toBe(bytes.length);
    const head = await request(headers, 'HEAD'); expect(head.headers).toEqual(response.headers); expect(await head.text()).toBe('');
    const cached = await request({ ...headers, 'if-none-match': `W/${response.headers.get('etag')}` });
    expect(cached.status).toBe(304); expect(await cached.text()).toBe('');
  });

  it('uses distinct representation validators and rejects all unacceptable encodings', async () => {
    const br = await request({ 'accept-encoding': 'br' }, 'HEAD'); const gzip = await request({ 'accept-encoding': 'gzip' }, 'HEAD');
    expect(br.headers.get('etag')).not.toBe(gzip.headers.get('etag'));
    const mismatch = await request({ 'accept-encoding': 'gzip', 'if-none-match': br.headers.get('etag')! });
    expect(mismatch.status).toBe(200); await mismatch.body?.cancel();
    const refused = await request({ 'accept-encoding': '*;q=0' });
    expect(refused.status).toBe(406); expect(refused.headers.get('cache-control')).toContain('no-store');
  });

  it('preserves identity ranges and strong If-Range without dynamic transformation', async () => {
    const head = await request({}, 'HEAD'); const etag = head.headers.get('etag')!;
    const range = await request({ range: 'bytes=10-99', 'if-range': etag, 'accept-encoding': 'br,gzip' });
    expect(range.status).toBe(206); expect(range.headers.get('content-encoding')).toBeNull();
    expect(range.headers.get('content-range')).toBe(`bytes 10-99/${original.length}`);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(original.subarray(10, 100));
    for (const value of ['"stale"', `W/${etag}`, 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      const full = await request({ range: 'bytes=10-99', 'if-range': value });
      expect(full.status).toBe(200); expect(Buffer.from(await full.arrayBuffer()).equals(original)).toBe(true);
    }
    expect((await request({ range: 'bytes=99999999-' })).status).toBe(416);
    for (const range of ['items=0-3', 'bytes=broken', 'bytes=0-2,10-12']) {
      const ignored = await request({ range }); expect(ignored.status).toBe(200); await ignored.body?.cancel();
    }
    const noIdentity = await request({ range: 'bytes=0-2', 'accept-encoding': 'br,identity;q=0' });
    expect(noIdentity.status).toBe(200); expect(Buffer.from(await noIdentity.arrayBuffer())).toEqual(encoded.br);
    const rangeHead = await request({ range: 'bytes=0-2' }, 'HEAD'); expect(rangeHead.status).toBe(200);
    expect(Number(rangeHead.headers.get('content-length'))).toBe(original.length);
  });

  it('cancel/abort one independent stream without damaging simultaneous transfers', async () => {
    const controller = new AbortController(); const canceled = await request({}, 'GET', controller.signal);
    const reader = canceled.body!.getReader(); await reader.read(); controller.abort();
    await reader.cancel().catch(() => {});
    const responses = await Promise.all([request(), request({ 'accept-encoding': 'br' }), request()]);
    expect(Buffer.from(await responses[0].arrayBuffer()).equals(original)).toBe(true);
    await responses[1].body!.cancel();
    expect(Buffer.from(await responses[2].arrayBuffer()).equals(original)).toBe(true);
  });

  it('shares one bounded encoded-body read across a classroom without coupling response cancellation', async () => {
    const cacheEvents = async () => Object.fromEntries((await register.getSingleMetric('openpbl_runtime_asset_body_cache_events_total')!.get()).values
      .map(row => [String(row.labels.event), row.value]));
    const read = (method = 'GET', extra: Record<string, string> = {}) => serve(new Request('http://localhost/runtime', {
      method, headers: { 'accept-encoding': 'br,identity;q=0', ...extra },
    }), [...parts.slice(0, 3), 'parallel.js'], 'application/javascript; charset=utf-8');
    const before = await cacheEvents();
    const head = await read('HEAD');
    const conditional = await read('GET', { 'if-none-match': head.headers.get('etag')! });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe('');
    expect(await cacheEvents()).toEqual(before);
    const responses = await Promise.all(Array.from({ length: 30 }, () => read()));
    await responses[0].body!.cancel();
    for (const response of responses.slice(1)) {
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(encoded.br);
    }
    const after = await cacheEvents();
    expect(after.miss - (before.miss ?? 0)).toBe(1);
    expect((after.hit ?? 0) + (after.join ?? 0) - (before.hit ?? 0) - (before.join ?? 0)).toBe(29);
    const retained = await register.getSingleMetric('openpbl_runtime_asset_body_cache_bytes')!.get();
    expect(retained.values[0].value).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('serves a separately pinned bundle layout without borrowing the original tree identity', async () => {
    const target = path.join(directory, 'separate-bundle');
    const fingerprint = 'b'.repeat(64);
    const representations = Object.fromEntries(Object.entries(encoded).map(([key, bytes]) => [key, { bytes: bytes.length, sha256: hash(bytes) }]));
    await mkdir(path.join(target, 'checks'), { recursive: true });
    const metadata = path.join(target, 'checks', 'representations.json');
    const data = { schemaVersion: 1, version: manifest.version, sourceTreeSha256: fingerprint, files: { 'entry.js': representations } };
    await writeFile(metadata, JSON.stringify({ ...data, sourceTreeSha256: manifest.treeSha256 }));
    for (const [encoding, bytes] of Object.entries(encoded)) {
      const filename = path.join(target, ...(encoding === 'identity' ? ['vs'] : ['encoded', encoding]), 'entry.js');
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes);
    }
    const bundle = createEncodedMonacoRuntime(target, { version: manifest.version, treeSha256: fingerprint, fileCount: 1,
      sourceDirectory: 'vs', metadataFile: 'checks/representations.json', encodedDirectory: 'encoded' });
    const parts = [manifest.version, fingerprint, 'vs', 'entry.js'];
    await expect(bundle(new Request('http://localhost'), parts, 'text/javascript')).rejects.toThrow('Mismatched');
    await writeFile(metadata, JSON.stringify(data));
    const head = await bundle(new Request('http://localhost', { method: 'HEAD', headers: { 'accept-encoding': 'br' } }), parts, 'text/javascript');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-encoding')).toBe('br');
    const response = await bundle(new Request('http://localhost', { headers: { 'accept-encoding': 'br' } }), parts, 'text/javascript');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(encoded.br);
    const cached = await bundle(new Request('http://localhost', { headers: { 'accept-encoding': 'br', 'if-none-match': head.headers.get('etag')! } }), parts, 'text/javascript');
    expect(cached.status).toBe(304);
    expect((await bundle(new Request('http://localhost'), [manifest.version, manifest.treeSha256, 'vs', 'entry.js'], 'text/javascript')).status).toBe(404);
  });

  it.each(['sourceDirectory', 'metadataFile', 'encodedDirectory'] as const)('rejects an unsafe fixed %s before any lookup', field => {
    expect(() => createEncodedMonacoRuntime(directory, { version: manifest.version, treeSha256: manifest.treeSha256,
      fileCount: 1, [field]: '../private' })).toThrow('Invalid fixed runtime artifact location');
  });

  it('rejects unknown hash/name, missing file and retries a failed manifest load', async () => {
    expect((await serve(new Request('http://localhost'), [manifest.version, 'a'.repeat(64), 'vs', 'editor.js'], 'text/javascript')).status).toBe(404);
    expect((await serve(new Request('http://localhost'), [...parts.slice(0, 3), 'secret.js'], 'text/javascript')).status).toBe(404);
    expect((await serve(new Request('http://localhost'), [...parts.slice(0, 3), 'unused-2.js'], 'text/javascript')).status).toBe(503);
    const target = path.join(directory, 'retry'); await mkdir(target); const retry = createEncodedMonacoRuntime(target);
    await expect(retry(new Request('http://localhost'), parts, 'text/javascript')).rejects.toThrow();
    await writeFile(path.join(target, 'encoded-manifest.json'), await readFile(path.join(directory, 'encoded-manifest.json')));
    expect((await retry(new Request('http://localhost'), parts, 'text/javascript')).status).toBe(503);
  });
});
