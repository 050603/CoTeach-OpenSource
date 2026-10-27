import { readFile } from 'node:fs/promises';
import path from 'node:path';
import manifest from '@/lib/browser/monaco-runtime-manifest.json';
import { locateLocalRuntimeAsset, readSmallRuntimeAsset, runtimeAssetMatchesIfNoneMatch, SMALL_RUNTIME_ASSET_MAX_BYTES } from './runtime-asset-cache';
import { parseByteRange, streamFileBytes } from '@/lib/uploads/file-stream';
import { streamBufferBytes } from '@/lib/uploads/buffer-stream';

type Encoding = 'identity' | 'gzip' | 'br';
type Representation = { bytes: number; sha256: string };
type EncodedManifest = { schemaVersion: number; version: string; sourceTreeSha256: string;
  files: Record<string, Record<Encoding, Representation>> };
type RuntimeSource = {
  version: string; treeSha256: string; fileCount: number;
  sourceDirectory?: string; metadataFile?: string; encodedDirectory?: string;
};

function relativeParts(value: string): string[] {
  const parts = value.split('/');
  if (!parts.every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')) {
    throw new Error('Invalid fixed runtime artifact location');
  }
  return parts;
}

/** Never interpret q=0, malformed q values or explicit rejection as permission.
 * With no field, use identity. Prefer br only among equally acceptable choices.
 */
