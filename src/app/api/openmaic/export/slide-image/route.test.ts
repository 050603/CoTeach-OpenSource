// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), origin: vi.fn(), render: vi.fn() }));
vi.mock('@/lib/auth/request-guards', () => ({ authenticateRequest: mocks.auth, requireSameOrigin: mocks.origin }));
vi.mock('@/lib/openmaic/export/render-playback-slide', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/openmaic/export/render-playback-slide')>(), renderPlaybackSlide: mocks.render,
}));
import { POST } from './route';

function scene() {
  return { id: 'slide', stageId: 'course', title: '课件', order: 1, type: 'slide', content: { type: 'slide', canvas: {
    id: 'canvas', viewportSize: 1000, viewportRatio: 0.5625, theme: { fontName: 'Arial', fontColor: '#333', themeColors: [] },
    elements: [{ id: 'text', type: 'text', left: 20, top: 30, width: 400, height: 100, rotate: 0, content: '<p>内容</p>' }],
  } } };
}

function request(body: unknown = { scene: scene() }, headers: HeadersInit = {}): Request {
  return new Request('https://coteach.example/api/openmaic/export/slide-image', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

describe('slide image export API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.origin.mockReturnValue(null);
    mocks.auth.mockResolvedValue({ claims: { sub: 'teacher' } });
    mocks.render.mockResolvedValue(Buffer.from('native PNG'));
  });

  it('requires same-origin authentication before reading or rendering a page', async () => {
    mocks.origin.mockReturnValueOnce(new Response(null, { status: 403 }));
    expect((await POST(request())).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    mocks.auth.mockResolvedValueOnce({ response: new Response(null, { status: 401 }) });
    expect((await POST(request())).status).toBe(401);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('returns the actual PNG with no caching and forwards only the scene', async () => {
    const input = scene();
    const response = await POST(request({ scene: input }, { cookie: 'private=session' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('native PNG');
    expect(mocks.render).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('reports the real rendering failure without returning a partial image', async () => {
    mocks.render.mockRejectedValueOnce(new Error('poster image failed to decode'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'poster image failed to decode' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('exports legacy scenes without a stage id after visual assets have been inlined', async () => {
    const input = { ...scene(), stageId: undefined };
    const response = await POST(request({ scene: input }));
    expect(response.status).toBe(200);
    expect(mocks.render).toHaveBeenCalledExactlyOnceWith(JSON.parse(JSON.stringify(input)));
  });

  it.each([
    undefined,
    { scene: { ...scene(), type: 'quiz' } },
    { scene: { ...scene(), content: { type: 'quiz' } } },
    { scene: { ...scene(), content: { ...scene().content, canvas: { ...scene().content.canvas, viewportRatio: 0 } } } },
    { scene: { ...scene(), content: { ...scene().content, canvas: { ...scene().content.canvas, viewportSize: 10000 } } } },
    { scene: { ...scene(), content: { ...scene().content, canvas: { ...scene().content.canvas,
      elements: [{ ...scene().content.canvas.elements[0], height: -1 }] } } } },
    { scene: { ...scene(), content: { ...scene().content, canvas: { ...scene().content.canvas,
      elements: [{ ...scene().content.canvas.elements[0], type: 'unknown' }] } } } },
  ])('rejects malformed scenes before starting Chromium: %j', async (body) => {
    const response = await POST(request(body === undefined ? {} : body));
    expect(response.status).toBe(400);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON and non-finite nested geometry', async () => {
    const invalid = (body: string) => new Request('https://coteach.example/api/openmaic/export/slide-image', { method: 'POST', body });
    expect((await POST(invalid('{invalid'))).status).toBe(400);
    const input = JSON.stringify({ scene: scene() }).replace('"rotate":0', '"rotate":1e309');
    expect((await POST(invalid(input))).status).toBe(400);
    expect(mocks.render).not.toHaveBeenCalled();
  });

  it('enforces 32 MiB from headers and streaming bytes', async () => {
    expect((await POST(request({}, { 'content-length': String(32 * 1024 * 1024 + 1) }))).status).toBe(413);
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(32 * 1024 * 1024));
      controller.enqueue(new Uint8Array(1));
    }, cancel });
    const streamed = new Request('https://coteach.example/api/openmaic/export/slide-image', {
      method: 'POST', body: stream, duplex: 'half',
    } as RequestInit);
    const response = await POST(streamed);
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(mocks.render).not.toHaveBeenCalled();
  });
});
