import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const courseStore = vi.hoisted(() => ({
  course: null as null | Record<string, unknown>,
  persistStudentAiProgress: vi.fn(),
}));
const classroomStore = vi.hoisted(() => ({
  classroom: null as null | { scenes: Array<{ id: string; outlineId?: string; stageKey?: string; audience?: string; generationPurpose?: string }> },
}));
const auth = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  requireSameOrigin: vi.fn(),
  scope: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ isDatabaseConfigured: () => true, prisma: {} }));
vi.mock('@/lib/courses/student-state-scope', () => ({ resolveStudentStateScope: auth.scope }));

vi.mock('@/lib/auth/request-guards', () => ({
  authenticateRequest: auth.authenticateRequest,
  requireSameOrigin: auth.requireSameOrigin,
}));
vi.mock('@/lib/auth/session', () => ({
  isAuthConfigured: () => true,
}));

vi.mock('@/lib/courses/ai-progress-context', () => ({
  loadAiProgressContext: vi.fn(async () => courseStore.course),
}));
vi.mock('@/lib/courses/ai-progress-service', () => ({
  persistStudentAiProgress: courseStore.persistStudentAiProgress,
}));
vi.mock('@/lib/platform/access', () => ({
  canAccessLegacyCourse: vi.fn(async () => true),
}));
vi.mock('@openmaic/lib/server/classroom-storage', () => ({
  readClassroom: vi.fn(async () => classroomStore.classroom),
}));

import { GET, POST } from './route';
import { loadAiProgressContext } from '@/lib/courses/ai-progress-context';
import { canAccessLegacyCourse } from '@/lib/platform/access';
import { PlatformError } from '@/lib/platform/repository';
import { timeProgress } from '@/lib/observability/progress-request-timing';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/openmaic/progress', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'x-openpbl-role': 'student',
    },
  });
}

