import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthClaims } from '@/lib/auth/session';
import type { PlatformDb } from './access';

const mocks = vi.hoisted(() => ({ auth: vi.fn(), preview: vi.fn(), versions: vi.fn(),
  raw: vi.fn(), user: vi.fn(), template: vi.fn(), offering: vi.fn(), enrollment: vi.fn(), teacher: vi.fn() }));
vi.mock('@/lib/auth/request-guards', () => ({ authenticateRequest: mocks.auth }));
vi.mock('@/lib/auth/session', async original => ({ ...await original<typeof import('@/lib/auth/session')>(), isAuthConfigured: () => true }));
vi.mock('@/lib/course-generation/generation-preview', () => ({ findCourseGenerationPreviewCourseId: mocks.preview }));
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: mocks.raw, classroomTemplateVersion: { findMany: mocks.versions } } }));

import { authorizeLegacyClassroomRead, canAccessLegacyCourse, getPlatformUser, resolveLegacyCourseAccess } from './access';

const claims = { role: 'student', sub: 'student', sv: 7, studentName: 'Synthetic student' } as AuthClaims;
const db = { $queryRaw: mocks.raw, user: { findUnique: mocks.user }, classroomTemplate: { findUnique: mocks.template },
  courseOffering: { findUnique: mocks.offering }, enrollment: { findFirst: mocks.enrollment },
  courseTeacher: { findFirst: mocks.teacher } } as unknown as PlatformDb;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.raw.mockResolvedValue([{ accessible: true, offeringId: 'offering', runtimeVersion: 7 }]);
  mocks.user.mockResolvedValue({ id: 'student', role: 'STUDENT', status: 'ACTIVE', sessionVersion: 7 });
  mocks.template.mockResolvedValue(null);
  mocks.offering.mockResolvedValue({ id: 'offering' });
  mocks.enrollment.mockResolvedValue({ id: 'enrollment' });
  mocks.auth.mockResolvedValue({ claims });
  mocks.preview.mockResolvedValue(null);
  mocks.versions.mockResolvedValue([{ template: { ownerId: 'teacher' }, instances: [{ id: 'classroom' }] }]);
});

describe('fresh student classroom access', () => {
  it('projects public account fields without exposing password or recovery credential digests', async () => {
    mocks.user.mockResolvedValue({ id: 'student', username: '20260001', displayName: '学生', role: 'STUDENT', status: 'ACTIVE', sessionVersion: 7,
      passwordHash: 'private-password-digest', recoveryCodeHash: 'private-recovery-digest' });
    expect(await getPlatformUser(claims, db)).toEqual({ id: 'student', username: '20260001', displayName: '学生', role: 'student', status: 'active', sessionVersion: 7 });
  });

  it('uses one live joined permission read and never loads the legacy projection', async () => {
    expect(await canAccessLegacyCourse(claims, 'classroom', 'read', db)).toBe(true);
    expect(mocks.raw).toHaveBeenCalledTimes(1);
    expect(mocks.raw.mock.calls[0].slice(1)).toEqual(['student', false, 7, true, 'classroom', 'classroom', 'classroom']);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.template).not.toHaveBeenCalled();
    expect(mocks.offering).not.toHaveBeenCalled();
  });

  it('rechecks revocation and does not fall through a denied classroom to an offering grant', async () => {
    expect(await canAccessLegacyCourse(claims, 'classroom', 'read', db)).toBe(true);
    mocks.raw.mockResolvedValue([{ accessible: false }]);
    expect(await canAccessLegacyCourse(claims, 'classroom', 'read', db)).toBe(false);
    expect(mocks.raw).toHaveBeenCalledTimes(2);
    expect(mocks.enrollment).not.toHaveBeenCalled();
  });

  it('requests write state checks independently of a successful read', async () => {
    mocks.raw.mockResolvedValueOnce([{ accessible: true }]).mockResolvedValueOnce([{ accessible: false }]);
    expect(await canAccessLegacyCourse(claims, 'classroom', 'read', db)).toBe(true);
    expect(await canAccessLegacyCourse(claims, 'classroom', 'write', db)).toBe(false);
    expect(mocks.raw.mock.calls[1].slice(1)).toEqual(['student', false, 7, false, 'classroom', 'classroom', 'classroom']);
  });

  it('keeps offering reads and template precedence on the null fallback', async () => {
    mocks.raw.mockResolvedValue([]);
    expect(await canAccessLegacyCourse(claims, 'offering', 'read', db)).toBe(true);
    expect(await canAccessLegacyCourse(claims, 'offering', 'write', db)).toBe(false);
    mocks.template.mockResolvedValue({ ownerId: 'teacher', status: 'ACTIVE' });
    expect(await canAccessLegacyCourse(claims, 'colliding-template-id', 'read', db)).toBe(false);
  });

  it('retains the teacher ownership path without a student-scope query', async () => {
    mocks.user.mockResolvedValue({ id: 'teacher', role: 'TEACHER', status: 'ACTIVE' });
    mocks.template.mockResolvedValue({ ownerId: 'teacher', status: 'ACTIVE' });
    expect(await canAccessLegacyCourse({ role: 'teacher', sub: 'teacher' } as AuthClaims, 'template', 'write', db)).toBe(true);
    expect(mocks.raw).not.toHaveBeenCalled();
  });
});

