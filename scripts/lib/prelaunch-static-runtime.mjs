import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { isMonacoStaticResourcePath } from './runtime-resource-path.mjs';

// Includes the full, separately pinned browser bundle, without unbounded reads.
const limit = 8 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** ResourceTiming can report zero or omit fields for several reasons. Keep
 * those values distinct from missing data and never call an ambiguous zero a hit. */
export function classifyStaticRuntimeTiming(raw, expectedBytes) {
  const timing = raw ? Object.fromEntries(['startTime', 'duration', 'responseStart', 'responseEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'workerStart', 'responseStatus']
    .map(key => [key, numeric(raw[key])])) : null;
  if (timing) timing.deliveryType = typeof raw.deliveryType === 'string' ? raw.deliveryType : null;
  let cache = 'unknown'; let reason = 'resource-timing-unavailable';
  if (timing) {
    reason = 'ambiguous-or-incomplete-resource-timing';
    const validBody = timing.encodedBodySize > 0 && timing.decodedBodySize === expectedBytes && expectedBytes > 0;
    const serviceWorker = timing.workerStart !== null && timing.workerStart > 0;
    if (validBody && !serviceWorker && timing.transferSize === 0) {
      cache = 'cache'; reason = timing.deliveryType === 'cache' ? 'explicit-cache-delivery-with-body-sizes' : 'zero-transfer-with-same-origin-body-sizes';
    } else if (validBody && !serviceWorker && timing.transferSize > 0 && timing.deliveryType !== 'cache') {
      cache = 'network-transfer'; reason = 'network-bytes-observed-body-may-have-been-revalidated';
    }
  }
  return { cache, reason, timing };
}

function embeddedFonts(css) {
  return [...css.toString().matchAll(/url\(\s*["']?data:(font\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)["']?\s*\)/g)].map(match => {
    const bytes = Buffer.from(match[2], 'base64');
    assert.ok(bytes.length >= 12, 'Embedded runtime font is empty or truncated');
    return { mimeType: match[1], bytes: bytes.length, sha256: sha256(bytes), transport: 'embedded-in-css', independentGet: 'not-applicable' };
  });
}

async function expectedRuntime(root) {
  const manifest = JSON.parse(await readFile(path.join(root, 'src/lib/browser/monaco-runtime-manifest.json'), 'utf8'));
  assert.ok(manifest.schemaVersion === 1 && manifest.package === 'monaco-editor' && manifest.source === 'min/vs'
    && /^\d+\.\d+\.\d+$/.test(manifest.version) && /^[a-f0-9]{64}$/.test(manifest.treeSha256), 'Invalid pinned Monaco manifest');
  // Read the public base from the same exported version helper as the browser,
  // without loading a TS module/JSON-import convention into native Node tests.
  const versions = await readFile(path.join(root, 'src/lib/browser/runtime-asset-versions.ts'), 'utf8');
  const template = versions.match(/export const MONACO_STATIC_RUNTIME_BASE\s*=\s*`([^`]+)`/);
  assert.ok(template, 'Cannot resolve MONACO_STATIC_RUNTIME_BASE from the runtime version helper');
  const publicBase = template[1].replaceAll('${MONACO_RUNTIME_VERSION}', manifest.version).replaceAll('${monacoManifest.treeSha256}', manifest.treeSha256);
  assert.ok(!publicBase.includes('${') && isMonacoStaticResourcePath(`${publicBase}/loader.js`), 'Unexpected public Monaco base');
  const packageRoot = path.join(root, 'node_modules/monaco-editor');
  const installed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(installed.version, manifest.version, 'Installed Monaco version differs from the manifest');
  const source = path.join(packageRoot, manifest.source);
  const workerNames = (await readdir(path.join(source, 'assets'))).filter(name => /^editor\.worker-[A-Za-z0-9_-]+\.js$/.test(name));
  assert.equal(workerNames.length, 1, 'Expected one representative native Monaco editor worker asset');
  const assets = [];
  for (const [kind, relative] of [['javascript', 'loader.js'], ['stylesheet', 'editor/editor.main.css'], ['worker', `assets/${workerNames[0]}`]]) {
    const file = path.join(source, relative); const info = await lstat(file);
    assert.ok(info.isFile() && info.size > 0 && info.size <= limit, 'Runtime representative must be a bounded regular file');
    const bytes = await readFile(file);
    assets.push({ kind, path: `${publicBase}/${relative}`, bytes: bytes.length, sha256: sha256(bytes),
      ...(kind === 'stylesheet' ? { fonts: embeddedFonts(bytes) } : {}) });
  }
  assert.ok(assets.find(asset => asset.kind === 'stylesheet').fonts.length > 0, 'Pinned Monaco CSS has no verifiable embedded font');
  const bundle = JSON.parse(await readFile(path.join(root, 'src/lib/browser/monaco-browser-bundle-manifest.json'), 'utf8'));
  assert.equal(bundle.version, manifest.version);
  assert.equal(bundle.originalSourceTreeSha256, manifest.treeSha256);
  assert.match(bundle.bundleSha256, /^[a-f0-9]{64}$/);
  assert.equal(bundle.file, 'editor.main.js');
  assert.ok(Number.isSafeInteger(bundle.bytes) && bundle.bytes > 0 && bundle.bytes <= limit);
  const bundleTemplate = versions.match(/export const MONACO_BUNDLE_RUNTIME_BASE\s*=\s*`([^`]+)`/);
  assert.ok(bundleTemplate, 'Cannot resolve MONACO_BUNDLE_RUNTIME_BASE from the runtime version helper');
  const bundleBase = bundleTemplate[1].replaceAll('${MONACO_RUNTIME_VERSION}', manifest.version).replaceAll('${monacoBundle.bundleSha256}', bundle.bundleSha256);
  assert.equal(bundleBase, `/_next/static/openpbl-runtime/monaco/${manifest.version}/${bundle.bundleSha256}/vs`, 'Unexpected public Monaco bundle base');
  assets.push({ kind: 'browser-bundle', path: `${bundleBase}/${bundle.file}`, bytes: bundle.bytes, sha256: bundle.bundleSha256 });
  return { manifest, publicBase, bundleBase, assets };
}

async function requestBytes(url, options, timeoutMs) {
  const target = new URL(url); const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  let outgoing;
  // Native HTTP preserves explicit conditional headers. Fetch can add a
  // no-cache directive to conditional requests, defeating Next's freshness check.
  const response = await new Promise((resolve, reject) => {
    outgoing = request(target, { agent: false, signal: AbortSignal.timeout(timeoutMs), ...options }, resolve);
    outgoing.once('error', reject); outgoing.end();
  });
  const chunks = []; let size = 0;
  try {
    assert.ok(!(Number(response.headers['content-length']) > limit), 'Runtime response exceeds the verification byte limit');
    for await (const chunk of response) {
      size += chunk.byteLength; assert.ok(size <= limit, 'Runtime response exceeds the verification byte limit'); chunks.push(chunk);
    }
    return { status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks, size) };
  } finally { response.destroy(); outgoing.destroy(); }
}

function publicHeaders(headers) {
  assert.equal(headers['access-control-allow-origin'], '*', 'Runtime must preserve public CORS');
  assert.equal(headers['cross-origin-resource-policy'], 'cross-origin', 'Runtime must preserve cross-origin CORP');
}
function immutable(headers) {
  assert.match(headers['cache-control'] ?? '', /(?:^|,)\s*public\s*(?:,|$)/i, 'Existing runtime is not public-cacheable');
  assert.match(headers['cache-control'] ?? '', /(?:^|,)\s*immutable\s*(?:,|$)/i, 'Existing pinned runtime is not immutable');
  assert.ok(Number(/(?:^|,)\s*max-age=(\d+)/i.exec(headers['cache-control'] ?? '')?.[1]) >= 31536000, 'Pinned runtime lacks its long cache lifetime');
  publicHeaders(headers);
}
const headerSummary = headers => Object.fromEntries(['etag', 'content-type', 'content-length', 'content-encoding', 'vary', 'cache-control', 'access-control-allow-origin', 'cross-origin-resource-policy']
  .map(key => [key, headers[key] ?? null]));

/** Native HTTP probes bypass a browser cache. The browser rounds below use
 * ordinary same-origin fetch; no routing interception/CDP cache disabling. */
export async function verifyStaticRuntimeHttp({ baseURL, publicBase, bundleBase, assets, timeoutMs = 15000 }) {
  assert.ok(Array.isArray(assets) && assets.length > 0 && assets.length <= 4, 'Expected a bounded runtime representative set');
  for (const asset of assets) assert.ok((asset.path.startsWith(`${publicBase}/`)
    || (asset.kind === 'browser-bundle' && bundleBase && asset.path === `${bundleBase}/editor.main.js`)) && isMonacoStaticResourcePath(asset.path)
    && Number.isSafeInteger(asset.bytes) && asset.bytes > 0 && asset.bytes <= limit && /^[a-f0-9]{64}$/.test(asset.sha256), 'Invalid public runtime representative');
  const origin = new URL(baseURL).origin;
  const headers = { 'accept-encoding': 'identity', origin: 'https://openpbl-static-probe.invalid' };
  const results = [];
  for (const asset of assets) {
    const url = new URL(asset.path, origin).href;
    const get = await requestBytes(url, { headers }, timeoutMs);
    assert.equal(get.status, 200, `Runtime GET failed: ${asset.kind}`); immutable(get.headers);
    assert.equal(get.bytes.length, asset.bytes, `Runtime GET length mismatch: ${asset.kind}`);
    assert.equal(sha256(get.bytes), asset.sha256, `Runtime GET digest mismatch: ${asset.kind}`);
    assert.match(get.headers.etag ?? '', /^(?:W\/)?"[^"\r\n]+"$/, 'Runtime GET has no usable ETag');
    const head = await requestBytes(url, { method: 'HEAD', headers }, timeoutMs);
    assert.equal(head.status, 200); assert.equal(head.bytes.length, 0); immutable(head.headers);
    assert.equal(head.headers.etag, get.headers.etag, 'HEAD changed the ETag');
    assert.equal(Number(head.headers['content-length']), asset.bytes, 'HEAD lost the actual resource length');
    const conditional = await requestBytes(url, { headers: { ...headers, 'if-none-match': get.headers.etag } }, timeoutMs);
    assert.equal(conditional.status, 304, 'Runtime conditional GET did not return a real 304');
    assert.equal(conditional.bytes.length, 0); immutable(conditional.headers);
    assert.equal(conditional.headers.etag, get.headers.etag);
    // These assertions run against the actual built Next server after load.
    // A beforeFiles rewrite that loses to Next's reserved static handling must
    // fail here, rather than silently passing an identity-only byte check.
    const representations = [];
    for (const encoding of ['br', 'gzip']) {
      const encodedHeaders = { ...headers, 'accept-encoding': `${encoding};q=1,identity;q=0` };
      const encoded = await requestBytes(url, { headers: encodedHeaders }, timeoutMs);
      assert.equal(encoded.status, 200); immutable(encoded.headers);
      assert.equal(encoded.headers['content-encoding'], encoding, 'Pinned runtime did not select its offline encoding');
      assert.match(encoded.headers.vary ?? '', /(?:^|,)\s*Accept-Encoding\s*(?:,|$)/i);
      assert.match(encoded.headers['cache-control'] ?? '', /no-transform/);
      assert.equal(Number(encoded.headers['content-length']), encoded.bytes.length, 'Offline representation lost its known wire length');
      const decoded = encoding === 'br' ? brotliDecompressSync(encoded.bytes) : gunzipSync(encoded.bytes);
      assert.equal(sha256(decoded), asset.sha256); assert.equal(decoded.length, asset.bytes);
      assert.notEqual(encoded.headers.etag, get.headers.etag, 'Distinct representations need distinct validators');
      const encodedHead = await requestBytes(url, { method: 'HEAD', headers: encodedHeaders }, timeoutMs);
      assert.equal(encodedHead.status, 200); assert.equal(encodedHead.bytes.length, 0);
      assert.equal(encodedHead.headers.etag, encoded.headers.etag);
      assert.equal(encodedHead.headers['content-length'], encoded.headers['content-length']);
      assert.equal(encodedHead.headers['content-encoding'], encoding);
      const encoded304 = await requestBytes(url, { headers: { ...encodedHeaders, 'if-none-match': encoded.headers.etag } }, timeoutMs);
      assert.equal(encoded304.status, 304); assert.equal(encoded304.bytes.length, 0);
      assert.equal(encoded304.headers.etag, encoded.headers.etag);
      representations.push({ encoding, wireBytes: encoded.bytes.length, wireSha256: sha256(encoded.bytes), decodedSha256: sha256(decoded),
        headStatus: encodedHead.status, conditionalStatus: encoded304.status, headers: headerSummary(encoded.headers) });
    }
    const range = await requestBytes(url, { headers: { ...headers, range: 'bytes=0-7', 'if-range': get.headers.etag } }, timeoutMs);
    assert.equal(range.status, 206); assert.deepEqual(range.bytes, get.bytes.subarray(0, 8));
    assert.equal(range.headers['content-range'], `bytes 0-7/${asset.bytes}`);
    const refused = await requestBytes(url, { headers: { ...headers, 'accept-encoding': 'br;q=0,gzip;q=0,identity;q=0,*;q=0' } }, timeoutMs);
    assert.equal(refused.status, 406, 'Explicitly unacceptable encodings must not be sent');
    const fonts = asset.fonts ? embeddedFonts(get.bytes) : undefined;
    if (fonts) assert.deepEqual(fonts, asset.fonts, 'HTTP CSS changed its embedded font bytes');
    results.push({ kind: asset.kind, path: asset.path, bytes: get.bytes.length, sha256: sha256(get.bytes), representations,
      range: { status: range.status, bytes: range.bytes.length }, refusedEncodingStatus: refused.status, get: { status: get.status, headers: headerSummary(get.headers) },
      head: { status: head.status, bodyBytes: head.bytes.length, headers: headerSummary(head.headers) }, conditional: { status: conditional.status, bodyBytes: conditional.bytes.length, headers: headerSummary(conditional.headers) }, ...(fonts ? { fonts } : {}) });
  }
  const missing = await requestBytes(new URL(`${publicBase}/missing-${randomUUID()}.js`, origin), { headers }, timeoutMs);
  assert.equal(missing.status, 404, 'A missing runtime resource did not return 404'); publicHeaders(missing.headers);
  assert.doesNotMatch(missing.headers['cache-control'] ?? '', /(?:^|,)\s*immutable\s*(?:,|$)/i, 'A missing resource became immutable');
  assert.ok(!(Number(/(?:^|,)\s*max-age=(\d+)/i.exec(missing.headers['cache-control'] ?? '')?.[1]) >= 31536000), 'A missing runtime resource has a year-long cache lifetime');
  return { assets: results, missing: { status: missing.status, headers: headerSummary(missing.headers) } };
}

async function browserReads(page, assets, timeoutMs) {
  return page.evaluate(async ({ expected, timeout }) => {
    const observations = [];
    performance.setResourceTimingBufferSize(100);
    for (const round of ['first', 'second']) for (const asset of expected) {
      performance.clearResourceTimings();
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
      const startedAt = performance.timeOrigin + performance.now();
      try {
        const response = await fetch(asset.path, { cache: 'default', credentials: 'omit', redirect: 'error', signal: controller.signal });
        const bytes = await response.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        let entries = [];
        for (let attempt = 0; attempt < 10; attempt++) {
          entries = performance.getEntriesByName(response.url).filter(entry => entry.entryType === 'resource' && entry.initiatorType === 'fetch');
          if (entries.length) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const entry = entries.length === 1 ? entries[0] : null;
        observations.push({ round, kind: asset.kind, path: asset.path, sameOrigin: new URL(response.url).origin === location.origin,
          status: response.status, bytes: bytes.byteLength, sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join(''),
          startedAtEpochMs: startedAt, finishedAtEpochMs: performance.timeOrigin + performance.now(), timingEntries: entries.length,
          resourceTiming: entry ? Object.fromEntries(['startTime', 'duration', 'responseStart', 'responseEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'deliveryType', 'workerStart', 'responseStatus']
            .map(key => [key, entry[key] ?? null])) : null });
      } finally { clearTimeout(timer); }
    }
    return observations;
  }, { expected: assets.map(({ kind, path }) => ({ kind, path })), timeout: timeoutMs });
}

/** Call only after existing UI/classroom/fault scenarios, before their cleanup.
 * A current, identity-verified Chrome/Edge browser is reused; its new context
 * starts with an independent cache. Fetching worker bytes is not worker execution.
 */
export async function verifyStaticRuntime({ root, baseURL, browser, browserIdentity, output, timeoutMs = 15000 }) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 60000, 'Invalid bounded static runtime timeout');
  assert.ok(['http:', 'https:'].includes(new URL(baseURL).protocol) && !new URL(baseURL).username && !new URL(baseURL).password, 'Expected a credential-free HTTP baseURL');
  assert.ok(browserIdentity?.label && browserIdentity.version === browser.version(), 'Static runtime needs the current verified browser identity');
  const target = output ? path.join(output, 'static-runtime.json') : null;
  if (target) assert.equal(await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'Refusing to overwrite an existing static runtime report');
  const report = { startedAt: new Date().toISOString(), status: 'running', browser: browserIdentity,
    scope: 'Post-load protocol and fresh-context fetch evidence only; no Monaco worker execution or font rendering assertion.' };
  let context; let failure;
  try {
    const expected = await expectedRuntime(root);
    report.manifest = expected.manifest; report.publicBase = expected.publicBase;
    report.http = await verifyStaticRuntimeHttp({ baseURL, ...expected, timeoutMs });
    context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    // A same-origin JSON document establishes an origin without importing or
    // preloading Monaco. No request routing is installed (it disables HTTP cache).
    const landing = await page.goto(new URL('/api/health/live', baseURL).href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    assert.equal(landing?.status(), 200, 'Static runtime browser origin page is unavailable');
    const observations = await browserReads(page, expected.assets, timeoutMs);
    assert.equal(observations.length, expected.assets.length * 2);
    report.browserFetches = observations.map((row, index) => {
      const asset = expected.assets[index % expected.assets.length];
      assert.equal(row.round, index < expected.assets.length ? 'first' : 'second');
      assert.equal(row.path, asset.path); assert.equal(row.sameOrigin, true); assert.equal(row.status, 200);
      assert.equal(row.bytes, asset.bytes); assert.equal(row.sha256, asset.sha256, 'Browser resource bytes differ from the pinned runtime');
      const timing = classifyStaticRuntimeTiming(row.timingEntries === 1 ? row.resourceTiming : null, row.bytes);
      return { ...row, resourceTiming: timing.timing, cache: timing.cache, cacheReason: timing.reason };
    });
    report.cacheObservations = Object.fromEntries(['first', 'second'].map(round => [round, report.browserFetches.filter(row => row.round === round).map(row => ({ kind: row.kind, cache: row.cache }))]));
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; failure = error; }
  finally {
    try { await context?.close(); } catch (error) { report.status = 'failed'; report.contextCloseError = error.message; failure ??= error; }
    report.finishedAt = new Date().toISOString();
    if (target) { await mkdir(output, { recursive: true, mode: 0o700 }); await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  }
  if (failure) throw failure;
  return report;
}
