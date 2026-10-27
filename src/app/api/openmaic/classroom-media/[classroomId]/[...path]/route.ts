import { promises as fs } from 'fs';
import { createHash } from 'node:crypto';
import path from 'path';
import { type NextRequest } from 'next/server';
import { CLASSROOMS_DIR, isValidClassroomId } from '@openmaic/lib/server/classroom-storage';
import { normalizePlayableWav } from '@openmaic/lib/audio/wav-container';
import { createClassroomMediaCache } from '@openmaic/lib/server/classroom-media-cache';
import { runtimeAssetEtag, runtimeAssetMatchesIfNoneMatch } from '@openmaic/lib/server/runtime-asset-cache';
import { authorizeClassroomMediaRead } from '@/lib/platform/classroom-media-access';
import { parseByteRange, streamFileBytes } from '@/lib/uploads/file-stream';
import { streamBufferBytes } from '@/lib/uploads/buffer-stream';
import { withHttpMetrics } from '@/lib/observability/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const wavBodies = createClassroomMediaCache({ maxBytes: 64 * 1024 * 1024, maxEntries: 128 });
const wavEtags = new WeakMap<Uint8Array, string>();
const fileIdentity = (stat: import('fs').BigIntStats) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

const MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.webp': 'image/webp',
};

async function getClassroomMedia(
  _request: NextRequest,
  context: { params: Promise<{ classroomId: string; path: string[] }> },
) {
  const { classroomId, path: pathParts } = await context.params;
  if (!isValidClassroomId(classroomId) || !Array.isArray(pathParts) || pathParts.length === 0) {
    return new Response('Invalid classroom media path', { status: 400 });
  }

  const authorization = await authorizeClassroomMediaRead(_request, classroomId, pathParts);
  if (authorization) return authorization;

  const classroomDir = path.resolve(CLASSROOMS_DIR, classroomId);
  const filePath = path.resolve(classroomDir, ...pathParts);
  if (filePath !== classroomDir && !filePath.startsWith(`${classroomDir}${path.sep}`)) {
    return new Response('Invalid classroom media path', { status: 400 });
  }

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const stat = await fs.stat(filePath, { bigint: true });
      const identity = fileIdentity(stat);
      let bytes: Uint8Array | undefined;
      if (ext === '.wav') {
        try {
          bytes = await wavBodies.read(JSON.stringify([filePath, identity]), async signal => {
            const normalized = normalizePlayableWav(await fs.readFile(filePath, { signal }));
            if (fileIdentity(await fs.stat(filePath, { bigint: true })) !== identity) {
              throw Object.assign(new Error('Classroom media changed while reading'), { code: 'CLASSROOM_MEDIA_CHANGED' });
            }
            return normalized;
          }, _request.signal);
        } catch (error) {
          if (attempt === 0 && (error as NodeJS.ErrnoException).code === 'CLASSROOM_MEDIA_CHANGED') continue;
          throw error;
        }
      }
      // Hash a normalized WAV once per cached allocation, so resumable ranges
      // use a strong validator for the exact playable representation.
      let etag = bytes && wavEtags.get(bytes);
      if (bytes && !etag) {
        etag = `"${createHash('sha256').update(bytes).digest('base64url')}"`;
        wavEtags.set(bytes, etag);
      }
      etag ||= runtimeAssetEtag({ filePath, size: Number(stat.size), identity }, 'classroom-media-v1');
      const headers = {
        // A browser can retain bytes, but must check current authorization and
        // file identity before reusing them. Shared caches must not store them.
        'Cache-Control': 'private, no-cache, must-revalidate',
        'Vary': 'Cookie, Authorization',
        'ETag': etag,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
      };
      if (runtimeAssetMatchesIfNoneMatch(_request.headers.get('if-none-match'), etag)) {
        return new Response(null, { status: 304, headers });
      }
      const totalSize = bytes?.byteLength ?? Number(stat.size);
      // Byte positions refer to the playable representation. WAV normalization
      // can replace its header and unwrap an extra container, changing its size.
      // If-Range requires a strong match; metadata validators and dates cannot
      // prove the byte positions still refer to the same representation.
      const ifRange = _request.headers.get('if-range');
      const rangeHeader = _request.method === 'HEAD' || (ifRange !== null && (etag.startsWith('W/') || ifRange !== etag))
        ? null : _request.headers.get('range');
      const range = rangeHeader === null ? null : parseByteRange(rangeHeader, totalSize);
      if (rangeHeader !== null && !range) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, 'Content-Range': `bytes */${totalSize}`, 'Content-Length': '0' },
        });
      }
      const length = range ? range.end - range.start + 1 : totalSize;
      const body = _request.method === 'HEAD' ? null : bytes ? streamBufferBytes(bytes, { ...range, signal: _request.signal })
        : totalSize === 0 ? null : await streamFileBytes(filePath, { ...range, signal: _request.signal });

      const responseHeaders = new Headers({ ...headers, 'Content-Length': String(length) });
      if (range) {
        responseHeaders.set('Content-Range', `bytes ${range.start}-${range.end}/${totalSize}`);
        // HTTP forbids weak validators on 206; keep ordinary file streaming
        // without hashing large non-WAV assets for each student's seek.
        if (etag.startsWith('W/')) responseHeaders.delete('ETag');
      }
      return new Response(body, {
        status: range ? 206 : 200,
        headers: responseHeaders,
      });
    }
    throw new Error('Classroom media remained unstable');
  } catch (error) {
    // readFile observes the request signal before response headers are sent.
    // A client disconnect is not a server failure; unrelated I/O errors retain
    // their real status even if the request also happened to be cancelled.
    const readError = error as NodeJS.ErrnoException;
    if (path.extname(filePath).toLowerCase() === '.wav' && _request.signal.aborted
      && (readError.name === 'AbortError' || readError.code === 'ABORT_ERR')) {
      return new Response(null, { status: 499, headers: { 'Cache-Control': 'private, no-store' } });
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Response('Classroom media not found', { status: 404 });
    }
    return new Response('Failed to read classroom media', { status: 500 });
  }
}
export const GET = withHttpMetrics('GET', '/api/openmaic/classroom-media/:classroomId/:path', getClassroomMedia);
export const HEAD = withHttpMetrics('HEAD', '/api/openmaic/classroom-media/:classroomId/:path', getClassroomMedia);
