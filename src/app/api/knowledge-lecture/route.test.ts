import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Course, KnowledgeLectureAttempt } from "@/lib/session/types";
import type { PersistedClassroomData } from "@openmaic/lib/server/classroom-storage";
import { callLLM } from "@openmaic/lib/ai/llm";
import { getKnowledgeLectureTutorSettings } from "@/lib/knowledge-lecture-settings";
import { resolveModel, resolveModelFromRequest } from "@openmaic/lib/server/resolve-model";
import { updateCourse } from "@/lib/session/server-store";
import { readClassroom } from "@openmaic/lib/server/classroom-storage";
import { appendDurableAiInteractionEvents } from "@/lib/ai-collaboration/audit-outbox";

const store = vi.hoisted(() => ({
  course: null as Course | null,
  classroom: null as PersistedClassroomData | null,
  authConfigured: false,
  durable: false,
  claimTutor: vi.fn(),
  persistAttempt: vi.fn(),
  finishTutor: vi.fn(),
  failTutor: vi.fn(),
  authenticate: vi.fn(),
  scope: vi.fn(),
  access: vi.fn(),
  readExplanation: vi.fn(),
  claims: null as { role: string; sub: string } | null,
}));
vi.mock("@/lib/ai-collaboration/audit-outbox", () => ({ appendDurableAiInteractionEvents: vi.fn(async () => {}) }));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: () => store.durable, prisma: {} }));
vi.mock("@/lib/courses/knowledge-lecture-attempts", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/courses/knowledge-lecture-attempts")>(), persistKnowledgeLectureAttempt: store.persistAttempt, loadKnowledgeLectureContext: async () => store.course }));
vi.mock("@/lib/courses/knowledge-tutor-requests", () => ({ claimTutorRequest: store.claimTutor, finishTutorRequest: store.finishTutor, failTutorRequest: store.failTutor }));
vi.mock("@/lib/auth/request-guards", () => ({ requireSameOrigin: () => null, authenticateRequest: store.authenticate }));
vi.mock("@/lib/courses/student-state-scope", () => ({ resolveStudentStateScope: store.scope }));
vi.mock("@/lib/auth/session", () => ({
  isAuthConfigured: () => store.authConfigured,
  readAuthFromRequest: vi.fn(async () => store.claims),
}));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: store.access }));
vi.mock("@/lib/session/server-store", () => ({
  getCourse: vi.fn(async () => store.course),
  updateCourse: vi.fn(async (_courseId: string, updater: (course: Course) => Course) => {
    store.course = updater(store.course!);
    return { courses: [store.course] };
  }),
}));
vi.mock("@openmaic/lib/server/classroom-storage", () => ({ readClassroom: vi.fn(async () => store.classroom) }));
vi.mock("@/lib/knowledge-lecture-settings", () => ({ getKnowledgeLectureTutorSettings: vi.fn() }));
vi.mock("@openmaic/lib/ai/llm", () => ({ callLLM: vi.fn() }));
vi.mock("@openmaic/lib/server/resolve-model", () => ({ resolveModel: vi.fn(), resolveModelFromRequest: vi.fn() }));
vi.mock("@/lib/courses/knowledge-explanations", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/courses/knowledge-explanations")>(), readPreparedExplanation: store.readExplanation,
}));
import { POST } from "./route";

function request(answers: Record<string, string | string[]>, extra: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/knowledge-lecture", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ action: "record-attempt", courseId: "course-1", studentId: "student-1",
      sectionId: "section-1", quizOutlineId: "quiz-1", runtimeSceneId: "runtime-quiz-1", answers, ...extra }),
  });
}
const attempts = () => store.course?.aiLearningProgress?.["student-1"]?.knowledgeLectureAttempts ?? [];

