import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { classifyStaticRuntimeTiming, verifyStaticRuntime, verifyStaticRuntimeHttp } from './prelaunch-static-runtime.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { schemaVersion: 1, package: 'monaco-editor', version: '0.56.0', source: 'min/vs', treeSha256: 'a'.repeat(64) };
const publicBase = `/_next/static/openpbl-runtime/monaco/${manifest.version}/${manifest.treeSha256}/vs`;
const font = Buffer.from('000100000001001000000000', 'hex');
const files = {
  'loader.js': Buffer.from('self.loader = true;'),
  'editor/editor.main.css': Buffer.from(`@font-face{src:url(data:font/ttf;base64,${font.toString('base64')})}.editor{color:black}`),
  'assets/editor.worker-fixture.js': Buffer.from('self.onmessage = () => {};'),
};
const bundleBytes = Buffer.from('define("vs/editor/editor.main",[],function(){return {};});');
const bundle = { schemaVersion: 1, version: manifest.version, originalSourceTreeSha256: manifest.treeSha256,
  bundleSha256: digest(bundleBytes), bytes: bundleBytes.length, file: 'editor.main.js' };
const bundleBase = `/_next/static/openpbl-runtime/monaco/${manifest.version}/${bundle.bundleSha256}/vs`;
const assets = Object.entries(files).map(([relative, bytes], index) => ({ kind: ['javascript', 'stylesheet', 'worker'][index], path: `${publicBase}/${relative}`, bytes: bytes.length, sha256: digest(bytes),
  ...(index === 1 ? { fonts: [{ mimeType: 'font/ttf', bytes: font.length, sha256: digest(font), transport: 'embedded-in-css', independentGet: 'not-applicable' }] } : {}) }));
assets.push({ kind: 'browser-bundle', path: `${bundleBase}/${bundle.file}`, bytes: bundle.bytes, sha256: bundle.bundleSha256 });

async function fixture(t, defect) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prelaunch-static-runtime-'));
  const source = path.join(root, 'node_modules/monaco-editor/min/vs');
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await mkdir(path.join(source, 'editor'), { recursive: true });
  await mkdir(path.join(root, 'src/lib/browser'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/monaco-editor/package.json'), JSON.stringify({ name: 'monaco-editor', version: manifest.version }));
  await writeFile(path.join(root, 'src/lib/browser/monaco-runtime-manifest.json'), JSON.stringify(manifest));
  await writeFile(path.join(root, 'src/lib/browser/monaco-browser-bundle-manifest.json'), JSON.stringify(bundle));
  await writeFile(path.join(root, 'src/lib/browser/runtime-asset-versions.ts'), 'export const MONACO_STATIC_RUNTIME_BASE = `/_next/static/openpbl-runtime/monaco/${MONACO_RUNTIME_VERSION}/${monacoManifest.treeSha256}/vs`;\nexport const MONACO_BUNDLE_RUNTIME_BASE = `/_next/static/openpbl-runtime/monaco/${MONACO_RUNTIME_VERSION}/${monacoBundle.bundleSha256}/vs`;\n');
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(source, name), bytes);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url, headers: request.headers });
    assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.authorization, undefined);
    const relative = request.url.slice(publicBase.length + 1);
    const body = request.url === `${bundleBase}/${bundle.file}` ? bundleBytes : files[relative];
    response.setHeader('Access-Control-Allow-Origin', defect === 'cors' ? 'https://wrong.invalid' : '*');
    response.setHeader('Cross-Origin-Resource-Policy', defect === 'corp' ? 'same-origin' : 'cross-origin');
    if (!body) {
      response.statusCode = 404;
      response.setHeader('Cache-Control', defect === 'missing-immutable' ? 'public, max-age=31536000, immutable' : 'private, no-store');
      response.end('not found'); return;
    }
    if (defect === 'timeout') return;
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable, no-transform');
    response.setHeader('Vary', 'Accept-Encoding');
    const accepted = request.headers['accept-encoding'] ?? '';
    if (accepted.includes('*;q=0')) { response.statusCode = 406; response.end(); return; }
    const encoding = accepted.startsWith('br;') ? 'br' : accepted.startsWith('gzip;') ? 'gzip' : 'identity';
    const wire = encoding === 'br' ? brotliCompressSync(body) : encoding === 'gzip' ? gzipSync(body) : body;
    if (encoding !== 'identity' && defect !== 'encoding-missing') response.setHeader('Content-Encoding', encoding);
    response.setHeader('Content-Type', relative.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8');
    response.setHeader('ETag', request.method === 'HEAD' && defect === 'head-etag' ? '"wrong"' : `"${encoding}-${body.length}-pinned"`);
    response.setHeader('Content-Length', defect === 'oversize' ? 8 * 1024 * 1024 + 1 : wire.length);
    // A real freshness gate refuses no-cache. This catches accidental Fetch
    // conditional-request defaults instead of accepting a fabricated304.
    if (request.headers['if-none-match'] && !/no-cache/.test(request.headers['cache-control'] ?? '') && defect !== 'conditional-200') response.statusCode = 304;
    if (defect === 'get-digest' && request.method === 'GET') {
      const changed = Buffer.from(body); changed[0] ^= 1; response.end(changed); return;
    }
    if (request.headers.range) {
      response.statusCode = 206; response.setHeader('Content-Range', `bytes 0-7/${body.length}`);
      response.setHeader('Content-Length', 8); response.end(body.subarray(0, 8)); return;
    }
    response.end(wire);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, baseURL: `http://127.0.0.1:${server.address().port}`, publicBase, bundleBase, assets, requests };
}

