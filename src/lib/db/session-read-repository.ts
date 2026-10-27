// Read projection boundary shared by HTTP and the optional read-only worker.
import type { Prisma } from "@prisma/client";
import { prisma } from "./client";
import { loadInstanceCourse, type CourseReadScope } from "./v2-course-projection";
import { loadPblTemplateCourse } from "@/lib/platform/pbl-template-read";
import { initialSessionState, type SessionState } from "@/lib/session/actions";
import type { Course } from "@/lib/session/types";

export async function loadCourse(courseId: string, db: Prisma.TransactionClient = prisma, readScope?: CourseReadScope): Promise<Course | undefined> { return await loadInstanceCourse(courseId, db, readScope) ?? await loadPblTemplateCourse(courseId, db) ?? undefined; }
export function stateFor(courses: Course[]): SessionState { return { ...initialSessionState(), courses, hydrated: true, updatedAt: new Date().toISOString() }; }
export async function loadSessionState(ownerId?: string): Promise<SessionState> {
  const [templates, instances] = await Promise.all([
    prisma.classroomTemplate.findMany({ where: { ...(ownerId ? { ownerId } : {}), status: { notIn: ["ARCHIVED", "archived", "DELETED", "deleted"] } }, select: { id: true } }),
    prisma.classroomInstance.findMany({ where: ownerId ? { activity: { chapter: { offering: { teachers: { some: { userId: ownerId } } } } } } : {}, select: { id: true } }),
  ]);
  const courses = await Promise.all([...templates, ...instances].map(t => loadCourse(t.id)));
  return stateFor(courses.filter((c): c is Course => Boolean(c)));
}
