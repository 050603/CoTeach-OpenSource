import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { SignJWT } from "jose";
import { PDFDocument, rgb } from "pdf-lib";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { QuizQuestion, Scene } from "../src/lib/openmaic/types/stage";
import { knowledgeTutorEvidence } from "../src/lib/courses/knowledge-tutor-evidence-shared";
import { createBrowserActionReceipts } from "../scripts/lib/classroom-acceptance-action-receipts.mjs";
import { ActionEnvelopeSchema, actionCourseId, type ActionAck, type ActionEnvelope } from "../src/lib/courses/contracts";
import { emptyResourcePackageDraft } from "../src/lib/resource-package/types";
import { DEFAULT_STAGES, type Course } from "../src/lib/session/types";
import { captureDesktopScreenshot, desktopAcceptanceProfiles, withDesktopProfile } from "./fixtures/desktop-coverage";

// All API traffic and sockets are intercepted. This suite never creates users,
// writes classroom state, or requires a real teacher account in the database.
const courseId = "e2e-teacher-presentation";
const fixedTime = "2026-09-12T00:00:00.000Z";
const showcaseDocumentTitle = `校园能源观察与改进方案：${"依据相同观察条件比较教室照明与设备使用数据，说明证据、实施步骤和预期效果。".repeat(5)}`;
const showcaseRecommendationReason = `观察证据与改进措施对应完整：${"作品保留观察时段、设备数量和实际用电记录，能够说明选择节能措施的依据。".repeat(12)}`;
const showcaseDocumentEnd = "布局回归文档末尾：先核对实际条件，再执行校园节能改进计划。";

function classroom(): Course {
  const students = Array.from({ length: 36 }, (_, index) => ({
    id: `student-${index}`, name: `私密学生${index + 1}`, joinedAt: fixedTime, stageProgress: {},
  }));
  return {
    id: courseId, version: 1, name: "校园节能方案设计：从数据观察到行动改进的跨学科项目课堂",
    subject: "科学", grade: "七年级", hours: 1, summary: "", drivingQuestion: "怎样改进校园能源使用？",
    status: "teaching", stages: DEFAULT_STAGES.map((stage) => ({ ...stage })), currentStageIndex: 0,
    students, resources: [], groups: [], inviteCode: "E2ETST",
    content: {
      pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" },
      teachingOutline: DEFAULT_STAGES.map((stage) => ({
        id: stage.key, stageKey: stage.key, title: `${stage.label}学习任务`, durationMin: 10,
        teachingGoal: "依据观察和证据说明方案", teacherRole: "组织观察和交流",
        platformRole: "展示任务并保留学习记录", aiRole: "按需协助理解和反思",
        studentActivity: "完成观察记录，并提交节能方案。",
      })),
    },
    uiState: { classroomTiming: {
      schemaVersion: 1, status: "paused", sessionStartedAt: fixedTime, pausedAt: fixedTime, activeStageKey: "launch", updatedAt: fixedTime,
      stages: DEFAULT_STAGES.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: 600, adjustmentSec: 0, elapsedSec: 0, status: index === 0 ? "active" : "pending" })),
    } },
    createdAt: fixedTime, updatedAt: fixedTime,
  } as Course;
}

async function samplePdf() {
  const document = await PDFDocument.create();
  for (let index = 1; index <= 2; index++) {
    const page = document.addPage([960, 540]);
    page.drawRectangle({ x: 0, y: 0, width: 960, height: 540, color: rgb(0.97, 0.98, 0.99), borderWidth: 8, borderColor: rgb(0.2, 0.3, 0.45) });
    page.drawText(`CLASSROOM PRESENTATION / PAGE ${index}`, { x: 48, y: 430, size: 34, color: rgb(0.2, 0.3, 0.45) });
    page.drawText(index === 1 ? "Observe energy use in our school." : "Use evidence to explain the proposed changes.", { x: 48, y: 330, size: 26 });
    page.drawRectangle({ x: 48, y: 48, width: 864, height: 200, color: index === 1 ? rgb(0.83, 0.91, 0.9) : rgb(0.91, 0.87, 0.73) });
  }
  return Buffer.from(await document.save());
}

async function mockClassroom(page: Page, options: { rejectFullscreen?: boolean; empty?: boolean; pdfResource?: boolean; pdfDisplayMode?: "slides" | "document"; activeShowcase?: boolean; waitingShowcase?: boolean; showcaseDocument?: boolean; showcaseRecommendations?: "empty" | "failed" | "pending"; posttestResponses?: boolean; mountain?: boolean; project?: boolean; studentWorks?: boolean; practiceAnalytics?: boolean; questionReview?: boolean; reviewEmptyDirectory?: boolean; reviewEarlierCorrectChapter?: boolean } = {}) {
  let course = classroom();
  let showcaseSelectedIds: string[] = [];
  if (options.showcaseDocument) {
    course.currentStageIndex = 3;
    course.uiState!.classroomTiming!.activeStageKey = "showcase";
    course.uiState!.classroomTiming!.stages = course.uiState!.classroomTiming!.stages.map((stage, index) => ({ ...stage, status: index < 3 ? "completed" : index === 3 ? "active" : "pending" }));
  }
  const reviewQuestions: QuizQuestion[] = [
    { id: "review-single", type: "single", format: "single_choice", question: "为比较两种照明方案，哪种观察记录更可靠？",
      options: [{ value: "A", label: "在相同时段和相同空间记录用电量" }, { value: "B", label: "比较不同空间的个人印象" }],
      answer: ["A"], analysis: "保持观察条件一致，才能比较方案造成的差异。", knowledgePointIds: ["evidence"], points: 5 },
    { id: "review-multiple", type: "multiple", format: "multiple_choice", question: "判断节能方案是否有效，需要保留哪些记录？",
      options: [{ value: "A", label: "观察时长" }, { value: "B", label: "设备使用数量" }, { value: "C", label: "只记录主观印象" }],
      answer: ["A", "B"], analysis: "同时记录观察时长和设备数量，才能建立可比较的数据。", knowledgePointIds: ["evidence"], points: 5 },
  ];
  const reviewScenes: Scene[] = [{ id: "review-slide", outlineId: "review-outline", stageId: "review-classroom", type: "slide", title: "统一观察条件", order: 0, actions: [],
    content: { type: "slide", canvas: { id: "review-canvas", viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: "#ffffff", themeColors: ["#344A6A"], fontColor: "#1F2933", fontName: "Noto Sans SC" },
      background: { type: "solid", color: "#ffffff" }, elements: [{ id: "review-slide-text", type: "text", left: 48, top: 80, width: 880, height: 220, rotate: 0,
        defaultFontName: "Noto Sans SC", defaultColor: "#1F2933", content: '<p style="font-size:36px">在相同时段与空间观察并记录用电量。</p>' }] } } },
    { id: "review-scene", outlineId: "review-quiz", stageId: "review-classroom", type: "quiz", title: "观察与证据小测", order: 1,
    content: { type: "quiz", questions: reviewQuestions } }];
  if (options.questionReview) {
    reviewQuestions[0].options![0].label += `\n${Array.from({ length: 18 }, (_, index) => `第 ${index + 1} 次观察：记录相同时段的用电量、照明设备数量与实际使用情况，再比较两种方案。`).join("\n")}`;
    course.currentStageIndex = 1;
    course.aiLearningClassroomId = "review-classroom";
    course.content.knowledgePoints = [{ id: "evidence", name: "控制变量与观察证据", description: "根据相同条件下的观察记录比较方案。",
      keyInfo: "保持时段与空间一致，同时记录设备数量。", masteryBoundary: "能够指出观察条件的差异，并说明数据能否直接比较。" },
      { id: "unlinked", name: "尚未关联的知识点", description: "保留真实无关联状态。" }];
    course.content._openmaicSceneOutlines = [{ id: "review-outline", type: "slide", title: "统一观察条件", stageKey: "ai-learning", audience: "student", order: 0, knowledgePointIds: ["evidence"] }];
    course.content.knowledgeLectureSections = [{ id: "review-section", title: "第一节：观察与证据", order: 1,
      knowledgePointIds: ["evidence"], sceneOutlineIds: ["review-outline"], quizOutlineId: "review-quiz", estimatedMinutes: 4, maxScore: 10 }];
    course.aiLearningProgress = Object.fromEntries(course.students.slice(0, 3).map((student, index) => [student.id, {
      classroomId: "review-classroom", studentId: student.id, currentSceneIndex: 1, totalScenes: 2, completedScenes: ["review-slide", "review-scene"],
      completionModelVersion: 2, masteryLevel: "completed", lastActiveAt: fixedTime,
      knowledgeLectureAttempts: [{ id: `review-attempt-${student.id}`, sectionId: "review-section", quizOutlineId: "review-quiz", runtimeSceneId: "review-scene",
        submittedAt: fixedTime, gradingSource: "server", gradingStatus: "graded", knowledgePointIds: ["evidence"], score: index === 0 ? 10 : 0, maxScore: 10,
        questions: reviewQuestions.map((question) => ({ questionId: question.id, prompt: question.question, options: question.options,
          answer: index === 0 ? question.answer!.join("、") : question.id === "review-single" ? "B" : "C", rawAnswer: index === 0 ? question.answer! : question.id === "review-single" ? ["B"] : ["C"],
          questionType: question.type, questionFormat: question.format, authoredAnalysis: question.analysis,
          authoredQuestionFingerprint: createHash("sha256").update(JSON.stringify({ question, evidence: knowledgeTutorEvidence(course.content, question.knowledgePointIds ?? []) })).digest("hex"),
          gradingStatus: "graded", points: 5, earned: index === 0 ? 5 : 0, correct: index === 0, feedback: index === 0 ? "回答正确" : "请核对观察条件。", knowledgePointIds: ["evidence"] })),
      }],
    }]));
  }
  if (options.reviewEmptyDirectory) {
    course.content.knowledgePoints = [];
    course.content.knowledgeLectureSections = [];
    course.aiLearningProgress = {};
  }
  if (options.reviewEarlierCorrectChapter) {
    const introQuestion: QuizQuestion = { id: "intro-correct", type: "single", format: "single_choice", question: "观察前需要先记录什么？",
      options: [{ value: "A", label: "记录观察地点与时间" }, { value: "B", label: "只记录最后结果" }], answer: ["A"], analysis: "保留观察地点与时间。", knowledgePointIds: ["evidence"], points: 5 };
    reviewScenes.unshift({ id: "intro-scene", outlineId: "intro-quiz", stageId: "review-classroom", type: "quiz", title: "准备观察小测", order: 0,
      content: { type: "quiz", questions: [introQuestion] } });
    course.content.knowledgeLectureSections!.unshift({ id: "intro-section", title: "准备观察", order: 0,
      knowledgePointIds: ["evidence"], sceneOutlineIds: [], quizOutlineId: "intro-quiz", estimatedMinutes: 2, maxScore: 5 });
    for (const [studentId, progress] of Object.entries(course.aiLearningProgress!)) progress.knowledgeLectureAttempts!.unshift({
      id: `intro-attempt-${studentId}`, sectionId: "intro-section", quizOutlineId: "intro-quiz", runtimeSceneId: "intro-scene", submittedAt: fixedTime,
      gradingSource: "server", gradingStatus: "graded", knowledgePointIds: ["evidence"], score: 5, maxScore: 5,
      questions: [{ questionId: introQuestion.id, prompt: introQuestion.question, options: introQuestion.options, answer: "A", rawAnswer: ["A"],
        questionType: "single", questionFormat: "single_choice", authoredAnalysis: introQuestion.analysis,
        authoredQuestionFingerprint: createHash("sha256").update(JSON.stringify({ question: introQuestion, evidence: knowledgeTutorEvidence(course.content, ["evidence"]) })).digest("hex"),
        gradingStatus: "graded", points: 5, earned: 5, correct: true, feedback: "回答正确", knowledgePointIds: ["evidence"] }],
    });
  }
  if (options.questionReview) {
    // Add this authored question only after the submitted snapshots and their
    // fingerprints have been constructed: it must have no fabricated attempt.
    reviewQuestions.push({ id: "review-unsubmitted", type: "single", format: "single_choice", question: "还没有作答时，比较节能效果应先固定哪个条件？",
      options: [{ value: "A", label: "固定观察时长" }, { value: "B", label: "任意改变观察时长" }],
      answer: ["A"], analysis: "先固定观察时长，再比较两次用电量。", knowledgePointIds: ["evidence"], points: 5 });
  }
  if (options.project) {
    const draft = emptyResourcePackageDraft();
    course.currentStageIndex = 2;
    course.content.stagePlan = {
      ...draft, schemaVersion: 1, source: "resource-package", totalMinutes: 60,
      drivingQuestion: "怎样改进校园能源使用？",
      projectTask: "设计一份有数据依据、可在校园实施的节能改进方案",
      stages: draft.stages.map((stage) => ({ ...stage,
        requirements: "设计一份有数据依据、可在校园实施的节能改进方案。\n观察校园用电情况，记录三个时段的数据。\n比较至少两种节能措施，说明选择依据。\n与 AI 伙伴讨论可行性，独立完成个人方案。",
        outputs: "提交个人节能方案，包含观察数据、改进措施与预期效果。\n准备三分钟汇报，说明方案依据和实施步骤。",
      })),
    };
    course.uiState!.classroomTiming!.activeStageKey = "make";
  }
  if (options.mountain) {
    course.students = Array.from({ length: 40 }, (_, index) => ({ id: `student-${index}`, name: `私密学生${index + 1}`, joinedAt: fixedTime, stageProgress: {} }));
    course.currentStageIndex = 1;
    course.aiLearningProgress = Object.fromEntries(course.students.map((student) => [student.id, {
      classroomId: courseId, studentId: student.id, currentSceneIndex: 5, totalScenes: 10,
      completedScenes: ["scene-1", "scene-2", "scene-3", "scene-4", "scene-5"],
      completionModelVersion: 2, masteryLevel: "in-progress", lastActiveAt: fixedTime,
    }]));
  }
  if (options.studentWorks) {
    course.submissions = [0, 1].map((index) => ({
      id: `work-${index}`, courseId, studentId: `student-${index}`, stageKey: "make", type: "document", status: "draft",
      title: index ? "另一份观察方案" : "校园能源观察与改进方案：以数据为依据进行比较、分析和说明",
      content: index ? "<p>第二名学生的独立方案。</p>" : `<h2>公开展示的观察方案</h2><p>我们通过记录三个时段的校园用电情况比较改进措施。</p>${Array.from({ length: 48 }, (_, i) => `<p>第 ${i + 1} 条观察：记录同一时段的数据，比较照明、空调和其他设备的使用情况，并说明改进依据。</p>`).join("")}<p>成果末尾的实施计划。</p>`,
      createdAt: fixedTime, updatedAt: fixedTime,
    }));
    course.projectDocumentVersions = [1, 2, 3].map((sequence) => ({ id: `document-${sequence}`, courseId, submissionId: "work-0", studentId: "student-0", stageKey: "make", sequence, sourceVersion: sequence, title: "已提交的观察方案", sourceHtml: "<p>已提交方案。</p>", status: sequence === 3 ? "failed" : "submitted", createdAt: fixedTime, submittedAt: sequence === 3 ? undefined : fixedTime }));
    course.aiInteractionEvents = [{ id: "private-question", courseId, studentId: "student-0", stageKey: "make", source: "sidebar", eventType: "request", actorRole: "student", content: "不应展示的个人 AI 对话", createdAt: fixedTime }];
  }
  course.platformContext = { offeringId: "presentation-offering", activityId: "presentation-activity", templateId: "template", templateVersionId: "version" };
  const questionnaire = {
    pretest: [{ id: "pre-evidence", type: "short-answer", prompt: "观察开始前，你会记录什么？" }],
    posttest: [
      { id: "comparison", type: "single-choice", prompt: "哪种记录更适合比较校园能源使用？", options: ["统一观察时长并记录数量", "只凭个人印象判断"], correctAnswer: "统一观察时长并记录数量", group: { id: "evidence", title: "观察与证据", instruction: "根据本次项目的记录作答。" } },
      { id: "explanation", type: "short-answer", prompt: "请结合具体观察记录说明你下一步如何验证节能方案。" },
    ],
  };
  const submissions = options.posttestResponses ? course.students.slice(0, 3).flatMap((student, index) => ([
    { id: `pre-${student.id}`, phase: "pretest", variant: "none", student: { id: student.id, displayName: student.name, username: student.id }, submittedAt: fixedTime, questionnaire, answers: { "pre-evidence": `前测原文${index + 1}：先记录观察地点和时间。` }, objectiveScore: 0, objectiveTotal: 0 },
    { id: `post-${student.id}`, phase: "posttest", variant: "none", student: { id: student.id, displayName: student.name, username: student.id }, submittedAt: fixedTime, questionnaire, answers: { comparison: "统一观察时长并记录数量", explanation: `后测原文${index + 1}：对比同一时段的用电数据，核验节能方案。` }, objectiveScore: 1, objectiveTotal: 1 },
  ])) : [];
  const resultReads: string[] = [];
  const exportCursors: Array<string | null> = [];
  let assignedStudentId: string | undefined;
  let startedShowcase: Record<string, unknown> | null = null;
  const pdfBytes = options.pdfResource || options.activeShowcase || options.waitingShowcase ? await samplePdf() : undefined;
  if (options.pdfResource) course.resources = [{ id: "presentation-pdf", title: "校园能源观察与改进建议：两页课堂演示资料", stageKey: "launch", type: "PDF", size: "2 KB", url: "/api/uploads/e2e-presentation-pdf", displayMode: options.pdfDisplayMode ?? "slides", downloadedBy: [] }];
  if (options.empty) course.students = [];
  if (options.practiceAnalytics) {
    course.aiInteractionEvents = [
      { id: "practice-request", courseId, studentId: "student-0", stageKey: "make", conversationId: "practice-conversation", requestId: "practice-request", source: "sidebar", eventType: "request", actorRole: "student", content: "请帮我核对方案中的证据。", createdAt: fixedTime },
      { id: "practice-response", courseId, studentId: "student-0", stageKey: "make", conversationId: "practice-conversation", requestId: "practice-request", source: "sidebar", eventType: "response", actorRole: "ai", content: `${"需要比较相同条件下的数据，明确观察时间、样本和结论之间的关系。\n\n".repeat(40)}协作长对话末尾`, payload: { contributionId: "practice-suggestion", suggestion: { title: "补充证据来源", targetText: "节能效果很好。", replacement: "在相同观察时段记录并比较用电量。" } }, createdAt: fixedTime },
      { id: "practice-decision", courseId, studentId: "student-0", stageKey: "make", conversationId: "practice-conversation", requestId: "practice-request", source: "sidebar", eventType: "decision", actorRole: "student", content: "学生修改后采用建议。", payload: { contributionId: "practice-suggestion", decision: "modified" }, createdAt: fixedTime },
      { id: "practice-boundary", courseId, studentId: "student-1", stageKey: "make", requestId: "protected-request", source: "sidebar", eventType: "policy", actorRole: "system", content: "需要学生先提出自己的分析。", payload: { protectedCapability: "核心方案判断" }, createdAt: fixedTime },
    ];
  }
  let practiceReminder = { id: "practice-reminder", studentId: "student-0", studentName: "私密学生1", createdAt: fixedTime, pastedCharacters: 460,
    excerpt: "需要教师核实的核心结论片段", requirementQuote: "依据观察证据提出改进建议", reason: "包含直接回答任务的结论", status: "pending", studentSource: "own-draft", studentExplanation: "这是我在课前整理的草稿", contentState: "unknown", history: [] as Array<{ actor: string; at: string; note: string }> };
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const actionReceipts = createBrowserActionReceipts(courseId, fixedTime);
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  // Production's service can use a different secret from .env.local. Supply
  // OPENPBL_E2E_JWT_SECRET_FILE when reusing that server; never log its contents.
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
    ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, "utf8").trim()
    : process.env.JWT_SECRET;
  if (secret && secret.length >= 32) {
    const token = await new SignJWT({ role: "teacher", sv: 1, username: "e2e-presentation", displayName: "大屏验收教师" })
      .setProtectedHeader({ alg: "HS256" }).setSubject("e2e-presentation-teacher")
      .setIssuer("openpbl").setAudience("openpbl-app").setIssuedAt().setExpirationTime("1h")
      .sign(new TextEncoder().encode(secret));
    const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000";
    await page.context().addCookies([{ name: "openpbl_teacher", value: token, domain: new URL(baseURL).hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
  }
  await page.routeWebSocket(/.*/, (socket) => {
    if (new URL(socket.url()).pathname.startsWith("/_next/")) {
      // Development hydration waits for the HMR handshake; it carries no
      // classroom traffic. Continue mocking every application socket below.
      socket.connectToServer();
      return;
    }
    socket.onMessage((message) => {
      const payload = JSON.parse(String(message)) as { type?: string; courseId?: string };
      if (payload.type === "subscribe") socket.send(JSON.stringify({ type: "subscribed", courseId: payload.courseId }));
    });
  });
  if (options.rejectFullscreen) {
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = async () => { throw new DOMException("Fixture denies native fullscreen", "NotAllowedError"); };
    });
  }
  const projectionSnapshot = () => ({
    courseId, courseVersion: course.version, projectionVersion: course.uiState?.projectionVersion ?? 0,
    projectionUpdatedAt: course.updatedAt, serverTime: new Date().toISOString(),
    resourceProjection: course.uiState?.resourceProjection ?? null,
    teacherResourceProjection: course.uiState?.teacherResourceProjection ?? null,
    projectionController: course.uiState?.projectionController ?? null,
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.method() === "GET" ? {} : request.postDataJSON() ?? {};
    if (request.method() !== "GET") writes.push({ path, body });
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (pdfBytes && (path === "/api/uploads/e2e-presentation-pdf" || path === `/api/courses/${courseId}/showcase/artifacts/e2e-artifact` || path.startsWith(`/api/courses/${courseId}/showcase/artifacts/artifact-student-`))) return route.fulfill({ status: 200, contentType: "application/pdf", body: pdfBytes });
    if (path === "/api/openmaic/classroom" && options.questionReview) return json({ success: true, classroom: { id: "review-classroom", stage: { id: "review-classroom", name: course.name, createdAt: 1, updatedAt: 1 }, scenes: reviewScenes } });
    if (options.questionReview && path === "/api/openmaic/progress") return json({ data: { progress: {} } });
    if (options.questionReview && ["/api/openmaic/provider-config", "/api/openmaic/server-providers", "/api/server-providers"].includes(path)) return json({ success: true, providers: {}, tts: {}, asr: {}, pdf: {}, image: {}, video: {}, webSearch: {}, generation: {} });
    if (path === "/api/auth/me") return json({ user: { id: "e2e-presentation-teacher", role: "teacher", name: "大屏验收教师", displayName: "大屏验收教师" } });
    if (path === "/api/courses") return json({ courses: [course], user: { role: "teacher", name: "大屏验收教师" }, hydrated: true, updatedAt: course.updatedAt });
    if (path === `/api/courses/${courseId}/state`) return json({ course, eventCursor: "0" });
    if (path === `/api/courses/${courseId}/events`) return json({ events: [], nextCursor: "0", hasMore: false, courseVersion: course.version, requiresReconciliation: Boolean(options.studentWorks) });
    if (path === "/api/project-practice/content-monitor/events" && request.method() === "GET") return json({ events: options.practiceAnalytics ? [practiceReminder] : [], pendingCount: options.practiceAnalytics && practiceReminder.status === "pending" ? 1 : 0, studentCounts: options.practiceAnalytics ? [{ studentId: "student-0", pendingCount: practiceReminder.status === "pending" ? 1 : 0, reviewedCount: practiceReminder.status === "reviewed" ? 1 : 0, dismissedCount: practiceReminder.status === "dismissed" ? 1 : 0 }] : [], nextCursor: null });
    if (path === "/api/project-practice/content-monitor/events/practice-reminder" && options.practiceAnalytics && request.method() === "PATCH") {
      practiceReminder = { ...practiceReminder, status: String(body.status), history: [...practiceReminder.history, { actor: "teacher", at: fixedTime, note: String(body.note ?? "") }] };
      return json({ event: practiceReminder });
    }
    if (path === `/api/courses/${courseId}/presence`) return json({ members: [], degraded: false });
    if (path === `/api/courses/${courseId}/projection`) return json(projectionSnapshot());
    if ((path === `/api/courses/${courseId}/showcase/artifacts/layout-document` || path === `/api/courses/${courseId}/showcase/artifacts/layout-document-2`) && options.showcaseDocument) return json({
      html: `<h1>校园能源观察成果</h1><p>使用相同观察时段和设备数量比较节能措施。</p>${Array.from({ length: 48 }, (_, index) => `<h2>第 ${index + 1} 次观察与分析</h2><p>记录教室照明、空调和其他设备的使用情况，以相同时长的用电数据核对改进效果，说明数据来源、限制条件以及下一步实施安排。</p>`).join("")}<p>${showcaseDocumentEnd}</p>`,
    });
    if (path === `/api/courses/${courseId}/showcase/recommendations` && options.showcaseRecommendations) {
      if (options.showcaseRecommendations === "failed") return json({ message: "推荐服务暂不可用" }, 503);
      return json({ courseId, targetCount: 3, targetSource: "default", recommendedStudentIds: [], candidates: [],
        pendingCount: options.showcaseRecommendations === "pending" ? 2 : 0,
        revision: `recommendations-${options.showcaseRecommendations}`, updatedAt: fixedTime });
    }
    if (path === `/api/courses/${courseId}/showcase/recommendations` && request.method() === "GET") return json(options.showcaseDocument ? {
      courseId, targetCount: 3, targetSource: "default", recommendedStudentIds: ["student-0"], pendingCount: 12,
      candidates: [{ studentId: "student-0", studentName: course.students[0].name, artifactVersionId: "layout-document", artifactKind: "document",
        analysisStatus: "complete", analysisFreshness: "exact", analyzedAt: fixedTime, qualityScore: 92, aiRequestCount: 18,
        reasons: [{ kind: "quality", text: showcaseRecommendationReason, location: "第 1 至 48 次观察与分析", quote: "记录教室照明、空调和其他设备的使用情况，以相同时长的用电数据核对改进效果。".repeat(8) },
          { kind: "earliest", text: "首次提交时间最早，保留从观察到改进的完整过程。".repeat(6) },
          { kind: "ai-interactions", text: "AI 协作请求 18 次，学生根据证据逐步修改方案。".repeat(6) }],
        coverage: { mode: "sampled", sourceCharacters: 18000, analyzedCharacters: 6000 } }],
      revision: "long-document-layout-fixture", updatedAt: fixedTime,
    } : {
      courseId, targetCount: 3, targetSource: "default", recommendedStudentIds: [], candidates: [], pendingCount: 0,
      revision: "presentation-layout-fixture", updatedAt: fixedTime,
    });
    if (path === `/api/courses/${courseId}/public-discussion` || path === `/api/courses/${courseId}/public-discussion/settings`) {
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ enabled: false }) });
    }
    if (path === `/api/courses/${courseId}/actions`) {
      const parsed = ActionEnvelopeSchema.safeParse(body);
      if (!parsed.success) {
        unexpected.push("Invalid action envelope");
        return json({ code: "INVALID_ACTION", message: "Action envelope is invalid." }, 400);
      }
      const envelope = parsed.data as unknown as ActionEnvelope;
      if (actionCourseId(envelope.action) !== courseId) return json({ code: "COURSE_MISMATCH" }, 400);
      const previous = actionReceipts.lookup(envelope);
      if (previous) return json(previous.body, previous.status);
      const action = envelope.action;
      const projectionWrite = action.type === "SET_UI_STATE" && (Object.hasOwn(action.payload.patch, "teacherResourceProjection") || Object.hasOwn(action.payload.patch, "resourceProjection"));
      if (action.type === "UPDATE_COURSE") course = { ...course, ...action.payload.patch };
      else if (action.type === "SET_UI_STATE") {
        if (envelope.expectedVersion !== undefined && envelope.expectedVersion !== course.version) {
          return json({ code: "VERSION_CONFLICT", message: "课程已被其他操作更新", details: { currentVersion: course.version } }, 409);
        }
        course = { ...course, uiState: { ...course.uiState, ...action.payload.patch } };
        if (projectionWrite) course = { ...course, uiState: { ...course.uiState,
          projectionVersion: (course.uiState?.projectionVersion ?? 0) + 1,
          projectionController: course.uiState?.teacherResourceProjection || course.uiState?.resourceProjection
            ? { teacherId: "e2e-presentation-teacher", clientId: action.payload.projectionControl!.clientId } : null,
        } };
      } else if (action.type === "ADD_ACTIVITY") {
        course = { ...course, activityLog: [...(course.activityLog ?? []), action.payload.activity] };
      } else {
        unexpected.push(`Action ${action.type}`);
        return json({ code: "FORBIDDEN_ACTION", message: "Unknown fixture action" }, 400);
      }
      course = { ...course, version: (course.version ?? 0) + 1, updatedAt: new Date().toISOString() };
      return json(actionReceipts.remember(envelope, { courseVersion: course.version, updatedAt: course.updatedAt,
        ...(projectionWrite ? { projection: projectionSnapshot() } : {}),
      }));
    }
    if (path === `/api/platform/classroom-instances/${courseId}/experiment/results`) {
      resultReads.push(request.url());
      const studentRows = course.students.map((student, index) => ({ student: { id: student.id, displayName: student.name },
        status: options.posttestResponses && index < 3 ? "submitted" : options.posttestResponses && index < 5 ? "in-progress" : "not-started",
        submittedAt: options.posttestResponses && index < 3 ? fixedTime : null }));
      return json({ enabled: true, status: "teaching", enrollmentCount: course.students.length, participantCount: course.students.length,
        pretestCount: options.posttestResponses ? 3 : 0, posttestCount: options.posttestResponses ? 3 : 0,
        posttestDraftCount: options.posttestResponses ? 2 : 0, posttestOpenedAt: fixedTime,
        studentRows, variantCounts: { aPreBPost: 0, bPreAPost: 0 }, submissions });
    }
    if (path === "/api/platform/offerings/presentation-offering/research-export") {
      const query = new URL(request.url()).searchParams;
      exportCursors.push(query.get("cursor"));
      return json({ rows: query.has("cursor") ? submissions.slice(3) : submissions.slice(0, 3), nextCursor: query.has("cursor") ? null : "page-2" });
    }
    if (path === `/api/courses/${courseId}/showcase/presentation` && options.showcaseDocument) {
      if (request.method() !== "GET") {
        if (request.method() !== "POST" || body.action !== "save-queue" || !Array.isArray(body.orderedStudentIds)
          || !body.orderedStudentIds.every((id) => typeof id === "string" && course.students.some((student) => student.id === id))) {
          unexpected.push(`${request.method()} document showcase action ${String(body.action)}`);
          return json({ message: "Document fixture only accepts saving the selected queue" }, 400);
        }
        showcaseSelectedIds = body.orderedStudentIds as string[];
      }
      const students = course.students.map((student, index) => ({ studentId: student.id, name: student.name, isAssigned: false,
        artifacts: index === 0 || index === 2 ? [{ kind: "document", versionId: index === 0 ? "layout-document" : "layout-document-2", title: index === 0 ? showcaseDocumentTitle : "第二份节能观察与实施方案", sequence: 1, submittedAt: fixedTime, displayModes: ["continuous"] }] : [] }));
      const orderedStudents = [...showcaseSelectedIds.flatMap((id) => students.find((student) => student.studentId === id) ?? []), ...students.filter((student) => !showcaseSelectedIds.includes(student.studentId))];
      return json({ courseId, stageKey: "showcase", students, ownArtifacts: [], presentations: [], activePresentation: null,
        queue: orderedStudents.map((student, index) => ({ studentId: student.studentId, studentName: student.name, position: index + 1, status: showcaseSelectedIds.includes(student.studentId) ? "waiting" : "not-ready", artifacts: student.artifacts })),
        queueConfig: { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: showcaseSelectedIds, orderedStudentIds: showcaseSelectedIds, presenterCount: 3, presentationSec: 180, discussionSec: 60, transitionSec: 20, minutesPerStudent: 5, updatedAt: fixedTime },
        budget: { stageRemainingSec: 600, plannedRemainingSec: 960, overrunSec: 360 },
        minutesPerStudent: 5, currentQueueItem: null, nextQueueItem: null });
    }
    if (path === `/api/courses/${courseId}/showcase/presentation` && options.waitingShowcase) {
      if (request.method() === "POST") {
        if (body.action !== "start" || typeof body.studentId !== "string") return route.fulfill({ status: 400, json: { message: "Fixture only allows starting the selected presentation" } });
        assignedStudentId = body.studentId;
        startedShowcase = { id: "fixture-started-showcase", courseId, studentId: assignedStudentId, studentName: course.students.find((student) => student.id === assignedStudentId)?.name,
          artifactKind: body.artifactKind, artifactVersionId: body.artifactVersionId, artifactTitle: "已提交成果1", displayMode: body.displayMode,
          status: "active", revision: 1, projectionVersion: 1, controllerClientId: body.clientId, controlEpoch: 1,
          requestedAt: fixedTime, startedAt: new Date().toISOString(), updatedAt: fixedTime, viewState: { page: 1, revision: 1, updatedAt: fixedTime } };
      }
      // The default server queue is ordered by ready time, not roster order.
      const order = [course.students[2]!, course.students[0]!, ...course.students.filter((_, index) => index !== 0 && index !== 2)];
      const queue = order.map((student, index) => ({
        studentId: student.id, studentName: student.name, groupId: `group-${student.id}`, position: index + 1,
        status: assignedStudentId === student.id ? "presenting" : index < 2 ? "waiting" : "not-ready",
        artifacts: index < 2 ? [{ kind: "pdf", versionId: `artifact-${student.id}`, title: `已提交成果${index + 1}`, sequence: 1, submittedAt: fixedTime, displayModes: ["slides"] }] : [],
      }));
      return json({
        courseId, stageKey: "showcase", presentingStudentId: assignedStudentId ?? null,
        presentingGroupId: assignedStudentId ? `group-${assignedStudentId}` : null,
        students: queue.map((item) => ({ studentId: item.studentId, name: item.studentName, groupId: item.groupId, isAssigned: item.studentId === assignedStudentId, artifacts: item.artifacts })),
        ownArtifacts: [], presentations: startedShowcase ? [startedShowcase] : [], activePresentation: startedShowcase, queue, minutesPerStudent: 5,
        queueConfig: { schemaVersion: 1, orderedStudentIds: order.map((student) => student.id), minutesPerStudent: 5, updatedAt: fixedTime },
        currentQueueItem: queue.find((item) => item.status === "presenting") ?? null,
        nextQueueItem: queue.find((item) => item.status === "waiting") ?? null,
      });
    }
    if (path === `/api/courses/${courseId}/showcase/presentation` && options.activeShowcase) {
      const artifact = { kind: "pdf", versionId: "e2e-artifact", title: "校园节能项目最终成果", sequence: 1, submittedAt: fixedTime, displayModes: ["slides", "continuous"] };
      const activePresentation = {
        id: "e2e-active", courseId, groupId: "", studentId: "student-0", studentName: "私密学生1",
        artifactKind: "pdf", artifactVersionId: artifact.versionId, artifactTitle: artifact.title, displayMode: "slides", status: "active", revision: 1,
        requestedAt: fixedTime, reviewedAt: fixedTime, startedAt: new Date().toISOString(), updatedAt: fixedTime,
        viewState: { page: 2, revision: 1, updatedAt: fixedTime },
      };
      const queue = course.students.map((student, index) => ({ studentId: student.id, studentName: student.name, position: index + 1, status: index === 0 ? "presenting" : "not-ready", presentationId: index === 0 ? activePresentation.id : undefined, artifacts: index === 0 ? [artifact] : [] }));
      return json({ courseId, stageKey: "showcase", presentingStudentId: "student-0", students: course.students.map((student, index) => ({ studentId: student.id, name: student.name, isAssigned: index === 0, artifacts: index === 0 ? [artifact] : [] })), ownArtifacts: [], presentations: [activePresentation], activePresentation, queue, currentQueueItem: queue[0], minutesPerStudent: 5 });
    }
    if (path === `/api/courses/${courseId}/showcase/presentation`) return json({
      courseId, stageKey: "showcase", presentations: [], activePresentation: null, ownArtifacts: [], minutesPerStudent: 5,
      students: course.students.map((student) => ({ studentId: student.id, name: student.name, isAssigned: false, artifacts: [] })),
      queue: course.students.map((student, index) => ({ studentId: student.id, studentName: student.name, position: index + 1, status: "not-ready", artifacts: [] })),
    });
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ message: "No fixture for this endpoint" }) });
  });
  await page.goto(`/teacher/teach/${courseId}/classroom`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true })).toBeVisible().catch((cause) => {
    throw new Error(`Classroom fixture did not hydrate: ${JSON.stringify({ errors, unexpected })}`, { cause });
  });
  return { writes, unexpected, errors, resultReads, exportCursors, submissions, course: () => course,
    updateStudentWork: (html: string) => {
      course = { ...course, version: (course.version ?? 0) + 1, updatedAt: new Date().toISOString(), submissions: course.submissions?.map((work, index) => index ? work : { ...work, content: html, updatedAt: new Date().toISOString() }) };
    },
  };
}