test('real native GET/HEAD/304/404 checks preserve bytes, public headers and the CSS-embedded font', async t => {
  const f = await fixture(t);
  const result = await verifyStaticRuntimeHttp(f);
  assert.equal(result.assets.length, 4); assert.equal(result.missing.status, 404);
  assert.deepEqual(result.assets[1].fonts, assets[1].fonts);
  assert.equal(f.requests.length, 45);
  for (const asset of result.assets) {
    assert.equal(asset.conditional.status, 304); assert.equal(asset.conditional.bodyBytes, 0);
    assert.equal(asset.head.status, 200); assert.equal(asset.head.bodyBytes, 0);
    assert.equal(asset.get.headers['cross-origin-resource-policy'], 'cross-origin');
  }
  assert.equal(f.requests.filter(row => row.headers['if-none-match']).length, 12);
  assert.ok(f.requests.every(row => row.headers.origin === 'https://openpbl-static-probe.invalid'));
});

for (const [defect, message] of [
  ['get-digest', /digest mismatch/], ['head-etag', /HEAD changed/], ['conditional-200', /real 304/],
  ['encoding-missing', /offline encoding/], ['cors', /CORS/], ['corp', /CORP/], ['missing-immutable', /missing resource became immutable/], ['oversize', /byte limit/],
]) test(`real protocol rejects ${defect}`, async t => {
  await assert.rejects(verifyStaticRuntimeHttp(await fixture(t, defect)), message);
});

test('protocol timeouts cancel a stalled request and never produce a successful observation', async t => {
  const f = await fixture(t, 'timeout');
  await assert.rejects(verifyStaticRuntimeHttp({ ...f, timeoutMs: 30 }), error => error.name === 'AbortError');
  assert.equal(f.requests.length, 1);
});

test('public path and cardinality validation cannot probe private resources', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyStaticRuntimeHttp({ ...f, assets: [{ ...assets[0], path: '/api/uploads/private' }] }), /Invalid public/);
  await assert.rejects(verifyStaticRuntimeHttp({ ...f, assets: Array(5).fill(assets[0]) }), /bounded/);
  assert.equal(f.requests.length, 0);
});