describe('published classroom resource boundaries', () => {
  const request = new Request('http://localhost/api/openmaic/classroom?id=content');

  it('requires a published resource reference before checking current student membership', async () => {
    expect(await authorizeLegacyClassroomRead(request, 'content')).toBeNull();
    expect(mocks.versions).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [
      { snapshot: { path: ['design', 'aiLearningClassroomId'], equals: 'content' } },
      { snapshot: { path: ['design', 'teacherClassroomId'], equals: 'content' } },
      { snapshot: { path: ['design', 'content', '_openmaicClassroomId'], equals: 'content' } },
    ] } }));
    mocks.versions.mockResolvedValue([]);
    expect((await authorizeLegacyClassroomRead(request, 'foreign-or-unpublished-content'))?.status).toBe(403);
    expect(mocks.raw).toHaveBeenCalledTimes(2);
  });

  it.each([
    { resourceType: 'branchRuns', status: 'ready' },
    { resourceType: 'branchRuns', status: 'completed' },
    { resourceType: 'microLessons', status: 'ready' },
    { resourceType: 'microLessons', status: 'completed' },
  ])('allows the current student to read a persisted $status $resourceType resource after checking its classroom history', async ({ resourceType, status }) => {
    mocks.versions.mockResolvedValue([]);
    mocks.raw.mockResolvedValueOnce([{ courseId: 'finished-run', classroomId: 'main-room', mainClassroomId: 'main-room',
      adaptiveLearning: { branchRuns: [], microLessons: [], [resourceType]: [{ id: 'resource:one', classroomId: 'content', status }] } }])
      .mockResolvedValueOnce([{ accessible: true }]);
    expect(await authorizeLegacyClassroomRead(request, 'content')).toBeNull();
    expect(mocks.raw).toHaveBeenCalledTimes(2);
    expect(mocks.raw.mock.calls[0].slice(1)).toEqual(['student', '[{"classroomId":"content"}]', '[{"classroomId":"content"}]']);
    expect(mocks.raw.mock.calls[1].slice(1)).toEqual(['student', false, 7, true, 'finished-run', 'finished-run', 'finished-run']);
  });

  it.each(['generating', 'failed', 'skipped', 'different-classroom', 'different-version', 'revoked-enrollment', 'other-student-or-unknown'])('denies resources outside the current authorized saved path: %s', async condition => {
    mocks.versions.mockResolvedValue([]);
    mocks.raw.mockResolvedValueOnce(condition === 'other-student-or-unknown' ? [] : [{ courseId: 'finished-run',
      classroomId: condition === 'different-version' ? 'old-main' : 'main-room', mainClassroomId: 'main-room',
      adaptiveLearning: { branchRuns: [{ id: 'run', classroomId: condition === 'different-classroom' ? 'private-content' : 'content',
        status: ['generating', 'failed', 'skipped'].includes(condition) ? condition : 'completed' }], microLessons: [] } }])
      .mockResolvedValueOnce([{ accessible: false }]);
    expect((await authorizeLegacyClassroomRead(request, 'content'))?.status).toBe(403);
    expect(mocks.raw).toHaveBeenCalledTimes(condition === 'revoked-enrollment' ? 2 : 1);
  });

  it('does not grant a teacher-only generation preview through student membership', async () => {
    mocks.preview.mockResolvedValue('classroom');
    expect((await authorizeLegacyClassroomRead(request, 'generation-preview'))?.status).toBe(403);
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.versions).not.toHaveBeenCalled();
  });

  it('stops on an invalid or revoked session before consulting any reference', async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await authorizeLegacyClassroomRead(request, 'content'))?.status).toBe(401);
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.versions).not.toHaveBeenCalled();
  });
});


describe('fresh course access result reuse', () => {
  it('returns only the current query scope and repeats permission/session checks on every poll', async () => {
    mocks.raw
      .mockResolvedValueOnce([{ accessible: true, offeringId: 'offering', runtimeVersion: 7 }])
      .mockResolvedValueOnce([{ accessible: true, offeringId: 'offering', runtimeVersion: 8 }])
      .mockResolvedValueOnce([{ accessible: false, offeringId: 'offering', runtimeVersion: 8 }]);
    expect(await resolveLegacyCourseAccess(claims, 'classroom', 'read', db)).toEqual({
      accessible: true, studentInstanceScope: { accessible: true, offeringId: 'offering', version: 7 },
    });
    expect(await resolveLegacyCourseAccess(claims, 'classroom', 'read', db)).toEqual({
      accessible: true, studentInstanceScope: { accessible: true, offeringId: 'offering', version: 8 },
    });
    expect(await resolveLegacyCourseAccess(claims, 'classroom', 'read', db)).toEqual({
      accessible: false, studentInstanceScope: { accessible: false, offeringId: 'offering', version: 8 },
    });
    expect(mocks.raw).toHaveBeenCalledTimes(3);
    for (const call of mocks.raw.mock.calls)
      expect(call.slice(1)).toEqual(['student', false, 7, true, 'classroom', 'classroom', 'classroom']);
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.enrollment).not.toHaveBeenCalled();
  });

  it('executes the null legacy fallback once without querying the same student scope again', async () => {
    mocks.raw.mockResolvedValue([]);
    expect(await resolveLegacyCourseAccess(claims, 'offering', 'read', db)).toEqual({ accessible: true });
    expect(mocks.raw).toHaveBeenCalledOnce();
    expect(mocks.user).toHaveBeenCalledOnce();
    expect(mocks.template).toHaveBeenCalledOnce();
    expect(mocks.offering).toHaveBeenCalledOnce();
    expect(mocks.enrollment).toHaveBeenCalledOnce();
  });
});
