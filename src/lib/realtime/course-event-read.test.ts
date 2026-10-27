import { beforeEach, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({ query: vi.fn(), findMany: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: mocks.query, domainEvent: { findMany: mocks.findMany } } }));
import { readCourseEvents } from './course-event-read';

beforeEach(() => { vi.resetAllMocks(); mocks.query.mockResolvedValue([]); mocks.findMany.mockResolvedValue([]); });

it('projects only delivery fields inside the canonical instance query and keeps hidden rows in pagination', async () => {
  const rows = [{ id: 'event', payload: { studentId: 'peer', scope: 'student' }, participation: null }];
  mocks.query.mockResolvedValue(rows);
  expect(await readCourseEvents({ classroomInstanceId: 'instance' }, null, 200)).toBe(rows);
  const query = mocks.query.mock.calls[0][0] as Prisma.Sql;
  expect(query.values).toEqual(['instance', 200]);
  expect(query.text).toContain('jsonb_build_object');
  expect(query.text).toContain("jsonb_typeof(d.payload -> 'courseVersion') = 'number'");
  expect(query.text).toContain("d.\"eventType\" = 'projection-changed'");
  expect(query.text).toContain("jsonb_typeof(d.payload -> 'projection') = 'object'");
  expect(query.text).toContain('LEFT JOIN "Enrollment"');
  expect(query.text).toContain('ORDER BY d."createdAt" ASC, d.id ASC');
  expect(query.text).not.toContain('d.*');
  expect(query.text).not.toContain('jsonb_strip_nulls');
  expect(mocks.findMany).not.toHaveBeenCalled();
});

it('binds the original timestamp/id seek and limit without interpolating scope values into SQL', async () => {
  const after = { createdAt: new Date('2026-10-17T00:00:00Z'), id: '11111111-1111-4111-8111-111111111111' };
  await readCourseEvents({ classroomInstanceId: "instance' OR TRUE --" }, after, 1);
  const query = mocks.query.mock.calls[0][0] as Prisma.Sql;
  expect(query.values).toEqual(["instance' OR TRUE --", after.createdAt, after.createdAt, after.id, 1]);
  expect(query.text).not.toContain("instance' OR");
  expect(query.text).toContain('d."createdAt" >');
  expect(query.text).toContain('d.id >');
});

it.each([
  { classroomInstanceId: null, payload: { path: ['templateId'], equals: 'template' } },
  { classroomInstanceId: 'instance', actorId: 'teacher' },
  { classroomInstanceId: { equals: 'instance' } },
])('retains every legacy or extended predicate in the narrow ORM fallback: %j', async where => {
  const after = { createdAt: new Date('2026-10-17T00:00:00Z'), id: 'cursor' };
  await readCourseEvents(where, after, 500);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(mocks.findMany).toHaveBeenCalledWith({
    where: { AND: [where, { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500,
    select: { id: true, createdAt: true, eventType: true, actorId: true, payload: true,
      participation: { select: { enrollment: { select: { userId: true } } } } },
  });
});

it('does not silently retry a failed projection with a full payload read', async () => {
  mocks.query.mockRejectedValue(new Error('database offline'));
  await expect(readCourseEvents({ classroomInstanceId: 'instance' }, null, 1)).rejects.toThrow('database offline');
  expect(mocks.findMany).not.toHaveBeenCalled();
});