test('cache interpretation retains missing/zero/ambiguous timing and distinguishes observed network traffic', () => {
  const raw = { transferSize: 0, encodedBodySize: 80, decodedBodySize: 100, workerStart: 0, deliveryType: 'cache' };
  assert.equal(classifyStaticRuntimeTiming(raw, 100).cache, 'cache');
  assert.equal(classifyStaticRuntimeTiming({ ...raw, deliveryType: '' }, 100).cache, 'cache');
  assert.equal(classifyStaticRuntimeTiming({ ...raw, transferSize: 380, deliveryType: '' }, 100).cache, 'network-transfer');
  assert.equal(classifyStaticRuntimeTiming(null, 100).timing, null);
  for (const value of [{}, { ...raw, transferSize: undefined }, { ...raw, encodedBodySize: 0, decodedBodySize: 0 }, { ...raw, decodedBodySize: 99 },
    { ...raw, transferSize: 80 }, { ...raw, workerStart: 1 }]) assert.equal(classifyStaticRuntimeTiming(value, 100).cache, 'unknown');
  const missing = classifyStaticRuntimeTiming({ ...raw, transferSize: null }, 100);
  assert.equal(missing.timing.transferSize, null); assert.equal(missing.cache, 'unknown');
  assert.equal(classifyStaticRuntimeTiming(raw, 100).timing.transferSize, 0);
});

// This is an orchestration fixture, not a claim of browser execution/cache
// behavior. Root's existing branded-browser scenarios execute page.evaluate.
function browserFixture(f, wrongDigest = false) {
  const state = { contexts: 0, closed: 0, evaluations: 0 };
  const browserIdentity = { label: 'google-chrome', version: 'fixture-version', userAgent: 'fixture-only' };
  const browser = { version: () => browserIdentity.version, newContext: async options => {
    state.contexts++; assert.deepEqual(options, { serviceWorkers: 'block' });
    return { close: async () => { state.closed++; }, newPage: async () => ({
      goto: async url => { assert.equal(url, `${f.baseURL}/api/health/live`); return { status: () => 200 }; },
      evaluate: async (_fn, input) => {
        state.evaluations++; assert.equal(input.expected.length, 4);
        return ['first', 'second'].flatMap(round => f.assets.map(asset => ({ round, kind: asset.kind, path: asset.path, sameOrigin: true,
          status: 200, bytes: asset.bytes, sha256: wrongDigest ? '0'.repeat(64) : asset.sha256, timingEntries: 0, resourceTiming: null })));
      },
    }) };
  } };
  return { browser, browserIdentity, state };
}

test('orchestration derives the manifest base, uses one fresh context, preserves unknown timing and never overwrites old evidence', async t => {
  const f = await fixture(t); const b = browserFixture(f); const output = path.join(f.root, 'evidence');
  const report = await verifyStaticRuntime({ ...f, ...b, output });
  assert.equal(report.status, 'passed'); assert.equal(report.publicBase, publicBase);
  assert.deepEqual(b.state, { contexts: 1, closed: 1, evaluations: 1 });
  assert.ok(report.browserFetches.every(row => row.cache === 'unknown' && row.resourceTiming === null));
  const original = await readFile(path.join(output, 'static-runtime.json'), 'utf8');
  await assert.rejects(verifyStaticRuntime({ ...f, ...b, output }), /overwrite/);
  assert.equal(await readFile(path.join(output, 'static-runtime.json'), 'utf8'), original);
  assert.equal(b.state.contexts, 1);
});

test('browser byte mismatches fail, close the fresh context, and retain a failed report', async t => {
  const f = await fixture(t); const b = browserFixture(f, true); const output = path.join(f.root, 'evidence');
  await assert.rejects(verifyStaticRuntime({ ...f, ...b, output }), /Browser resource bytes differ/);
  assert.equal(b.state.closed, 1);
  assert.equal(JSON.parse(await readFile(path.join(output, 'static-runtime.json'), 'utf8')).status, 'failed');
});