const classroomViews = ["授课展示", "班级学情", "课堂讲解", "学生成果"] as const;
type ClassroomViewLabel = typeof classroomViews[number];

async function selectClassroomView(page: Page, label: ClassroomViewLabel) {
  await page.locator('footer[aria-label="课堂操作栏"]').getByRole("button", { name: label, exact: true }).click();
  await expectClassroomView(page, label);
}

async function expectClassroomView(page: Page, label: ClassroomViewLabel) {
  await expect(page.locator('footer[aria-label="课堂操作栏"]').getByRole("button", { name: label, exact: true })).toHaveAttribute("aria-pressed", "true");
}

for (const viewport of [
  { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 768, height: 1024 },
  { width: 844, height: 390 }, { width: 1024, height: 576 }, { width: 1280, height: 720 },
  { width: 1366, height: 768 }, { width: 1920, height: 1080 },
]) {
  test(`classroom view buttons stay expanded and clickable ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page);
    await page.getByRole("combobox", { name: "当前教学阶段", exact: true }).selectOption("1");
    await page.getByRole("dialog").getByRole("button", { name: "进入“知识讲授”", exact: true }).click();
    const footer = page.locator('footer[aria-label="课堂操作栏"]');
    for (const fullscreen of [false, true]) {
      if (fullscreen) await enterFullscreen(page, "班级学情");
      await expect(footer.getByRole("combobox", { name: "课堂视图", exact: true })).toHaveCount(0);
      for (const label of classroomViews.slice(0, 3)) {
        const button = footer.getByRole("button", { name: label, exact: true });
        await expect(button).toBeInViewport({ ratio: 1 });
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await selectClassroomView(page, label);
      }
      await selectClassroomView(page, "班级学情");
      await assertNoPageOverflow(page);
      const geometry = await footer.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const buttons = Array.from(node.querySelectorAll("button, select")).map((button) => button.getBoundingClientRect());
        return {
          overflow: node.scrollWidth - node.clientWidth,
          overlaps: buttons.some((rect, index) => buttons.slice(index + 1).some((other) => Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 1 && Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 1)),
          rows: new Set(buttons.map((button) => Math.round(button.top))).size,
          height: bounds.height,
        };
      });
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.overlaps).toBe(false);
      // A normal laptop has room for all knowledge-stage controls in one row.
      if (viewport.width >= 1280) {
        expect(geometry.rows).toBe(1);
        expect(geometry.height).toBeLessThanOrEqual(64);
      }
      await screenshot(page, info, `expanded-views-${fullscreen ? "fullscreen" : "window"}`);
    }
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [
  { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 },
  { width: 1024, height: 576 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 },
]) {
  test(`launch lesson keeps resources in a drawer and PDF controls floating ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { pdfResource: true });
    const footer = page.locator('footer[aria-label="课堂操作栏"]');
    for (const fullscreen of [false, true]) {
      if (fullscreen) await enterFullscreen(page);
      await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
      await expect(page.getByRole("combobox", { name: "选择授课资料", exact: true })).toHaveCount(0);
      await assertCanvasFits(page, "PPT 第 1 页");
      const manager = footer.getByRole("group", { name: "左侧展示操作" }).getByRole("button", { name: "资料管理", exact: true });
      await expect(manager).toBeInViewport({ ratio: 1 });
      await expect(page.locator("header").getByRole("button", { name: "资料管理", exact: true })).toHaveCount(0);
      await expect(footer.getByText(fixture.course().resources![0]!.title, { exact: true })).toHaveCount(0);
      const sync = footer.getByRole("group", { name: "右侧课堂操作" }).getByRole("button", { name: "同步到学生", exact: true });
      await expect(sync).toBeInViewport({ ratio: 1 });
      await expect(sync).toHaveCSS("background-color", "rgb(252, 251, 248)");
      await expect(sync).toHaveCSS("background-color", await footer.getByRole("button", { name: "工具", exact: true }).evaluate(node => getComputedStyle(node).backgroundColor));
      await assertFooterOrder(page);
      await manager.click();
      const drawer = page.getByRole("dialog", { name: "资料管理", exact: true });
      await expect(drawer).toBeInViewport({ ratio: 1 });
      await expect(drawer.getByLabel("上传资料", { exact: true })).toBeAttached();
      await expect(drawer.getByRole("button", { name: /^PDF.*校园能源观察/ })).toHaveAttribute("aria-pressed", "true");
      await expect(drawer.getByRole("button", { name: /^删除学习资料/ })).toBeVisible();
      await drawer.getByRole("button", { name: "关闭抽屉", exact: true }).click();
      await expect(manager).toBeFocused();
      await page.locator('canvas[aria-label="PPT 第 1 页"]').hover({ position: { x: 20, y: 20 } });
      const tools = page.getByRole("toolbar", { name: "课件操作", exact: true });
      await expect(tools).toBeInViewport({ ratio: 1 });
      expect(await tools.evaluate((node) => getComputedStyle(node).position)).toBe("absolute");
      expect(await tools.evaluate(node => {
        const panel = node.getBoundingClientRect();
        return Array.from(node.parentElement!.querySelectorAll(".launch-pdf-page-navigation button")).some(button => {
          const arrow = button.getBoundingClientRect();
          return Math.min(panel.right, arrow.right) - Math.max(panel.left, arrow.left) > 1 && Math.min(panel.bottom, arrow.bottom) - Math.max(panel.top, arrow.top) > 1;
        });
      })).toBe(false);
      await tools.getByRole("button", { name: "下一页", exact: true }).click();
      await expect(tools.getByRole("spinbutton", { name: "跳转页码", exact: true })).toHaveValue("2");
      await tools.getByRole("combobox", { name: "显示比例", exact: true }).selectOption("fit-page");
      await expect(page.getByRole("button", { name: /收起课件操作|显示课件操作/ })).toHaveCount(0);
      await expect(tools).toBeHidden();
      await assertCanvasFits(page, "PPT 第 2 页");
      const navigation = page.getByRole("group", { name: "课件翻页", exact: true });
      const previous = navigation.getByRole("button", { name: "上一页课件", exact: true });
      const next = navigation.getByRole("button", { name: "下一页课件", exact: true });
      await expect(previous).toBeInViewport({ ratio: 1 });
      await expect(next).toBeDisabled();
      const sideGeometry = await navigation.evaluate(node => {
        const canvas = node.parentElement!.querySelector("canvas")!.getBoundingClientRect();
        const viewport = node.getBoundingClientRect();
        const [left, right] = Array.from(node.querySelectorAll("button"), button => button.getBoundingClientRect());
        return {
          leftUsesMargin: canvas.left - viewport.left < 60 || left.right <= canvas.left,
          rightUsesMargin: viewport.right - canvas.right < 60 || right.left >= canvas.right,
        };
      });
      expect(sideGeometry).toEqual({ leftUsesMargin: true, rightUsesMargin: true });
      await previous.click();
      await expect(tools).toBeVisible();
      await assertCanvasFits(page, "PPT 第 1 页");
      await expect(previous).toBeDisabled();
      await next.click();
      await assertCanvasFits(page, "PPT 第 2 页");
      await expect(tools.getByRole("combobox", { name: "显示比例", exact: true })).toHaveValue("fit-page");
      await expect(tools).toBeHidden();
      await page.locator('canvas[aria-label="PPT 第 2 页"]').hover({ position: { x: 20, y: 20 } });
      await expect(tools).toBeVisible();
      await tools.getByRole("button", { name: "上一页", exact: true }).click();
      await assertCanvasFits(page, "PPT 第 1 页");
      await screenshot(page, info, `launch-${fullscreen ? "fullscreen" : "window"}`);
      await selectClassroomView(page, "班级学情");
      await page.getByRole("button", { name: "查看明细", exact: true }).click();
      const reading = page.getByRole("dialog", { name: "资料阅读明细", exact: true });
      await expect(reading.getByRole("heading", { name: "阅读跟进矩阵", exact: true })).toBeVisible();
      await reading.getByRole("button", { name: "关闭抽屉", exact: true }).click();
      await expectClassroomView(page, "班级学情");
      await selectClassroomView(page, "授课展示");
      await assertNoPageOverflow(page);
    }
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("launch document arrows keep reading position while floating controls hide and return on scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const fixture = await mockClassroom(page, { pdfResource: true, pdfDisplayMode: "document" });
  const canvas = page.locator('canvas[aria-label="PDF 第 1 页"]');
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.width)).toBeGreaterThan(600);
  const navigation = page.getByRole("group", { name: "课件翻页", exact: true });
  const next = navigation.getByRole("button", { name: "下一页课件", exact: true });
  const previous = navigation.getByRole("button", { name: "上一页课件", exact: true });
  const tools = page.getByRole("toolbar", { name: "课件操作", exact: true });
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(tools.getByRole("spinbutton", { name: "跳转页码", exact: true })).toHaveValue("2");
  await expect(next).toBeDisabled();
  await expect(tools).toBeHidden();
  await expect(previous).toBeInViewport({ ratio: 1 });
  const viewport = page.locator(".teacher-resource-preview .resource-pdf-viewport");
  await viewport.dispatchEvent("wheel", { deltaY: -80 });
  await expect(tools).toBeVisible();
  await expect(tools.getByRole("spinbutton", { name: "跳转页码", exact: true })).toHaveValue("2");
  await previous.click();
  await expect(tools.getByRole("spinbutton", { name: "跳转页码", exact: true })).toHaveValue("1");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("launch resource management uploads and removes a PDF without starting student synchronization", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await mockClassroom(page, { pdfResource: true });
  const uploads: string[] = [];
  await page.route("**/api/uploads", async (route) => {
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataBuffer()!.toString();
    uploads.push(body);
    expect(body).toContain('name="pdfDisplayMode"\r\n\r\nslides');
    fixture.course().resources!.push({ id: "launch-uploaded", title: "新启动课件.pdf", type: "PDF", displayMode: "slides", size: "2 KB", stageKey: "launch", url: "/api/uploads/e2e-presentation-pdf", downloadedBy: [] });
    fixture.course().version = (fixture.course().version ?? 0) + 1;
    fixture.course().updatedAt = new Date().toISOString();
    await route.fulfill({ json: { id: "launch-uploaded", title: "新启动课件.pdf", url: "/api/uploads/e2e-presentation-pdf" } });
  });
  const removed: string[] = [];
  await page.route("**/api/uploads/launch-uploaded", async (route) => {
    expect(route.request().method()).toBe("DELETE");
    removed.push("launch-uploaded");
    fixture.course().resources = fixture.course().resources!.filter((resource) => resource.id !== "launch-uploaded");
    fixture.course().version = (fixture.course().version ?? 0) + 1;
    fixture.course().updatedAt = new Date().toISOString();
    await route.fulfill({ json: { ok: true } });
  });
  await enterFullscreen(page);
  await page.getByRole("button", { name: "资料管理", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "资料管理", exact: true });
  await drawer.getByLabel("上传资料", { exact: true }).setInputFiles({ name: "新启动课件.pdf", mimeType: "application/pdf", buffer: await samplePdf() });
  await page.getByRole("dialog", { name: "这份 PDF 如何用于课堂？", exact: true }).getByRole("button", { name: /幻灯片演示/ }).click();
  await expect.poll(() => uploads.length).toBe(1);
  await expect(drawer.getByRole("button", { name: /^PDF.*新启动课件/ })).toHaveAttribute("aria-pressed", "true");
  expect(uploads).toHaveLength(1);
  await drawer.getByRole("button", { name: /^PDF.*新启动课件/ }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator('footer[aria-label="课堂操作栏"]').getByText("新启动课件.pdf", { exact: true })).toHaveCount(0);
  await assertCanvasFits(page, "PPT 第 1 页");
  await page.getByRole("button", { name: "资料管理", exact: true }).click();
  await expect(drawer.getByRole("button", { name: /^PDF.*新启动课件/ })).toHaveAttribute("aria-pressed", "true");
  page.once("dialog", (dialog) => dialog.accept());
  await drawer.getByRole("button", { name: "删除学习资料 新启动课件.pdf", exact: true }).click();
  await expect(drawer.getByRole("button", { name: /^PDF.*新启动课件/ })).toHaveCount(0);
  expect(removed).toEqual(["launch-uploaded"]);
  expect(fixture.course().resources).toHaveLength(1);
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

async function enterFullscreen(page: Page, defaultView: ClassroomViewLabel = "授课展示", rejected = false) {
  await page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true }).click();
  if (rejected) {
    await expect(page.getByRole("status").filter({ hasText: "浏览器未允许全屏" })).toBeVisible();
    await expect(page.getByRole("button", { name: "全屏授课", exact: true })).toBeVisible();
  } else await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  await expectClassroomView(page, defaultView);
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 768, height: 576 }, { width: 320, height: 568 }]) {
  test(`stage navigation explains its arrows and keeps ending in context ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page);
    const footer = page.locator('footer[aria-label="课堂操作栏"]');
    const navigation = footer.getByRole("group", { name: "教学阶段切换" });
    const next = navigation.getByRole("button", { name: "下一教学阶段" });
    const previous = navigation.getByRole("button", { name: "上一教学阶段" });
    await expect(navigation).toBeVisible();
    await expect(previous).toBeDisabled();
    await expect(footer.getByRole("button", { name: "结束课堂", exact: true })).toHaveCount(0);
    await next.hover();
    await expect(page.getByRole("tooltip")).toHaveText("下一阶段：知识讲授");
    await screenshot(page, info, "stage-navigation-window");
    await footer.getByRole("button", { name: "工具", exact: true }).click();
    const tools = page.getByRole("dialog", { name: "课堂工具" });
    await tools.getByRole("button", { name: "结束课堂", exact: true }).click();
    await expect(tools).toBeHidden();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    expect(fixture.writes).toHaveLength(0);
    await page.getByRole("button", { name: "继续授课", exact: true }).click();

    await enterFullscreen(page);
    await next.focus();
    await expect(page.getByRole("tooltip")).toHaveText("下一阶段：知识讲授");
    expect(await page.getByRole("tooltip").evaluate(element => document.fullscreenElement?.contains(element))).toBe(true);
    await navigation.scrollIntoViewIfNeeded();
    await expect(navigation).toBeInViewport({ ratio: 1 });
    await screenshot(page, info, "stage-navigation-fullscreen");
    await next.click();
    await page.getByRole("dialog").getByRole("button", { name: "进入“知识讲授”", exact: true }).click();
    await expect.poll(() => fixture.course().currentStageIndex).toBe(1);
    await previous.focus();
    await expect(page.getByRole("tooltip")).toHaveText("上一阶段：项目启动");
    await page.keyboard.press("Escape");

    await navigation.getByRole("combobox", { name: "当前教学阶段" }).selectOption("4");
    await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
    await expect.poll(() => fixture.course().currentStageIndex).toBe(4);
    await expect(next).toBeDisabled();
    await expect(footer.getByRole("button", { name: "结束课堂", exact: true })).toBeInViewport();
    await footer.getByRole("button", { name: "工具", exact: true }).click();
    await expect(tools.getByRole("button", { name: "结束课堂", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await footer.getByRole("button", { name: "结束课堂", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "继续授课", exact: true }).click();
    expect(fixture.course().status).toBe("teaching");
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [
  { width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 },
  { width: 768, height: 1024 }, { width: 1024, height: 576 }, { width: 1366, height: 768 },
  { width: 1920, height: 1080 }, { width: 3840, height: 2160 },
]) {
  test(`persistent classroom time fits the presentation header ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page);
    await enterFullscreen(page);
    const time = page.getByRole("group", { name: "课堂时间", exact: true });
    await expect(time).toContainText("阶段剩余10:00");
    await expect(time).toContainText("累计授课00:00");
    await expect(time).toContainText("已暂停");
    await expect(time).toBeInViewport({ ratio: 1 });
    const header = page.locator("header").filter({ has: time });
    await expect(header.getByRole("heading", { name: fixture.course().name, exact: true })).toBeVisible();
    await expect(header.getByText("全屏授课", { exact: true })).toHaveCount(0);
    const progress = header.getByRole("progressbar", { name: "教学阶段", exact: true });
    await expect(progress).toHaveAttribute("aria-valuenow", "1");
    await expect(progress).toHaveAttribute("aria-valuetext", "项目启动");
    await expect(progress.getByText("知识讲授", { exact: true })).toHaveCount(0);
    const geometry = await time.evaluate((node) => {
      const header = node.closest("header")!;
      const rects = Array.from(header.children).map((child) => child.getBoundingClientRect());
      return {
        overflow: header.scrollWidth - header.clientWidth,
        overlaps: rects.some((rect, index) => rects.slice(index + 1).some((other) => Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 1 && Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 1)),
      };
    });
    expect(geometry).toEqual({ overflow: 0, overlaps: false });
    await time.getByRole("button", { name: "课堂计时控制", exact: true }).click();
    const timer = page.getByRole("dialog", { name: "课堂计时控制", exact: true });
    await expect(timer).toBeInViewport({ ratio: 1 });
    await expect(timer.getByRole("button", { name: "继续", exact: true })).toBeVisible();
    for (const button of await timer.getByRole("button").all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await screenshot(page, info, "header-time-controls");
    await timer.getByRole("button", { name: "关闭计时控制", exact: true }).click();
    await selectClassroomView(page, "班级学情");
    await expect(time).toBeInViewport({ ratio: 1 });
    await screenshot(page, info, "persistent-classroom-time");
    expect(fixture.writes).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("header timer controls share the classroom clock and stage progress follows teaching changes", async ({ page }) => {
  const fixture = await mockClassroom(page, { rejectFullscreen: true });
  await enterFullscreen(page, "授课展示", true);
  const time = page.getByRole("group", { name: "课堂时间", exact: true });
  await time.getByRole("button", { name: "课堂计时控制", exact: true }).click();
  const timer = page.getByRole("dialog", { name: "课堂计时控制", exact: true });
  const headerElapsed = time.getByText("累计授课", { exact: true }).locator("..").locator("strong");
  const popupElapsed = timer.locator("p").filter({ hasText: "累计授课" }).locator("strong");
  for (const name of ["继续", "暂停", "重计本阶段"]) {
    const receipt = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/courses/${courseId}/actions` && response.request().method() === "POST");
    await timer.getByRole("button", { name, exact: true }).click();
    expect((await receipt).status()).toBe(200);
    await expect.poll(() => fixture.course().uiState!.classroomTiming!.status).toBe(name === "继续" ? "running" : "paused");
    if (name === "继续") {
      await expect(timer.getByRole("button", { name: "暂停", exact: true })).toBeVisible();
      await expect(headerElapsed).not.toHaveText("00:00");
    } else {
      await expect(timer.getByRole("button", { name: "继续", exact: true })).toBeVisible();
      await expect(popupElapsed).toHaveText(await headerElapsed.innerText());
      if (name === "重计本阶段") await expect(headerElapsed).toHaveText("00:00");
      else await expect(headerElapsed).not.toHaveText("00:00");
    }
  }
  expect(fixture.course().uiState!.classroomTiming!.stages[0].elapsedSec).toBe(0);
  await page.keyboard.press("Escape");
  await expect(timer).toBeHidden();
  await expect(page.getByRole("button", { name: "全屏授课", exact: true })).toBeVisible();
  await expect(time.getByRole("button", { name: "课堂计时控制", exact: true })).toBeFocused();
  await page.getByRole("combobox", { name: "当前教学阶段", exact: true }).selectOption("1");
  await page.getByRole("dialog").getByRole("button", { name: "进入“知识讲授”", exact: true }).click();
  const progress = page.getByRole("progressbar", { name: "教学阶段", exact: true });
  await expect(progress).toHaveAttribute("aria-valuenow", "2");
  await expect(progress).toHaveAttribute("aria-valuetext", "知识讲授");
  await expect(progress.getByText("项目启动", { exact: true })).toHaveCount(0);
  await expect(progress.locator('[data-state="complete"]')).toHaveCount(1);
  await expect(progress.locator('[data-state="current"]')).toHaveCount(1);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

for (const viewport of [
  { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 1280, height: 720 },
  { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 },
  { width: 844, height: 390 }, { width: 320, height: 568 }, { width: 568, height: 320 },
]) {
  test(`stage defaults and blue transition dialog remain usable ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page);
    await enterFullscreen(page);
    const picker = page.getByRole("combobox", { name: "当前教学阶段" });
    await picker.selectOption("1");
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "切换教学阶段", exact: true })).toBeVisible();
    await expect(dialog).toHaveAttribute("data-presentation", "true");
    await expect(dialog).toContainText("接下来显示班级学情");
    await expect(dialog.getByRole("group", { name: "阶段切换方向" })).toContainText("当前阶段项目启动");
    await expect(dialog.getByRole("group", { name: "阶段切换方向" })).toContainText("即将进入知识讲授");
    const confirm = dialog.getByRole("button", { name: "进入“知识讲授”", exact: true });
    const cancel = dialog.getByRole("button", { name: "留在当前阶段", exact: true });
    for (const button of [confirm, cancel, dialog.getByRole("button", { name: "关闭对话框" })]) {
      await expect(button).toBeInViewport({ ratio: 1 });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await confirm.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(52, 74, 106)");
    expect(await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await screenshot(page, info, "stage-transition-forward");
    const writesBeforeCancel = fixture.writes.length;
    await cancel.click();
    await expect(dialog).toBeHidden();
    expect(fixture.writes).toHaveLength(writesBeforeCancel);
    await expectClassroomView(page, "授课展示");
    await picker.selectOption("1");
    await confirm.click();
    await expectClassroomView(page, "班级学情");
    await expect(page.getByRole("region", { name: "班级学情", exact: true })).toBeVisible();
    await expect.poll(() => fixture.course().currentStageIndex).toBe(1);
    await selectClassroomView(page, "授课展示");
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await enterFullscreen(page, "授课展示");
    await picker.selectOption("2");
    await expect(dialog).toContainText("知识讲授内容尚未生成或关联");
    await expect(dialog).toContainText("系统将记录本次未完成事项");
    await expect(dialog).toContainText("接下来显示授课展示");
    await screenshot(page, info, "stage-transition-incomplete");
    await dialog.getByRole("button", { name: "仍要进入“项目实践”", exact: true }).click();
    await expectClassroomView(page, "授课展示");
    await expect.poll(() => fixture.course().currentStageIndex).toBe(2);
    await picker.selectOption("1");
    await expect(dialog.getByRole("heading", { name: "回退教学阶段", exact: true })).toBeVisible();
    await expect(dialog).toContainText("已有课堂记录将保留");
    await dialog.getByRole("button", { name: "确认回退到“知识讲授”", exact: true }).click();
    await expectClassroomView(page, "班级学情");
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

async function assertNoPageOverflow(page: Page, mode: "classroom" | "posttest" = "classroom") {
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    height: window.innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
  // The presentation's content area may scroll; the fixed outer frame must fit.
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height + 1);
  const fullscreen = page.getByRole("button", { name: /^(全屏授课|退出全屏)$/ });
  await expect(fullscreen).toBeInViewport();
  if (mode !== "posttest") {
    await expect(page.getByRole("button", { name: "授课展示", exact: true })).toBeInViewport();
  }
  const stageNumber = await page.getByRole("progressbar", { name: "教学阶段", exact: true }).getAttribute("aria-valuenow");
  const noWorkspace = stageNumber === "1" || stageNumber === "2" || stageNumber === "3" || stageNumber === "4";
  const controls = noWorkspace ? ["工具"] : ["课堂操作", "工具"];
  const footer = page.locator('footer[aria-label="课堂操作栏"]');
  const navigation = footer.getByRole("group", { name: "教学阶段切换" });
  await navigation.scrollIntoViewIfNeeded();
  await expect(navigation).toBeInViewport({ ratio: 1 });
  await assertFooterOrder(page);
  const isLastStage = await footer.getByRole("combobox", { name: "当前教学阶段" }).evaluate(select => {
    const element = select as HTMLSelectElement;
    return element.selectedIndex === element.options.length - 1;
  });
  if (isLastStage) controls.push("结束课堂");
  else await expect(footer.getByRole("button", { name: "结束课堂", exact: true })).toHaveCount(0);
  if (noWorkspace) await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
  for (const name of controls) {
    const control = page.getByRole("button", { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport();
    const box = await control.boundingBox();
    expect(box?.height, `${name} click target`).toBeGreaterThanOrEqual(44);
  }
}

async function assertFooterOrder(page: Page) {
  const right = page.locator('footer[aria-label="课堂操作栏"]').getByRole("group", { name: "右侧课堂操作" });
  const order = await right.evaluate(node => {
    const tools = Array.from(node.children).find(child => child.textContent === "工具")!;
    const navigation = node.querySelector('[aria-label="教学阶段切换"]')!;
    const actions = node.querySelector('[aria-label="当前阶段常用操作"]')!;
    const toolRect = tools.getBoundingClientRect();
    const navRect = navigation.getBoundingClientRect();
    const sync = Array.from(actions.querySelectorAll("button")).find(button => button.textContent === "同步到学生");
    const syncRect = sync?.getBoundingClientRect();
    return {
      navigationIsLast: navigation === node.lastElementChild,
      toolsBeforeNavigation: tools.nextElementSibling === navigation,
      toolsVisuallyBeforeNavigation: Math.abs(toolRect.top - navRect.top) < 1 ? toolRect.right <= navRect.left : toolRect.bottom <= navRect.top,
      syncVisuallyBeforeTools: !syncRect || (Math.abs(syncRect.top - toolRect.top) < 1 ? syncRect.right <= toolRect.left : syncRect.bottom <= toolRect.top),
    };
  });
  expect(order).toEqual({ navigationIsLast: true, toolsBeforeNavigation: true, toolsVisuallyBeforeNavigation: true, syncVisuallyBeforeTools: true });
}

async function screenshot(page: Page, info: TestInfo, name: string, fullPage = true) {
  const path = info.outputPath(`${name}.png`);
  await captureDesktopScreenshot(page, path, fullPage);
  await info.attach(name, { path, contentType: "image/png" });
}

async function inspectClassroomTools(page: Page) {
  const footer = page.locator('footer[aria-label="课堂操作栏"]');
  await expect(footer.getByRole("button", { name: "教学建议", exact: true })).toHaveCount(0);
  await expect(footer.getByRole("button", { name: "AI 公开讨论", exact: true })).toHaveCount(0);
  for (const name of ["学生邀请码", "在线学生"]) {
    await page.getByRole("button", { name: "工具", exact: true }).click();
    const tools = page.getByRole("dialog", { name: "课堂工具", exact: true });
    await expect(tools).toBeVisible();
    await expect(tools.getByRole("link", { name: "查看课程" })).toHaveAttribute("target", "_blank");
    const appearance = (element: Element) => {
      const style = getComputedStyle(element);
      return [style.height, style.fontSize, style.fontWeight, style.color, style.backgroundColor, style.border, style.borderRadius];
    };
    expect(await tools.getByRole("link", { name: "查看课程" }).evaluate(appearance)).toEqual(await tools.getByRole("button", { name: "课堂计时" }).evaluate(appearance));
    await tools.getByRole("button", { name, exact: true }).click();
    const detail = page.getByRole("dialog", { name, exact: true });
    await expect(detail).toBeVisible();
    if (name === "学生邀请码") await expect(detail.getByRole("button", { name: "复制", exact: true })).toBeInViewport({ ratio: 1 });
    else await expect(detail.getByText("私密学生1", { exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await page.getByRole("dialog", { name: "课堂工具", exact: true }).getByRole("button", { name: "教学建议", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "教学建议", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

async function assertWorkspaceFrame(page: Page) {
  const workspace = page.locator("section.classroom-stage[data-details='true']");
  await expect(workspace).toBeVisible();
  const appearance = await workspace.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, border: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth], shadow: style.boxShadow };
  });
  expect(appearance.background).toBe("rgba(0, 0, 0, 0)");
  expect(appearance.border).toEqual(["0px", "0px", "0px", "0px"]);
  expect(appearance.shadow).toBe("none");
  const measureLayout = () => workspace.evaluate((node: HTMLElement) => {
    const footer = document.querySelector('footer[aria-label="课堂操作栏"]')!;
    const footerBounds = footer.getBoundingClientRect();
    let scrollHost: HTMLElement | undefined;
    for (let candidate: HTMLElement | null = node; candidate; candidate = candidate.parentElement) {
      const style = getComputedStyle(candidate);
      if (/(auto|scroll)/.test(style.overflowY) && candidate.scrollHeight > candidate.clientHeight + 1) { scrollHost = candidate; break; }
    }
    const bounds = (scrollHost ?? node).getBoundingClientRect();
    let scrolled = false;
    if (scrollHost) {
      const original = scrollHost.scrollTop;
      scrollHost.scrollTop = scrollHost.scrollHeight;
      scrolled = scrollHost.scrollTop > 0;
      scrollHost.scrollTop = original;
    }
    return { bottom: bounds.bottom, footerTop: footerBounds.top, needsScroll: Boolean(scrollHost), scrolled };
  });
  let layout = await measureLayout();
  await expect.poll(async () => {
    layout = await measureLayout();
    return layout.bottom - layout.footerTop;
  }, { message: "The stage transition settles with the workspace above the fixed footer" }).toBeLessThanOrEqual(1);
  if (layout.needsScroll) expect(layout.scrolled).toBe(true);
  const returnButton = page.locator('footer[aria-label="课堂操作栏"]').getByRole("button", { name: /^返回(展示|汇总)$/ });
  await expect(returnButton).toBeInViewport({ ratio: 1 });
  // Real hit testing catches a workspace child painting over the fixed footer.
  expect(await returnButton.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit === node || node.contains(hit);
  })).toBe(true);
}

async function enterPosttest(page: Page) {
  await enterFullscreen(page);
  await page.getByRole("combobox", { name: "当前教学阶段" }).selectOption("4");
  await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
  await expect(page.getByRole("region", { name: "后测进度", exact: true })).toBeVisible();
}

async function assertPosttestCounts(page: Page, counts: [number, number, number]) {
  const statistics = page.getByLabel("后测人数统计", { exact: true });
  for (const [index, status] of ["未开始", "作答中", "已提交"].entries()) {
    const card = statistics.locator(":scope > div").filter({ hasText: status });
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeInViewport({ ratio: 0.98 });
    await expect(card.locator("strong")).toHaveText(String(counts[index]));
  }
  const progress = page.getByRole("progressbar", { name: "后测提交进度", exact: true });
  await expect(progress).toHaveAttribute("aria-valuenow", String(counts[2]));
  await expect(progress).toHaveAttribute("aria-valuemax", String(counts.reduce((sum, count) => sum + count, 0)));
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1280, height: 720 }, { width: 1024, height: 768 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }, { width: 390, height: 844 }]) {
  test(`posttest progress protects projected answers and keeps teacher details usable ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { posttestResponses: true });
    await enterPosttest(page);
    const board = page.getByRole("region", { name: "后测进度", exact: true });
    await assertPosttestCounts(page, [31, 2, 3]);
    await expect(board).toContainText("3/36 人已提交正式后测。草稿不计入提交人数。");
    await expect(board).not.toContainText("私密学生");
    await expect(board).not.toContainText("后测原文");
    await assertNoPageOverflow(page, "posttest");
    await screenshot(page, info, "posttest-projected-progress");

    await page.getByRole("button", { name: "课堂操作", exact: true }).click();
    await assertWorkspaceFrame(page);
    await expect(board.getByRole("link", { name: "实验配置", exact: true })).toHaveAttribute("href", "/teacher/classes/presentation-offering/activities/presentation-activity/experiment");
    const student = board.locator("#posttest-student-student-0");
    await student.locator("summary").click();
    const pretest = student.getByRole("region", { name: "前测正式答案", exact: true });
    const posttest = student.getByRole("region", { name: "后测正式答案", exact: true });
    await expect(pretest).toContainText("前测原文1");
    await expect(pretest).not.toContainText("后测原文");
    await expect(posttest).toContainText("后测原文1");
    await expect(posttest).not.toContainText("前测原文");
    await expect(posttest).toContainText("参考答案：统一观察时长并记录数量");
    await expect(posttest).toContainText("客观题 1/1");
    const answer = posttest.getByText("学生作答：后测原文1：对比同一时段的用电数据，核验节能方案。", { exact: true });
    await answer.scrollIntoViewIfNeeded();
    await expect(answer).toBeInViewport({ ratio: 1 });
    await screenshot(page, info, "posttest-formal-answers");
    await page.getByRole("button", { name: "返回展示", exact: true }).click();
    await expect(board).not.toContainText("私密学生");
    await expect(board.getByRole("region", { name: "后测正式答案" })).toHaveCount(0);
    await assertPosttestCounts(page, [31, 2, 3]);
    await assertNoPageOverflow(page, "posttest");
    expect(fixture.course().currentStageIndex).toBe(4);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.writes[0]!.body.action).toMatchObject({ type: "UPDATE_COURSE", payload: { patch: { currentStageIndex: 4 } } });
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("empty posttest results show no submitted students or invented formal answers", async ({ page }) => {
  const fixture = await mockClassroom(page);
  await enterPosttest(page);
  await assertPosttestCounts(page, [36, 0, 0]);
  await expect(page.getByRole("region", { name: "后测进度" })).toContainText("0/36 人已提交正式后测。");
  await page.getByRole("button", { name: "课堂操作", exact: true }).click();
  const board = page.getByRole("region", { name: "后测进度", exact: true });
  await expect(board.locator('[id^="posttest-student-"]')).toHaveCount(36);
  await expect(board.locator("details")).toHaveCount(0);
  await expect(board.getByRole("region", { name: /正式答案$/ })).toHaveCount(0);
  await expect(board.locator("#posttest-student-student-0")).toContainText("未开始");
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("posttest refresh and paginated export preserve each student's formal pretest and posttest", async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 576 });
  const fixture = await mockClassroom(page, { posttestResponses: true });
  await enterPosttest(page);
  await page.getByRole("button", { name: "课堂操作", exact: true }).click();
  const reads = fixture.resultReads.length;
  await page.getByRole("button", { name: "刷新进度", exact: true }).click();
  await expect.poll(() => fixture.resultReads.length).toBeGreaterThan(reads);
  await expect(page.getByRole("button", { name: "刷新进度", exact: true })).toBeEnabled();
  const board = page.getByRole("region", { name: "后测进度", exact: true });
  await expect(board.locator("#posttest-student-student-3")).toContainText("作答中");
  await expect(board.locator("#posttest-student-student-3 details")).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出实验数据", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("classroom-experiments-presentation-offering.json");
  const path = info.outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const exported = JSON.parse(readFileSync(path, "utf8"));
  expect(exported.rows).toEqual(fixture.submissions);
  expect(exported.rows).toHaveLength(6);
  expect(fixture.exportCursors).toEqual([null, "page-2"]);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const viewport of [{ width: 1024, height: 576 }, { width: 1920, height: 1080 }]) {
  test(`footer starts the first ready showcase student without approval ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { waitingShowcase: true });
    await enterFullscreen(page);
    await page.getByRole("combobox", { name: "当前教学阶段" }).selectOption("3");
    await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
    const commonActions = page.getByRole("group", { name: "当前阶段常用操作", exact: true });
    const start = commonActions.getByRole("button", { name: "开始私密学生3汇报并投屏", exact: true });
    await expect(start).toBeEnabled();
    await expect(start).toBeInViewport({ ratio: 1 });
    expect(fixture.writes.filter(({ path }) => path.endsWith("/showcase/presentation"))).toEqual([]);
    await start.click();
    await expect.poll(() => fixture.writes.filter(({ path }) => path.endsWith("/showcase/presentation")).map(({ body }) => body)).toEqual([
      expect.objectContaining({ action: "start", studentId: "student-2", artifactKind: "pdf", artifactVersionId: "artifact-student-2", clientId: expect.any(String) }),
    ]);
    await expect(page.getByRole("region", { name: "作品全屏展示：已提交成果1", exact: true }).getByRole("button", { name: "结束私密学生3汇报", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "批准并开始", exact: true })).toHaveCount(0);
    await screenshot(page, info, "footer-showcase-called");
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1366, height: 768 }]) {
  test(`ordinary showcase material controls do not overlap the preview ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { waitingShowcase: true });
    await enterFullscreen(page);
    await page.getByRole("combobox", { name: "当前教学阶段" }).selectOption("3");
    await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
    const selector = page.getByRole("button", { name: "选择学生汇报材料" });
    await expect(selector).toBeVisible();
    await expect(page.getByTestId("teacher-showcase-management")).toHaveCount(0);
    await page.getByRole("button", { name: "选择学生", exact: true }).click();
    const directory = viewport.width >= 1100 ? page.getByRole("complementary", { name: "汇报学生与安排", exact: true })
      : page.getByRole("dialog", { name: "选择汇报学生", exact: true });
    await expect(directory).toBeVisible();
    await directory.getByRole("button", { name: "浏览私密学生1作品", exact: true }).click();
    if (viewport.width >= 1100) await expect(directory).toBeVisible();
    else await expect(directory).toBeHidden();
    await expect(page.locator('canvas[aria-label="PDF 第 1 页"]').first()).toBeVisible();
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await page.getByRole("button", { name: "逐页演示", exact: true }).click();
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    const zoom = page.getByRole("main", { name: "学生作品浏览", exact: true }).locator('[aria-label="作品缩放"]');
    await wakeShowcaseZoom(zoom);
    await expect(zoom.getByRole("button", { name: "缩小作品", exact: true })).toHaveCount(0);
    await zoom.getByRole("button", { name: "调整作品缩放", exact: true }).click();
    await expect(zoom.getByRole("button", { name: "缩小作品", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.locator('footer[aria-label="作品浏览操作"]')).toHaveCount(0);
    await assertShowcasePdfZoomGeometry(zoom);
    await zoom.getByRole("button", { name: "调整作品缩放", exact: true }).click();
    await enterFullscreen(page);
    await expect(selector).toContainText("已提交成果2");
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "显示班级概览" })).toHaveCount(0);
    await assertNoPageOverflow(page);
    const geometry = await selector.evaluate((node) => {
      const toolbar = node.closest("[class*=toolbar]")!;
      const preview = toolbar.nextElementSibling!.getBoundingClientRect();
      const footer = document.querySelector('footer[aria-label="课堂操作栏"]')!.getBoundingClientRect();
      return { controlBottom: toolbar.getBoundingClientRect().bottom, previewTop: preview.top, previewBottom: preview.bottom, footerTop: footer.top };
    });
    expect(geometry.previewTop).toBeGreaterThanOrEqual(geometry.controlBottom - 1);
    expect(geometry.previewBottom).toBeLessThanOrEqual(geometry.footerTop + 1);
    await screenshot(page, info, "showcase-ordinary-workspace");
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

async function assertShowcasePdfZoomGeometry(zoom: Locator, mode: "controller" | "follower" = "controller") {
  await wakeShowcaseZoom(zoom);
  const geometry = await zoom.evaluate((node, mode) => {
    const surface = node.parentElement!;
    const zoomBounds = node.getBoundingClientRect();
    const next = (mode === "follower" ? surface.firstElementChild!.lastElementChild!.querySelector("span")!
      : surface.querySelector('[aria-label="下一页"]')!).getBoundingClientRect();
    const reader = surface.firstElementChild!.getBoundingClientRect();
    const surfaceBounds = surface.getBoundingClientRect();
    return { zoomLeft: zoomBounds.left, zoomRight: zoomBounds.right, zoomBottom: zoomBounds.bottom,
      readerLeft: reader.left, readerRight: reader.right, surfaceLeft: surfaceBounds.left, surfaceRight: surfaceBounds.right,
      surfaceBottom: surfaceBounds.bottom, nextRight: next.right, nextTop: next.top,
      paged: surface.dataset.paged === "true", narrow: matchMedia("(max-width: 500px)").matches };
  }, mode);
  expect(geometry.paged).toBe(true);
  expect(Math.abs(geometry.readerLeft - geometry.surfaceLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.readerRight - geometry.surfaceRight), "PDF reader keeps its full width beneath the floating zoom").toBeLessThanOrEqual(1);
  if (geometry.narrow) expect(geometry.zoomBottom, "Mobile floating zoom stays above the central PDF page controls").toBeLessThanOrEqual(geometry.nextTop);
  else expect(geometry.nextRight, "Floating zoom stays clear of the central PDF page controls").toBeLessThanOrEqual(geometry.zoomLeft);
  expect(geometry.surfaceRight - geometry.zoomRight).toBeCloseTo(8, 0);
  expect(geometry.surfaceBottom - geometry.zoomBottom).toBeCloseTo(geometry.narrow ? 64 : 8, 0);
}

async function assertShowcaseDocumentRoom(document: Locator, minimumHeight: number, info: TestInfo, mode: string) {
  await expect(document).toBeVisible();
  await document.dispatchEvent("pointermove", { pointerType: "mouse" });
  await expect(document.locator('xpath=ancestor::*[contains(@class, "readingSurface")][1]').locator('[aria-label="作品缩放"]')).toBeVisible();
  const geometry = await document.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const overlay = node.closest('[aria-label^="作品全屏展示："]');
    const toolbar = overlay?.querySelector("header") ?? node.closest('main[aria-label="学生作品浏览"]')?.querySelector('[class*="teacherMaterialToolbar"]');
    const controls = overlay?.querySelector("footer");
    const surface = node.closest('[class*="readingSurface"]');
    const surfaceBounds = surface?.getBoundingClientRect();
    const zoom = surface?.querySelector('[aria-label="作品缩放"]')?.getBoundingClientRect();
    const classroomFooter = overlay ? undefined : globalThis.document.querySelector('footer[aria-label="课堂操作栏"]');
    const clips: number[] = [Math.max(0, -bounds.left, bounds.right - innerWidth, -bounds.top, bounds.bottom - innerHeight)];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) clips.push(Math.max(0, rect.left - bounds.left, bounds.right - rect.right));
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) clips.push(Math.max(0, rect.top - bounds.top, bounds.bottom - rect.bottom));
    }
    const editor = node.querySelector("[data-slate-editor]");
    return { width: bounds.width, height: bounds.height, top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right,
      fontSize: editor ? Number.parseFloat(getComputedStyle(editor).fontSize) : 0,
      toolbarBottom: toolbar?.getBoundingClientRect().bottom, controlsTop: controls?.getBoundingClientRect().top,
      controlsBottom: controls?.getBoundingClientRect().bottom, classroomFooterTop: classroomFooter?.getBoundingClientRect().top,
      zoomRight: zoom?.right, zoomBottom: zoom?.bottom, surfaceLeft: surfaceBounds?.left, surfaceRight: surfaceBounds?.right, surfaceBottom: surfaceBounds?.bottom,
      clipping: Math.max(...clips), pageOverflowX: globalThis.document.documentElement.scrollWidth - innerWidth,
      pageOverflowY: globalThis.document.documentElement.scrollHeight - innerHeight };
  });
  const geometryPath = info.outputPath(`showcase-document-${mode}-geometry.json`);
  writeFileSync(geometryPath, JSON.stringify(geometry, null, 2));
  await info.attach(`showcase-document-${mode}-geometry`, { path: geometryPath, contentType: "application/json" });
  expect(geometry.height, `${mode}: student document must retain a readable vertical area`).toBeGreaterThanOrEqual(minimumHeight);
  expect(geometry.width).toBeGreaterThanOrEqual(280);
  expect(geometry.fontSize, `${mode}: document text remains readable`).toBeGreaterThanOrEqual(18);
  expect(geometry.clipping).toBeLessThanOrEqual(2);
  expect(geometry.pageOverflowX).toBeLessThanOrEqual(2);
  expect(geometry.pageOverflowY).toBeLessThanOrEqual(2);
  if (geometry.toolbarBottom !== undefined) expect(geometry.top).toBeGreaterThanOrEqual(geometry.toolbarBottom - 2);
  if (geometry.controlsTop !== undefined) expect(geometry.bottom).toBeLessThanOrEqual(geometry.controlsTop + 2);
  if (geometry.classroomFooterTop !== undefined) expect(geometry.bottom).toBeLessThanOrEqual(geometry.classroomFooterTop + 2);
  if (geometry.surfaceLeft !== undefined) expect(Math.abs(geometry.left - geometry.surfaceLeft)).toBeLessThanOrEqual(1);
  if (geometry.surfaceRight !== undefined) expect(Math.abs(geometry.right - geometry.surfaceRight), `${mode}: the document fills the reading surface without a reserved zoom gutter`).toBeLessThanOrEqual(1);
  if (geometry.surfaceRight !== undefined && geometry.zoomRight !== undefined) {
    expect(geometry.surfaceRight - geometry.zoomRight).toBeGreaterThanOrEqual(0);
    expect(geometry.surfaceRight - geometry.zoomRight).toBeLessThanOrEqual(16);
  }
  if (geometry.surfaceBottom !== undefined && geometry.zoomBottom !== undefined) {
    expect(geometry.surfaceBottom - geometry.zoomBottom).toBeGreaterThanOrEqual(0);
    expect(geometry.surfaceBottom - geometry.zoomBottom).toBeLessThanOrEqual(16);
  }
}

async function firstVisibleShowcaseBlock(document: Locator) {
  return document.evaluate((node) => [...node.querySelectorAll<HTMLElement>("[data-showcase-block]")]
    .find((block) => block.getBoundingClientRect().bottom > node.getBoundingClientRect().top + 1)?.dataset.showcaseBlock);
}

async function showcaseDocumentMetrics(document: Locator) {
  return document.evaluate((node) => ({
    fontSize: Number.parseFloat(getComputedStyle(node.querySelector("[data-slate-editor]")!).fontSize),
    contentHeight: node.scrollHeight,
  }));
}

async function shrinkShowcaseDocument(zoom: Locator) {
  await wakeShowcaseZoom(zoom);
  await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText("100%");
  await openShowcaseZoom(zoom);
  await zoom.getByRole("button", { name: "缩小作品", exact: true }).click();
  await zoom.getByRole("button", { name: "缩小作品", exact: true }).click();
  await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText("80%");
}

async function openShowcaseZoom(zoom: Locator) {
  await wakeShowcaseZoom(zoom);
  const trigger = zoom.getByRole("button", { name: "调整作品缩放", exact: true });
  if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
}

async function wakeShowcaseZoom(zoom: Locator) {
  await zoom.locator("..").dispatchEvent("pointermove", { pointerType: "mouse" });
  await expect(zoom).toBeVisible();
}

for (const { viewport, minimumHeight } of [
  { viewport: { width: 1366, height: 768 }, minimumHeight: 400 },
  { viewport: { width: 1024, height: 576 }, minimumHeight: 260 },
  { viewport: { width: 820, height: 1180 }, minimumHeight: 680 },
  { viewport: { width: 390, height: 844 }, minimumHeight: 350 },
  { viewport: { width: 844, height: 390 }, minimumHeight: 130 },
]) {
  test(`showcase long document stays readable in ordinary and fullscreen modes ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { showcaseDocument: true });
    const document = page.getByLabel("最终文档预览", { exact: true });
    const zoom = page.getByRole("main", { name: "学生作品浏览", exact: true }).locator('[aria-label="作品缩放"]');
    const sidebar = page.getByRole("complementary", { name: "汇报学生与安排", exact: true });
    const hasSidebar = viewport.width >= 1100;
    const material = page.getByRole("button", { name: "选择学生汇报材料", exact: true });
    await expect(sidebar.getByText("点击姓名预览作品，加入名单后按顺序汇报。", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/本轮汇报完成，可继续添加学生/)).toHaveCount(0);
    await expect(material).toHaveText(showcaseDocumentTitle);
    await expect(page.locator('footer[aria-label="作品浏览操作"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
    await expect(document.getByRole("heading", { name: "校园能源观察成果", exact: true })).toBeVisible();
    await screenshot(page, info, "showcase-document-ordinary");
    await assertShowcaseDocumentRoom(document, minimumHeight, info, "ordinary");
    await expect(page.getByRole("main", { name: "学生作品浏览", exact: true }).getByText(showcaseRecommendationReason, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "人数与时间", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "教案要求", exact: true })).toHaveCount(0);
    const originalMetrics = await showcaseDocumentMetrics(document);
    await shrinkShowcaseDocument(zoom);
    await expect.poll(async () => (await showcaseDocumentMetrics(document)).fontSize).toBeCloseTo(originalMetrics.fontSize * .8, 1);
    await expect.poll(async () => (await showcaseDocumentMetrics(document)).contentHeight).toBeLessThan(originalMetrics.contentHeight);
    const smallerMetrics = await showcaseDocumentMetrics(document);
    await screenshot(page, info, "showcase-document-80-percent");
    await openShowcaseZoom(zoom);
    await zoom.getByRole("button", { name: "恢复100%", exact: true }).click();
    await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText("100%");
    await expect.poll(async () => (await showcaseDocumentMetrics(document)).fontSize).toBeCloseTo(originalMetrics.fontSize, 1);
    await expect.poll(async () => (await showcaseDocumentMetrics(document)).contentHeight).toBeGreaterThan(smallerMetrics.contentHeight);
    const zoomMetricsPath = info.outputPath("showcase-document-zoom-metrics.json");
    writeFileSync(zoomMetricsPath, JSON.stringify({ original: originalMetrics, zoom80: smallerMetrics, restored: await showcaseDocumentMetrics(document) }, null, 2));
    await info.attach("showcase-document-zoom-metrics", { path: zoomMetricsPath, contentType: "application/json" });
    if (hasSidebar) {
      await expect(sidebar).toBeInViewport({ ratio: 1 });
      await expect(sidebar.getByRole("tab", { name: "全部学生", exact: true })).toHaveAttribute("aria-selected", "true");
      await sidebar.getByRole("button", { name: "浏览私密学生2作品", exact: true }).click();
      await expect(page.getByRole("heading", { name: "尚无可展示作品", exact: true })).toBeVisible();
      await sidebar.getByRole("button", { name: "浏览私密学生1作品", exact: true }).click();
      await expect(document.getByRole("heading", { name: "校园能源观察成果", exact: true })).toBeVisible();
      expect(fixture.writes).toEqual([]);
    } else await expect(sidebar).toBeHidden();

    for (const fullscreen of [false, true]) {
      if (fullscreen) {
        await shrinkShowcaseDocument(zoom);
        await enterFullscreen(page);
        await expect.poll(() => page.evaluate(() => Boolean(globalThis.document.fullscreenElement))).toBe(true);
        await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText("80%");
        await expect.poll(async () => (await showcaseDocumentMetrics(document)).fontSize).toBeCloseTo(originalMetrics.fontSize * .8, 1);
        await openShowcaseZoom(zoom);
        await zoom.getByRole("button", { name: "恢复100%", exact: true }).click();
        await assertShowcaseDocumentRoom(document, minimumHeight, info, "browser-fullscreen");
      }
      await document.evaluate((node) => { node.scrollTop = 900; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
      expect(await document.evaluate((node) => node.scrollTop)).toBeGreaterThan(800);
      if (hasSidebar) {
        const heightBefore = await document.evaluate((node) => node.getBoundingClientRect().height);
        const anchorBefore = await firstVisibleShowcaseBlock(document);
        expect(anchorBefore).toBeTruthy();
        await sidebar.getByRole("button", { name: "收起汇报侧栏", exact: true }).click();
        await expect(sidebar).toBeHidden();
        await expect.poll(() => document.evaluate((node) => node.getBoundingClientRect().height)).toBeCloseTo(heightBefore, 0);
        await expect.poll(() => firstVisibleShowcaseBlock(document)).toBe(anchorBefore);
        await page.getByRole("button", { name: "选择学生", exact: true }).click();
        await expect(sidebar).toBeInViewport({ ratio: 1 });
        await expect(page.getByRole("dialog", { name: "选择汇报学生", exact: true })).toBeHidden();
        await expect.poll(() => document.evaluate((node) => node.getBoundingClientRect().height)).toBeCloseTo(heightBefore, 0);
        await expect.poll(() => firstVisibleShowcaseBlock(document)).toBe(anchorBefore);
      }
      const scrollBefore = await document.evaluate((node) => node.scrollTop);
      for (const drawer of [
        { button: /^汇报安排/, title: "汇报安排" },
        { button: /^推荐依据$/, title: "推荐依据" },
        { button: /^更多$/, title: "更多操作" },
        { button: /^选择学生$/, title: "选择汇报学生" },
      ]) {
        if (hasSidebar && drawer.title === "选择汇报学生") continue;
        let trigger: Locator;
        if (drawer.title === "选择汇报学生") trigger = page.getByRole("button", { name: drawer.button });
        else if (hasSidebar) trigger = sidebar.getByRole("button", { name: drawer.button });
        else {
          await page.getByRole("button", { name: "选择学生", exact: true }).click();
          trigger = page.getByRole("dialog", { name: "选择汇报学生", exact: true }).getByRole("button", { name: drawer.button });
        }
        await trigger.click();
        const dialog = page.getByRole("dialog", { name: drawer.title, exact: true });
        await expect(dialog).toBeInViewport({ ratio: 1 });
        expect(await dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(2);
        if (drawer.title === "推荐依据") await expect(dialog.getByText(showcaseRecommendationReason, { exact: true })).toBeVisible();
        if (!hasSidebar && drawer.title !== "选择汇报学生") await expect(page.getByRole("dialog", { name: "选择汇报学生", exact: true })).toBeHidden();
        if (drawer.title === "更多操作") {
          await expect(dialog.getByRole("heading", { name: "成果评分", exact: true })).toBeVisible();
          await expect(dialog.getByRole("link", { name: "下载全班成果", exact: true })).toBeVisible();
        }
        if (drawer.title === "汇报安排") {
          await expect(dialog.getByRole("button", { name: "人数与时间", exact: true })).toBeVisible();
          await expect(dialog.getByRole("button", { name: "教案要求", exact: true })).toBeVisible();
          await expect(dialog.getByRole("button", { name: "采用推荐名单", exact: true })).toBeEnabled();
        }
        await dialog.getByRole("button", { name: `关闭${drawer.title}`, exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect.poll(() => document.evaluate((node) => node.scrollTop)).toBeCloseTo(scrollBefore, 0);
      }
      await document.evaluate((node) => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
      await expect(document.getByText(showcaseDocumentEnd, { exact: true })).toBeInViewport({ ratio: 1 });
      if (fullscreen) await screenshot(page, info, "showcase-document-browser-fullscreen");
    }

    await shrinkShowcaseDocument(zoom);
    await page.getByRole("button", { name: "本机全屏展示", exact: true }).click();
    const local = page.getByRole("dialog", { name: `作品全屏展示：${showcaseDocumentTitle}`, exact: true });
    await expect(local).toBeVisible();
    const localDocument = local.getByLabel("最终文档预览", { exact: true });
    const localZoom = local.locator('[aria-label="作品缩放"]');
    await expect(localZoom.getByLabel("文档缩放比例", { exact: true })).toHaveText("80%");
    await expect.poll(async () => (await showcaseDocumentMetrics(localDocument)).fontSize).toBeCloseTo(originalMetrics.fontSize * .8, 1);
    await openShowcaseZoom(localZoom);
    await localZoom.getByRole("button", { name: "恢复100%", exact: true }).click();
    await assertShowcaseDocumentRoom(localDocument, viewport.height - 160, info, "local-fullscreen");
    await expect(local.getByRole("button", { name: "返回作品浏览", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(local.getByRole("button", { name: "浏览器全屏", exact: true })).toHaveCount(0);
    await localDocument.evaluate((node) => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await expect(localDocument.getByText(showcaseDocumentEnd, { exact: true })).toBeInViewport({ ratio: 1 });
    await screenshot(page, info, "showcase-document-local-fullscreen");
    await shrinkShowcaseDocument(localZoom);
    await local.getByRole("button", { name: "返回作品浏览", exact: true }).click();
    await expect(local).toBeHidden();
    await expect.poll(() => page.evaluate(() => Boolean(globalThis.document.fullscreenElement))).toBe(true);
    await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText("80%");
    await expect.poll(async () => (await showcaseDocumentMetrics(document)).fontSize).toBeCloseTo(originalMetrics.fontSize * .8, 1);
    await expect(document.getByText(showcaseDocumentEnd, { exact: true })).toBeInViewport({ ratio: 1 });
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("showcase floating zoom hides when idle and returns on document interaction", async ({ page }, info) => {
  test.setTimeout(75_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  const fixture = await mockClassroom(page, { showcaseDocument: true });
  for (const fullscreen of [false, true]) {
    if (fullscreen) await page.getByRole("button", { name: "本机全屏展示", exact: true }).click();
    const root = fullscreen ? page.getByRole("dialog", { name: `作品全屏展示：${showcaseDocumentTitle}`, exact: true })
      : page.getByRole("main", { name: "学生作品浏览", exact: true });
    const document = root.getByLabel("最终文档预览", { exact: true });
    const zoom = root.locator('[aria-label="作品缩放"]');
    await expect(document).toBeVisible();
    await wakeShowcaseZoom(zoom);
    const expectedScale = fullscreen ? "80%" : "100%";
    await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText(expectedScale);
    await document.click({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(700);
    await expect(zoom).toBeVisible();
    await expect(zoom).toBeHidden({ timeout: 3_500 });
    await screenshot(page, info, `showcase-floating-zoom-idle-${fullscreen ? "fullscreen" : "ordinary"}`);

    for (const event of ["pointermove", "pointerdown", "wheel", "scroll", "keydown", "touchstart"] as const) {
      await expect(zoom).toBeHidden({ timeout: 3_500 });
      await document.dispatchEvent(event, event === "keydown" ? { key: "ArrowDown", code: "ArrowDown" }
        : event === "wheel" ? { deltaY: 20 }
          : event === "pointermove" || event === "pointerdown" ? { pointerType: "mouse" } : {});
      await expect(zoom, `${event} restores the floating zoom while reading`).toBeVisible();
      await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText(expectedScale);
    }

    await openShowcaseZoom(zoom);
    await document.hover({ position: { x: 24, y: 24 } });
    await page.waitForTimeout(2_200);
    await expect(zoom.getByRole("button", { name: "缩小作品", exact: true })).toBeVisible();
    if (!fullscreen) {
      await zoom.getByRole("button", { name: "缩小作品", exact: true }).click();
      await zoom.getByRole("button", { name: "缩小作品", exact: true }).click();
    } else {
      await zoom.getByRole("button", { name: "放大作品", exact: true }).click();
      await zoom.getByRole("button", { name: "缩小作品", exact: true }).click();
    }
    await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText("80%");
    await zoom.getByRole("button", { name: "调整作品缩放", exact: true }).click();
    await document.click({ position: { x: 8, y: 8 } });
    await expect(zoom).toBeHidden({ timeout: 3_500 });
    await document.dispatchEvent("pointermove", { pointerType: "mouse" });
    await expect(zoom).toBeVisible();
    await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText("80%");
    if (fullscreen) await root.getByRole("button", { name: "返回作品浏览", exact: true }).click();
  }
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("showcase student tabs distinguish browsing from the ordered presentation list", async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const fixture = await mockClassroom(page, { showcaseDocument: true });
  const sidebar = page.getByRole("complementary", { name: "汇报学生与安排", exact: true });
  const all = sidebar.getByRole("tab", { name: "全部学生", exact: true });
  const recommended = sidebar.getByRole("tab", { name: "推荐人选", exact: true });
  const selected = sidebar.getByRole("tab", { name: /^汇报名单 / });
  const students = sidebar.getByRole("button", { name: /^浏览私密学生\d+作品$/ });
  await expect(all).toHaveAttribute("aria-selected", "true");
  await expect(students).toHaveCount(36);
  await expect(sidebar.getByRole("button", { name: "浏览私密学生1作品", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const row of (await sidebar.locator("article").all()).slice(0, 3)) {
    expect((await row.boundingBox())!.height, "student rows remain compact with long recommendation reasons").toBeLessThanOrEqual(112);
  }
  await expect(sidebar.getByRole("button", { name: /私密学生\d+[上下]移$/ })).toHaveCount(0);

  await selected.click();
  await expect(sidebar.getByRole("heading", { name: "还没有汇报人选", exact: true })).toBeVisible();
  await sidebar.getByRole("button", { name: "浏览全部学生", exact: true }).click();
  await recommended.click();
  await expect(students).toHaveCount(1);
  await expect(sidebar.getByText(/优先展示作品质量较高|暂无符合条件的学生/)).toHaveCount(0);
  await all.click();
  const search = sidebar.getByRole("searchbox", { name: "搜索学生姓名", exact: true });
  await search.fill("不存在的学生");
  await expect(students).toHaveCount(0);
  await sidebar.getByRole("button", { name: "清空搜索", exact: true }).click();
  await expect(search).toHaveValue("");
  await expect(students).toHaveCount(36);

  await sidebar.getByRole("button", { name: "浏览私密学生3作品", exact: true }).click();
  await expect(sidebar.getByRole("button", { name: "浏览私密学生3作品", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(fixture.writes).toEqual([]);
  for (const name of ["私密学生3", "私密学生1"]) {
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/courses/${courseId}/showcase/presentation` && response.request().method() === "POST");
    await sidebar.getByRole("button", { name: `加入${name}汇报名单`, exact: true }).click();
    expect((await saved).status()).toBe(200);
  }
  await expect(selected).toContainText("2");
  await expect(sidebar.getByRole("button", { name: /私密学生\d+[上下]移$/ })).toHaveCount(0);
  await selected.click();
  await expect(students).toHaveCount(2);
  expect(await students.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual(["浏览私密学生3作品", "浏览私密学生1作品"]);
  await expect(sidebar.locator("article").nth(0).getByLabel("汇报顺序 1", { exact: true })).toBeVisible();
  await expect(sidebar.locator("article").nth(1).getByLabel("汇报顺序 2", { exact: true })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "私密学生3上移", exact: true })).toBeDisabled();
  await expect(sidebar.getByRole("button", { name: "私密学生3下移", exact: true })).toBeEnabled();
  await expect(sidebar.getByRole("button", { name: "私密学生1上移", exact: true })).toBeEnabled();
  await expect(sidebar.getByRole("button", { name: "私密学生1下移", exact: true })).toBeDisabled();
  expect(fixture.writes.map(({ path, body }) => ({ path, action: body.action, order: body.orderedStudentIds }))).toEqual([
    { path: `/api/courses/${courseId}/showcase/presentation`, action: "save-queue", order: ["student-2"] },
    { path: `/api/courses/${courseId}/showcase/presentation`, action: "save-queue", order: ["student-2", "student-0"] },
  ]);
  await expect(sidebar.getByRole("button", { name: "安排私密学生3下一位", exact: true })).toBeDisabled();
  for (const operation of [
    { name: "安排私密学生1下一位", order: ["浏览私密学生1作品", "浏览私密学生3作品"] },
    { name: "私密学生1下移", order: ["浏览私密学生3作品", "浏览私密学生1作品"] },
    { name: "移除私密学生3汇报名单", order: ["浏览私密学生1作品"] },
  ]) {
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/courses/${courseId}/showcase/presentation` && response.request().method() === "POST");
    await sidebar.getByRole("button", { name: operation.name, exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect.poll(() => students.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual(operation.order);
  }
  await expect(page.getByRole("button", { name: "开始私密学生1汇报并投屏", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "选择学生汇报材料", exact: true })).toHaveText("第二份节能观察与实施方案");
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
  await screenshot(page, info, "showcase-ordered-student-list");
});

test("showcase local fullscreen opens in one click and returns to a window", async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.addInitScript(() => {
    const original = Element.prototype.requestFullscreen;
    Element.prototype.requestFullscreen = function (...args) {
      document.documentElement.dataset.fullscreenRequests = String(Number(document.documentElement.dataset.fullscreenRequests ?? 0) + 1);
      return original.apply(this, args);
    };
  });
  const fixture = await mockClassroom(page, { showcaseDocument: true });
  const document = page.getByLabel("最终文档预览", { exact: true });
  const trigger = page.getByRole("button", { name: "本机全屏展示", exact: true });
  const zoom = page.locator('[aria-label="作品缩放"]');
  await expect(document).toBeVisible();
  await shrinkShowcaseDocument(zoom);
  await document.evaluate((node) => { node.scrollTop = 900; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
  const blockBefore = await firstVisibleShowcaseBlock(document);
  expect(blockBefore).toBeTruthy();
  expect(await page.evaluate(() => Boolean(globalThis.document.fullscreenElement))).toBe(false);
  await trigger.click();
  const local = page.getByRole("dialog", { name: `作品全屏展示：${showcaseDocumentTitle}`, exact: true });
  const localDocument = local.getByLabel("最终文档预览", { exact: true });
  await expect(local).toBeVisible();
  await expect.poll(() => page.evaluate(() => Boolean(globalThis.document.fullscreenElement))).toBe(true);
  expect(await page.locator("html").getAttribute("data-fullscreen-requests")).toBe("1");
  await expect.poll(() => firstVisibleShowcaseBlock(localDocument)).toBe(blockBefore);
  await expect(local.getByLabel("文档缩放比例", { exact: true })).toHaveText("80%");
  await expect(local.getByRole("button", { name: "退出全屏", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(local.getByRole("button", { name: "浏览器全屏", exact: true })).toHaveCount(0);
  await localDocument.evaluate((node) => { node.scrollTop = 1400; node.dispatchEvent(new Event("scroll", { bubbles: true })); });
  const blockAfter = await firstVisibleShowcaseBlock(localDocument);
  await screenshot(page, info, "showcase-one-click-native-fullscreen");
  await local.getByRole("button", { name: "返回作品浏览", exact: true }).click();
  await expect(local).toBeHidden();
  await expect.poll(() => page.evaluate(() => globalThis.document.fullscreenElement === null)).toBe(true);
  await expect(trigger).toBeFocused();
  await expect.poll(() => firstVisibleShowcaseBlock(document)).toBe(blockAfter);
  await expect(zoom.getByLabel("文档缩放比例", { exact: true })).toHaveText("80%");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const exit of ["Escape", "browser fullscreen exit"] as const) {
  test(`showcase local fullscreen restores browsing after ${exit}`, async ({ page }) => {
    const fixture = await mockClassroom(page, { showcaseDocument: true });
    const trigger = page.getByRole("button", { name: "本机全屏展示", exact: true });
    await trigger.click();
    const local = page.getByRole("dialog", { name: `作品全屏展示：${showcaseDocumentTitle}`, exact: true });
    await expect(local).toBeVisible();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    if (exit === "Escape") await page.keyboard.press("Escape");
    else await page.evaluate(() => document.exitFullscreen());
    await expect(local).toBeHidden();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("main", { name: "学生作品浏览", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const failure of ["denied", "unsupported"] as const) {
  test(`showcase local fullscreen remains usable when native fullscreen is ${failure}`, async ({ page }, info) => {
    if (failure === "unsupported") await page.addInitScript(() => {
      Object.defineProperty(Element.prototype, "requestFullscreen", { configurable: true, value: undefined });
    });
    const fixture = await mockClassroom(page, { showcaseDocument: true, rejectFullscreen: failure === "denied" });
    const trigger = page.getByRole("button", { name: "本机全屏展示", exact: true });
    await trigger.click();
    const local = page.getByRole("dialog", { name: `作品全屏展示：${showcaseDocumentTitle}`, exact: true });
    await expect(local.getByRole("heading", { name: "校园能源观察成果", exact: true })).toBeVisible();
    await expect(local.getByRole("status", { name: "全屏提示", exact: true })).toContainText(failure === "denied" ? "浏览器未允许全屏" : "浏览器不支持全屏");
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
    const retry = local.getByRole("button", { name: "进入全屏", exact: true });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(local.getByRole("status", { name: "全屏提示", exact: true })).toContainText(failure === "denied" ? "浏览器未允许全屏" : "浏览器不支持全屏");
    await screenshot(page, info, `showcase-fullscreen-${failure}`);
    await local.getByRole("button", { name: "返回作品浏览", exact: true }).click();
    await expect(local).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const scenario of [
  { state: "empty" as const, title: "本轮暂无推荐人选", noWorks: false },
  { state: "failed" as const, title: "推荐暂时不可用", noWorks: false },
  { state: "pending" as const, title: "推荐名单准备中", noWorks: false },
  { state: "empty" as const, title: "还没有可展示的作品", noWorks: true },
]) {
  test(`showcase recommendation empty state explains the next action: ${scenario.title}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const fixture = await mockClassroom(page, { showcaseDocument: true, showcaseRecommendations: scenario.state, empty: scenario.noWorks });
    const sidebar = page.getByRole("complementary", { name: "汇报学生与安排", exact: true });
    await sidebar.getByRole("tab", { name: "推荐人选", exact: true }).click();
    await expect(sidebar.getByRole("heading", { name: scenario.title, exact: true })).toBeVisible();
    await expect(sidebar.getByText(/优先展示作品质量较高|暂无符合条件的学生/)).toHaveCount(0);
    await screenshot(page, info, `showcase-recommendations-${scenario.noWorks ? "no-works" : scenario.state}`);
    await sidebar.getByRole("button", { name: "浏览全部学生", exact: true }).click();
    await expect(sidebar.getByRole("tab", { name: "全部学生", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(sidebar.getByRole("button", { name: /^浏览私密学生\d+作品$/ })).toHaveCount(scenario.noWorks ? 0 : 36);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const profile of desktopAcceptanceProfiles([{ width: 1024, height: 576 }])) {
test(`all five classroom workspaces stay unframed and clear of the footer ${profile.viewport.width}x${profile.viewport.height} ${profile.name}`, async ({ browser }, info) => {
  test.setTimeout(60_000);
  await withDesktopProfile(profile, browser, info, async ({ page }) => {
  const fixture = await mockClassroom(page);
  await enterFullscreen(page);
  for (let index = 0; index < DEFAULT_STAGES.length; index++) {
    if (index > 0) {
      await page.getByRole("combobox", { name: "当前教学阶段" }).selectOption(String(index));
      await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
    }
    if (index === 0) {
      await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "资料管理", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "资料管理", exact: true })).toBeInViewport({ ratio: 1 });
      await page.getByRole("button", { name: "关闭抽屉", exact: true }).click();
      continue;
    }
    if (index === 1) {
      await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
      await selectClassroomView(page, "班级学情");
      await page.getByRole("tab", { name: "学生明细", exact: true }).click();
      await expect(page.getByRole("tabpanel", { name: "学生明细", exact: true })).toBeVisible();
      await screenshot(page, info, "workspace-1-student-details");
      continue;
    }
    if (index === 2) {
      await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
      await selectClassroomView(page, "班级学情");
      await page.getByRole("tab", { name: "学生进度", exact: true }).click();
      await expect(page.getByRole("tabpanel", { name: "学生进度", exact: true })).toBeVisible();
      await screenshot(page, info, "workspace-2-student-progress");
      continue;
    }
    if (index === 3) {
      await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
      await expect(page.getByRole("main", { name: "学生作品浏览", exact: true })).toBeVisible();
      await assertNoPageOverflow(page);
      await screenshot(page, info, "workspace-3-showcase");
      continue;
    }
    await page.getByRole("button", { name: "课堂操作", exact: true }).click();
    await assertWorkspaceFrame(page);
    await screenshot(page, info, `workspace-${index}`);
    await page.locator('footer[aria-label="课堂操作栏"]').getByRole("button", { name: /^返回(展示|汇总)$/ }).click();
  }
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
  });
});
}

async function assertCanvasFits(page: Page, label: string) {
  const canvas = page.locator(`canvas[aria-label="${label}"]`).filter({ visible: true });
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.width)).toBeGreaterThan(0);
  const geometry = await canvas.evaluate((node: HTMLCanvasElement) => {
    const bounds = node.getBoundingClientRect();
    const clipping: string[] = [];
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const rect = ancestor.getBoundingClientRect();
      const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX);
      const clipsY = /auto|scroll|hidden|clip/.test(style.overflowY);
      if ((clipsX && (bounds.left < rect.left - 2 || bounds.right > rect.right + 2)) || (clipsY && (bounds.top < rect.top - 2 || bounds.bottom > rect.bottom + 2))) clipping.push(ancestor.className);
    }
    return { width: bounds.width, height: bounds.height, renderedRatio: bounds.width / bounds.height, sourceRatio: node.width / node.height, clipping };
  });
  expect(geometry.width).toBeGreaterThan(150);
  expect(geometry.height).toBeGreaterThan(80);
  expect(geometry.renderedRatio).toBeCloseTo(geometry.sourceRatio, 1);
  expect(geometry.clipping).toEqual([]);
  await expect(canvas).toBeInViewport({ ratio: 1 });
}

for (const viewport of [{ width: 1024, height: 576 }, { width: 1920, height: 1080 }]) {
  test(`PDF slides remain visible and retain page across views ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { pdfResource: true });
    await enterFullscreen(page);
    await assertCanvasFits(page, "PPT 第 1 页");
    await page.locator('canvas[aria-label="PPT 第 1 页"]').hover({ position: { x: 20, y: 20 } });
    await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toBeInViewport({ ratio: 1 });
    await screenshot(page, info, "pdf-first-page");
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("2");
    await assertCanvasFits(page, "PPT 第 2 页");
    await selectClassroomView(page, "班级学情");
    await selectClassroomView(page, "授课展示");
    await page.locator('canvas[aria-label="PPT 第 2 页"]').hover({ position: { x: 20, y: 20 } });
    await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("2");
    await page.getByRole("button", { name: "资料管理", exact: true }).click();
    await page.getByRole("button", { name: "关闭抽屉", exact: true }).click();
    await page.locator('canvas[aria-label="PPT 第 2 页"]').hover({ position: { x: 20, y: 20 } });
    await expect(page.getByRole("spinbutton", { name: "跳转页码" })).toHaveValue("2");
    await assertCanvasFits(page, "PPT 第 2 页");
    await expect(page.getByRole("button", { name: "上一页", exact: true })).toBeInViewport({ ratio: 1 });
    await screenshot(page, info, "pdf-preserved-second-page");
    await assertNoPageOverflow(page);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });

  test(`approved showcase PDF fits the presentation area ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { activeShowcase: true });
    await enterFullscreen(page);
    await page.getByRole("combobox", { name: "当前教学阶段" }).selectOption("3");
    await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
    await assertCanvasFits(page, "PDF 第 2 页");
    const projection = page.getByRole("region", { name: "作品全屏展示：校园节能项目最终成果", exact: true });
    await expect(projection).toBeVisible();
    await assertShowcasePdfZoomGeometry(projection.locator('[aria-label="作品缩放"]'), "follower");
    await expect(page.getByTestId("teacher-showcase-management")).toHaveCount(0);
    await expect(projection.getByText(/^2 \/ 2(?: · 跟随汇报)?$/)).toBeInViewport({ ratio: 1 });
    await expect(projection.getByRole("button", { name: "结束私密学生1汇报", exact: true })).toBeInViewport({ ratio: 1 });
    await projection.getByRole("button", { name: "浏览学生作品", exact: true }).click();
    const browser = page.getByRole("dialog", { name: "浏览学生作品", exact: true });
    await expect(browser).toBeVisible();
    await browser.getByRole("button", { name: "选择学生", exact: true }).click();
    const students = viewport.width >= 1100 ? browser.getByRole("complementary", { name: "汇报学生与安排", exact: true })
      : page.getByRole("dialog", { name: "选择汇报学生", exact: true });
    await expect(students).toBeVisible();
    await students.getByRole("button", { name: viewport.width >= 1100 ? "收起汇报侧栏" : "关闭选择汇报学生", exact: true }).click();
    await browser.getByRole("button", { name: "返回当前汇报", exact: true }).click();
    await expect(browser).toBeHidden();
    await expect(projection.getByText(/^2 \/ 2(?: · 跟随汇报)?$/)).toBeVisible();
    await screenshot(page, info, "showcase-approved-pdf");
    await projection.getByRole("button", { name: "返回作品浏览", exact: true }).click();
    await selectClassroomView(page, "班级学情");
    await expect(page.getByRole("region", { name: "班级学情大屏" })).not.toContainText("私密学生");
    await selectClassroomView(page, "授课展示");
    await page.getByRole("button", { name: "返回当前汇报", exact: true }).click();
    await assertCanvasFits(page, "PDF 第 2 页");
    await projection.getByRole("button", { name: "返回作品浏览", exact: true }).click();
    await assertNoPageOverflow(page);
    expect(fixture.writes.every(({ path }) => path.endsWith("/actions"))).toBe(true);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("showcase floating PDF zoom preserves mobile page controls", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockClassroom(page, { activeShowcase: true });
  await page.getByRole("combobox", { name: "当前教学阶段" }).selectOption("3");
  await page.getByRole("dialog").getByRole("button", { name: /进入“/ }).click();
  const projection = page.getByRole("region", { name: "作品全屏展示：校园节能项目最终成果", exact: true });
  await expect(projection).toBeVisible();
  await assertCanvasFits(page, "PDF 第 2 页");
  await assertShowcasePdfZoomGeometry(projection.locator('[aria-label="作品缩放"]'), "follower");
  await screenshot(page, info, "showcase-mobile-pdf-projection-floating-zoom");
  await projection.getByRole("button", { name: "返回作品浏览", exact: true }).click();
  const browser = page.getByRole("main", { name: "学生作品浏览", exact: true });
  await expect(browser).toBeVisible();
  await expect(browser.locator('canvas[aria-label="PDF 第 1 页"]')).toBeVisible();
  await assertShowcasePdfZoomGeometry(browser.locator('[aria-label="作品缩放"]'));
  await browser.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(browser.getByText("2 / 2", { exact: true })).toBeVisible();
  await screenshot(page, info, "showcase-mobile-pdf-ordinary-floating-zoom");
  await browser.getByRole("button", { name: "本机全屏展示", exact: true }).click();
  const local = page.getByRole("dialog", { name: "作品全屏展示：校园节能项目最终成果", exact: true });
  await expect(local).toBeVisible();
  await expect(local.getByText("2 / 2", { exact: true })).toBeVisible();
  await assertShowcasePdfZoomGeometry(local.locator('[aria-label="作品缩放"]'));
  await screenshot(page, info, "showcase-mobile-pdf-local-fullscreen-floating-zoom");
  await local.getByRole("button", { name: "返回作品浏览", exact: true }).click();
  await expect(local).toBeHidden();
  expect(fixture.writes.every(({ path }) => path.endsWith("/actions"))).toBe(true);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const viewport of [
  { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 },
  { width: 1024, height: 768 }, { width: 1024, height: 576 }, { width: 390, height: 844 },
  { width: 768, height: 1024 }, { width: 844, height: 390 },
]) {
  test(`projection layout ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page);
    await enterFullscreen(page);
    await assertNoPageOverflow(page);
    await screenshot(page, info, "teaching");
    await selectClassroomView(page, "班级学情");
    const analytics = page.getByRole("region", { name: "班级学情大屏" });
    await expect(analytics).toBeVisible();
    await expect(analytics).not.toContainText("私密学生");
    await assertNoPageOverflow(page);
    await screenshot(page, info, "analytics");
    await inspectClassroomTools(page);
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect(page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true })).toBeVisible();
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1024, height: 576 }, { width: 390, height: 844 }]) {
  test(`AI learning mountain keeps 40 students accessible in the compact chart ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { mountain: true });
    await enterFullscreen(page, "班级学情");
    await selectClassroomView(page, "班级学情");
    const mountain = page.getByRole("region", { name: "班级学习山形图" });
    await expect(mountain).toBeVisible();
    const leaderNames = mountain.locator("span").filter({ hasText: "领先学生" }).first().locator("strong");
    await expect(leaderNames).toContainText("私密学生1、私密学生10、私密学生11");
    expect(await leaderNames.evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("normal");
    const bin = mountain.getByRole("button", { name: "50–59%，40人，查看名单" });
    await expect(bin).toContainText("40 人");
    await expect(mountain.locator("svg path").last()).toHaveAttribute("d", / C /);
    await bin.hover();
    await expect(mountain.locator("svg rect")).toHaveCount(1);
    await bin.click();
    await expect(mountain.getByRole("region", { name: "50–59%学生名单" }).locator("li")).toHaveCount(40);
    await assertNoPageOverflow(page);
    await screenshot(page, info, "learning-mountain");
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("five stages retain controls, hide details on view/stage changes, and preserve save semantics", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const fixture = await mockClassroom(page);
  await enterFullscreen(page);
  for (let index = 0; index < DEFAULT_STAGES.length; index++) {
    if (index > 0) {
      await page.getByRole("combobox", { name: "当前教学阶段" }).selectOption(String(index));
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: /进入“/ }).click();
    }
    const progress = page.getByRole("progressbar", { name: "教学阶段", exact: true });
    await expect(progress).toHaveAttribute("aria-valuetext", index === 4 ? "后测" : DEFAULT_STAGES[index]!.label);
    await expect(progress).toHaveAttribute("aria-valuenow", String(index + 1));
    if (index === 4) {
      const posttest = page.getByRole("region", { name: "后测进度", exact: true });
      await expect(posttest).toBeVisible();
      await screenshot(page, info, "stage-4-posttest");
      await page.getByRole("button", { name: "课堂操作", exact: true }).click();
      await assertWorkspaceFrame(page);
      await page.getByRole("button", { name: /^返回(展示|汇总)$/ }).click();
      await expect(posttest).toBeVisible();
      await assertNoPageOverflow(page, "posttest");
      continue;
    }
    await expectClassroomView(page, index === 1 ? "班级学情" : "授课展示");
    await selectClassroomView(page, "授课展示");
    await screenshot(page, info, `stage-${index}-teaching`);
    await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
    await selectClassroomView(page, "班级学情");
    if (index === 2) {
      await expect(page.getByRole("region", { name: "第三阶段班级学情", exact: true })).toBeVisible();
      await page.getByRole("tab", { name: "学生进度", exact: true }).click();
      await selectClassroomView(page, "授课展示");
      await selectClassroomView(page, "班级学情");
      await expect(page.getByRole("tab", { name: "学生进度", exact: true })).toHaveAttribute("aria-selected", "true");
      await page.getByRole("tab", { name: "概览", exact: true }).click();
      await assertNoPageOverflow(page);
      await screenshot(page, info, "stage-2-analytics");
      continue;
    }
    await expect(page.getByRole("region", { name: index === 1 ? "班级学情概览" : "班级学情大屏", exact: true })).not.toContainText("私密学生");
    await page.getByRole("button", { name: "查看明细", exact: true }).click();
    if (index === 0) {
      await expect(page.getByRole("dialog", { name: "资料阅读明细", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "关闭抽屉", exact: true }).click();
    } else if (index === 1) {
      await expect(page.getByRole("tab", { name: "学生明细", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("button", { name: "返回汇总", exact: true })).toHaveCount(0);
    } else if (index === 3) {
      await expectClassroomView(page, "授课展示");
      await expect(page.getByRole("main", { name: "学生作品浏览", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "返回汇总", exact: true })).toHaveCount(0);
    } else await expect(page.getByRole("button", { name: "返回汇总", exact: true })).toBeVisible();
    await selectClassroomView(page, "授课展示");
    await selectClassroomView(page, "班级学情");
    if (index === 1) {
      await expect(page.getByRole("tab", { name: "学生明细", exact: true })).toHaveAttribute("aria-selected", "true");
      await page.getByRole("tab", { name: "概览", exact: true }).click();
    }
    await expect(page.getByRole("button", { name: "返回汇总", exact: true })).toHaveCount(0);
    await assertNoPageOverflow(page);
    await screenshot(page, info, `stage-${index}-analytics`);
  }
  await page.getByRole("button", { name: "工具", exact: true }).click();
  await page.getByRole("dialog", { name: "课堂工具" }).getByRole("button", { name: "课堂计时" }).click();
  const timer = page.getByRole("dialog", { name: "课堂计时" });
  await expect(timer).toBeVisible();
  const timingWritesStart = fixture.writes.length;
  const timingVersionStart = fixture.course().version!;
  async function persistTimerControl(name: string) {
    const beforeVersion = fixture.course().version!;
    const receipt = page.waitForResponse((response) => {
      const request = response.request();
      return new URL(request.url()).pathname === `/api/courses/${courseId}/actions`
        && request.method() === "POST" && request.postDataJSON()?.action?.type === "SET_UI_STATE";
    });
    await timer.getByRole("button", { name, exact: true }).click();
    const response = await receipt;
    const envelope = response.request().postDataJSON() as ActionEnvelope;
    const ack = await response.json() as ActionAck;
    expect(response.status()).toBe(200);
    expect(envelope.expectedVersion).toBe(beforeVersion);
    expect(envelope.action.type).toBe("SET_UI_STATE");
    if (envelope.action.type !== "SET_UI_STATE") throw new Error("Timer sent a non-UI action");
    expect(envelope.action.payload.courseId).toBe(courseId);
    expect(Object.keys(envelope.action.payload).sort()).toEqual(["courseId", "patch"]);
    expect(Object.keys(envelope.action.payload.patch)).toEqual(["classroomTiming"]);
    expect(ack.requestId).toBe(envelope.requestId);
    expect(ack.courseVersion).toBe(beforeVersion + 1);
    expect(ack.eventCursor).toEqual(expect.any(String));
    expect(fixture.course().version).toBe(ack.courseVersion);
    expect(fixture.course().uiState?.classroomTiming).toEqual(envelope.action.payload.patch.classroomTiming);
  }
  async function assertTimerAfterReload(plannedText: string) {
    const timing = structuredClone(fixture.course().uiState!.classroomTiming!);
    const version = fixture.course().version;
    const writes = fixture.writes.length;
    const bootstrap = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/courses" && response.request().method() === "GET");
    await page.reload({ waitUntil: "domcontentloaded" });
    const body = await (await bootstrap).json() as { courses: Course[] };
    const reloaded = body.courses.find((item) => item.id === courseId);
    expect(reloaded?.version).toBe(version);
    expect(reloaded?.uiState?.classroomTiming).toEqual(timing);
    // The final (posttest) stage intentionally hides the teaching/analytics tabs.
    await page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "后测进度", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "工具", exact: true }).click();
    await page.getByRole("dialog", { name: "课堂工具" }).getByRole("button", { name: "课堂计时" }).click();
    await expect(timer.getByRole("button", { name: "继续", exact: true })).toBeVisible();
    await expect(timer).toContainText("已暂停");
    await expect(timer).toContainText(plannedText);
    expect(fixture.writes).toHaveLength(writes);
  }
  await persistTimerControl("继续");
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.status).toBe("running");
  await persistTimerControl("暂停");
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.status).toBe("paused");
  const adjustment = fixture.course().uiState!.classroomTiming!.stages[4]!.adjustmentSec;
  await persistTimerControl("+2 分");
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.stages[4]?.adjustmentSec).toBe(adjustment + 120);
  await assertTimerAfterReload("计划 12 分");
  await persistTimerControl("-2 分");
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.stages[4]?.adjustmentSec).toBe(adjustment);
  await persistTimerControl("重计");
  await expect.poll(() => fixture.course().uiState?.classroomTiming?.stages[4]?.elapsedSec).toBe(0);
  await assertTimerAfterReload("计划 10 分 · 已用 0 秒");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "结束课堂", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "继续授课", exact: true }).click();
  expect(fixture.course().currentStageIndex).toBe(4);
  expect(fixture.writes.every(({ path }) => path.endsWith("/actions"))).toBe(true);
  expect(fixture.writes.slice(0, timingWritesStart).every(({ body }) => (body.action as { type: string }).type === "UPDATE_COURSE")).toBe(true);
  expect(fixture.writes.slice(timingWritesStart)).toHaveLength(5);
  expect(fixture.writes.slice(timingWritesStart).every(({ body }) => (body.action as { type: string }).type === "SET_UI_STATE")).toBe(true);
  expect(fixture.course().version).toBe(timingVersionStart + 5);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("fullscreen denial keeps the unified classroom and preserves its selected view", async ({ page }) => {
  const fixture = await mockClassroom(page, { rejectFullscreen: true, empty: true });
  await enterFullscreen(page, "授课展示", true);
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
  await selectClassroomView(page, "班级学情");
  await expect(page.getByText("暂无学生加入课堂", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "全屏授课", exact: true }).filter({ visible: true })).toBeVisible();
  await expectClassroomView(page, "班级学情");
  await expect(page.locator(".teacher-presentation")).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const viewport of [{ width: 1024, height: 576 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
  test(`project task fits one presentation screen ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { project: true });
    await enterFullscreen(page);
    const board = page.getByRole("region", { name: "当前阶段任务", exact: true });
    await expect(board.getByRole("heading", { name: "项目任务", exact: true })).toBeVisible();
    await expect(board.getByRole("listitem")).toHaveCount(5);
    await expect(page.locator('footer[aria-label="课堂操作栏"]').getByRole("button", { name: "学生成果", exact: true })).toBeVisible();
    const overflow = await board.evaluate((node) => {
      const result = [];
      for (let element: Element | null = node; element; element = element.parentElement) {
        if (element.scrollHeight > element.clientHeight + 1) result.push({ tag: element.tagName, className: element.className });
      }
      return result;
    });
    expect(overflow).toEqual([]);
    await screenshot(page, info, "project-task");
    await board.locator("summary").click();
    await expect(board.getByText("怎样改进校园能源使用？", { exact: true })).toBeVisible();
    await board.locator("summary").click();
    await selectClassroomView(page, "学生成果");
    await expect(board).toHaveCount(0);
    await selectClassroomView(page, "授课展示");
    await expect(board).toBeVisible();
    expect(fixture.errors).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });
}

async function verifyStudentWorkPresentation(page: Page, info: TestInfo) {
  const fixture = await mockClassroom(page, { project: true, studentWorks: true, rejectFullscreen: true });
  await enterFullscreen(page, "授课展示", true);
  const selectView = (name: ClassroomViewLabel) => selectClassroomView(page, name);
  await selectView("学生成果");
  const roster = page.getByRole("complementary", { name: "学生成果列表" });
  const preview = page.getByRole("region", { name: "学生成果预览", exact: true });
  await expect(roster.getByRole("button")).toHaveCount(36);
  await expect(preview.getByText("点击左侧学生，展示其最新保存的文档或代码。", { exact: true })).toBeVisible();
  const student = roster.getByRole("button", { name: /^私密学生1 / });
  await expect(student).toContainText("已提交 2 次");
  await student.click();
  const workContent = page.getByRole("region", { name: "私密学生1的成果内容", exact: true });
  await expect(workContent.getByText("公开展示的观察方案", { exact: true })).toBeVisible();
  await expect(page.getByText("不应展示的个人 AI 对话", { exact: true })).toHaveCount(0);
  const geometry = await roster.evaluate((node) => {
    const preview = document.querySelector('[aria-label="学生成果预览"]')!;
    const content = document.querySelector('[aria-label="私密学生1的成果内容"]')!;
    const stage = node.closest('section[aria-label="学生成果展示"]')!;
    const footer = document.querySelector('footer[aria-label="课堂操作栏"]')!;
    const rect = (element: Element) => element.getBoundingClientRect().toJSON();
    return { roster: rect(node), preview: rect(preview), content: rect(content), stage: rect(stage), footer: rect(footer), width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, pageHeightOverflow: document.documentElement.scrollHeight - innerHeight };
  });
  expect(geometry.overflow).toBeLessThanOrEqual(2);
  expect(geometry.pageHeightOverflow).toBeLessThanOrEqual(2);
  expect(geometry.roster.right).toBeLessThan(geometry.preview.left);
  expect(geometry.content.width).toBeGreaterThan(geometry.stage.width * .55);
  expect(geometry.content.height).toBeGreaterThan(geometry.stage.height - 120);
  expect(geometry.preview.bottom).toBeLessThanOrEqual(geometry.footer.top);
  expect(geometry.footer.bottom).toBeLessThanOrEqual(geometry.height + 1);
  await screenshot(page, info, "student-work-document");
  await workContent.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const lastParagraph = workContent.getByText("成果末尾的实施计划。", { exact: true });
  // Submission records follow the document; at high zoom they can fill the
  // visible pane when scrolled to its absolute bottom.
  await lastParagraph.scrollIntoViewIfNeeded();
  await expect(lastParagraph).toBeInViewport();
  await expect(roster).toBeInViewport();
  await workContent.evaluate((node) => { node.scrollTop = 120; });
  const scrollBefore = await workContent.evaluate((node) => node.scrollTop);
  fixture.updateStudentWork(`<h2>实时更新后的观察方案</h2>${fixture.course().submissions![0].content}`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(workContent.getByText("实时更新后的观察方案", { exact: true })).toHaveCount(1, { timeout: 15_000 });
  expect(await workContent.evaluate((node) => node.scrollTop)).toBeGreaterThanOrEqual(scrollBefore - 2);
  await expect(student).toHaveAttribute("aria-pressed", "true");
  await selectView("班级学情");
  await expect(page.getByRole("region", { name: "第三阶段班级学情" })).toBeVisible();
  await selectView("学生成果");
  expect(await workContent.evaluate((node) => node.scrollTop)).toBeGreaterThanOrEqual(scrollBefore - 2);
  await expect(workContent.getByText("实时更新后的观察方案", { exact: true })).toHaveCount(1);
  await selectView("授课展示");
  await expect(page.getByRole("region", { name: "当前阶段任务", exact: true })).toBeVisible();
  await selectView("学生成果");
  await roster.getByRole("button", { name: /^私密学生36 / }).click();
  await expect(preview.getByText("该学生尚未保存可展示的成果。", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索展示学生", exact: true }).fill("私密学生2");
  await roster.getByRole("button", { name: /^私密学生2 / }).click();
  await expect(preview.getByText("第二名学生的独立方案。", { exact: true })).toBeVisible();
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.writes).toEqual([]);
  await info.attach("student-work-layout", { body: JSON.stringify(geometry), contentType: "application/json" });
}

for (const profile of desktopAcceptanceProfiles([{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }])) {
  test(`student work presentation desktop ${profile.viewport.width}x${profile.viewport.height} ${profile.name}`, async ({ browser }, info) => {
    await withDesktopProfile(profile, browser, info, async ({ page }) => verifyStudentWorkPresentation(page, info));
  });
}

for (const viewport of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
  test(`student work presentation tablet ${viewport.width}x${viewport.height}`, async ({ browser }, info) => {
    const context = await browser.newContext({ viewport, hasTouch: true, reducedMotion: "reduce", baseURL: process.env.OPENPBL_RESOURCE_E2E_BASE_URL || "http://localhost:3000" });
    try { await verifyStudentWorkPresentation(await context.newPage(), info); }
    finally { await context.close(); }
  });
}

async function assertQuestionNavigationInViewport(page: Page) {
  const review = page.getByRole("region", { name: "题目讲解", exact: true });
  const navigation = review.getByRole("navigation", { name: "讲解题目翻页" });
  for (const fraction of [0, 0.5, 1]) {
    const geometry = await navigation.evaluate((node, fraction) => {
      let scroller = node.parentElement!;
      while (scroller.parentElement && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * fraction;
      const bounds = node.getBoundingClientRect();
      const viewport = scroller.getBoundingClientRect();
      const footer = document.querySelector('footer[aria-label="课堂操作栏"]')!.getBoundingClientRect();
      return { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right, width: innerWidth,
        viewportTop: viewport.top, viewportBottom: viewport.bottom, footerTop: footer.top,
        contentBottom: node.previousElementSibling!.getBoundingClientRect().bottom,
        scrollRange: scroller.scrollHeight - scroller.clientHeight };
    }, fraction);
    expect(geometry.scrollRange).toBeGreaterThan(0);
    expect(geometry.top).toBeGreaterThanOrEqual(geometry.viewportTop);
    expect(geometry.bottom).toBeLessThanOrEqual(Math.min(geometry.viewportBottom, geometry.footerTop));
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);
    // Fractional layout coordinates can outlive integer scrollTop rounding.
    if (fraction === 1) expect(geometry.contentBottom).toBeLessThanOrEqual(geometry.top + 1);
    for (const name of ["上一题", "下一题"]) {
      const button = navigation.getByRole("button", { name, exact: true });
      await expect(button).toBeInViewport({ ratio: 1 });
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(36);
    }
  }
}

async function openReviewDirectory(page: Page) {
  const review = page.getByRole("region", { name: "课堂讲解", exact: true });
  const back = review.getByRole("button", { name: /^(返回章节列表|返回知识点列表|返回目录)$/ });
  if (await back.isVisible()) await back.click();
  return review.getByRole("complementary", { name: "讲解目录", exact: true });
}

test("unified classroom review keeps the projected player mounted across questions, views and fullscreen", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  const fixture = await mockClassroom(page, { questionReview: true });
  const studentProgress = structuredClone(fixture.course().aiLearningProgress);
  await selectClassroomView(page, "课堂讲解");
  const workspace = page.locator('section[aria-label="课堂讲解"]');
  await workspace.getByRole("button", { name: "查看相关课件", exact: true }).click();
  await workspace.getByRole("button", { name: "投屏", exact: true }).click();
  const surface = page.getByRole("region", { name: "当前投屏课件", exact: true });
  await expect(surface).toBeVisible();
  await expect(workspace.getByText("投屏已提交 · 强制全屏", { exact: true })).toBeVisible();
  const iframe = surface.locator('iframe[title="授课资源播放器"]');
  const runtime = iframe.contentFrame();
  await expect(runtime.getByText("在相同时段与空间观察并记录用电量。", { exact: true })).toBeVisible();
  const originalWindow = await iframe.evaluateHandle((node: HTMLIFrameElement) => node.contentWindow);
  const originalDocument = await iframe.evaluateHandle((node: HTMLIFrameElement) => node.contentDocument);
  await iframe.evaluate((node: HTMLIFrameElement) => { node.contentDocument!.documentElement.dataset.projectionPersistence = "kept"; });
  // Send one paused playback sample from the real frame, with its real source
  // window. The API is simulated; this exercises the parent/frame runtime path.
  await runtime.locator("html").evaluate(() => {
    window.parent.postMessage({ channel: "openpbl-resource-player-v1", type: "playback",
      identity: JSON.stringify(["review-classroom", "review-slide", "teacher-resource"]),
      state: { engineMode: "paused", snapshot: { sceneId: "review-slide", sceneIndex: 0, actionIndex: 2, consumedDiscussions: [] } },
    }, window.location.origin);
  });
  await expect.poll(() => fixture.course().uiState?.teacherResourceProjection?.playback?.actionIndex).toBe(2);
  await expect.poll(() => fixture.course().uiState?.teacherResourceProjection?.engineMode).toBe("paused");
  const playback = structuredClone(fixture.course().uiState!.teacherResourceProjection!.playback);
  const startedAt = fixture.course().uiState!.teacherResourceProjection!.startedAt;
  const baselineWrites = fixture.writes.length;
  async function expectSameProjectedPlayer() {
    const current = workspace.locator('section[aria-label="当前投屏课件"] iframe');
    expect(await current.evaluate((node: HTMLIFrameElement, reference) => node.contentWindow === reference, originalWindow)).toBe(true);
    expect(await current.evaluate((node: HTMLIFrameElement, reference) => node.contentDocument === reference, originalDocument)).toBe(true);
    expect(await current.evaluate((node: HTMLIFrameElement) => node.contentDocument?.documentElement.dataset.projectionPersistence)).toBe("kept");
    expect(fixture.course().uiState?.teacherResourceProjection).toMatchObject({ sceneId: "review-slide", startedAt, engineMode: "paused", playback });
  }
  await workspace.getByRole("button", { name: /^(返回分析|返回讲题)$/ }).click();
  await expect(surface).toBeHidden();
  await expect(workspace.getByRole("button", { name: "按知识点补讲", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(workspace.getByRole("button", { name: "查看关联题目", exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "停止投屏", exact: true })).toBeVisible();
  await expectSameProjectedPlayer();
  for (const view of ["班级学情", "授课展示"] as const) {
    await selectClassroomView(page, view);
    await expect(workspace).toBeHidden();
    await expectSameProjectedPlayer();
    await selectClassroomView(page, "课堂讲解");
    await expectSameProjectedPlayer();
  }
  await workspace.getByRole("button", { name: "查看投屏", exact: true }).click();
  await expect(surface).toBeVisible();
  await expectSameProjectedPlayer();
  await enterFullscreen(page, "课堂讲解");
  await expectSameProjectedPlayer();
  await page.getByRole("button", { name: "退出全屏", exact: true }).click();
  await expectSameProjectedPlayer();
  const laterPlaybackWrites = fixture.writes.slice(baselineWrites).flatMap(({ body }) => {
    const action = body.action as { type?: string; payload?: { patch?: { teacherResourceProjection?: { playback?: unknown; engineMode?: string } } } } | undefined;
    return action?.type === "SET_UI_STATE" && action.payload?.patch?.teacherResourceProjection ? [action.payload.patch.teacherResourceProjection] : [];
  });
  for (const projection of laterPlaybackWrites) expect(projection).toMatchObject({ engineMode: "paused", playback });
  await screenshot(page, info, "classroom-review-projection-preserved");
  await workspace.getByRole("button", { name: /^(返回分析|返回讲题)$/ }).click();
  await workspace.getByRole("button", { name: "查看相关课件", exact: true }).click();
  await workspace.getByRole("button", { name: "投屏", exact: true }).click();
  await expect.poll(() => fixture.course().uiState?.teacherResourceProjection?.startedAt).not.toBe(startedAt);
  await expect.poll(() => fixture.course().uiState?.teacherResourceProjection?.playback?.actionIndex).toBe(0);
  await expect.poll(() => fixture.course().uiState?.teacherResourceProjection?.engineMode).toBe("idle");
  await expect(workspace.getByText("投屏已提交 · 强制全屏", { exact: true })).toBeVisible();
  await expect(runtime.getByText("在相同时段与空间观察并记录用电量。", { exact: true })).toBeVisible();
  expect(await iframe.evaluate((node: HTMLIFrameElement, reference) => node.contentDocument === reference, originalDocument)).toBe(false);
  expect(await iframe.evaluate((node: HTMLIFrameElement) => node.contentDocument?.documentElement.dataset.projectionPersistence)).toBeUndefined();
  await screenshot(page, info, "classroom-review-projection-restarted");
  await workspace.getByRole("button", { name: "停止投屏", exact: true }).click();
  await expect.poll(() => fixture.course().uiState?.teacherResourceProjection).toBeNull();
  await expect(workspace.locator('section[aria-label="当前投屏课件"] iframe')).toHaveCount(0);
  const stopped = await page.evaluate(async (path) => (await fetch(path)).json(), `/api/courses/${courseId}/projection`);
  expect(stopped).toMatchObject({ courseId, teacherResourceProjection: null, projectionController: null });
  expect(stopped.projectionVersion).toBeGreaterThan(1);
  expect(fixture.course().aiLearningProgress).toEqual(studentProgress);
  expect(fixture.writes.every(({ path, body }) => path.endsWith("/actions") && ["SET_UI_STATE", "ADD_ACTIVITY"].includes((body.action as { type: string }).type))).toBe(true);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
  await originalWindow.dispose();
  await originalDocument.dispose();
});

test("unified classroom review keeps all courseware reachable with an empty directory on a narrow screen", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await mockClassroom(page, { questionReview: true, reviewEmptyDirectory: true });
  await selectClassroomView(page, "课堂讲解");
  const workspace = page.getByRole("region", { name: "课堂讲解", exact: true });
  await workspace.getByRole("button", { name: "浏览全部课件", exact: true }).click();
  await page.getByRole("dialog", { name: "选择讲解课件", exact: true }).getByRole("button", { name: "预览第 1 页：统一观察条件", exact: true }).click();
  await expect(workspace.getByRole("region", { name: "课件预览", exact: true })).toBeVisible();
  await expect(workspace.getByRole("button", { name: "投屏", exact: true })).toBeEnabled();
  await assertNoPageOverflow(page);
  await screenshot(page, info, "classroom-review-empty-directory");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("dual-mode classroom review retains saved attempts and retries an unavailable full catalog", async ({ page }, info) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const fixture = await mockClassroom(page, { questionReview: true });
  let rejectOriginals = true;
  await page.route("**/api/openmaic/classroom?**", async (route) => {
    if (rejectOriginals) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "原题目录暂时不可用" }) });
    return route.fallback();
  });
  await selectClassroomView(page, "课堂讲解");
  const workspace = page.getByRole("region", { name: "课堂讲解", exact: true });
  await expect(workspace).toContainText("完整题目目录未加载，已保存的作答仍可查看。");
  await workspace.getByRole("button", { name: "按章节查题", exact: true }).click();
  const review = workspace.getByRole("region", { name: "题目讲解", exact: true });
  const prompt = "为比较两种照明方案，哪种观察记录更可靠？";
  await expect(review.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
  await expect(review.getByLabel("本题作答情况", { exact: true })).toContainText("答错 2/3 人");
  await expect(review.getByRole("combobox", { name: "选择讲解题目", exact: true }).locator("option")).toHaveCount(2);
  rejectOriginals = false;
  await workspace.getByRole("button", { name: "重试加载题目目录", exact: true }).click();
  await expect(review.getByRole("combobox", { name: "选择讲解题目", exact: true }).locator("option")).toHaveCount(3);
  await expect(workspace.getByRole("button", { name: "重试加载题目目录", exact: true })).toHaveCount(0);
  await expect(review.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
  await screenshot(page, info, "dual-mode-catalog-retry");
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 1024, height: 360 }]) {
  test(`dual-mode classroom review connects knowledge evidence to chapter questions and unsubmitted originals ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { questionReview: true, reviewEarlierCorrectChapter: true });
    await selectClassroomView(page, "课堂讲解");
    const workspace = page.getByRole("region", { name: "课堂讲解", exact: true });
    const review = workspace.getByRole("region", { name: "题目讲解", exact: true });
    const knowledgeMode = workspace.getByRole("button", { name: "按知识点补讲", exact: true });
    const chapterMode = workspace.getByRole("button", { name: "按章节查题", exact: true });
    async function expectModesInViewport(checkpoint: string) {
      try {
        await expect(knowledgeMode).toBeInViewport({ ratio: 1 });
        await expect(chapterMode).toBeInViewport({ ratio: 1 });
      } catch (cause) {
        await screenshot(page, info, `dual-mode-tabs-${checkpoint}`);
        throw cause;
      }
    }
    const prompt = "为比较两种照明方案，哪种观察记录更可靠？";
    await expect(knowledgeMode).toHaveAttribute("aria-pressed", "true");
    await expect(chapterMode).toHaveAttribute("aria-pressed", "false");
    const knowledgeDirectory = await openReviewDirectory(page);
    const evidencePoint = knowledgeDirectory.getByRole("button", { name: "控制变量与观察证据", exact: true });
    await expect(evidencePoint).toContainText("样本不足");
    await expect(evidencePoint).not.toContainText(/未达标|有效作答|\d+ 人/);
    const pointDensity = await evidencePoint.evaluate((node) => ({ height: node.getBoundingClientRect().height,
      titleSize: parseFloat(getComputedStyle(node.querySelector("strong")!).fontSize) }));
    expect(pointDensity.height).toBeLessThanOrEqual(60);
    expect(pointDensity.titleSize).toBeLessThanOrEqual(14);
    await evidencePoint.click();
    await expectModesInViewport("point-selected");
    await expect(workspace.getByRole("region", { name: "补讲依据", exact: true })).toHaveCount(0);
    await expect(workspace.getByText(/为什么需要关注|已有足够作答证据|推荐至少需要|统计口径与推荐依据/)).toHaveCount(0);
    const emphasis = workspace.getByRole("region", { name: "补讲重点", exact: true });
    const feedback = workspace.getByRole("region", { name: "评阅提示", exact: true });
    const relatedQuestions = workspace.getByRole("region", { name: "知识点关联题目", exact: true });
    const relatedSlides = workspace.getByRole("region", { name: "知识点关联课件", exact: true });
    await expect(emphasis.getByRole("heading", { name: "讲解要点", exact: true })).toBeVisible();
    await expect(emphasis).toContainText("根据相同条件下的观察记录比较方案。");
    await expect(emphasis).toContainText("保持时段与空间一致，同时记录设备数量。");
    await expect(emphasis).toContainText("能够指出观察条件的差异，并说明数据能否直接比较。");
    await expect(emphasis.getByText("建议讲法", { exact: true })).toBeVisible();
    await expect(feedback).toContainText("题意或条件识别错误");
    await expect(feedback).toContainText("2 人");
    const feedbackEvidence = feedback.getByText("请核对观察条件。", { exact: true });
    await expect(feedbackEvidence).toBeHidden();
    await feedback.locator("summary").click();
    await expect(feedbackEvidence).toBeVisible();
    await feedback.locator("summary").click();
    for (const panel of [emphasis, feedback, relatedQuestions, relatedSlides]) {
      const bounds = await panel.evaluate((node) => {
        const style = getComputedStyle(node);
        return { border: Math.max(parseFloat(style.borderTopWidth), parseFloat(style.borderLeftWidth)), width: node.getBoundingClientRect().width };
      });
      expect(bounds.border).toBeGreaterThanOrEqual(1);
      expect(bounds.width).toBeGreaterThan(0);
    }
    for (const [panel, name] of [[relatedQuestions, "查看关联题目"], [relatedSlides, "查看相关课件"]] as const) {
      const action = panel.getByRole("button", { name, exact: true });
      await expect(action).toHaveCount(1);
      await expect(action).toBeVisible();
      const style = await action.evaluate((node) => {
        const computed = getComputedStyle(node);
        return { background: computed.backgroundColor, border: parseFloat(computed.borderTopWidth), borderColor: computed.borderTopColor, cursor: computed.cursor };
      });
      expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
      expect(style.border).toBeGreaterThanOrEqual(1);
      expect(style.borderColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(style.cursor).toBe("pointer");
    }
    await emphasis.scrollIntoViewIfNeeded();
    await expectModesInViewport("overview-structured");
    await screenshot(page, info, "dual-mode-knowledge-overview");
    await workspace.getByRole("button", { name: "查看相关课件", exact: true }).click();
    await expect(workspace.getByRole("region", { name: "课件预览", exact: true })).toBeVisible();
    expect(fixture.writes).toEqual([]);
    expect(fixture.course().uiState?.teacherResourceProjection).toBeUndefined();
    await workspace.getByRole("button", { name: "返回知识点", exact: true }).click();
    await expectModesInViewport("preview-return");
    await workspace.getByRole("button", { name: "查看关联题目", exact: true }).click();
    await expect(review.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
    // A knowledge point spans both authored chapters, including unanswered work.
    await expect(review.getByRole("combobox", { name: "选择讲解题目", exact: true }).locator("option")).toHaveCount(4);
    await review.getByRole("button", { name: "显示答案与解析", exact: true }).click();
    await review.getByRole("button", { name: "补讲知识点：控制变量与观察证据", exact: true }).click();
    await expect(workspace.getByText("根据相同条件下的观察记录比较方案。", { exact: true })).toBeVisible();
    await workspace.getByRole("button", { name: "查看关联题目", exact: true }).click();
    await expect(review.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "隐藏答案与解析", exact: true })).toBeVisible();
    await chapterMode.click();
    const directory = await openReviewDirectory(page);
    const chapter = directory.getByRole("button", { name: /第一节：观察与证据/ });
    const earlierChapter = directory.getByRole("button", { name: /准备观察/ });
    await expect(chapter).toHaveAttribute("aria-pressed", "true");
    await expect(earlierChapter).toHaveAttribute("aria-pressed", "false");
    await expect(chapter).toContainText("3 题");
    const chapterRows = workspace.locator('aside[aria-label="讲解目录"]');
    const firstQuestion = chapterRows.getByRole("button", { name: /^查看第 1 题：为比较两种/, includeHidden: true });
    const secondQuestion = chapterRows.getByRole("button", { name: /^查看第 2 题：判断节能方案/, includeHidden: true });
    const thirdQuestion = chapterRows.getByRole("button", { name: /^查看第 3 题：还没有作答/, includeHidden: true });
    await expect(firstQuestion).toHaveAttribute("aria-current", "true");
    await expect(firstQuestion).toContainText("2/3");
    const firstBar = firstQuestion.getByRole("img", { name: /第 1 题作答分布：答对.*1 人，答错.*2 人，未评 0 人/, includeHidden: true });
    await expect(firstBar).toHaveCount(1);
    const barPreview = await firstBar.evaluate((node) => {
      const good = node.querySelector('[data-kind="good"]')!;
      const wrong = node.querySelector('[data-kind="wrong"]')!;
      const width = node.getBoundingClientRect().width;
      return { width, goodRatio: good.getBoundingClientRect().width / width, wrongRatio: wrong.getBoundingClientRect().width / width,
        goodColor: getComputedStyle(good).backgroundColor, wrongColor: getComputedStyle(wrong).backgroundColor, neutralColor: getComputedStyle(node).backgroundColor };
    });
    expect(barPreview.width).toBeGreaterThan(24);
    expect(barPreview.goodRatio).toBeCloseTo(1 / 3, 1);
    expect(barPreview.wrongRatio).toBeCloseTo(2 / 3, 1);
    expect(new Set([barPreview.goodColor, barPreview.wrongColor, barPreview.neutralColor]).size).toBe(3);
    await expect(secondQuestion.getByRole("img", { name: /第 2 题作答分布：答对.*1 人，答错.*2 人，未评 0 人/, includeHidden: true })).toHaveCount(1);
    await expect(thirdQuestion.getByRole("img", { name: /第 3 题作答分布：未作答/, includeHidden: true })).toHaveCount(1);
    await expect(thirdQuestion).toContainText("未作答");
    const footer = page.locator('footer[aria-label="课堂操作栏"]');
    await expect(footer).toBeInViewport({ ratio: 1 });
    expect(await footer.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const center = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return Boolean(center && node.contains(center));
    })).toBe(true);
    await footer.getByRole("button", { name: "课堂讲解", exact: true }).click();
    await expect(chapterMode).toHaveAttribute("aria-pressed", "true");
    await screenshot(page, info, "dual-mode-chapter-directory", false);
    await secondQuestion.click();
    await expect(review.getByRole("heading", { name: "判断节能方案是否有效，需要保留哪些记录？", exact: true })).toBeVisible();
    await expect(secondQuestion).toHaveAttribute("aria-current", "true");
    await expect(firstQuestion).not.toHaveAttribute("aria-current", "true");
    await review.getByRole("button", { name: "上一题", exact: true }).click();
    await expect(firstQuestion).toHaveAttribute("aria-current", "true");
    await review.getByRole("button", { name: "下一题", exact: true }).click();
    await expect(secondQuestion).toHaveAttribute("aria-current", "true");
    const chapterSelector = review.getByRole("combobox", { name: "选择讲解题目", exact: true });
    await chapterSelector.selectOption({ index: 2 });
    await expect(thirdQuestion).toHaveAttribute("aria-current", "true");
    await chapterSelector.selectOption({ index: 0 });
    await expect(firstQuestion).toHaveAttribute("aria-current", "true");
    await expect(review.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
    await screenshot(page, info, "dual-mode-knowledge-question");
    await openReviewDirectory(page);
    await earlierChapter.click();
    await expect(review.getByRole("heading", { name: "观察前需要先记录什么？", exact: true })).toBeVisible();
    await expect(review.getByLabel("本题作答情况", { exact: true })).toContainText("答错 0/3 人");
    await openReviewDirectory(page);
    await chapter.click();
    const selector = review.getByRole("combobox", { name: "选择讲解题目", exact: true });
    await expect(selector.locator("option")).toHaveCount(3);
    const unanswered = selector.locator("option").filter({ hasText: "第 3 题 · 还没有作答时，比较节能效…" });
    await expect(unanswered).not.toContainText(/人答错|人未达标|未作答/);
    await selector.selectOption(await unanswered.getAttribute("value") as string);
    await expect(review.getByRole("heading", { name: "还没有作答时，比较节能效果应先固定哪个条件？", exact: true })).toBeVisible();
    await expect(review.getByLabel("本题作答情况", { exact: true })).toContainText("已提交 0 人");
    await review.getByRole("button", { name: "显示答案与解析", exact: true }).click();
    await expect(review.getByText("先固定观察时长，再比较两次用电量。", { exact: true })).toBeVisible();
    await review.getByRole("button", { name: "补讲知识点：控制变量与观察证据", exact: true }).click();
    await expect(workspace.getByText("根据相同条件下的观察记录比较方案。", { exact: true })).toBeVisible();
    await workspace.getByRole("button", { name: "返回题目", exact: true }).click();
    await expect(review.getByRole("heading", { name: "还没有作答时，比较节能效果应先固定哪个条件？", exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "隐藏答案与解析", exact: true })).toBeVisible();
    await workspace.getByRole("button", { name: "查看相关课件", exact: true }).click();
    await expect(workspace.getByRole("region", { name: "课件预览", exact: true })).toBeVisible();
    await workspace.getByRole("button", { name: "返回题目", exact: true }).click();
    await expect(review.getByRole("button", { name: "隐藏答案与解析", exact: true })).toBeVisible();
    await knowledgeMode.click();
    const points = await openReviewDirectory(page);
    await points.getByRole("button", { name: /尚未关联的知识点/ }).click();
    await expect(workspace.getByText("保留真实无关联状态。", { exact: true })).toBeVisible();
    const browseAll = workspace.getByRole("button", { name: "浏览全部课件", exact: true });
    await expect(browseAll).toBeVisible();
    await browseAll.scrollIntoViewIfNeeded();
    await expectModesInViewport("unlinked-end");
    await assertNoPageOverflow(page);
    await screenshot(page, info, "dual-mode-unsubmitted-and-unlinked");
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
  test(`knowledge analytics contains student details and keeps its state across views and fullscreen ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { questionReview: true });
    const analytics = page.getByRole("region", { name: "班级学情", exact: true });
    await expect(analytics.getByRole("tab", { name: "概览", exact: true })).toHaveAttribute("aria-selected", "true");
    await analytics.getByRole("button", { name: "查看明细", exact: true }).click();
    const details = analytics.getByRole("tabpanel", { name: "学生明细", exact: true });
    await expect(details).toBeVisible();
    await expect(details.getByRole("list", { name: "学生状态总览", exact: true }).getByRole("listitem")).toHaveCount(36);
    await expect(details.getByRole("heading", { name: "学生学习情况", exact: true })).toHaveCount(0);
    const sort = details.getByRole("combobox", { name: "学生排序指标", exact: true });
    await sort.selectOption("accuracy");
    await details.getByRole("button", { name: "查看私密学生2的学习轨迹", exact: true }).click();
    const student = page.getByRole("dialog", { name: /私密学生2$/ });
    await expect(student.getByRole("tab", { name: "学习轨迹", exact: true })).toHaveAttribute("aria-selected", "true");
    await student.getByRole("tab", { name: "答题详情", exact: true }).click();
    await expect(student.getByRole("region", { name: "答题详情", exact: true })).toContainText("为比较两种照明方案");
    await student.getByRole("button", { name: "关闭抽屉", exact: true }).click();
    await selectClassroomView(page, "课堂讲解");
    await selectClassroomView(page, "班级学情");
    await expect(analytics.getByRole("tab", { name: "学生明细", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(sort).toHaveValue("accuracy");
    await enterFullscreen(page, "班级学情");
    await expect(sort).toHaveValue("accuracy");
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expect(sort).toHaveValue("accuracy");
    await assertNoPageOverflow(page);
    await screenshot(page, info, "knowledge-analytics-students");
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

for (const viewport of [
  { width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1024, height: 768 },
  { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 844, height: 390 },
  { width: 1024, height: 360 },
]) {
  test(`unified classroom review preserves question, courseware and revealed answers ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mockClassroom(page, { questionReview: true });
    await expectClassroomView(page, "班级学情");
    await expect(page.getByRole("link", { name: "返回教学工作台" })).toBeVisible();
    await expect(page.getByRole("button", { name: "显示班级概览" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
    await expect(page.locator('footer[aria-label="课堂操作栏"]').getByRole("button", { name: /知识点补讲|错题讲解/ })).toHaveCount(0);
    await page.getByRole("region", { name: "班级学情", exact: true }).getByRole("button", { name: "课堂讲解", exact: true }).click();
    await expectClassroomView(page, "课堂讲解");
    const workspace = page.getByRole("region", { name: "课堂讲解", exact: true });
    const review = page.getByRole("region", { name: "题目讲解", exact: true });
    const prompt = "为比较两种照明方案，哪种观察记录更可靠？";
    await expect(workspace.getByRole("button", { name: "按知识点补讲", exact: true })).toHaveAttribute("aria-pressed", "true");
    await workspace.getByRole("button", { name: "按章节查题", exact: true }).click();
    const chapterDirectory = await openReviewDirectory(page);
    await chapterDirectory.getByRole("button", { name: /^第一节：观察与证据/ }).click();
    await expect(review.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "查看相关课件", exact: true })).toBeInViewport();
    await expect(review.getByLabel("本题作答情况", { exact: true })).toContainText("已提交 3 人");
    await expect(review.getByLabel("本题作答情况", { exact: true })).toContainText("答错 2/3 人");
    const questionChoices = review.getByRole("combobox", { name: "选择讲解题目", exact: true });
    await expect(questionChoices.locator("option").first()).toHaveText("第 1 题 · 为比较两种照明方案，哪种…");
    for (const label of await questionChoices.locator("option").allTextContents()) {
      expect(label.length).toBeLessThanOrEqual(24);
      expect(label).not.toMatch(/人答错|人未达标|暂无错答/);
    }
    await expect(review).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(questionChoices).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(review.getByText("正确选项", { exact: true })).toHaveCount(0);
    await expect(review.getByText("保持观察条件一致，才能比较方案造成的差异。", { exact: true })).toHaveCount(0);
    await assertQuestionNavigationInViewport(page);
    await review.getByRole("button", { name: "显示答案与解析", exact: true }).click();
    await expect(review.getByText("正确选项", { exact: true })).toHaveCount(1);
    await expect(review.getByText("保持观察条件一致，才能比较方案造成的差异。", { exact: true })).toBeVisible();
    await assertQuestionNavigationInViewport(page);
    await screenshot(page, info, "question-review-window");
    await enterFullscreen(page, "课堂讲解");
    await expect(review.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "隐藏答案与解析", exact: true })).toBeVisible();
    await assertQuestionNavigationInViewport(page);
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await expectClassroomView(page, "课堂讲解");
    await expect(review.getByRole("button", { name: "隐藏答案与解析", exact: true })).toBeVisible();
    await review.getByRole("button", { name: "下一题", exact: true }).click();
    await expect(review.getByRole("heading", { name: "判断节能方案是否有效，需要保留哪些记录？", exact: true })).toBeVisible();
    await expect(review.getByRole("heading", { name: "判断节能方案是否有效，需要保留哪些记录？", exact: true })).toBeInViewport();
    await expect(review.getByRole("button", { name: "查看相关课件", exact: true })).toBeInViewport();
    await expect(review.getByRole("button", { name: "显示答案与解析", exact: true })).toBeVisible();
    await expect(review.getByText("正确选项", { exact: true })).toHaveCount(0);
    await review.getByRole("combobox", { name: "选择讲解题目", exact: true }).selectOption({ index: 0 });
    await expect(review.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
    await review.getByRole("button", { name: "显示答案与解析", exact: true }).click();
    await review.getByRole("button", { name: "查看原始作答", exact: true }).click();
    await expect(review.getByLabel("本题原始作答", { exact: true }).locator("article")).toHaveCount(3);
    await workspace.getByRole("button", { name: "查看相关课件", exact: true }).click();
    await expect(workspace.getByRole("region", { name: "课件预览", exact: true })).toBeVisible();
    await expect(workspace.getByRole("button", { name: "投屏", exact: true })).toBeEnabled();
    await expect(workspace.getByText("尚未投屏", { exact: true })).toHaveCount(0);
    await workspace.getByRole("button", { name: "返回题目", exact: true }).click();
    await expect(review.getByRole("button", { name: "隐藏答案与解析", exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "收起原始作答", exact: true })).toBeVisible();
    await selectClassroomView(page, "班级学情");
    await selectClassroomView(page, "课堂讲解");
    await expect(review.getByRole("heading", { name: prompt, exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "隐藏答案与解析", exact: true })).toBeVisible();
    await assertNoPageOverflow(page);
    await screenshot(page, info, "question-review-returned");
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}


for (const scenario of [
  { name: "ordinary", viewport: { width: 1440, height: 900 }, fullscreen: false },
  { name: "fullscreen", viewport: { width: 1280, height: 720 }, fullscreen: true },
  { name: "narrow", viewport: { width: 390, height: 844 }, fullscreen: false },
]) {
  test(`project analytics integrates collaboration and reminder review ${scenario.name}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize(scenario.viewport);
    const fixture = await mockClassroom(page, { project: true, studentWorks: true, practiceAnalytics: true });
    if (scenario.fullscreen) await enterFullscreen(page);
    const originalUiState = structuredClone(fixture.course().uiState);
    const footer = page.locator('footer[aria-label="课堂操作栏"]');
    await selectClassroomView(page, "班级学情");
    await expect(page.getByRole("tab", { name: "概览", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("img", { name: "未开始 34 人，任务进行中 1 人，提交过成果 1 人", exact: true })).toBeVisible();
    await screenshot(page, info, `project-analytics-overview-${scenario.name}`);
    const headlines = page.getByRole("group", { name: "项目实践关键统计", exact: true });
    const totalInteractions = headlines.getByRole("button", { name: /累计 AI 交互/ });
    await expect(totalInteractions).toContainText("1次");
    await expect(headlines.getByRole("button", { name: /需关注学生/ })).toHaveCount(0);
    await totalInteractions.click();
    await expect(page.getByRole("combobox", { name: "协作筛选", exact: true })).toHaveValue("participating");
    await page.getByRole("combobox", { name: "协作筛选", exact: true }).selectOption("all");
    const collaborationList = page.getByRole("list", { name: "学生协作列表", exact: true });
    const firstStudent = collaborationList.locator('[data-student-id="student-0"]');
    const secondStudent = collaborationList.locator('[data-student-id="student-1"]');
    await expect(firstStudent.getByRole("button", { name: "对话 1 轮", exact: true })).toBeVisible();
    await expect(firstStudent.getByRole("button", { name: "采纳 1 次", exact: true })).toBeVisible();
    await expect(firstStudent.getByRole("button", { name: "未采纳 0 次", exact: true })).toBeVisible();
    await expect(firstStudent.getByRole("button", { name: "外部待核实 1", exact: true })).toBeVisible();
    await expect(secondStudent.getByRole("button", { name: "AI 边界 1 次", exact: true })).toBeVisible();
    const geometry = await collaborationList.evaluate(list => {
      const cards = [...list.children];
      const first = cards[0].getBoundingClientRect(), second = cards[1].getBoundingClientRect();
      const header = document.querySelector('[aria-label="AI 协作汇总"]')!;
      const summary = header.firstElementChild!.getBoundingClientRect(), reminder = header.lastElementChild!.getBoundingClientRect();
      return { first: first.toJSON(), second: second.toJSON(), columns: getComputedStyle(list).gridTemplateColumns.split(" ").length, summary: summary.toJSON(), reminder: reminder.toJSON(), viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    expect(geometry.second.left).toBeGreaterThan(geometry.first.left);
    expect(Math.abs(geometry.second.top - geometry.first.top)).toBeLessThan(2);
    if (scenario.name !== "narrow") {
      expect(geometry.columns).toBeGreaterThanOrEqual(4);
      expect(geometry.first.top).toBeLessThan(geometry.viewportHeight * .5);
      expect(Math.abs((geometry.summary.top + geometry.summary.height / 2) - (geometry.reminder.top + geometry.reminder.height / 2))).toBeLessThan(3);
      expect(geometry.reminder.right).toBeGreaterThan(geometry.viewportWidth * .8);
    }
    await screenshot(page, info, `project-collaboration-grid-${scenario.name}`);
    await page.getByRole("tab", { name: "学生进度", exact: true }).click();
    const progressList = page.getByRole("list", { name: "学生进度列表", exact: true });
    const progressColumns = await progressList.evaluate(list => getComputedStyle(list).gridTemplateColumns.split(" ").length);
    expect(progressColumns).toBeGreaterThanOrEqual(scenario.name === "narrow" ? 2 : 4);
    await screenshot(page, info, `project-progress-grid-${scenario.name}`);
    const progressPanel = page.getByRole("tabpanel", { name: "学生进度", exact: true });
    await progressPanel.evaluate(async node => { node.scrollTop = 220; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    const listScroll = await progressPanel.evaluate(node => node.scrollTop);
    expect(listScroll).toBeGreaterThan(100);
    await selectClassroomView(page, "授课展示");
    await selectClassroomView(page, "班级学情");
    await expect(page.getByRole("tab", { name: "学生进度", exact: true })).toHaveAttribute("aria-selected", "true");
    expect(await progressPanel.evaluate(node => node.scrollTop)).toBeGreaterThanOrEqual(listScroll - 2);
    const search = page.getByRole("textbox", { name: "搜索进度学生" });
    await search.fill("私密学生1");
    await page.getByRole("button", { name: "查看私密学生1的 AI 协作", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "私密学生1 · AI 协作", exact: true });
    await expect(dialog).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByText("请帮我核对方案中的证据。", { exact: true })).toBeVisible();
    await dialog.getByText(/协作长对话末尾/).scrollIntoViewIfNeeded();
    await expect(dialog.getByText(/协作长对话末尾/)).toBeVisible();
    await dialog.getByRole("tab", { name: "建议处理", exact: true }).click();
    await expect(dialog.getByText("修改后采纳", { exact: true })).toBeVisible();
    await expect(dialog.getByText("在相同观察时段记录并比较用电量。", { exact: true })).toBeVisible();
    await dialog.getByRole("tab", { name: "外部内容提醒", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(dialog.getByRole("combobox", { name: "学生", exact: true })).toHaveValue("student-0");
    await expect(dialog.getByText(/这是我在课前整理的草稿/)).toBeVisible();
    await dialog.getByRole("textbox", { name: "核实备注（可选）" }).fill("已核对课前草稿与学生说明");
    await dialog.getByRole("button", { name: "排除这条提醒", exact: true }).click();
    await expect(dialog.getByText("当前筛选下暂无提醒记录。", { exact: true })).toBeVisible();
    await dialog.getByRole("combobox", { name: "核实状态", exact: true }).selectOption("all");
    await expect(dialog.getByRole("heading", { name: "私密学生1 · 已排除", exact: true })).toBeVisible();
    await expect(dialog.getByText(/已核对课前草稿与学生说明/)).toBeVisible();
    const dimensions = await dialog.evaluate(node => ({ width: node.getBoundingClientRect().width, viewport: innerWidth, overflow: node.scrollWidth - node.clientWidth }));
    expect(dimensions.overflow).toBeLessThanOrEqual(1);
    if (scenario.name === "narrow") expect(dimensions.width).toBe(dimensions.viewport);
    await screenshot(page, info, `project-collaboration-${scenario.name}`);
    await dialog.getByRole("button", { name: "关闭抽屉", exact: true }).click();
    await expect(search).toHaveValue("私密学生1");
    const row = page.getByRole("list", { name: "学生进度列表" }).getByRole("listitem").filter({ has: page.getByRole("button", { name: "查看私密学生1的 AI 协作", exact: true }) });
    await row.getByRole("button", { name: "查看成果", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^私密学生1 ·/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "私密学生1的成果内容", exact: true }).getByText("公开展示的观察方案", { exact: true })).toBeVisible();
    await selectClassroomView(page, "班级学情");
    await expect(search).toHaveValue("私密学生1");
    await page.getByRole("tab", { name: "AI 协作", exact: true }).click();
    await page.getByRole("button", { name: "外部内容提醒", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("combobox", { name: "学生", exact: true })).toHaveValue("");
    await page.getByRole("button", { name: "关闭抽屉", exact: true }).click();
    for (const view of ["授课展示", "班级学情", "学生成果"] as const) {
      await selectClassroomView(page, view);
      await expect(footer.getByRole("button", { name: "课堂操作", exact: true })).toHaveCount(0);
      await expect(footer.getByRole("button", { name: /^返回/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /选择项目实践成果形式/ })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /导出过程档案|导出该生/ })).toHaveCount(0);
    }
    expect(fixture.course().uiState).toEqual(originalUiState);
    expect(fixture.writes).toEqual([{ path: "/api/project-practice/content-monitor/events/practice-reminder", body: { courseId, action: "review", status: "dismissed", note: "已核对课前草稿与学生说明" } }]);
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}
