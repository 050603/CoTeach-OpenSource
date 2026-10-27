import { beforeEach, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
import type { Course } from "@/lib/session/types";
import type { ActionEnvelope } from "./contracts";
import { applySessionAction, type SessionState } from "@/lib/session/actions";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { createClassroomTimingState } from "@/lib/classroom/timing";
import { nextClassroomStageVersion } from "@/lib/classroom/stage-version";

const mocks = vi.hoisted(() => ({
  lock: vi.fn(), load: vi.fn(), mutate: vi.fn(), publish: vi.fn(), transaction: vi.fn(),
  tx: { $queryRaw: vi.fn(), domainEvent: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    classroomInstance: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/db/transaction-retry", () => ({ runMutationTransaction: (operation: (tx: typeof mocks.tx) => unknown) => mocks.transaction(operation) }));
vi.mock("@/lib/db/session-repository", () => ({ lockProjectedCourse: mocks.lock, loadCourse: mocks.load, mutateProjectedCourse: mocks.mutate }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: vi.fn(async () => true) }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
import { executeCourseAction } from "./action-service";

type ReceiptRow = { idempotencyKey: string; payload: { fingerprint: string; ack: unknown; requestedAction?: unknown; action: unknown } };
const claims: AuthClaims = { sub: "teacher-1", role: "teacher", username: "teacher", displayName: "教师", sv: 1 };
let course: Course;
let receipts: Map<string, ReceiptRow>;
let actors: Map<string, { userStatus: string; userRole: string; sessionVersion: number; isTeacher: boolean }>;
function command(requestId = "init-1", stageVersion = course.stageVersion ?? 1): ActionEnvelope {
  return { requestId, expectedVersion: 1, action: { type: "SET_UI_STATE", payload: { courseId: course.id, patch: {},
    intent: { type: "initialize-classroom-timing", baseStageVersion: stageVersion, stageKey: course.stages[course.currentStageIndex]!.key } } } };
}

beforeEach(() => {
  vi.resetAllMocks();
  receipts = new Map();
  actors = new Map(["teacher-1", "teacher-2"].map(id => [id, { userStatus: "ACTIVE", userRole: "TEACHER", sessionVersion: 1, isTeacher: true }]));
  course = createPblTemplateCourse("course");
  course.status = "teaching"; course.version = 31; course.stageVersion = 4; course.currentStageIndex = 0;
  course.uiState = { projectionVersion: 7, resourceProjection: null };
  course.students = Array.from({ length: 30 }, (_, i) => ({ id: "student-" + i, name: "学生" + i,
    joinedAt: "2026-10-17T00:00:00.000Z", stageProgress: { launch: i } }));
  // The service tests model serialized locked transactions. Native PG locking/
  // durability proof remains separate and must not be inferred from this mock.
  let queue = Promise.resolve<unknown>(undefined);
  mocks.transaction.mockImplementation((operation: (tx: typeof mocks.tx) => unknown) => {
    const next = queue.then(() => operation(mocks.tx)); queue = next.catch(() => undefined); return next;
  });
  mocks.tx.$queryRaw.mockImplementation((_sql: TemplateStringsArray, key: string, courseId: string, actor: string) => {
    const authorization = actors.get(actor);
    return Promise.resolve(courseId === course.id && authorization
      ? [{ offeringId: "offering", ...authorization, receipt: receipts.get(key)?.payload ?? null }] : []);
  });
  mocks.load.mockImplementation(async () => structuredClone(course));
  mocks.mutate.mockImplementation(async (_tx: unknown, action: ActionEnvelope["action"]) => {
    const state: SessionState = { courses: [course], hydrated: true, user: { role: "teacher", name: "教师" } };
    const next = applySessionAction(state, action).courses[0]!;
    course = { ...next, version: course.version! + 1, stageVersion: nextClassroomStageVersion(course, next) };
    return structuredClone(course);
  });
  mocks.tx.domainEvent.create.mockImplementation(async ({ data }: { data: ReceiptRow }) => {
    receipts.set(data.idempotencyKey, structuredClone(data)); return data;
  });
  mocks.tx.domainEvent.findUnique.mockImplementation(async ({ where }: { where: { idempotencyKey: string } }) => receipts.get(where.idempotencyKey) ?? null);
  mocks.tx.domainEvent.findFirst.mockImplementation(async () => [...receipts.values()].reverse().find(row =>
    (row.payload as unknown as { timingInitialization?: { outcome: string } }).timingInitialization?.outcome === "initialized") ?? null);
  mocks.tx.classroomInstance.findUnique.mockResolvedValue(null);
});

it("uses the fresh stage/plan after 30 student aggregate version changes and retains every student's progress", async () => {
  const input = command(); const before = structuredClone(course);
  const ack = await executeCourseAction(course.id, input, claims);
  expect(ack).toMatchObject({ requestId: input.requestId, courseVersion: 32, stageVersion: 5 });
  expect(course.students).toEqual(before.students);
  expect(course.uiState).toMatchObject({ projectionVersion: 7, resourceProjection: null, classroomTiming: {
    status: "running", activeStageKey: before.stages[0]!.key, schemaVersion: 1,
  } });
  expect(course.uiState!.classroomTiming!.stages.map(stage => stage.stageKey)).toEqual(before.stages.map(stage => stage.key));
  expect(input).toEqual(command("init-1", 4));
  expect(mocks.mutate).toHaveBeenCalledOnce();
  expect(receipts.get("course-action:teacher-1:init-1")?.payload.requestedAction).toEqual(input.action);
});

it("two teachers receive durable own receipts while only the first creates the timer/version", async () => {
  const [first, second] = await Promise.all([
    executeCourseAction(course.id, command("teacher-one"), claims),
    executeCourseAction(course.id, command("teacher-two"), { ...claims, sub: "teacher-2" }),
  ]);
  expect(first).toMatchObject({ requestId: "teacher-one", courseVersion: 32, stageVersion: 5 });
  expect(second).toMatchObject({ requestId: "teacher-two", courseVersion: 32, stageVersion: 5 });
  expect(first.eventCursor).not.toBe(second.eventCursor);
  expect(mocks.tx.domainEvent.findFirst).toHaveBeenCalledOnce();
  expect(mocks.mutate).toHaveBeenCalledOnce();
  expect(receipts.size).toBe(2);
  const timing = structuredClone(course.uiState!.classroomTiming);
  await executeCourseAction(course.id, command("third-noop"), claims);
  expect(course.version).toBe(32); expect(course.uiState!.classroomTiming).toEqual(timing);
  expect(mocks.mutate).toHaveBeenCalledOnce();
  expect(mocks.tx.domainEvent.findFirst).toHaveBeenCalledOnce();
});

it.each(["missing", "outcome", "intent", "ack-stage", "ack-course", "timer"] as const)(
  "rejects stale initialization when persisted proof is %s instead of trusting a one-step token gap", async invalid => {
    const original = command("first"); const waiting = command("second");
    await executeCourseAction(course.id, original, claims);
    const before = structuredClone(course);
    const proof = structuredClone(receipts.get("course-action:teacher-1:first")!.payload) as unknown as {
      timingInitialization: { outcome: string }; requestedAction: Extract<ActionEnvelope["action"], { type: "SET_UI_STATE" }>;
      ack: { stageVersion: number; courseVersion: number }; action: Extract<ActionEnvelope["action"], { type: "SET_UI_STATE" }>;
    };
    if (invalid === "outcome") proof.timingInitialization.outcome = "already-present";
    if (invalid === "intent") proof.requestedAction.payload.intent!.baseStageVersion = 3;
    if (invalid === "ack-stage") proof.ack.stageVersion = 4;
    if (invalid === "ack-course") proof.ack.courseVersion = 999;
    if (invalid === "timer") proof.action.payload.patch.classroomTiming!.status = "paused";
    mocks.tx.domainEvent.findFirst.mockResolvedValueOnce(invalid === "missing" ? null : { payload: proof });
    await expect(executeCourseAction(course.id, waiting, claims)).rejects.toMatchObject({ code: "CLASSROOM_STAGE_CONFLICT", status: 409 });
    expect(course).toEqual(before); expect(receipts.size).toBe(1); expect(mocks.mutate).toHaveBeenCalledOnce();
  },
);

it("compares persisted JSONB proof structurally and retains the ordinary stage/timing token protections", async () => {
  const first = command("first"); const waiting = command("waiting");
  await executeCourseAction(course.id, first, claims);
  const reverseKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(reverseKeys)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;
  mocks.tx.domainEvent.findFirst.mockResolvedValueOnce({ payload: reverseKeys(receipts.get("course-action:teacher-1:first")!.payload) });
  expect(await executeCourseAction(course.id, waiting, claims)).toMatchObject({ stageVersion: 5, courseVersion: 32 });
  const clock = structuredClone(course.uiState!.classroomTiming);
  const beforeChange = structuredClone(course);
  course.uiState!.classroomTiming = { ...clock!, status: "paused" };
  course.stageVersion = nextClassroomStageVersion(beforeChange, course);
  expect(course.stageVersion).toBe(6);
  const paused = structuredClone(course);
  await expect(executeCourseAction(course.id, command("after-pause", 4), claims)).rejects.toMatchObject({ code: "CLASSROOM_STAGE_CONFLICT", status: 409 });
  expect(course).toEqual(paused);
  const beforeLeave = structuredClone(course); course.currentStageIndex = 1;
  course.stageVersion = nextClassroomStageVersion(beforeLeave, course);
  const beforeReturn = structuredClone(course); course.currentStageIndex = 0;
  course.stageVersion = nextClassroomStageVersion(beforeReturn, course);
  expect(course.stageVersion).toBe(8);
  await expect(executeCourseAction(course.id, command("after-return", 4), claims)).rejects.toMatchObject({ code: "CLASSROOM_STAGE_CONFLICT", status: 409 });
  expect(receipts.size).toBe(2); expect(mocks.mutate).toHaveBeenCalledOnce();
});

it("replays the original raw intent receipt without rehashing its derived timer or rewriting a later paused clock", async () => {
  const input = command(); const original = structuredClone(input);
  const ack = await executeCourseAction(course.id, input, claims);
  course.uiState = { ...course.uiState, classroomTiming: { ...course.uiState!.classroomTiming!, status: "paused" } };
  course.version = 40; course.stageVersion = 5; course.currentStageIndex = 1;
  const later = structuredClone(course);
  expect(await executeCourseAction(course.id, original, claims)).toEqual(ack);
  expect(course).toEqual(later); expect(mocks.mutate).toHaveBeenCalledOnce(); expect(receipts.size).toBe(1);
});

it("rejects a reused request ID with a changed intent even if a timer already exists", async () => {
  await executeCourseAction(course.id, command(), claims);
  await expect(executeCourseAction(course.id, command("init-1", 99), claims))
    .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  expect(mocks.mutate).toHaveBeenCalledOnce(); expect(receipts.size).toBe(1);
});

it("stage guards also reject an existing-timer no-op and an uncommitted leave-and-return command", async () => {
  const stale = command("stale");
  await executeCourseAction(course.id, command(), claims);
  course.stageVersion = 6;
  const before = structuredClone(course);
  await expect(executeCourseAction(course.id, stale, claims)).rejects.toMatchObject({ code: "CLASSROOM_STAGE_CONFLICT", status: 409 });
  expect(course).toEqual(before); expect(receipts.size).toBe(1);
});

it.each(["sessionVersion", "isTeacher", "userStatus", "userRole"] as const)(
  "rejects a committed receipt after live %s is revoked at the course lock", async field => {
    const input = command();
    await executeCourseAction(course.id, input, claims);
    const previous = structuredClone(course);
    mocks.lock.mockImplementationOnce(() => {
      const actor = actors.get("teacher-1")!;
      if (field === "sessionVersion") actor.sessionVersion++;
      if (field === "isTeacher") actor.isTeacher = false;
      if (field === "userStatus") actor.userStatus = "DISABLED";
      if (field === "userRole") actor.userRole = "STUDENT";
    });
    await expect(executeCourseAction(course.id, input, claims)).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(course).toEqual(previous); expect(receipts.size).toBe(1);
  },
);

it("keeps ordinary teacher timer edits behind aggregate CAS", async () => {
  await expect(executeCourseAction(course.id, { requestId: "ordinary", expectedVersion: 1,
      action: { type: "SET_UI_STATE", payload: { courseId: course.id, patch: { classroomTiming: {
        ...createClassroomTimingState({ stages: course.stages, totalMinutes: 60,
          activeStageKey: course.stages[0]!.key, now: "2026-10-17T00:00:00.000Z" }), status: "paused",
      } } } } }, claims))
    .rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409, details: { currentVersion: 31 } });
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(receipts.size).toBe(0);
});

it("rejects students and a new initialization after classroom closure", async () => {
  await expect(executeCourseAction(course.id, command(), { sub: "student", role: "student", studentName: "学生", sv: 1 }))
    .rejects.toMatchObject({ code: "FORBIDDEN_ACTION", status: 403 });
  course.status = "finished";
  await expect(executeCourseAction(course.id, command(), claims)).rejects.toMatchObject({ code: "CLASSROOM_STAGE_CONFLICT", status: 409 });
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(receipts.size).toBe(0);
});

it("normalizes a missing stageVersion baseline to 1, advances it to 2 for initialization, then preserves the clock", async () => {
  course.stageVersion = undefined;
  const first = await executeCourseAction(course.id, command("legacy-init"), claims);
  const clock = structuredClone(course.uiState!.classroomTiming);
  expect(first).toMatchObject({ requestId: "legacy-init", stageVersion: 2, courseVersion: 32 });
  expect(await executeCourseAction(course.id, command("legacy-noop"), claims))
    .toMatchObject({ requestId: "legacy-noop", stageVersion: 2, courseVersion: 32 });
  expect(course.uiState!.classroomTiming).toEqual(clock);
  expect(mocks.mutate).toHaveBeenCalledOnce();
  expect(receipts.size).toBe(2);
});

it.each([0, 0.5])("does not treat invalid current stageVersion %s as the legacy default", async currentVersion => {
  course.stageVersion = currentVersion;
  await expect(executeCourseAction(course.id, command("invalid-current-stage", 1), claims))
    .rejects.toMatchObject({ code: "CLASSROOM_STAGE_CONFLICT", status: 409 });
  expect(mocks.mutate).not.toHaveBeenCalled(); expect(receipts.size).toBe(0);
});
