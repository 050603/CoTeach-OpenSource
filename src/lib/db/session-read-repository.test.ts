// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ instance: vi.fn(), template: vi.fn(), templates: vi.fn(), instances: vi.fn() }));
vi.mock('./client', () => ({ prisma: { classroomTemplate: { findMany: mocks.templates }, classroomInstance: { findMany: mocks.instances } } }));
vi.mock('./v2-course-projection', () => ({ loadInstanceCourse: mocks.instance }));
vi.mock('@/lib/platform/pbl-template-read', () => ({ loadPblTemplateCourse: mocks.template }));
import { loadCourse, loadSessionState, stateFor } from './session-read-repository';
import { prisma } from './client';
beforeEach(() => { vi.clearAllMocks(); mocks.instance.mockResolvedValue(undefined); mocks.template.mockResolvedValue(null); });
describe('read projection repository', () => {
  it('passes the same DB identity and private read scope, preferring canonical instances', async () => {
    const course = { id: 'instance' }; mocks.instance.mockResolvedValue(course);
    expect(await loadCourse('instance', prisma, { studentId: 'student' })).toBe(course);
    expect(mocks.instance).toHaveBeenCalledWith('instance', prisma, { studentId: 'student' });
    expect(mocks.template).not.toHaveBeenCalled();
  });
  it('preserves legacy fallback and missing-course undefined semantics', async () => {
    const template = { id: 'template' }; mocks.template.mockResolvedValueOnce(template);
    expect(await loadCourse('template')).toBe(template); expect(mocks.template).toHaveBeenCalledWith('template', prisma);
    expect(await loadCourse('missing')).toBeUndefined();
  });
  it('preserves teacher owner predicates, template-before-instance ordering and fresh updatedAt', async () => {
    mocks.templates.mockResolvedValue([{ id: 'template' }]); mocks.instances.mockResolvedValue([{ id: 'instance' }]);
    mocks.instance.mockImplementation(async (id: string) => id === 'instance' ? { id } : undefined);
    mocks.template.mockResolvedValue({ id: 'template' });
    const result = await loadSessionState('teacher'); expect(result.courses.map(c => c.id)).toEqual(['template', 'instance']);
    expect(mocks.templates).toHaveBeenCalledWith(expect.objectContaining({ where: { ownerId: 'teacher', status: { notIn: ['ARCHIVED', 'archived', 'DELETED', 'deleted'] } } }));
    expect(mocks.instances).toHaveBeenCalledWith(expect.objectContaining({ where: { activity: { chapter: { offering: { teachers: { some: { userId: 'teacher' } } } } } } }));
    expect(result.hydrated).toBe(true); expect(Number.isFinite(Date.parse(result.updatedAt!))).toBe(true);
    expect(stateFor([]).courses).toEqual([]);
  });
});
