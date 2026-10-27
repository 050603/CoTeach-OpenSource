import path from 'node:path';
import { encodedMonacoRuntime } from './encoded-monaco-runtime';
import { encodedMonacoBundle } from './encoded-monaco-bundle';

export type PinnedMonacoTarget = { kind: 'tree' | 'bundle'; parts: string[] };

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.data': 'application/octet-stream',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.tar': 'application/x-tar',
  '.wasm': 'application/wasm', '.whl': 'application/zip', '.zip': 'application/zip',
};

/** Standard Web Request/Response core for the pinned Next resource route.
 * Explicit route targets preserve decoded API-params semantics;
 * the encoded factories themselves only serve their fixed manifest identity.
 * Global Next security headers and transport metrics belong to the caller.
 */
export async function servePinnedMonaco(request: Request, target: PinnedMonacoTarget): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
  try {
    const serve = target.kind === 'bundle' ? encodedMonacoBundle : encodedMonacoRuntime;
    return await serve(request, target.parts,
      MIME_TYPES[path.extname(target.parts.at(-1) ?? '').toLowerCase()] ?? 'application/octet-stream');
  } catch (error) {
    console.error('[interactive-runtime] Failed to serve asset', {
      runtime: 'monaco', path: target.parts.join('/'), error,
    });
    return new Response('Failed to load interactive runtime asset', { status: 502,
      headers: { 'Cache-Control': 'no-store, no-transform', 'Vary': 'Accept-Encoding',
        'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
  }
}
