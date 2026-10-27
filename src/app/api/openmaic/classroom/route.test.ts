import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ read: vi.fn(), access: vi.fn(), preview: vi.fn() }));
vi.mock('@/lib/platform/access', () => ({ authorizeLegacyClassroomRead: mocks.access }));
vi.mock('@openmaic/lib/server/classroom-storage', () => ({
  isValidClassroomId: (id: string) => /^[a-zA-Z0-9_-]+$/.test(id), readClassroom: mocks.read,
}));
vi.mock('@/lib/course-generation/generation-preview', () => ({
  courseGenerationPreviewJobId: (id: string) => id.startsWith('preview-') ? id : null,
  loadCourseGenerationPreviewClassroom: mocks.preview,
}));
vi.mock('@/lib/auth/read-api-boundary', () => ({
  withReadApiBoundary: (handler: unknown) => handler,
  readApiOptionsFor: vi.fn(), readApiMethodNotAllowed: vi.fn(),
}));
vi.mock('@/lib/observability/http', () => ({
  withHttpMetrics: (_method: string, _route: string, handler: unknown) => handler,
}));
import { GET } from './route';

const classroom = { id: 'lesson', stage: { id: 'lesson', name: '原课件' }, scenes: [
  { id: 'page', actions: [{ type: 'speech', text: '讲解', audioUrl: '/original.wav' }] },
] };
const request = (etag?: string, id = 'lesson') => new NextRequest(`http://localhost/api/openmaic/classroom?id=${id}`, {
  headers: etag ? { 'if-none-match': etag } : {},
});

describe('classroom browser revalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue(null);
    mocks.read.mockResolvedValue(structuredClone(classroom));
  });

  it('returns no body for an unchanged authorized lesson', async () => {
    const first = await GET(request());
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-cache, must-revalidate');
    expect(first.headers.get('vary')).toContain('Cookie');
    expect(await first.json()).toMatchObject({ success: true, classroom });
    const again = await GET(request(`"old", ${first.headers.get('etag')}`));
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(mocks.access).toHaveBeenCalledTimes(2);
  });

  it.each(['audio', 'stage', 'preview'])('invalidates when %s changes without relying on a revision field', async (change) => {
    const first = await GET(request());
    const updated = structuredClone(classroom);
    if (change === 'audio') updated.scenes[0].actions[0].audioUrl = '/repaired.wav';
    if (change === 'stage') updated.stage.name = '已修订的课件';
    mocks.read.mockResolvedValue(change === 'preview'
      ? { ...updated, assetGeneration: { status: 'running', failures: [] } } : updated);
    const response = await GET(request(first.headers.get('etag')!));
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).not.toBe(first.headers.get('etag'));
  });

  it('checks access before conditional responses and never serves a removed lesson from cache', async () => {
    const first = await GET(request());
    mocks.access.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    mocks.read.mockClear();
    expect((await GET(request(first.headers.get('etag')!))).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
    mocks.read.mockResolvedValueOnce(null);
    expect((await GET(request(first.headers.get('etag')!))).status).toBe(404);
  });

  it('revalidates generated preview readiness independently of lesson bytes', async () => {
    mocks.preview.mockResolvedValue({ ...classroom, generationPreview: { active: true, jobStatus: 'running' } });
    const first = await GET(request(undefined, 'preview-job'));
    mocks.preview.mockResolvedValue({ ...classroom, generationPreview: { active: false, jobStatus: 'completed' } });
    const next = await GET(request(first.headers.get('etag')!, 'preview-job'));
    expect(next.status).toBe(200);
    expect(await next.json()).toMatchObject({ classroom: { generationPreview: { active: false } } });
  });
});