describe('progress route integrity', () => {
  beforeEach(() => {
    vi.mocked(loadAiProgressContext).mockClear();
    courseStore.persistStudentAiProgress.mockReset();
    courseStore.persistStudentAiProgress.mockImplementation(async (_courseId, _studentId, progress) => progress);
    courseStore.course = {
      id: 'course-1',
      aiLearningClassroomId: 'classroom-1',
      content: {},
      students: [{ id: 'student-1' }],
      aiLearningProgress: {
        'student-1': { classroomId: 'classroom-1', completedScenes: ['s1'], completionModelVersion: 2 },
      },
    };
    classroomStore.classroom = {
      scenes: [
        { id: 's1', outlineId: 'outline-ai-1' },
        { id: 's2', outlineId: 'outline-ai-2' },
      ],
    };
    auth.requireSameOrigin.mockReturnValue(null);
    auth.scope.mockReset(); auth.scope.mockResolvedValue({ accessible: true });
    vi.mocked(canAccessLegacyCourse).mockReset(); vi.mocked(canAccessLegacyCourse).mockResolvedValue(true);
    auth.authenticateRequest.mockReset();
    auth.authenticateRequest.mockResolvedValue({
      claims: {
        sub: 'student-1',
        role: 'student',
        courseId: 'course-1',
        studentId: 'student-1',
        studentName: '测试学生',
        sv: 1,
      },
    });
  });

  it('rejects another student before querying progress data', async () => {
    const response = await GET(new NextRequest('http://localhost/api/openmaic/progress?courseId=course-1&studentId=other'));
    expect(response.status).toBe(403);
    expect(response.headers.get('Server-Timing')).toMatch(/(?:^|, )handler;dur=\d+\.\d{2}$/);
    expect(loadAiProgressContext).not.toHaveBeenCalled();
  });

  it('reads only the authenticated learner progress context', async () => {
    const response = await GET(new NextRequest('http://localhost/api/openmaic/progress?courseId=course-1&studentId=student-1'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Server-Timing')).toMatch(/(?:^|, )handler;dur=\d+\.\d{2}$/);
    expect(loadAiProgressContext).toHaveBeenCalledWith('course-1', 'student-1');
    expect(Object.keys((await response.json()).data.progress)).toEqual(['student-1']);
    expect(auth.scope).toHaveBeenCalledWith(expect.anything(), 'course-1', 'student-1');
    expect(canAccessLegacyCourse).not.toHaveBeenCalled();
  });

  it('does not override a denied instance scope, but preserves namespace fallback for null', async () => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1', currentSceneIndex: 0, totalScenes: 2, completedScenes: [] };
    auth.scope.mockResolvedValue({ accessible: false });
    expect((await POST(request(body))).status).toBe(403);
    expect(canAccessLegacyCourse).not.toHaveBeenCalled();
    expect(loadAiProgressContext).not.toHaveBeenCalled();
    auth.scope.mockResolvedValue(null);
    expect((await POST(request(body))).status).toBe(200);
    expect(canAccessLegacyCourse).toHaveBeenCalledWith(expect.objectContaining({ sub: 'student-1' }), 'course-1', 'read');
  });

  it('keeps teacher aggregate reads on their established authorization path', async () => {
    auth.authenticateRequest.mockResolvedValue({ claims: { sub: 'teacher', role: 'teacher', sv: 1 } });
    expect((await GET(new NextRequest('http://localhost/api/openmaic/progress?courseId=course-1'))).status).toBe(200);
    expect(auth.scope).not.toHaveBeenCalled();
    expect(canAccessLegacyCourse).toHaveBeenCalledWith(expect.objectContaining({ role: 'teacher' }), 'course-1', 'read');
    expect(loadAiProgressContext).toHaveBeenCalledWith('course-1', undefined);
  });

  it('rejects progress written to a classroom not linked to the course', async () => {
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'other',
      currentSceneIndex: 0, totalScenes: 99, completedScenes: [],
    }));

    expect(response.status).toBe(400);
    expect(courseStore.persistStudentAiProgress).not.toHaveBeenCalled();
  });

  it('uses persisted scenes and preserves earlier completion', async () => {
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 99, totalScenes: 999,
      completedScenes: ['s2', 's2', 'unknown'],
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('Server-Timing')).toMatch(/(?:^|, )handler;dur=\d+\.\d{2}$/);
    const body = await response.json();
    expect(body.data.progress).toMatchObject({
      currentSceneIndex: 1,
      totalScenes: 2,
      completedScenes: ['s1', 's2'],
      completedOutlineIds: ['outline-ai-1', 'outline-ai-2'],
      masteryLevel: 'completed',
    });
    expect(courseStore.persistStudentAiProgress).toHaveBeenCalledWith(
      'course-1',
      'student-1',
      expect.objectContaining({ completedScenes: ['s1', 's2'] }),
      classroomStore.classroom!.scenes,
      expect.objectContaining({ requestId: expect.stringMatching(/^legacy-/), fingerprint: expect.any(String), sessionVersion: 1 }),
    );
  });

  it('excludes teacher-only scenes from completion exactly as the student player does', async () => {
    classroomStore.classroom!.scenes = [
      { id: 's1', audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching' },
      { id: 'teacher', audience: 'teacher', stageKey: 'ai-learning', generationPurpose: 'teacher-resource' },
    ];
    const response = await POST(request({ courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 1, totalScenes: 2, completedScenes: ['s1', 'teacher'] }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.progress).toMatchObject({ totalScenes: 1, completedScenes: ['s1'], masteryLevel: 'completed' });
  });

  it('ignores a player-reported score when deciding completion and stored scoring', async () => {
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 1, totalScenes: 2, completedScenes: ['s2'], quizScore: 100,
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.progress.masteryLevel).toBe('completed');
    expect(body.data.progress.quizScore).toBeUndefined();
  });

  it('does not carry completed scenes or quiz attempts from a previous classroom', async () => {
    courseStore.course = {
      ...(courseStore.course ?? {}),
      aiLearningProgress: { 'student-1': { classroomId: 'old-classroom', completedScenes: ['s1'], completionModelVersion: 2, knowledgeLectureAttempts: [{ id: 'old-quiz' }] } },
    };
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 0, totalScenes: 2, completedScenes: [],
    }));
    const body = await response.json();
    expect(body.data.progress).toMatchObject({ completedScenes: [], masteryLevel: 'not-started' });
    expect(body.data.progress.knowledgeLectureAttempts).toBeUndefined();
  });

  it('does not carry forward completion produced by the legacy enter-page model', async () => {
    courseStore.course = {
      ...(courseStore.course ?? {}),
      aiLearningProgress: {
        'student-1': { completedScenes: ['s1', 's2'], masteryLevel: 'completed' },
      },
    };

    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 0, totalScenes: 2, completedScenes: [],
    }));
    const body = await response.json();

    expect(body.data.progress).toMatchObject({
      completedScenes: [],
      masteryLevel: 'not-started',
      completionModelVersion: 2,
    });
  });

  it('fingerprints the stable original body rather than mutable progress and supports old clients', async () => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1', requestId: 'stable-id', currentSceneIndex: 0, totalScenes: 2, completedScenes: ['s1'] };
    expect((await POST(request(body))).status).toBe(200);
    const first = courseStore.persistStudentAiProgress.mock.calls.at(-1)?.[4];
    courseStore.course!.aiLearningProgress = { 'student-1': { classroomId: 'classroom-1', completedScenes: ['s1', 's2'], completionModelVersion: 2 } };
    expect((await POST(request(Object.fromEntries(Object.entries(body).reverse())))).status).toBe(200);
    expect(courseStore.persistStudentAiProgress.mock.calls.at(-1)?.[4]).toEqual(first);
    await POST(request({ ...body, completedScenes: ['s2'] }));
    expect(courseStore.persistStudentAiProgress.mock.calls.at(-1)?.[4].fingerprint).not.toBe(first.fingerprint);
  });
  it('rejects malformed request identifiers without persisting progress', async () => {
    expect((await POST(request({ courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1', requestId: 'bad id', currentSceneIndex: 0, totalScenes: 1, completedScenes: [] }))).status).toBe(400);
    expect(courseStore.persistStudentAiProgress).not.toHaveBeenCalled();
  });
  it('rejects progress updates for another student identity', async () => {
    const response = await POST(request({
      courseId: 'course-1', studentId: 'student-2', classroomId: 'classroom-1',
      currentSceneIndex: 0, totalScenes: 2, completedScenes: [],
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get('Server-Timing')).toMatch(/(?:^|, )handler;dur=\d+\.\d{2}$/);
    expect(courseStore.persistStudentAiProgress).not.toHaveBeenCalled();
  });

  it('preserves the actual authentication rejection and records no later business phase', async () => {
    const original = Response.json({ code: 'UNAUTHORIZED', marker: 'original-body' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    auth.authenticateRequest.mockResolvedValueOnce({ response: original });
    const response = await GET(new NextRequest('http://localhost/api/openmaic/progress?courseId=course-1&studentId=student-1'));
    expect(response).toBe(original);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: 'UNAUTHORIZED', marker: 'original-body' });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Server-Timing')).toContain('progress-auth;dur=');
    expect(response.headers.get('Server-Timing')).not.toContain('progress-context;');
    expect(loadAiProgressContext).not.toHaveBeenCalled();
  });

  it('adds fixed diagnostic spans to a real successful save without changing its payload', async () => {
    const response = await POST(request({ courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      currentSceneIndex: 1, totalScenes: 2, completedScenes: ['s2'], requestId: 'private-request-id' }));
    expect(response.status).toBe(200);
    expect((await response.json()).data.progress).toMatchObject({ studentId: 'student-1', completedScenes: ['s1', 's2'], totalScenes: 2 });
    const timing = response.headers.get('Server-Timing')!;
    expect(timing).toContain('progress-context;dur=');
    expect(timing).toContain('progress-classroom;dur=');
    expect(timing).toContain('progress-normalize;dur=');
    expect(timing.match(/progress-auth;dur=/g)).toHaveLength(3);
    expect(timing).not.toContain('student-1'); expect(timing).not.toContain('private-request-id');
    expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce();
  });

  it('coalesces an exact retry after caller abort while preserving independent response timings', async () => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      requestId: 'pending-abort-retry', currentSceneIndex: 0, totalScenes: 2, completedScenes: [] };
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    courseStore.persistStudentAiProgress.mockImplementation(async (_course, _student, progress) => {
      await timeProgress('progress-transaction', () => pending);
      return progress;
    });
    const controller = new AbortController();
    const firstRequest = new NextRequest(request(body), { signal: controller.signal });
    const original = POST(firstRequest);
    await vi.waitFor(() => expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce());
    controller.abort();
    courseStore.course!.aiLearningProgress = { 'student-1': { classroomId: 'classroom-1', completedScenes: ['s1', 's2'], completionModelVersion: 2 } };
    const replay = POST(request(body));
    await vi.waitFor(() => expect(loadAiProgressContext).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    const callsWhilePending = courseStore.persistStudentAiProgress.mock.calls.length;
    release();
    const [first, second] = await Promise.all([original, replay]);
    expect(callsWhilePending).toBe(1);
    expect(first).not.toBe(second);
    expect(first.status).toBe(200); expect(second.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.progress.completedScenes).toEqual(['s1']);
    expect(await second.json()).toEqual(firstBody);
    expect(first.headers.get('Server-Timing')).toContain('progress-transaction;');
    expect(second.headers.get('Server-Timing')).not.toContain('progress-transaction;');
  });

  it('keeps changed bodies separate so the existing DB collision guard rejects them', async () => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      requestId: 'collision', currentSceneIndex: 0, totalScenes: 2, completedScenes: ['s1'] };
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    courseStore.persistStudentAiProgress.mockImplementationOnce(async (_c, _s, progress) => { await pending; return progress; })
      .mockRejectedValueOnce(new PlatformError('IDEMPOTENCY_CONFLICT', 'Changed request body', 409));
    const original = POST(request(body));
    await vi.waitFor(() => expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce());
    const changed = await POST(request({ ...body, completedScenes: ['s2'] }));
    expect(changed.status).toBe(409);
    expect(courseStore.persistStudentAiProgress.mock.calls[0][4].fingerprint)
      .not.toBe(courseStore.persistStudentAiProgress.mock.calls[1][4].fingerprint);
    release(); expect((await original).status).toBe(200);
  });

  it('does not share changes to ignored body fields or legacy namespace fallback', async () => {
    for (const canonical of [true, false]) {
      auth.scope.mockResolvedValue(canonical ? { accessible: true } : null);
      const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
        requestId: `full-body-${canonical}`, currentSceneIndex: 0, totalScenes: 2, completedScenes: [] };
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      courseStore.persistStudentAiProgress.mockClear();
      courseStore.persistStudentAiProgress.mockImplementation(async (_c, _s, progress) => { await pending; return progress; });
      const first = POST(request(body));
      await vi.waitFor(() => expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce());
      const second = POST(request(canonical ? { ...body, extra: 'different' } : body));
      await vi.waitFor(() => expect(courseStore.persistStudentAiProgress).toHaveBeenCalledTimes(2));
      release(); expect((await Promise.all([first, second])).map(r => r.status)).toEqual([200, 200]);
    }
  });

  it.each(['session', 'enrollment', 'claims'] as const)('revalidates each caller after waiting: %s revoked', async revoked => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      requestId: `revoked-${revoked}`, currentSceneIndex: 0, totalScenes: 2, completedScenes: [] };
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    courseStore.persistStudentAiProgress.mockImplementation(async (_c, _s, progress) => { await pending; return progress; });
    const first = POST(request(body));
    await vi.waitFor(() => expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce());
    const second = POST(request(body));
    await vi.waitFor(() => expect(loadAiProgressContext).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    if (revoked === 'session') auth.authenticateRequest.mockImplementation(async () => ({ response: Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }) }));
    if (revoked === 'enrollment') auth.scope.mockResolvedValue({ accessible: false });
    if (revoked === 'claims') auth.authenticateRequest.mockResolvedValue({ claims: { sub: 'student-1', role: 'student', sv: 2 } });
    release();
    expect((await Promise.all([first, second])).map(r => r.status)).toEqual(revoked === 'session' ? [401, 401] : [403, 403]);
    expect(auth.authenticateRequest).toHaveBeenCalledTimes(4);
    expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce();
  });

  it('removes failed pending work so a later retry consults the DB again', async () => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      requestId: 'failed-pending', currentSceneIndex: 0, totalScenes: 2, completedScenes: [] };
    let fail!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
    courseStore.persistStudentAiProgress.mockImplementationOnce(() => pending);
    const first = POST(request(body));
    await vi.waitFor(() => expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce());
    const second = POST(request(body));
    await vi.waitFor(() => expect(loadAiProgressContext).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    fail(new PlatformError('COURSE_BUSY', 'retry later', 503));
    expect((await Promise.all([first, second])).map(r => r.status)).toEqual([503, 503]);
    expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce();
    expect((await POST(request(body))).status).toBe(200);
    expect(courseStore.persistStudentAiProgress).toHaveBeenCalledTimes(2);
  });

  it('preserves committed replay after closure and does not cache a completed authorization decision', async () => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      requestId: 'closed-replay', currentSceneIndex: 0, totalScenes: 2, completedScenes: [] };
    courseStore.course!.status = 'FINISHED';
    const committed = { classroomId: 'classroom-1', studentId: 'student-1', completedScenes: ['s1'], lastActiveAt: '2026-10-16T00:00:00.000Z' };
    courseStore.persistStudentAiProgress.mockResolvedValue(committed);
    for (let index = 0; index < 2; index++) {
      const response = await POST(request(body));
      expect(response.status).toBe(200); expect((await response.json()).data.progress).toEqual(committed);
    }
    expect(courseStore.persistStudentAiProgress).toHaveBeenCalledTimes(2);
    expect(auth.scope).toHaveBeenCalledWith(expect.anything(), 'course-1', 'student-1', { sessionVersion: 1 });
    auth.scope.mockResolvedValue({ accessible: false });
    expect((await POST(request(body))).status).toBe(403);
    expect(courseStore.persistStudentAiProgress).toHaveBeenCalledTimes(2);
  });

  it('checks each waiting HTTP session independently instead of sharing the first authorization', async () => {
    const body = { courseId: 'course-1', studentId: 'student-1', classroomId: 'classroom-1',
      requestId: 'individual-auth', currentSceneIndex: 0, totalScenes: 2, completedScenes: [] };
    let release!: () => void; let revoked = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const claims = { sub: 'student-1', role: 'student', sv: 1 };
    auth.authenticateRequest.mockImplementation(async (req: NextRequest) => revoked && req.headers.has('x-test-replay')
      ? { response: Response.json({ code: 'UNAUTHORIZED' }, { status: 401 }) } : { claims });
    courseStore.persistStudentAiProgress.mockImplementation(async (_c, _s, progress) => { await pending; return progress; });
    const first = POST(request(body));
    await vi.waitFor(() => expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce());
    const retryRequest = request(body); retryRequest.headers.set('x-test-replay', '1');
    const second = POST(retryRequest);
    await vi.waitFor(() => expect(loadAiProgressContext).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    revoked = true; release();
    expect((await Promise.all([first, second])).map(r => r.status)).toEqual([200, 401]);
    expect(courseStore.persistStudentAiProgress).toHaveBeenCalledOnce();
  });

});
