import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import {
  coalesceRuntimeAssetRead, locateLocalRuntimeAsset, readSmallRuntimeAsset,
  runtimeAssetEtag, runtimeAssetMatchesIfNoneMatch, SMALL_RUNTIME_ASSET_MAX_BYTES, type RuntimeAsset,
} from '@/lib/openmaic/server/runtime-asset-cache';
import { INTERACTIVE_RUNTIME_VERSIONS } from '@/lib/browser/runtime-asset-versions';
import { withHttpMetrics } from '@/lib/observability/http';
import { streamFileBytes } from '@/lib/uploads/file-stream';
import { servePinnedMonaco } from '@/lib/openmaic/server/pinned-monaco-handler';
import monacoBundle from '@/lib/browser/monaco-browser-bundle-manifest.json';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PYODIDE_VERSION = '0.25.0';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// Optional Pyodide wheels are fetched once by the server and cached under the
// existing writable/persistent data volume. The production container runs as
// an unprivileged user and cannot safely create arbitrary directories in the
// application root; `.openpbl-data` is created and chowned by the image.
const RUNTIME_CACHE_DIR = path.join(
  process.cwd(),
  '.openpbl-data',
  'interactive-runtime-cache',
);
const CODEMIRROR_ROOT = path.join(process.cwd(), 'node_modules', 'codemirror');
const KATEX_ROOT = path.join(process.cwd(), 'node_modules', 'katex', 'dist');
const MONACO_ROOT = path.join(process.cwd(), 'node_modules', 'monaco-editor', 'min', 'vs');
const PYODIDE_ROOT = path.join(process.cwd(), 'node_modules', 'pyodide');
const THREE_VERSION = '0.160.0';
const THREE_ROOT = path.join(process.cwd(), 'node_modules', 'three');
let pyodidePackageFilesPromise: Promise<Set<string>> | null = null;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.data': 'application/octet-stream',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.tar': 'application/x-tar',
  '.wasm': 'application/wasm',
  '.whl': 'application/zip',
  '.zip': 'application/zip',
};

function isSafePath(parts: string[]): boolean {
  return (
    parts.length > 0 &&
    parts.every((part) => /^[A-Za-z0-9@_+.,-]+$/.test(part) && part !== '.' && part !== '..')
  );
}

async function responseFor(asset: RuntimeAsset, fileName: string, immutable: boolean, version: string, request: Request): Promise<Response> {
  const local = 'filePath' in asset;
  const length = local ? asset.size : asset.byteLength;
  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate',
    'Content-Length': String(length),
    'Content-Type': MIME_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  if (local) {
    const etag = runtimeAssetEtag(asset, version);
    headers.set('ETag', etag);
    // Validate metadata before opening a stream or consulting the body cache.
    if (runtimeAssetMatchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers });
    }
  } else if (/^[ \t]*\*[ \t]*$/.test(request.headers.get('if-none-match') ?? '')) {
    // The first remote wheel already exists, even before a local validator is
    // available. Preserve wildcard semantics without hashing it per client.
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') return new Response(null, { headers });
  // Each response pulls a bounded view of the shared immutable read result.
  // Avoid one full Buffer.slice + Response copy for every simultaneous editor.
  let body: ReadableStream<Uint8Array>;
  if (!local || asset.size <= SMALL_RUNTIME_ASSET_MAX_BYTES) {
    const bytes = local ? await readSmallRuntimeAsset(asset, version) : asset; let offset = 0;
    body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (request.signal.aborted) { controller.error(request.signal.reason); return; }
      if (offset >= bytes.byteLength) { controller.close(); return; }
      const end = Math.min(offset + 64 * 1024, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end)); offset = end;
    } }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
  } else {
    body = await streamFileBytes(asset.filePath, { signal: request.signal });
  }
  return new Response(body, { headers });
}

async function readLocalAsset(root: string, pathParts: string[]): Promise<RuntimeAsset | null> {
  return locateLocalRuntimeAsset(root, pathParts);
}

async function allowedPyodidePackageFiles(): Promise<Set<string>> {
  pyodidePackageFilesPromise ??= fs
    .readFile(path.join(PYODIDE_ROOT, 'pyodide-lock.json'), 'utf8')
    .then((raw) => {
      const lock = JSON.parse(raw) as { packages?: Record<string, { file_name?: unknown }> };
      return new Set(
        Object.values(lock.packages ?? {}).flatMap((pkg) =>
          typeof pkg.file_name === 'string' ? [pkg.file_name] : [],
        ),
      );
    });
  return pyodidePackageFilesPromise;
}