export function monacoEncodingQuality(header: string | null): Record<Encoding, number> {
  if (!header?.trim()) return { identity: 1, gzip: 0, br: 0 };
  const values = new Map<string, number>();
  for (const item of header.split(',')) {
    const [token, ...parameters] = item.trim().toLowerCase().split(';').map(s => s.trim());
    if (!/^(?:[a-z0-9!#$%&'*+.^_`|~-]+)$/.test(token)) continue;
    let q = 1;
    if (parameters.length) {
      const match = parameters.length === 1 && /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(parameters[0]);
      q = match ? Number(match[1]) : 0;
    }
    values.set(token, Math.min(values.get(token) ?? 1, q));
  }
  return { br: values.get('br') ?? values.get('*') ?? 0,
    gzip: values.get('gzip') ?? values.get('*') ?? 0,
    identity: values.get('identity') ?? (values.get('*') === 0 ? 0 : 1) };
}

const headers = () => new Headers({ 'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin', 'Vary': 'Accept-Encoding',
  // The selected representation is complete. Next/proxies must not recompress
  // identity ranges or replace a validator with a dynamically encoded body.
  'Cache-Control': 'public, max-age=31536000, immutable, no-transform' });

/** One bounded metadata object per immutable process release. Small public
 * representations share the existing byte-bounded runtime cache; larger files
 * retain independent file streams. Cancellation belongs to each response.
 * Build/release validation proves hashes and decompression before publication.
 */
export function createEncodedMonacoRuntime(directory: string, source: RuntimeSource = manifest) {
  // Options are fixed by the reviewed build manifest, never by request paths.
  const expected = { version: source.version, treeSha256: source.treeSha256, fileCount: source.fileCount };
  if (!/^\d+\.\d+\.\d+$/.test(expected.version) || !/^[a-f0-9]{64}$/.test(expected.treeSha256)
    || !Number.isSafeInteger(expected.fileCount) || expected.fileCount < 1) throw new Error('Invalid fixed runtime artifact identity');
  const sourceParts = relativeParts(source.sourceDirectory ?? `${expected.version}/${expected.treeSha256}/vs`);
  const metadataParts = relativeParts(source.metadataFile ?? 'encoded-manifest.json');
  const encodedParts = relativeParts(source.encodedDirectory ?? `encoded/${expected.treeSha256}`);
  let pending: Promise<EncodedManifest> | undefined;
  function metadata() {
    if (pending) return pending;
    const promise = (async () => {
      const raw = await readFile(/* turbopackIgnore: true */ path.join(directory, ...metadataParts), 'utf8');
      if (raw.length > 512 * 1024) throw new Error('Oversized Monaco encoding manifest');
      const value = JSON.parse(raw) as EncodedManifest;
      if (value.schemaVersion !== 1 || value.version !== expected.version || value.sourceTreeSha256 !== expected.treeSha256
        || !value.files || Object.keys(value.files).length !== expected.fileCount) throw new Error('Mismatched Monaco encoding manifest');
      for (const [name, representations] of Object.entries(value.files)) {
        if (!name.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')) throw new Error('Invalid Monaco encoding path');
        for (const encoding of ['identity', 'gzip', 'br'] as const) {
          const item = representations[encoding];
          if (!item || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid Monaco encoding metadata');
        }
      }
      return value;
    })();
    pending = promise;
    void promise.catch(() => { if (pending === promise) pending = undefined; });
    return promise;
  }
  return async (request: Request, parts: string[], contentType: string): Promise<Response> => {
    const responseHeaders = headers();
    const failure = (status: number) => { responseHeaders.set('Cache-Control', 'no-store, no-transform'); return new Response(null, { status, headers: responseHeaders }); };
    if (parts[0] !== expected.version || parts[1] !== expected.treeSha256 || parts[2] !== 'vs') return failure(404);
    const name = parts.slice(3).join('/');
    const data = await metadata();
    const representations = Object.hasOwn(data.files, name) ? data.files[name] : undefined;
    if (!representations) return failure(404);
    const quality = monacoEncodingQuality(request.headers.get('accept-encoding'));
    const choices: Encoding[] = ['br', 'gzip', 'identity'];
    let encoding = choices.sort((a, b) => quality[b] - quality[a])[0];
    // Range is over identity bytes when allowed. If identity is forbidden,
    // ignore Range and send the negotiated complete encoded representation.
    if (request.headers.has('range') && quality.identity > 0) encoding = 'identity';
    if (quality[encoding] <= 0) return failure(406);
    const info = representations[encoding];
    const fileParts = encoding === 'identity' ? [...sourceParts, ...parts.slice(3)]
      : [...encodedParts, encoding, ...parts.slice(3)];
    const asset = await locateLocalRuntimeAsset(directory, fileParts);
    if (!asset || asset.size !== info.bytes) return failure(503);
    const etag = `"${encoding}-${info.sha256}"`;
    responseHeaders.set('Content-Type', contentType);
    responseHeaders.set('Content-Length', String(info.bytes));
    responseHeaders.set('ETag', etag);
    responseHeaders.set('Accept-Ranges', 'bytes');
    if (encoding !== 'identity') responseHeaders.set('Content-Encoding', encoding);
    if (runtimeAssetMatchesIfNoneMatch(request.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers: responseHeaders });
    if (request.method === 'HEAD') return new Response(null, { headers: responseHeaders });
    const rangeHeader = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    let range: { start: number; end: number } | undefined;
    // Like Next/send, ignore unknown units, malformed syntax and unsupported
    // multiple ranges. Only a syntactically valid unsatisfiable range is 416.
    const singleRange = rangeHeader && /^bytes=(\d+)-(\d*)$|^bytes=-(\d+)$/i.test(rangeHeader.trim());
    if (encoding === 'identity' && singleRange && (!ifRange || ifRange === etag)) {
      const parsed = parseByteRange(rangeHeader, info.bytes);
      if (!parsed) {
        responseHeaders.set('Content-Range', `bytes */${info.bytes}`);
        responseHeaders.delete('Content-Length');
        responseHeaders.set('Cache-Control', 'no-store, no-transform');
        return new Response(null, { status: 416, headers: responseHeaders });
      }
      range = parsed;
      responseHeaders.set('Content-Range', `bytes ${range.start}-${range.end}/${info.bytes}`);
      responseHeaders.set('Content-Length', String(range.end - range.start + 1));
    }
    const body = asset.size <= SMALL_RUNTIME_ASSET_MAX_BYTES
      ? streamBufferBytes(await readSmallRuntimeAsset(asset, `${expected.version}:${expected.treeSha256}:${encoding}`), { ...range, signal: request.signal })
      : await streamFileBytes(asset.filePath, { ...range, signal: request.signal });
    return new Response(body, { status: range ? 206 : 200, headers: responseHeaders });
  };
}

export const encodedMonacoRuntime = createEncodedMonacoRuntime(path.join(process.cwd(),
  process.env.NEXT_DIST_DIR?.trim() || '.next', 'static/openpbl-runtime/monaco'));
