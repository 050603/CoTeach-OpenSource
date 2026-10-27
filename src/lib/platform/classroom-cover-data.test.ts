import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({
  teacher: vi.fn(),
  instance: vi.fn(),
  owner: vi.fn(),
  participants: vi.fn(),
}));

vi.mock("./access", () => ({ requireTeacherUser: mocks.teacher }));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    classroomInstance: { findUnique: mocks.instance },
    courseTeacher: { findFirst: mocks.owner },
    classroomParticipation: { findMany: mocks.participants },
  },
}));

import { listClassroomParticipants } from "./classroom";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.teacher.mockResolvedValue({ id: "teacher" });
  mocks.owner.mockResolvedValue({ id: "link" });
  mocks.participants.mockResolvedValue([]);
  mocks.instance.mockResolvedValue({
    id: "instance",
    status: "FINISHED",
    activity: { title: "河流调查", chapter: { offeringId: "offering" } },
    templateVersion: {
      snapshot: {
        schemaVersion: 2,
        kind: "pbl-course",
        design: { coverImageUrl: "/classroom-cover.webp" },
      },
    },
  });
});

describe("teacher classroom record cover", () => {
  it("returns the immutable preparation cover with the classroom record", async () => {
    const result = await listClassroomParticipants(
      { sub: "teacher", role: "teacher" } as AuthClaims,
      "instance",
    );
    expect(result.instance).toMatchObject({
      id: "instance",
      coverImageUrl: "/classroom-cover.webp",
    });
  });

  it("summarizes people, submitted versions and teacher states without exposing full evaluation records", async () => {
    const now = new Date("2026-10-26T01:00:00Z");
    mocks.participants.mockResolvedValue([
      { id: "first", firstEnteredAt: now, lastEnteredAt: now, completedAt: null, stageProgress: {},
        enrollment: { user: { displayName: "小林", username: "lin" } }, workspace: { version: 2, updatedAt: now },
        submissions: [], artifacts: [{ versions: [{ status: "SUBMITTED", submittedAt: now }, { status: "SUBMITTED", submittedAt: now }, { status: "DRAFT", submittedAt: null }] }],
        evaluations: [{ evaluatorType: "TEACHER", type: "PBL_TEACHER", result: { status: "draft", answers: { comment: "私有草稿" } } }],
        _count: { artifacts: 1, reflections: 0, evaluations: 1 } },
      { id: "precreated", firstEnteredAt: null, lastEnteredAt: null, completedAt: now, stageProgress: {},
        enrollment: { user: { displayName: "小周", username: "zhou" } }, workspace: null,
        submissions: [], artifacts: [], evaluations: [], _count: { artifacts: 0, reflections: 0, evaluations: 0 } },
    ]);
    const result = await listClassroomParticipants({ sub: "teacher", role: "teacher" } as AuthClaims, "instance");
    expect(result.participants[0]).toMatchObject({ username: "lin", hasLearningEvidence: true, hasFinalOutput: true, submittedArtifactVersionCount: 2, evaluationSummary: { teacherStatus: "draft", pending: true, published: false } });
    expect(result.participants[0]).not.toHaveProperty("evaluations");
    expect(result.participants[0]).not.toHaveProperty("artifacts");
    expect(result.participants[1]).toMatchObject({ hasLearningEvidence: false, hasFinalOutput: false, submittedArtifactVersionCount: 0, evaluationSummary: { pending: false } });
    expect(mocks.participants).toHaveBeenCalledTimes(1);
    const query = mocks.participants.mock.calls[0][0];
    expect(query.select.enrollment.select.user.select.username).toBe(true);
    expect(query.select.artifacts.select.versions.select).toEqual({ status: true, submittedAt: true });
  });
});
