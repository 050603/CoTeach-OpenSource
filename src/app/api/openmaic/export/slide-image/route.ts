import { authenticateRequest, requireSameOrigin } from '@/lib/auth/request-guards';
import { assertPlaybackSlideScene, renderPlaybackSlide } from '@/lib/openmaic/export/render-playback-slide';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

class BodyTooLarge extends Error {}

async function readBody(request: Request): Promise<unknown> {
  const length = request.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > MAX_BODY_BYTES) throw new BodyTooLarge();
  if (!request.body) throw new Error('请求内容为空');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function failure(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const auth = await authenticateRequest(request);
  if ('response' in auth) return auth.response;

  let scene;
  try {
    const body = await readBody(request);
    const input = typeof body === 'object' && body !== null && 'scene' in body ? body.scene : undefined;
    assertPlaybackSlideScene(input);
    scene = input;
  } catch (error) {
    if (error instanceof BodyTooLarge) return failure('PPT 页面请求超过 32 MiB', 413);
    return failure(error instanceof Error ? error.message : 'PPT 页面请求无效', 400);
  }

  try {
    const png = await renderPlaybackSlide(scene);
    return new Response(new Uint8Array(png), { headers: {
      'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    return failure(error instanceof Error ? error.message : '播放器页面截图失败', 503);
  }
}
