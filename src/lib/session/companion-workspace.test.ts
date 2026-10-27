import { describe, expect, it } from "vitest";
import { applySessionAction, initialSessionState, type SessionState } from "./actions";
import type { CompanionConfirmation, CompanionProcessRecord, CompanionTask, Course } from "./types";
import { DEFAULT_STAGES } from "./types";

function makeCourse(overrides: Partial<Course> = {}): Course {
  return {
    id: "course-1",
    name: "测试课程",
    subject: "科学",
    grade: "六年级",
    hours: 8,
    summary: "",
    drivingQuestion: "如何让校园更节能？",
    status: "teaching",
    stages: DEFAULT_STAGES,
    currentStageIndex: 2,
    content: {
      pblOutline: "",
      knowledgePoints: [],
      lessonOutline: [],
      evaluationPlan: { dimensions: [], overallRubric: "" },
    },
    students: [{ id: "s1", name: "张三", joinedAt: "2026-07-01T00:00:00.000Z", stageProgress: {} }],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function stateWithCourse(course: Course): SessionState {
  return { ...initialSessionState(), hydrated: true, courses: [course] };
}

const task: CompanionTask = {
  id: "task-1",
  courseId: "course-1",
  studentId: "s1",
  stageKey: "proposal",
  companionId: "planner",
  kind: "planning",
  title: "拆解下一步",
  request: "把方案拆成一个现在可以完成的小动作",
  status: "assigned",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
};

const confirmation: CompanionConfirmation = {
  id: "confirm-1",
  courseId: "course-1",
  studentId: "s1",
  stageKey: "proposal",
  action: "adopt-draft",
  title: "采用方案草稿",
  summary: "将记记整理的草稿保存为个人方案",
  taskId: task.id,
  status: "pending",
  createdAt: "2026-07-01T00:00:00.000Z",
};

describe("companion workspace records", () => {
  it("normalizes new arrays for existing course objects", () => {
    const course = makeCourse();
    const next = applySessionAction(stateWithCourse(course), { type: "HYDRATE", payload: stateWithCourse(course) });
    expect(next.courses[0].companionTasks).toEqual([]);
    expect(next.courses[0].companionConfirmations).toEqual([]);
    expect(next.courses[0].companionProcessRecords).toEqual([]);
  });

  it("upserts tasks instead of duplicating a task id", () => {
    const course = makeCourse({ companionTasks: [task] });
    const next = applySessionAction(stateWithCourse(course), {
      type: "UPSERT_COMPANION_TASK",
      payload: { courseId: course.id, task: { ...task, status: "responding", updatedAt: "2026-07-01T00:01:00.000Z" } },
    });
    expect(next.courses[0].companionTasks).toHaveLength(1);
    expect(next.courses[0].companionTasks?.[0].status).toBe("responding");
  });

  it("resolves a confirmation without changing other confirmations", () => {
    const other = { ...confirmation, id: "confirm-2" };
    const course = makeCourse({ companionConfirmations: [confirmation, other] });
    const next = applySessionAction(stateWithCourse(course), {
      type: "RESOLVE_COMPANION_CONFIRMATION",
      payload: { courseId: course.id, confirmationId: confirmation.id, status: "confirmed", resolvedAt: "2026-07-01T00:02:00.000Z" },
    });
    expect(next.courses[0].companionConfirmations?.find((item) => item.id === confirmation.id)).toMatchObject({ status: "confirmed", resolvedAt: "2026-07-01T00:02:00.000Z" });
    expect(next.courses[0].companionConfirmations?.find((item) => item.id === other.id)?.status).toBe("pending");
  });

  it("keeps newest process records first and caps the log", () => {
    const first: CompanionProcessRecord = {
      id: "record-1", courseId: "course-1", studentId: "s1", stageKey: "proposal", title: "第一条", summary: "", source: "agent", createdAt: "2026-07-01T00:00:00.000Z",
    };
    const second = { ...first, id: "record-2", title: "第二条" };
    const course = makeCourse({ companionProcessRecords: [first] });
    const next = applySessionAction(stateWithCourse(course), { type: "ADD_COMPANION_PROCESS_RECORD", payload: { courseId: course.id, record: second } });
    expect(next.courses[0].companionProcessRecords?.map((item) => item.id)).toEqual(["record-2", "record-1"]);
  });
});