async function fetchAndCachePyodideAsset(pathParts: string[]): Promise<RuntimeAsset | null> {
  if (pathParts.length !== 1 || !(await allowedPyodidePackageFiles()).has(pathParts[0])) {
    return null;
  }
  const cacheRoot = path.join(RUNTIME_CACHE_DIR, `pyodide-${PYODIDE_VERSION}`);
  const cached = await readLocalAsset(cacheRoot, pathParts);
  if (cached) return cached;

  const remoteUrl = new URL(pathParts.map(encodeURIComponent).join('/'), PYODIDE_CDN);
  const response = await fetch(remoteUrl, {
    cache: 'force-cache',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;

  const bytes = new Uint8Array(await response.arrayBuffer());
  const filePath = path.resolve(cacheRoot, ...pathParts);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Blue/green app containers can share this cache volume. Use a random
  // suffix so concurrent first requests from processes with the same PID do
  // not write the same temporary file.
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, bytes);
  await fs.rename(temporaryPath, filePath).catch(async () => {
    await fs.rm(temporaryPath, { force: true });
  });
  return bytes;
}

async function getRuntimeAsset(
  request: Request,
  context: { params: Promise<{ runtime: string; path: string[] }> },
) {
  const { runtime: runtimeName, path: pathParts } = await context.params;
  if (!isSafePath(pathParts)) {
    return new Response('Invalid interactive runtime path', { status: 400 });
  }

  try {
    // Exact build fingerprint URLs are also the target of the public static
    // rewrite. Legacy unversioned/version-only API paths keep their contract.
    if (runtimeName === 'monaco' && /^[a-f0-9]{64}$/.test(pathParts[1] ?? '')) {
      return await servePinnedMonaco(request, {
        kind: pathParts[1] === monacoBundle.bundleSha256 ? 'bundle' : 'tree', parts: pathParts,
      });
    }
    const expectedVersion = INTERACTIVE_RUNTIME_VERSIONS[runtimeName];
    const versioned = Boolean(expectedVersion && pathParts[0] === expectedVersion);
    if (expectedVersion && !versioned && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(pathParts[0])) {
      return new Response('Unknown interactive runtime version', { status: 404 });
    }
    const localParts = versioned ? pathParts.slice(1) : pathParts;
    const immutable = runtimeName === 'three' || versioned;
    const version = runtimeName === 'three' ? THREE_VERSION : expectedVersion ?? '';
    // Package replacements are unusual, but a file changed between metadata
    // lookup and a bounded read must be resolved again with a fresh validator.
    for (let attempt = 0; attempt < 2; attempt++) {
      let bytes: RuntimeAsset | null = null;
      if (runtimeName === 'codemirror') {
        bytes = await coalesceRuntimeAssetRead(`codemirror:${version}:${localParts.join('/')}`, () => readLocalAsset(CODEMIRROR_ROOT, localParts));
      } else if (runtimeName === 'katex') {
        bytes = await coalesceRuntimeAssetRead(`katex:${version}:${localParts.join('/')}`, () => readLocalAsset(KATEX_ROOT, localParts));
      } else if (runtimeName === 'monaco') {
        bytes = await coalesceRuntimeAssetRead(`monaco:${version}:${localParts.join('/')}`, () => readLocalAsset(MONACO_ROOT, localParts));
      } else if (runtimeName === 'three') {
        const [version, ...assetParts] = pathParts;
        const assetPath = assetParts.join('/');
        // Serve only executable browser assets from the pinned package. Never
        // expose package metadata, server entry points, or arbitrary CDN fetches.
        const allowed = /^build\/three(?:\.module)?(?:\.min)?\.js$/.test(assetPath)
          || /^examples\/jsm\/.+\.js$/.test(assetPath);
        if (version !== THREE_VERSION || !allowed) return new Response('Unknown Three.js runtime asset', { status: 404 });
        bytes = await coalesceRuntimeAssetRead(`three:${version}:${assetParts.join('/')}`, () => readLocalAsset(THREE_ROOT, assetParts));
      } else if (runtimeName === 'pyodide') {
        bytes = await coalesceRuntimeAssetRead(`pyodide:${version}:${localParts.join('/')}`, async () =>
          await readLocalAsset(PYODIDE_ROOT, localParts) ?? await fetchAndCachePyodideAsset(localParts));
      } else {
        return new Response('Unknown interactive runtime', { status: 404 });
      }

      if (!bytes) return new Response('Interactive runtime asset not found', { status: 404 });
      try {
        return await responseFor(bytes, pathParts.at(-1) ?? 'runtime.bin', immutable, version, request);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt === 0 && (code === 'RUNTIME_ASSET_CHANGED' || code === 'ENOENT')) continue;
        throw error;
      }
    }
    throw new Error('Interactive runtime asset remained unstable');
  } catch (error) {
    console.error('[interactive-runtime] Failed to serve asset', {
      runtime: runtimeName,
      path: pathParts.join('/'),
      error,
    });
    return new Response('Failed to load interactive runtime asset', { status: 502,
      headers: { 'Cache-Control': 'no-store, no-transform', 'Vary': 'Accept-Encoding',
        'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
  }
}
export const GET = withHttpMetrics('GET', '/api/openmaic/interactive-runtime/:runtime/:path', getRuntimeAsset);
export const HEAD = withHttpMetrics('HEAD', '/api/openmaic/interactive-runtime/:runtime/:path', getRuntimeAsset);
