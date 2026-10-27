// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), access: vi.fn(), load: vi.fn(), latest: vi.fn(), studentScope: vi.fn(), scope: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("@/lib/courses/student-state-scope", () => ({ resolveStudentStateScope: mocks.studentScope }));
vi.mock("@/lib/realtime/course-event-scope", () => ({ resolveCourseEventScope: mocks.scope }));
vi.mock("@/lib/db/session-read-repository", () => ({ loadCourse: mocks.load }));
vi.mock("@/lib/db/client", () => ({ prisma: { domainEvent: { findFirst: mocks.latest } } }));
vi.mock("@/lib/observability/http", () => ({ withHttpMetrics: (_method: string, _route: string, fn: unknown) => fn }));
import { GET } from "./route";
const context = { params: Promise.resolve({ courseId: "course" }) };
const read = (etag?: string) => GET(new Request("http://localhost/api/courses/course/state", { headers: etag ? { "If-None-Match": etag } : {} }), context);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ claims: { role: "teacher", sub: "teacher" } });
  mocks.access.mockResolvedValue(true); mocks.latest.mockResolvedValue(null);
  mocks.studentScope.mockResolvedValue(null); mocks.scope.mockResolvedValue({ where: { classroomInstanceId: "course" } });
  mocks.load.mockResolvedValue({ id: "course", version: 1, stages: [], students: [], content: {}, companionTasks: [] });
});
describe("authorized classroom validators", () => {
  it("captures the event watermark before loading the canonical student snapshot", async () => {
    mocks.auth.mockResolvedValue({ claims: { role: "student", sub: "student" } });
    const id = "11111111-1111-4111-8111-111111111111";
    mocks.latest.mockResolvedValue({ id, createdAt: new Date("2026-09-08T00:00:00.000Z") });
    const response = await read();
    expect((await response.json()).eventCursor).toBe(`2026-09-08T00:00:00.000Z~${id}`);
    expect(mocks.latest.mock.invocationCallOrder[0]).toBeLessThan(mocks.load.mock.invocationCallOrder[0]);
    expect(mocks.load).toHaveBeenLastCalledWith("course", expect.anything(), { studentId: "student" });
  });
  it("retains a complete teacher snapshot without applying a student read scope", async () => {
    expect((await read()).status).toBe(200);
    expect(mocks.load).toHaveBeenLastCalledWith("course", expect.anything(), undefined);
  });
  it("reuses this request's authorized student scope and rejects denied membership without loading data", async () => {
    mocks.auth.mockResolvedValue({ claims: { role: "student", sub: "student" } });
    mocks.studentScope.mockResolvedValue({ accessible: true });
    expect((await read()).status).toBe(200);
    expect(mocks.access).not.toHaveBeenCalled(); expect(mocks.scope).not.toHaveBeenCalled();
    expect(mocks.latest).toHaveBeenCalledWith(expect.objectContaining({ where: { classroomInstanceId: "course" } }));
    mocks.load.mockClear(); mocks.latest.mockClear();
    mocks.studentScope.mockResolvedValue({ accessible: false });
    expect((await read()).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.latest).not.toHaveBeenCalled();
  });
  it("returns 304 for the same representation, including an unchanged cursor", async () => {
    const first = await read(); const etag = first.headers.get("ETag")!;
    expect(first.status).toBe(200); expect(etag).toMatch(/^W\/"[a-f0-9]{64}"$/);
    const again = await read(etag);
    expect(again.status).toBe(304); expect(await again.text()).toBe("");
    expect(mocks.access).toHaveBeenCalledTimes(2);
  });
  it("does not hide independently persisted changes behind an unchanged course version", async () => {
    const first = await read();
    mocks.load.mockResolvedValue({ id: "course", version: 1, stages: [], students: [], content: {}, companionTasks: [{ id: "new-task" }] });
    const changed = await read(first.headers.get("ETag")!);
    expect(changed.status).toBe(200);
    expect((await changed.json()).course.companionTasks).toEqual([{ id: "new-task" }]);
    expect(changed.headers.get("ETag")).not.toBe(first.headers.get("ETag"));
  });
  it("rechecks current access before considering a validator", async () => {
    const first = await read(); mocks.access.mockResolvedValue(false);
    expect((await read(first.headers.get("ETag")!)).status).toBe(403);
    expect(mocks.load).toHaveBeenCalledOnce();
  });
});