describe("knowledge lecture server-authoritative grading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readClassroom).mockImplementation(async () => store.classroom);
    store.authConfigured = false;
    store.durable = false;
    store.readExplanation.mockResolvedValue(null);
    store.claims = null;
    store.authenticate.mockImplementation(async () => store.claims ? { claims: { ...store.claims, sv: 1 } } : { response: Response.json({ code: "UNAUTHORIZED" }, { status: 401 }) });
    store.scope.mockResolvedValue({ accessible: true });
    store.access.mockResolvedValue(true);
    vi.mocked(resolveModel).mockResolvedValue({ model: {}, modelString: "test/model", thinkingConfig: undefined } as never);
    vi.mocked(resolveModelFromRequest).mockResolvedValue({ model: {}, thinkingConfig: undefined } as never);
    vi.mocked(getKnowledgeLectureTutorSettings).mockResolvedValue({ modelString: "" } as never);
    vi.mocked(callLLM).mockResolvedValue({ text: '{"score":5,"comment":"理解了核心概念"}' } as never);
    store.course = {
      id: "course-1", status: "teaching", students: [{ id: "student-1" }], aiLearningClassroomId: "classroom-1",
      content: { knowledgePoints: [{ id: "kp-1", name: "变量关系" }],
        knowledgeLectureSections: [{ id: "section-1", quizOutlineId: "quiz-1", knowledgePointIds: ["kp-1"] }],
        teachingBlueprint: { sections: [{ id: "section-1", units: [{ id: "unit-1" }] }] } },
      aiLearningProgress: {},
    } as Course;
    store.classroom = {
      id: "classroom-1", stage: { id: "classroom-1" }, createdAt: "2026-01-01T00:00:00.000Z",
      scenes: [{ id: "runtime-quiz-1", outlineId: "quiz-1", lectureSectionId: "section-1",
        content: { type: "quiz", questions: [
          { id: "choice-1", type: "single", question: "选哪个？", answer: ["A"], points: 4,
            options: [{ value: "A", label: "变量增加" }, { value: "B", label: "变量减少" }],
            knowledgePointIds: ["kp-1"], teachingUnitIds: ["unit-1", "foreign-unit"] },
          { id: "short-1", type: "short_answer", question: "解释原因", points: 6,
            commentPrompt: "说明变量关系", knowledgePointIds: ["kp-1"] },
        ] } }],
    } as PersistedClassroomData;
  });

  it("uses the narrow service for durable quiz submissions without updating a complete Course", async () => {
    store.durable = true;
    store.persistAttempt.mockImplementation(async (input) => input.attempt);
    const response = await POST(request({ "choice-1": "A", "short-1": "" }));
    expect(response.status).toBe(200);
    expect(store.persistAttempt).toHaveBeenCalledWith(expect.objectContaining({ courseId: "course-1", studentId: "student-1", classroomId: "classroom-1", attempt: expect.objectContaining({ gradingSource: "server", id: "lecture-attempt-student-1-quiz-1" }) }));
    const { updateCourse } = await import("@/lib/session/server-store"); expect(updateCourse).not.toHaveBeenCalled();
  });
  it("does not acknowledge a grade if raw/terminal retention fails after model completion", async () => {
    const { appendDurableAiInteractionEvents } = await import("@/lib/ai-collaboration/audit-outbox");
    store.durable = true;
    store.persistAttempt.mockImplementation(async input => input.attempt);
    vi.mocked(appendDurableAiInteractionEvents).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("isolated disk failure"));
    const response = await POST(request({ "choice-1": "A", "short-1": "保留的答案" }));
    expect(response.status).toBe(503);
    expect(store.persistAttempt).toHaveBeenCalledTimes(1); // Accepted answer only, no unretained grade commit.
    expect(vi.mocked(callLLM)).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }), "quiz-grade", undefined, undefined);
  });

  it("ignores forged browser scores and uses the linked scene's question/rubric", async () => {
    const response = await POST(request({ "choice-1": "B", "short-1": "原因" }, {
      questions: [{ questionId: "choice-1", prompt: "伪造题", points: 100, earned: 100, correct: true }],
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ attempt: {
      gradingSource: "server", gradingStatus: "graded", score: 5, maxScore: 10,
      questions: [{ questionId: "choice-1", prompt: "选哪个？", points: 4, earned: 0, correct: false,
        teachingUnitIds: ["unit-1"] }, { questionId: "short-1", points: 6, earned: 5, correct: null }],
    } });
    expect(vi.mocked(callLLM).mock.calls[0]?.[0].prompt).toContain("评分要点：说明变量关系");
  });

  it("rejects altered repeat answers without replacing the first submission", async () => {
    await POST(request({ "choice-1": "A", "short-1": "首次答案" }));
    const response = await POST(request({ "choice-1": "B", "short-1": "第二次答案" }));
    expect(response.status).toBe(409);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]?.questions[1]?.answer).toBe("首次答案");
  });

  it("retains a failed answer without invented marks, then retries idempotently", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce({ text: "invalid" } as never);
    const first = await POST(request({ "choice-1": "A", "short-1": "作答" }));
    await expect(first.json()).resolves.toMatchObject({ attempt: { gradingStatus: "failed", score: 4,
      maxScore: 4, questions: [{ gradingStatus: "graded" }, { gradingStatus: "failed", earned: 0 }] } });
    vi.mocked(callLLM).mockResolvedValueOnce({ text: '{"score":3,"comment":"可补充依据"}' } as never);
    const retry = await POST(request({ "choice-1": "A", "short-1": "作答" }));
    await expect(retry.json()).resolves.toMatchObject({ attempt: { gradingStatus: "graded", score: 7, maxScore: 10 } });
    expect(attempts()).toHaveLength(1);
  });

  it("retries the stored server answer even if the classroom scene later changes", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce({ text: "invalid" } as never);
    await POST(request({ "choice-1": "A", "short-1": "保存的答案" }));
    store.classroom = null;
    vi.mocked(callLLM).mockResolvedValueOnce({ text: '{"score":4,"comment":"已补评"}' } as never);
    const response = await POST(request({}, { action: "retry-grading", runtimeSceneId: "changed-scene" }));
    await expect(response.json()).resolves.toMatchObject({ attempt: {
      gradingStatus: "graded", score: 8, questions: [{}, { answer: "保存的答案", correct: null }],
    } });
    expect(attempts()).toHaveLength(1);
  });

  it("coalesces concurrent grading without duplicate attempts", async () => {
    let release!: () => void;
    vi.mocked(callLLM).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ text: '{"score":2,"comment":"部分正确"}' } as never);
    }));
    const first = POST(request({ "choice-1": "A", "short-1": "并发答案" }));
    const second = POST(request({ "choice-1": "A", "short-1": "并发答案" }));
    await vi.waitFor(() => expect(vi.mocked(callLLM)).toHaveBeenCalledTimes(1));
    release();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]?.score).toBe(6);
  });

  it("finishes grading already accepted before classroom closure", async () => {
    store.durable = true;
    store.persistAttempt.mockImplementation(async input => input.attempt);
    let release!: () => void;
    vi.mocked(callLLM).mockImplementationOnce(() => new Promise(resolve => {
      release = () => resolve({ text: '{"score":2,"comment":"部分正确"}' } as never);
    }));
    const pending = POST(request({ "choice-1": "A", "short-1": "结课前已受理的答案" }));
    await vi.waitFor(() => expect(callLLM).toHaveBeenCalledTimes(1));
    store.course!.status = "finished";
    release();
    expect((await pending).status).toBe(200);
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(store.persistAttempt).toHaveBeenCalledTimes(2);
    expect(store.persistAttempt).toHaveBeenLastCalledWith(expect.objectContaining({
      courseId: "course-1", studentId: "student-1",
    }), expect.any(Map));
  });

  it("retains more than forty earlier quiz records", async () => {
    await POST(request({ "choice-1": "A", "short-1": "第一次" }));
    const first = attempts()[0]!;
    store.course!.aiLearningProgress!["student-1"].knowledgeLectureAttempts = Array.from({ length: 45 }, (_, index) => ({
      ...first, id: `old-${index}`, quizOutlineId: `old-quiz-${index}`,
    }));
    expect((await POST(request({ "choice-1": "A", "short-1": "新一轮" }))).status).toBe(200);
    expect(attempts()).toHaveLength(46);
  });

  it("rejects a scene outside the course-linked quiz", async () => {
    expect((await POST(request({ "choice-1": "A", "short-1": "作答" }, { runtimeSceneId: "foreign-scene" }))).status).toBe(404);
    expect(attempts()).toHaveLength(0);
  });

  it("requires the submitting student's identity even when a teacher can read the course", async () => {
    store.authConfigured = true;
    store.claims = { role: "teacher", sub: "teacher-1" };
    expect((await POST(request({ "choice-1": "A", "short-1": "作答" }))).status).toBe(403);
    store.claims = { role: "student", sub: "another-student" };
    expect((await POST(request({ "choice-1": "A", "short-1": "作答" }))).status).toBe(403);
    expect(attempts()).toHaveLength(0);
  });

  it("rejects a revoked session before new submission or accepted-answer replay", async () => {
    store.authConfigured = true; store.durable = true;
    store.claims = { role: "student", sub: "student-1" };
    store.persistAttempt.mockImplementation(async input => input.attempt);
    const answers = { "choice-1": "A", "short-1": "" };
    expect((await POST(request(answers))).status).toBe(200);
    expect(store.persistAttempt).toHaveBeenCalledWith(expect.objectContaining({ sessionVersion: 1 }));
    store.authenticate.mockResolvedValue({ response: Response.json({ code: "UNAUTHORIZED" }, { status: 401 }) });
    expect((await POST(request(answers))).status).toBe(401);
    expect((await POST(request(answers, { quizOutlineId: "new-quiz" }))).status).toBe(401);
    expect(store.persistAttempt).toHaveBeenCalledTimes(1);
    expect(store.scope).toHaveBeenCalledTimes(1);
  });

  it("uses narrow instance authorization, falls back only for null namespaces and never overrides a denial", async () => {
    store.authConfigured = true; store.durable = true; store.claims = { role: "student", sub: "student-1" };
    store.persistAttempt.mockImplementation(async input => input.attempt);
    const answers = { "choice-1": "A", "short-1": "" };
    expect((await POST(request(answers))).status).toBe(200);
    expect(store.scope).toHaveBeenCalledWith(expect.anything(), "course-1", "student-1");
    expect(store.access).not.toHaveBeenCalled();
    store.scope.mockResolvedValue({ accessible: false });
    expect((await POST(request(answers))).status).toBe(403);
    expect(store.access).not.toHaveBeenCalled();
    store.scope.mockResolvedValue(null);
    expect((await POST(request(answers))).status).toBe(200);
    expect(store.access).toHaveBeenCalledWith(expect.objectContaining({ sub: "student-1" }), "course-1", "read");
  });

  it("allows an authorized teacher to retry accepted grading without submitting a student's answer", async () => {
    await POST(request({ "choice-1": "A", "short-1": "" }));
    store.authConfigured = true; store.claims = { role: "teacher", sub: "teacher-1" };
    expect((await POST(request({}, { action: "retry-grading" }))).status).toBe(200);
    expect(store.authenticate).toHaveBeenCalledWith(expect.anything(), undefined);
    expect(store.scope).not.toHaveBeenCalled();
    expect(store.access).toHaveBeenCalledWith(expect.objectContaining({ role: "teacher" }), "course-1", "read");
    expect((await POST(request({ "choice-1": "A", "short-1": "" }))).status).toBe(403);
  });

  it("keeps source choices for tutoring", async () => {
    const response = await POST(request({ "choice-1": "B", "short-1": "因为" }));
    const payload = await response.json() as { attempt: KnowledgeLectureAttempt };
    vi.mocked(callLLM).mockResolvedValue({ text: '{"answer":"请对照选项判断","boardNotes":[]}' } as never);
    const tutorResponse = await POST(new NextRequest("http://localhost/api/knowledge-lecture", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ action: "tutor-message", message: "请说明这两个选项", courseId: "course-1", studentId: "student-1",
        attemptId: payload.attempt.id, questionId: "choice-1" }),
    }));
    expect(tutorResponse.status).toBe(200);
    expect(vi.mocked(callLLM).mock.calls.at(-1)?.[0].prompt).toContain("选项：\nA. 变量增加\nB. 变量减少");
  });
  it("replays a durable tutor receipt without another AI call", async () => {
    const response = await POST(request({ "choice-1": "B", "short-1": "因为" }));
    const { attempt } = await response.json() as { attempt: KnowledgeLectureAttempt };
    store.durable = true;
    const thread = { id: "existing-thread", messages: [] };
    store.claimTutor.mockResolvedValue({ run: false, status: "COMPLETED", thread });
    vi.mocked(callLLM).mockClear();
    const tutor = await POST(request({}, { action: "tutor-message", attemptId: attempt.id, questionId: "choice-1", message: "为什么", requestId: "stable-request" }));
    expect(tutor.status).toBe(200);
    expect(await tutor.json()).toEqual({ thread, resultSource: "personalized" });
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("preserves both notes and raw evidence when repairing the observed extra JSON close", async () => {
    const response = await POST(request({ "choice-1": "B", "short-1": "因为" }));
    const { attempt } = await response.json() as { attempt: KnowledgeLectureAttempt };
    store.durable = true;
    store.claimTutor.mockResolvedValue({ run: true, token: "token" });
    store.finishTutor.mockImplementation(async (_input, _token, thread) => thread);
    const raw = '{"answer":"相同观察时长才能公平比较。"},"boardNotes":[{"title":"公平比较","body":"保持时长相同","kind":"concept"}]}';
    vi.mocked(callLLM).mockClear();
    vi.mocked(callLLM).mockResolvedValue({ text: raw } as never);
    const result = await POST(request({}, { action: "tutor-message", attemptId: attempt.id, questionId: "choice-1", message: "为什么", requestId: "repair-request" }));
    expect(result.status).toBe(200);
    const { thread } = await result.json();
    expect(thread.messages.at(-1).content).toBe("相同观察时长才能公平比较。");
    expect(thread.boardNotes).toEqual([expect.objectContaining({ title: "公平比较", body: "保持时长相同" })]);
    expect(store.finishTutor.mock.calls.at(-1)?.slice(3)).toEqual([raw, "personalized", "removed-extra-object-close-before-board-notes"]);
    expect(callLLM).toHaveBeenCalledOnce();
  });

  it("returns answers beyond 3000 characters and passes exact raw JSON to durable storage", async () => {
    const response = await POST(request({ "choice-1": "B", "short-1": "因为" }));
    const { attempt } = await response.json() as { attempt: KnowledgeLectureAttempt };
    store.durable = true;
    store.claimTutor.mockResolvedValue({ run: true, token: "token" });
    store.finishTutor.mockImplementation(async (_input, _token, thread) => thread);
    const answer = "  完整回答".repeat(700) + "\n";
    const raw = "\n " + JSON.stringify({ answer, boardNotes: [{ title: "重要依据", body: "完整板书".repeat(300) }] }) + " ";
    vi.mocked(callLLM).mockResolvedValue({ text: raw } as never);
    const message = " " + "问".repeat(998) + " ";
    const args = { action: "tutor-message", attemptId: attempt.id, questionId: "choice-1", message, requestId: "long-stable-request" };
    const tutor = await POST(request({}, args));
    expect(tutor.status).toBe(200);
    const { thread } = await tutor.json();
    expect(thread.messages[0].content).toBe(message);
    expect(thread.messages[1].content).toBe(answer);
    expect(thread.boardNotes[0].body).toHaveLength(500);
    expect(store.claimTutor).toHaveBeenCalledWith(expect.objectContaining({ message }));
    expect(store.finishTutor.mock.calls.at(-1)?.[3]).toBe(raw);
    store.claimTutor.mockResolvedValue({ run: false, status: "COMPLETED", thread });
    vi.mocked(callLLM).mockClear();
    expect(await (await POST(request({}, args))).json()).toEqual({ thread, resultSource: "personalized" });
    expect(callLLM).not.toHaveBeenCalled();
  });
  it.each(["问".repeat(1001), " ".repeat(1000) + "问"])("rejects oversized input instead of silently truncating it", async (message) => {
    const response = await POST(request({ "choice-1": "B", "short-1": "因为" }));
    const { attempt } = await response.json() as { attempt: KnowledgeLectureAttempt };
    store.durable = true;
    vi.mocked(callLLM).mockClear();
    const tutor = await POST(request({}, { action: "tutor-message", attemptId: attempt.id, questionId: "choice-1", message, requestId: "oversize" }));
    expect(tutor.status).toBe(400);
    expect(await tutor.json()).toMatchObject({ error: "TUTOR_MESSAGE_TOO_LONG", maxLength: 1000 });
    expect(store.claimTutor).not.toHaveBeenCalled();
    expect(callLLM).not.toHaveBeenCalled();
  });


  it("reads the original explanation by submission fingerprint after a teacher edits the current question", async () => {
    const { attempt } = await (await POST(request({ "choice-1": "A", "short-1": "" }))).json();
    const explanation = { id: "prepared", questionFingerprint: attempt.questions[0].authoredQuestionFingerprint,
      text: "A正确，B不正确。", boardNotes: [], source: "prepared" };
    store.readExplanation.mockResolvedValue(explanation);
    vi.mocked(callLLM).mockClear();
    const args = { action: "tutor-explain", attemptId: attempt.id, questionId: "choice-1" };
    expect(await (await POST(request({}, args))).json()).toMatchObject({ resultSource: "shared", explanation });
    const scene = store.classroom!.scenes[0];
    if (scene.content.type !== "quiz") throw new Error("fixture");
    scene.content.questions[0].answer = ["B"];
    expect(await (await POST(request({}, args))).json()).toMatchObject({ resultSource: "shared", explanation });
    expect(callLLM).not.toHaveBeenCalled();
    expect(store.claimTutor).not.toHaveBeenCalled();
  });

  it("serves 30 simultaneous initial reads and missing resources without AI tasks, model resolution or personalized feedback", async () => {
    const { attempt } = await (await POST(request({ "choice-1": "B", "short-1": "" }))).json();
    const question = attempts()[0].questions[0]; question.authoredAnalysis = "共同原题解析";
    question.feedback = "针对这个学生的批阅意见";
    store.durable = true; vi.mocked(callLLM).mockClear(); vi.mocked(resolveModel).mockClear();
    const args = { action: "tutor-explain", attemptId: attempt.id, questionId: "choice-1" };
    const replies = await Promise.all(Array.from({ length: 30 }, async () => (await POST(request({}, args))).json()));
    expect(replies.every(reply => reply.explanation.text === "共同原题解析" && reply.explanation.source === "reference")).toBe(true);
    expect(callLLM).not.toHaveBeenCalled(); expect(resolveModel).not.toHaveBeenCalled(); expect(store.claimTutor).not.toHaveBeenCalled();
    const { updateCourse } = await import("@/lib/session/server-store");
    vi.mocked(updateCourse).mockClear();
    await POST(request({}, args)); expect(updateCourse).not.toHaveBeenCalled();
  });

  it("records fill_blank format and serves its common explanation while retaining existing grading", async () => {
    const scene = store.classroom!.scenes[0];
    if (scene.content.type !== "quiz") throw new Error("fixture");
    Object.assign(scene.content.questions[1], { format: "fill_blank", referenceAnswer: "同化", analysis: "用原框架解释新信息。" });
    const { attempt } = await (await POST(request({ "choice-1": "B", "short-1": "同化" }))).json();
    expect(attempt.questions[1]).toMatchObject({ questionFormat: "fill_blank", authoredAnalysis: "用原框架解释新信息。" });
    vi.mocked(callLLM).mockClear();
    const response = await POST(request({}, { action: "tutor-explain", attemptId: attempt.id, questionId: "short-1" }));
    expect(await response.json()).toMatchObject({ explanation: { source: "reference", text: "用原框架解释新信息。\n\n同化" } });
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("supplies common lecture context only when the student actively follows up", async () => {
    const { attempt } = await (await POST(request({ "choice-1": "B", "short-1": "" }))).json();
    store.readExplanation.mockResolvedValue({ text: "A符合题意，B混淆方向。" });
    vi.mocked(callLLM).mockClear(); vi.mocked(callLLM).mockResolvedValue({ text: '{"answer":"你选择B，方向判断需要调整。","boardNotes":[]}' } as never);
    const response = await POST(request({}, { action: "tutor-message", attemptId: attempt.id, questionId: "choice-1", message: "为什么B不对" }));
    expect(response.status).toBe(200); expect(callLLM).toHaveBeenCalledOnce();
    expect(vi.mocked(callLLM).mock.calls[0][0].prompt).toContain("统一讲解：A符合题意，B混淆方向。");
    expect(vi.mocked(callLLM).mock.calls[0][0].prompt).toContain("学生答案：B");
  });

  it("recognizes old fill blanks without format and uses the saved reference after source edits", async () => {
    const scene = store.classroom!.scenes[0];
    if (scene.content.type !== "quiz") throw new Error("fixture");
    Object.assign(scene.content.questions[1], { format: "fill_blank", referenceAnswer: "同化", analysis: "原框架未变。" });
    const { attempt } = await (await POST(request({ "choice-1": "A", "short-1": "同化" }))).json();
    const question = attempts()[0].questions[1];
    delete question.questionFormat; delete question.authoredAnalysis;
    vi.mocked(callLLM).mockClear();
    const args = { action: "tutor-explain", attemptId: attempt.id, questionId: "short-1" };
    expect(await (await POST(request({}, args))).json()).toMatchObject({ explanation: { text: "原框架未变。\n\n同化" } });
    scene.content.questions[1].referenceAnswer = "已修改的新答案";
    expect(await (await POST(request({}, args))).json()).toMatchObject({ explanation: { text: "同化", source: "reference" } });
    expect(callLLM).not.toHaveBeenCalled(); expect(store.claimTutor).not.toHaveBeenCalled();
  });

  it("keeps initial generation for a verified deep question and then reuses its thread", async () => {
    const { attempt } = await (await POST(request({ "choice-1": "A", "short-1": "理由" }))).json();
    vi.mocked(callLLM).mockClear(); vi.mocked(callLLM).mockResolvedValue({ text: '{"answer":"根据你的理由继续分析。","boardNotes":[]}' } as never);
    const args = { action: "tutor-explain", attemptId: attempt.id, questionId: "short-1" };
    expect(await (await POST(request({}, args))).json()).toMatchObject({ thread: { questionId: "short-1" }, resultSource: "personalized" });
    expect(callLLM).toHaveBeenCalledOnce();
    await POST(request({}, args)); expect(callLLM).toHaveBeenCalledOnce();
  });

  it("retains malformed tutor output as a failure instead of completing a generic explanation", async () => {
    const { attempt } = await (await POST(request({ "choice-1": "A", "short-1": "" }))).json();
    store.durable = true;
    store.claimTutor.mockResolvedValue({ run: true, token: "token" });
    vi.mocked(callLLM).mockResolvedValue({ text: "broken-json" } as never);
    const response = await POST(request({}, { action: "tutor-message", attemptId: attempt.id, questionId: "choice-1", message: "为什么", requestId: "invalid" }));
    expect(response.status).toBe(503);
    expect(store.finishTutor).not.toHaveBeenCalled();
    expect(store.failTutor).toHaveBeenCalledWith(expect.anything(), "token", false, "broken-json", "TUTOR_INVALID_OUTPUT");
  });
  it("requires a stable request id before starting durable tutoring", async () => {
    const response = await POST(request({ "choice-1": "B", "short-1": "因为" }));
    const { attempt } = await response.json() as { attempt: KnowledgeLectureAttempt };
    store.durable = true;
    const tutor = await POST(request({}, { action: "tutor-message", attemptId: attempt.id, questionId: "choice-1", message: "为什么" }));
    expect(tutor.status).toBe(400);
    expect(store.claimTutor).not.toHaveBeenCalled();
  });

  describe("finished classroom explanation review", () => {
    function finishClassroom() {
      store.course!.status = "finished";
      store.authConfigured = true;
      store.durable = true;
      store.claims = { role: "student", sub: "student-1" };
      vi.clearAllMocks();
    }
    function expectReadOnly(before: string) {
      expect(JSON.stringify(store.course)).toBe(before);
      expect(store.persistAttempt).not.toHaveBeenCalled();
      expect(updateCourse).not.toHaveBeenCalled();
      expect(store.claimTutor).not.toHaveBeenCalled();
      expect(store.finishTutor).not.toHaveBeenCalled();
      expect(store.failTutor).not.toHaveBeenCalled();
      expect(callLLM).not.toHaveBeenCalled();
      expect(resolveModel).not.toHaveBeenCalled();
      expect(resolveModelFromRequest).not.toHaveBeenCalled();
      expect(getKnowledgeLectureTutorSettings).not.toHaveBeenCalled();
      expect(appendDurableAiInteractionEvents).not.toHaveBeenCalled();
    }

    it.each([
      { action: "retry-grading", role: "student", sub: "student-1" },
      { action: "retry-grading", role: "teacher", sub: "teacher-1" },
      { action: "record-attempt", role: "student", sub: "student-1" },
    ])("rejects $role $action after closure without restarting a failed grade", async ({ action, role, sub }) => {
      const answers = { "choice-1": "A", "short-1": "当时保存的答案" };
      vi.mocked(callLLM).mockResolvedValueOnce({ text: "invalid" } as never);
      const { attempt } = await (await POST(request(answers))).json();
      expect(attempt.gradingStatus).toBe("failed");
      finishClassroom();
      store.claims = { role, sub };
      store.persistAttempt.mockResolvedValue(attempt);
      const before = JSON.stringify(store.course);
      const response = await POST(request(answers, { action }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "CLASSROOM_READ_ONLY" });
      expectReadOnly(before);
    });

    it("reads the student's prepared explanation by original answer fingerprint without changing records", async () => {
      const { attempt } = await (await POST(request({ "choice-1": "B", "short-1": "" }))).json();
      finishClassroom();
      const explanation = { id: "prepared", questionFingerprint: attempt.questions[0].authoredQuestionFingerprint,
        text: "A符合题意，B混淆了变量方向。", boardNotes: [], source: "prepared", audioUrl: "/api/audio/prepared.mp3" };
      store.readExplanation.mockResolvedValue(explanation);
      const before = JSON.stringify(store.course);
      const result = await POST(request({}, { action: "review-explanation", attemptId: attempt.id, questionId: "choice-1" }));
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ explanation, resultSource: "shared" });
      expect(store.readExplanation).toHaveBeenCalledWith({ classroomId: "classroom-1", sceneId: "runtime-quiz-1",
        questionFingerprint: attempt.questions[0].authoredQuestionFingerprint });
      expect(store.authenticate).toHaveBeenCalledWith(expect.anything(), "student");
      expectReadOnly(before);
    });

    it("returns an existing deep-question AI thread without another task or model call", async () => {
      const { attempt } = await (await POST(request({ "choice-1": "B", "short-1": "" }))).json();
      const thread = { id: `lecture-tutor-${attempt.id}-short-1`, attemptId: attempt.id, questionId: "short-1",
        messages: [{ id: "saved-message", role: "assistant" as const, content: "当时的 AI 讲解", createdAt: "2026-01-01T00:00:00.000Z" }],
        boardNotes: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      store.course!.aiLearningProgress!["student-1"].knowledgeLectureTutorThreads = [thread];
      finishClassroom();
      const before = JSON.stringify(store.course);
      const result = await POST(request({}, { action: "review-explanation", attemptId: attempt.id, questionId: "short-1" }));
      expect(await result.json()).toEqual({ thread, resultSource: "personalized" });
      expectReadOnly(before);
    });

    it.each(["review-explanation", "tutor-explain"])("uses the saved authored reference for a deep question in %s without new AI work", async action => {
      const scene = store.classroom!.scenes[0];
      if (scene.content.type !== "quiz") throw new Error("fixture");
      Object.assign(scene.content.questions[1], { format: "scenario_task", analysis: "原始推理路径。", referenceAnswer: "原始参考答案。" });
      const { attempt } = await (await POST(request({ "choice-1": "B", "short-1": "" }))).json();
      scene.content.questions[1].analysis = "教师后来改动的解析。";
      scene.content.questions[1].referenceAnswer = "后来改动的参考答案。";
      finishClassroom();
      const before = JSON.stringify(store.course);
      const result = await POST(request({}, { action, attemptId: attempt.id, questionId: "short-1", message: "不能触发新生成" }));
      expect(await result.json()).toMatchObject({ explanation: { text: "原始推理路径。\n\n原始参考答案。", source: "reference" }, resultSource: "reference" });
      expectReadOnly(before);
    });

    it("reads a prepared explanation for an unattempted source question without inventing a submission", async () => {
      const { attempt } = await (await POST(request({ "choice-1": "B", "short-1": "" }))).json();
      const questionFingerprint = attempt.questions[0].authoredQuestionFingerprint;
      store.course!.aiLearningProgress = {};
      finishClassroom();
      const explanation = { id: "prepared-unanswered", questionFingerprint, text: "这道题的公共讲解。", boardNotes: [], source: "prepared" };
      store.readExplanation.mockImplementation(async input => input.questionFingerprint === questionFingerprint ? explanation : null);
      const before = JSON.stringify(store.course);
      const result = await POST(request({ "choice-1": "forged-answer" }, { action: "review-explanation", questionId: "choice-1" }));
      expect(await result.json()).toEqual({ explanation, resultSource: "shared" });
      expect(store.readExplanation).toHaveBeenCalledWith({ classroomId: "classroom-1", sceneId: "runtime-quiz-1", questionFingerprint });
      expectReadOnly(before);
    });

    it("falls back to source analysis and reference for an unattempted deep question", async () => {
      const scene = store.classroom!.scenes[0];
      if (scene.content.type !== "quiz") throw new Error("fixture");
      Object.assign(scene.content.questions[1], { format: "scenario_task", analysis: "先比较变量条件。", referenceAnswer: "保持其他变量不变。" });
      finishClassroom();
      const before = JSON.stringify(store.course);
      const result = await POST(request({}, { action: "review-explanation", questionId: "short-1", referenceAnswer: "浏览器伪造解析" }));
      expect(await result.json()).toMatchObject({ explanation: { text: "先比较变量条件。\n\n保持其他变量不变。", source: "reference" }, resultSource: "reference" });
      expectReadOnly(before);
    });

    it("shows the authored objective answer and option label when no separate analysis or reference is available", async () => {
      finishClassroom();
      const before = JSON.stringify(store.course);
      const result = await POST(request({}, { action: "review-explanation", questionId: "choice-1" }));
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ explanation: { text: "参考答案：A（变量增加）", source: "reference" }, resultSource: "reference" });
      expectReadOnly(before);
    });

    it.each([
      { kind: "branch", status: "ready", insertionId: "branch:run-1" },
      { kind: "branch", status: "completed", insertionId: "branch:run-1" },
      { kind: "micro", status: "ready", insertionId: "micro-lesson:lesson:one" },
      { kind: "micro", status: "completed", insertionId: "micro-lesson:lesson:one" },
    ])("reads a $status $kind quiz from its saved resource classroom with complete insertion ids", async ({ kind, status, insertionId }) => {
      const resource = { id: kind === "branch" ? insertionId : "lesson:one", status, classroomId: "resource-room" };
      store.course!.aiLearningProgress = { "student-1": { classroomId: "classroom-1", adaptiveLearning: {
        evidence: [], branchRuns: kind === "branch" ? [resource] : [], microLessons: kind === "micro" ? [resource] : [],
      } } } as unknown as Course["aiLearningProgress"];
      finishClassroom();
      const authored = { ...store.classroom!, id: "resource-room", scenes: [{ ...store.classroom!.scenes[0], id: "quiz:source" }] };
      vi.mocked(readClassroom).mockImplementation(async id => id === "resource-room" ? authored : store.classroom);
      const explanation = { id: "adaptive-prepared", questionFingerprint: "resource-fingerprint", text: "补充课程原题讲解", boardNotes: [], source: "prepared" };
      store.readExplanation.mockResolvedValue(explanation);
      const before = JSON.stringify(store.course);
      const result = await POST(request({}, { action: "review-explanation", runtimeSceneId: `adaptive:${insertionId}:quiz:source`, questionId: "choice-1", classroomId: "forged-room" }));
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ explanation, resultSource: "shared" });
      expect(readClassroom).toHaveBeenCalledExactlyOnceWith("resource-room");
      expect(store.readExplanation).toHaveBeenCalledWith(expect.objectContaining({ classroomId: "resource-room", sceneId: "quiz:source" }));
      expectReadOnly(before);
    });

    it.each(["generating", "failed", "skipped", "foreign-student", "different-version", "unknown-insertion"])('rejects an adaptive explanation outside the saved ready/completed student path: %s', async condition => {
      const owner = condition === "foreign-student" ? "other-student" : "student-1";
      store.course!.aiLearningProgress = { [owner]: { classroomId: condition === "different-version" ? "old-classroom" : "classroom-1", adaptiveLearning: {
        evidence: [], branchRuns: [{ id: "run-1", status: ["generating", "failed", "skipped"].includes(condition) ? condition : "completed", classroomId: "resource-room" }], microLessons: [],
      } } } as unknown as Course["aiLearningProgress"];
      finishClassroom();
      const before = JSON.stringify(store.course);
      const result = await POST(request({}, { action: "review-explanation", runtimeSceneId: `adaptive:${condition === "unknown-insertion" ? "run-10" : "run-1"}:runtime-quiz-1`, questionId: "choice-1", classroomId: "resource-room" }));
      expect(result.status).toBe(404);
      expect(readClassroom).not.toHaveBeenCalled();
      expect(store.readExplanation).not.toHaveBeenCalled();
      expectReadOnly(before);
    });

    it.each(["teaching", "ready"] as const)("does not expose unattempted question explanations while the classroom is %s", async status => {
      finishClassroom(); store.course!.status = status;
      const before = JSON.stringify(store.course);
      const result = await POST(request({}, { action: "review-explanation", questionId: "choice-1" }));
      expect(result.status).toBe(409);
      expect(await result.json()).toEqual({ error: "CLASSROOM_NOT_FINISHED" });
      expect(store.readExplanation).not.toHaveBeenCalled();
      expectReadOnly(before);
    });

    it.each([{ role: "student", sub: "another-student" }, { role: "teacher", sub: "teacher-1" }])("requires the matching student's identity: %j", async claims => {
      finishClassroom(); store.claims = claims;
      const before = JSON.stringify(store.course);
      expect((await POST(request({}, { action: "review-explanation", questionId: "choice-1" }))).status).toBe(403);
      expect(store.readExplanation).not.toHaveBeenCalled();
      expectReadOnly(before);
    });

    it.each([{ attemptId: "another-students-attempt", questionId: "choice-1" },
      { runtimeSceneId: "foreign-scene", questionId: "choice-1" }, { questionId: "foreign-question" }])("rejects a question outside the owned source context: %j", async context => {
      finishClassroom();
      const before = JSON.stringify(store.course);
      expect((await POST(request({}, { action: "review-explanation", ...context }))).status).toBe(404);
      expect(store.readExplanation).not.toHaveBeenCalled();
      expectReadOnly(before);
    });

    it("rejects a live enrollment denial without legacy permission fallback", async () => {
      finishClassroom(); store.scope.mockResolvedValue({ accessible: false });
      const before = JSON.stringify(store.course);
      expect((await POST(request({}, { action: "review-explanation", questionId: "choice-1" }))).status).toBe(403);
      expect(store.access).not.toHaveBeenCalled();
      expectReadOnly(before);
    });

    it("does not expose a teacher-only quiz through the source scene review path", async () => {
      Object.assign(store.classroom!.scenes[0], { audience: "teacher", stageKey: "ai-learning", generationPurpose: "knowledge-teaching" });
      finishClassroom();
      const before = JSON.stringify(store.course);
      expect((await POST(request({}, { action: "review-explanation", questionId: "choice-1" }))).status).toBe(404);
      expect(store.readExplanation).not.toHaveBeenCalled();
      expectReadOnly(before);
    });
  });

});
