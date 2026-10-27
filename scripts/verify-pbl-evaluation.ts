// Invoked by verify-research-database.mjs against its marked disposable database.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AuthClaims } from "../src/lib/auth/session";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres"); assert.equal(target.password, ""); assert.ok(target.port);
  process.env.REDIS_URL = "";
  process.env.PROVIDER_CONFIG_DATABASE_URL = target.href;
  process.env.JWT_SECRET = randomUUID() + randomUUID();
  const { prisma } = await import("../src/lib/db/client");
  try {
    assert.equal((await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker=${marker}`).length, 1);
    const { getPblEvaluation, mutatePblEvaluation } = await import("../src/lib/evaluation/pbl-service");
    const { emptyPblAnswers } = await import("../src/lib/evaluation/pbl-contract");
    const { readProcessEvidence } = await import("../src/lib/evaluation/process-evidence");
    const { analyzeProcessEvidence } = await import("../src/lib/evaluation/process-analysis");
    const { enqueueProcessEvaluation, getProcessEvaluation } = await import("../src/lib/evaluation/process-service");
    const { claimProcessJob, runProcessJob } = await import("../src/lib/evaluation/process-worker");
    const { ensureExperimentAssignment, getStudentExperimentAssessment, submitExperimentAssessment, saveExperimentAssessmentDraft } = await import("../src/lib/platform/experiment-service");
    const { setClassroomPosttestAccess } = await import("../src/lib/platform/experiment-access-service");
    const { createPblTemplateCourse, encodePblTemplate } = await import("../src/lib/platform/pbl-template");
    const user = (name: string, role = "STUDENT") => prisma.user.create({ data: { username: `pbl-${name}`, usernameKey: `pbl-${name}`, displayName: name, role, passwordHash: "test-only-unusable" } });
    const teacher = await user("teacher", "TEACHER"), students = await Promise.all([user("甲"), user("乙"), user("丙")]);
    const outsider = await user("无关学生");
    const claims = (u: typeof teacher): AuthClaims => ({ sub: u.id, role: u.role.toLowerCase() as "teacher" | "student", sv: 1 });
    const teacherClaims = claims(teacher);
    const offering = await prisma.courseOffering.create({ data: { name: "PBL评价真实数据库回归", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: "项目", position: 0, isOpen: true } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "评价课堂", type: "CLASSROOM", position: 0, isOpen: true,
      config: { experiment: { enabled: true, pretest: [{ id: "pre", type: "short-answer", prompt: "课前解释控制变量" }], posttest: [{ id: "post", type: "short-answer", prompt: "课后解释控制变量" }] } } } });
    const template = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: "变量研究" } });
    const design = createPblTemplateCourse(template.id, { name: "变量研究", subject: "科学", grade: "七年级", drivingQuestion: "怎样检验影响蒸发快慢的因素？" });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: JSON.parse(JSON.stringify(encodePblTemplate(design))) } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "SCHEDULED",
      runtimeConfig: { evaluationContractVersion: 2, currentStageIndex: 0, version: 1, posttestAccess: { status: "closed", version: 0 } } } });
    const participants = [];
    for (const student of students) {
      const enrollment = await prisma.enrollment.create({ data: { userId: student.id, offeringId: offering.id } });
      const p = await prisma.classroomParticipation.create({ data: { enrollmentId: enrollment.id, instanceId: instance.id, firstEnteredAt: new Date(), lastEnteredAt: new Date() } });
      participants.push(p);
      await ensureExperimentAssignment(instance.id, enrollment.id);
      await getStudentExperimentAssessment(claims(student), instance.id, "pretest");
      await submitExperimentAssessment(claims(student), instance.id, { phase: "pretest", answers: { pre: "只改变一个因素" } });
      const artifact = await prisma.artifact.create({ data: { participationId: p.id, title: `${student.displayName}的实验`, type: "DOCUMENT_ARCHIVE", status: "SUBMITTED" } });
      await prisma.artifactVersion.create({ data: { artifactId: artifact.id, sequence: 1, status: "SUBMITTED", submittedAt: new Date(), mimeType: "text/html", sourceHtml: "<p>分别记录三个温度下的蒸发量，保持容器面积和测量时间一致。</p>" } });
    }
    const first = participants[0], studentClaims = claims(students[0]);
    let snapshot = await getPblEvaluation(teacherClaims, instance.id);
    assert.equal(snapshot.canConfigureRubric, true);
    const { version: configVersion, ...config } = snapshot.config;
    await mutatePblEvaluation(teacherClaims, instance.id, { action: "config", version: configVersion, config: { ...config, peerMode: "balanced", reviewsPerStudent: 2 }, idempotencyKey: randomUUID() });
    const begin = async (stage: number, status = "TEACHING") => {
      const current = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
      await prisma.classroomInstance.update({ where: { id: instance.id }, data: { status, startedAt: new Date(), runtimeConfig: { ...(current.runtimeConfig as object), currentStageIndex: stage } } });
    };
    await begin(4);
    const assignmentCommand = { action: "assign" as const, idempotencyKey: randomUUID() };
    await Promise.all([mutatePblEvaluation(teacherClaims, instance.id, assignmentCommand), mutatePblEvaluation(teacherClaims, instance.id, assignmentCommand)]);
    snapshot = await getPblEvaluation(teacherClaims, instance.id);
    assert.equal(snapshot.assignments.length, 6);
    assert.ok(snapshot.assignments.every(a => a.reviewerParticipationId !== a.targetParticipationId));
    assert.equal((await getStudentExperimentAssessment(studentClaims, instance.id, "posttest")).available, false);
    const answers = { ...emptyPblAnswers(snapshot.config.rubric), dimensionScores: Object.fromEntries(snapshot.config.rubric.map(d => [d.id, 80])),
      comment: "实验设计有依据", evidence: "比较了初稿和验证后的版本", strengths: "保持其他条件一致", improvements: "增加重复次数", learning: "学会区分控制变量", plan: "进行三次重复测试" };
    const save = { action: "save" as const, source: "self" as const, participationId: first.id, version: 0, answers, idempotencyKey: randomUUID() };
    await Promise.all([mutatePblEvaluation(studentClaims, instance.id, save), mutatePblEvaluation(studentClaims, instance.id, save)]);
    assert.equal(await prisma.evaluation.count({ where: { pblKey: `self:${first.id}` } }), 1);
    await assert.rejects(() => mutatePblEvaluation(studentClaims, instance.id, { ...save, idempotencyKey: randomUUID() }), (e: { code: string }) => e.code === "DRAFT_VERSION_CONFLICT");
    await mutatePblEvaluation(studentClaims, instance.id, { ...save, action: "submit", version: 1, idempotencyKey: randomUUID() });
    await assert.rejects(() => mutatePblEvaluation(studentClaims, instance.id, { ...save, version: 2, idempotencyKey: randomUUID() }), (e: { code: string }) => e.code === "EVALUATION_LOCKED");
    await assert.rejects(() => mutatePblEvaluation(studentClaims, instance.id, { ...save, source: "teacher", idempotencyKey: randomUUID() }), (e: { code: string }) => e.code === "FORBIDDEN");
    await assert.rejects(() => getPblEvaluation(claims(outsider), instance.id), (e: { code: string }) => e.code === "FORBIDDEN");
    const assignment = snapshot.assignments.find(a => a.reviewerParticipationId === participants[1].id && a.targetParticipationId === first.id)!;
    await mutatePblEvaluation(claims(students[1]), instance.id, { action: "submit", source: "peer", participationId: first.id, assignmentId: assignment.id, version: 0, answers, idempotencyKey: randomUUID() });
    await mutatePblEvaluation(teacherClaims, instance.id, { action: "submit", source: "teacher", participationId: first.id, version: 0, answers, idempotencyKey: randomUUID() });
    const privateView = (await getPblEvaluation(studentClaims, instance.id)).participants[0];
    assert.equal(privateView.teacherEvaluation, null); assert.deepEqual(privateView.peerEvaluations, []);
    console.log("PASS real PostgreSQL: self/peer/teacher, balanced assignment, idempotency, stale version, submission lock and private grades");

    const { signTeacherToken, signStudentToken } = await import("../src/lib/auth/session");
    const teacherToken = await signTeacherToken({ teacherId: teacher.id, username: teacher.username, displayName: teacher.displayName, sessionVersion: 1 });
    const studentToken = await signStudentToken({ userId: students[0].id, studentName: students[0].displayName, sessionVersion: 1 });
    const outsiderToken = await signStudentToken({ userId: outsider.id, studentName: outsider.displayName, sessionVersion: 1 });
    const evaluationRoute = await import("../src/app/api/platform/classroom-instances/[instanceId]/evaluation/route");
    const processRoute = await import("../src/app/api/platform/classroom-instances/[instanceId]/process-evaluation/route");
    const routeContext = { params: Promise.resolve({ instanceId: instance.id }) };
    const request = (token?: typeof studentToken, body?: unknown, origin = "http://localhost") => new Request(`http://localhost/api/platform/classroom-instances/${instance.id}/evaluation`, {
      method: body === undefined ? "GET" : "POST", headers: { ...(token ? { cookie: `${token.cookieName}=${token.token}`, "x-auth-role": token.cookieName === teacherToken.cookieName ? "teacher" : "student" } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json", origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await evaluationRoute.GET(request(), routeContext)).status, 401);
    assert.equal((await evaluationRoute.GET(request(outsiderToken), routeContext)).status, 403);
    const studentHttp = await evaluationRoute.GET(request(studentToken), routeContext);
    assert.equal(studentHttp.status, 200); assert.equal(studentHttp.headers.get("Cache-Control"), "private, no-store");
    const studentDto = await studentHttp.json(); assert.equal(studentDto.participants.length, 1); assert.equal(studentDto.participants[0].teacherEvaluation, null); assert.equal(studentDto.participants[0].processReport, null);
    assert.equal((await evaluationRoute.POST(request(studentToken, { ...save, source: "teacher", idempotencyKey: randomUUID() }), routeContext)).status, 403);
    assert.equal((await evaluationRoute.POST(request(studentToken, { ...save, idempotencyKey: randomUUID() }), routeContext)).status, 409);
    assert.equal((await evaluationRoute.POST(request(teacherToken, { action: "assign", idempotencyKey: randomUUID() }, "https://foreign.invalid"), routeContext)).status, 403);
    assert.equal((await processRoute.GET(request(studentToken), routeContext)).status, 401);
    assert.equal((await processRoute.GET(request(teacherToken), routeContext)).status, 200);
    assert.equal((await processRoute.POST(request(teacherToken, { participationId: "foreign-participation" }), routeContext)).status, 404);
    console.log("PASS real PostgreSQL + authenticated HTTP handlers: valid JWTs, role projection, missing/foreign membership, CSRF, score forgery, stale edit, teacher-only process access");


    for (const [index, content] of ["计划比较蒸发快慢，但没有固定测量时间。", "将所有容器的观察时间固定为十分钟，记录三次测量，并解释控制变量。"].entries()) {
      await prisma.domainEvent.create({ data: { idempotencyKey: `pbl-save-${index}`, actorId: students[0].id, participationId: first.id, offeringId: offering.id, classroomInstanceId: instance.id,
        researchKey: (await prisma.enrollment.findUniqueOrThrow({ where: { id: first.enrollmentId } })).researchKey,
        eventType: "COURSE_ACTION", createdAt: new Date(Date.now() + index), payload: { action: { type: "UPSERT_SUBMISSION", payload: { submission: { stageKey: "make", content, version: index + 1 } } } } } });
    }
    const ownLearningQuestion = "学习审计原始追问：为什么测量时间必须相同？";
    const privateLearningQuestion = "其他学生的私有追问：这段内容不得进入甲的报告。";
    for (const [index, content] of [ownLearningQuestion, privateLearningQuestion].entries()) {
      const conversation = await prisma.aiConversation.create({ data: {
        userId: students[index].id, participationId: participants[index].id, offeringId: offering.id,
        title: "知识小测后的追问", metadata: { feature: "knowledge-tutor" },
      } });
      const message = await prisma.aiMessage.create({ data: { conversationId: conversation.id, userId: students[index].id, role: "user", content } });
      await prisma.aiInteractionEvent.create({ data: {
        idempotencyKey: `pbl-learning-${index}`, userId: students[index].id, participationId: participants[index].id,
        offeringId: offering.id, conversationId: conversation.id, eventType: "student_message", actor: "student", content: null,
        payload: { schemaVersion: 2, legacy: { stageKey: "ai-learning", source: "knowledge-tutor" }, detail: { contentRef: "AiMessage", messageId: message.id } },
      } });
    }
    const evidence = await readProcessEvidence(first.id);
    assert.ok(evidence.evidence.some(e => e.kind === "saved-version" && e.content.includes("修改前") && e.content.includes("十分钟")));
    assert.ok(evidence.evidence.every(e => !e.content.includes("课前解释控制变量")));
    assert.ok(evidence.evidence.some(e => e.kind === "learning-dialogue" && e.stageKey === "ai-learning" && e.actor === "student" && e.content.includes(ownLearningQuestion)));
    assert.ok(!JSON.stringify(evidence).includes(privateLearningQuestion));
    console.log("PASS real PostgreSQL: learning audit resolves owned canonical AiMessage content and excludes other students' private questions");
    await Promise.all([enqueueProcessEvaluation(instance.id, { participationId: first.id, immediate: true }), enqueueProcessEvaluation(instance.id, { participationId: first.id, immediate: true })]);
    assert.equal(await prisma.aiTask.count({ where: { queueKey: "pbl-process-evaluation" } }), 1);
    const job = await claimProcessJob(); assert.ok(job);
    let modelCalls = 0;
    await runProcessJob(job, new AbortController().signal, (input, id, signal) => analyzeProcessEvidence(input, id, signal, async () => {
      modelCalls++;
      const { PROCESS_DIMENSIONS } = await import("../src/lib/evaluation/process-contract");
      return JSON.stringify({ summary: "保存版本显示学生补充了控制测量时间及重复测试的设计；已有学习追问，尚缺少AI建议取舍与实际改动的关联证据。", confidence: "medium", evidenceGaps: ["缺少AI建议取舍与实际改动的关联证据"],
        dimensions: PROCESS_DIMENSIONS.map((d, index) => ({ dimensionId: d.id, score: index === 3 ? null : 80, rationale: "修改后明确固定测量时间并重复三次。", evidenceIds: index === 3 ? [] : [input.evidence.find(e => e.kind === "saved-version")!.id], evidenceGaps: index === 3 ? ["未使用AI，无法判断"] : [], improvements: ["保留实际测量结果"] })) });
    }));
    assert.equal(modelCalls, 1);
    const report = (await getProcessEvaluation(teacherClaims, instance.id)).reports[0]; assert.ok(report);
    assert.equal(report.dimensions[3].score, null);
    await assert.rejects(() => getProcessEvaluation(studentClaims, instance.id), (e: { code: string }) => e.code === "FORBIDDEN");
    assert.equal((await getPblEvaluation(studentClaims, instance.id)).participants[0].processReport, null);
    await mutatePblEvaluation(teacherClaims, instance.id, { action: "publish", participationIds: [first.id], includeTeacher: true, includeProcess: true, idempotencyKey: randomUUID() });
    const published = (await getPblEvaluation(studentClaims, instance.id)).participants[0];
    assert.equal(published.teacherEvaluation?.score, 80); assert.equal(published.processReport?.id, report.id);
    assert.equal(published.peerEvaluations[0].evaluatorName, undefined); assert.equal(published.peerEvaluations[0].assignmentId, null);
    const teacherRecord = published.teacherEvaluation!;
    await mutatePblEvaluation(teacherClaims, instance.id, { action: "return", evaluationId: teacherRecord.id, version: teacherRecord.version, reason: "核对修改依据", idempotencyKey: randomUUID() });
    assert.equal((await getPblEvaluation(studentClaims, instance.id)).participants[0].teacherEvaluation?.status, "submitted");
    const readback = await prisma.evaluation.findUniqueOrThrow({ where: { pblKey: `teacher:${first.id}` } });
    assert.equal((readback.result as { status: string }).status, "returned");
    console.log("PASS real PostgreSQL: persisted revision evidence, deduplicated queue with local mock model, unknown score, immutable publication and anonymous peer snapshot");

    // Redistribution must preserve submitted peer work and its original immutable version.
    const firstArtifact = await prisma.artifact.findFirstOrThrow({ where: { participationId: first.id } });
    const newArtifactVersion = await prisma.artifactVersion.create({ data: { artifactId: firstArtifact.id, sequence: 2, status: "SUBMITTED", submittedAt: new Date(), mimeType: "text/html", sourceHtml: "<p>第二版：补充三次实验结果。</p>" } });
    const configurePeer = async (peerMode: "manual" | "presenters-only") => {
      const current = (await getPblEvaluation(teacherClaims, instance.id)).config;
      const { version, ...rest } = current;
      await mutatePblEvaluation(teacherClaims, instance.id, { action: "config", version, config: { ...rest, peerMode }, idempotencyKey: randomUUID() });
    };
    await configurePeer("manual");
    await mutatePblEvaluation(teacherClaims, instance.id, { action: "assign", pairs: [{ reviewerParticipationId: participants[2].id, targetParticipationId: first.id }], idempotencyKey: randomUUID() });
    let reassigned = await getPblEvaluation(teacherClaims, instance.id);
    assert.equal(reassigned.assignments.length, 2);
    assert.equal(reassigned.assignments.find(a => a.id === assignment.id)?.artifact.versionId, assignment.artifact.versionId);
    assert.notEqual(assignment.artifact.versionId, newArtifactVersion.id);
    assert.equal(reassigned.assignments.find(a => a.id === assignment.id)?.evaluation?.status, "submitted");
    await assert.rejects(() => mutatePblEvaluation(teacherClaims, instance.id, { action: "assign", pairs: [{ reviewerParticipationId: first.id, targetParticipationId: first.id }], idempotencyKey: randomUUID() }), (e: { code: string }) => e.code === "INVALID_ASSIGNMENT");
    await prisma.showcasePresentation.create({ data: { participationId: first.id, artifactId: firstArtifact.id, artifactVersionId: newArtifactVersion.id, status: "ENDED", presentedAt: new Date() } });
    await configurePeer("presenters-only");
    await mutatePblEvaluation(teacherClaims, instance.id, { action: "assign", idempotencyKey: randomUUID() });
    reassigned = await getPblEvaluation(teacherClaims, instance.id);
    assert.equal(reassigned.assignments.length, 2); assert.ok(reassigned.assignments.every(a => a.targetParticipationId === first.id));
    assert.equal((await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: first.id } })).stageProgress && ((await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: first.id } })).stageProgress as { progress: { reflection: number } }).progress.reflection, 100);
    const selfRecord = reassigned.participants.find(p => p.participationId === first.id)!.selfEvaluation!;
    await mutatePblEvaluation(teacherClaims, instance.id, { action: "return", evaluationId: selfRecord.id, version: selfRecord.version, reason: "补充真实测试结果", idempotencyKey: randomUUID() });
    assert.equal(((await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: first.id } })).stageProgress as { progress: { reflection: number } }).progress.reflection, 0);
    await mutatePblEvaluation(studentClaims, instance.id, { action: "submit", source: "self", participationId: first.id, version: selfRecord.version + 1, answers: { ...answers, evidence: "第二版加入三次实际测试" }, idempotencyKey: randomUUID() });
    assert.equal(((await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: first.id } })).stageProgress as { progress: { reflection: number } }).progress.reflection, 100);
    console.log("PASS real PostgreSQL: manual/presenters-only ENDED tasks, fixed formal version, preserve submitted reviews, self exclusion, self-return progress and revision history");

    const addEvidence = async (content: string) => prisma.reflection.create({ data: { participationId: first.id, activityId: activity.id, authorId: students[0].id, content } });
    const latestReportId = async () => (await getProcessEvaluation(teacherClaims, instance.id)).reports[0]?.id;
    await enqueueProcessEvaluation(instance.id, { participationId: first.id, immediate: true });
    let failureCalls = 0, failedId = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const failedJob = await claimProcessJob(); assert.ok(failedJob, `failure attempt ${attempt} must claim`); failedId = failedJob.id;
      await runProcessJob(failedJob, new AbortController().signal, async () => { failureCalls++; throw new Error("verification model outage"); });
      const persisted = await prisma.aiTask.findUniqueOrThrow({ where: { id: failedId } });
      assert.equal(persisted.attemptCount, attempt); assert.equal(persisted.status, attempt === 3 ? "FAILED" : "PENDING");
      assert.equal(await latestReportId(), report.id, "failed model must retain last usable report");
      if (attempt < 3) await prisma.aiTask.update({ where: { id: failedId }, data: { availableAt: new Date(0) } });
    }
    assert.equal(failureCalls, 3); assert.equal(await claimProcessJob(), null);
    assert.equal((await getPblEvaluation(studentClaims, instance.id)).participants[0].processReport?.id, report.id);
    console.log("PASS real PostgreSQL: bounded three-attempt model failure, terminal FAILED, last READY report and published snapshot preserved");

    await addEvidence("队列覆盖检查：加入新的测量结论");
    const futureSnapshot = await readProcessEvidence(first.id);
    const newerQueuedId = `verification-newer-${randomUUID()}`;
    await prisma.aiTask.create({ data: { id: newerQueuedId, createdById: students[0].id, offeringId: offering.id, taskType: "PBL_PROCESS_EVALUATION", queueKey: "pbl-process-evaluation", status: "PENDING", availableAt: new Date(Date.now() + 60_000),
      input: JSON.parse(JSON.stringify({ ...futureSnapshot, fingerprint: "verification-future", snapshotAt: new Date(Date.now() + 60_000).toISOString() })) } });
    const taskCount = await prisma.aiTask.count({ where: { queueKey: "pbl-process-evaluation" } });
    assert.equal(await enqueueProcessEvaluation(instance.id, { participationId: first.id, immediate: true }), 0);
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: newerQueuedId } })).status, "PENDING");
    assert.equal(await prisma.aiTask.count({ where: { queueKey: "pbl-process-evaluation" } }), taskCount);
    await prisma.aiTask.update({ where: { id: newerQueuedId }, data: { status: "CANCELLED" } });
    console.log("PASS real PostgreSQL: older snapshot admission cannot cancel or replace a newer pending task");

    await enqueueProcessEvaluation(instance.id, { participationId: first.id, immediate: true });
    const oldClaim = await claimProcessJob(); assert.ok(oldClaim);
    await prisma.aiTask.update({ where: { id: oldClaim.id }, data: { leaseUntil: new Date(0) } });
    await new Promise(resolve => setTimeout(resolve, 3));
    const replacementClaim = await claimProcessJob(); assert.ok(replacementClaim); assert.equal(replacementClaim.id, oldClaim.id);
    assert.equal(replacementClaim.attemptCount, oldClaim.attemptCount + 1); assert.notEqual(replacementClaim.startedAt.toISOString(), oldClaim.startedAt.toISOString());
    const fakeAnalyze: Parameters<typeof runProcessJob>[2] = async (input, id) => ({ ...report, id, snapshotAt: input.snapshotAt, generatedAt: new Date().toISOString(), fingerprint: input.fingerprint, summary: "接管后的新报告" });
    await runProcessJob(oldClaim, new AbortController().signal, fakeAnalyze);
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: oldClaim.id } })).status, "RUNNING");
    assert.equal(await prisma.aiSupportRecord.count({ where: { id: oldClaim.id } }), 0);
    await runProcessJob(replacementClaim, new AbortController().signal, fakeAnalyze);
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: replacementClaim.id } })).status, "COMPLETED");
    assert.equal(await latestReportId(), replacementClaim.id);
    assert.equal((await getPblEvaluation(studentClaims, instance.id)).participants[0].processReport?.id, report.id);
    console.log("PASS real PostgreSQL: expired lease takeover, old worker commit rejected, replacement completes, newer report does not silently change student publication");

    const lateId = `verification-late-${randomUUID()}`, lateStarted = new Date();
    const lateSnapshot = { ...futureSnapshot, snapshotAt: new Date(Date.now() - 60_000).toISOString() };
    await prisma.aiTask.create({ data: { id: lateId, createdById: students[0].id, offeringId: offering.id, taskType: "PBL_PROCESS_EVALUATION", queueKey: "pbl-process-evaluation", status: "RUNNING", startedAt: lateStarted, attemptCount: 1, input: JSON.parse(JSON.stringify(lateSnapshot)) } });
    await runProcessJob({ id: lateId, input: lateSnapshot, startedAt: lateStarted, attemptCount: 1 }, new AbortController().signal, fakeAnalyze);
    assert.equal((await prisma.aiSupportRecord.findUniqueOrThrow({ where: { id: lateId } })).status, "SUPERSEDED");
    assert.equal(await latestReportId(), replacementClaim.id);
    console.log("PASS real PostgreSQL: a distinct older snapshot finishing late remains SUPERSEDED and never replaces the latest report");

    await addEvidence("提交报告前重新核对场次权限");
    await enqueueProcessEvaluation(instance.id, { participationId: first.id, immediate: true });
    const closingClaim = await claimProcessJob(); assert.ok(closingClaim);
    await runProcessJob(closingClaim, new AbortController().signal, async (input, id, signal) => {
      const current = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
      await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: { ...(current.runtimeConfig as object), evaluationContractVersion: 1 } } });
      return fakeAnalyze!(input, id, signal);
    });
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: closingClaim.id } })).status, "FAILED");
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: closingClaim.id } })).error, "PROCESS_SCOPE_CLOSED");
    assert.equal(await prisma.aiSupportRecord.count({ where: { id: closingClaim.id } }), 0);
    const scoped = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: { runtimeConfig: { ...(scoped.runtimeConfig as object), evaluationContractVersion: 2 } } });
    assert.equal(await latestReportId(), replacementClaim.id);
    console.log("PASS real PostgreSQL: contract change during model execution is rechecked at commit and cannot publish a stale-scope report");

    const assertPosttestBlocked = async (draftCode: string, submitCode: string) => {
      const assessment = await getStudentExperimentAssessment(studentClaims, instance.id, "posttest");
      assert.equal(assessment.available, false);
      assert.deepEqual(assessment.questions, []);
      await assert.rejects(() => saveExperimentAssessmentDraft(studentClaims, instance.id, {
        phase: "posttest", answers: { post: "不可提前保存" }, currentPage: 0, version: 0, accessVersion: 0,
      }), (error: { code: string }) => error.code === draftCode);
      await assert.rejects(() => submitExperimentAssessment(studentClaims, instance.id, {
        phase: "posttest", answers: { post: "不可提前提交" }, accessVersion: 0,
      }), (error: { code: string }) => error.code === submitCode);
      assert.equal(await prisma.experimentAssessmentDraft.count({ where: { phase: "posttest", assignment: { instanceId: instance.id } } }), 0);
      assert.equal(await prisma.experimentAssessmentSubmission.count({ where: { instanceId: instance.id, phase: "posttest" } }), 0);
    };
    await assert.rejects(() => setClassroomPosttestAccess(teacherClaims, instance.id, { status: "open", version: 0 }),
      (error: { code: string }) => error.code === "ASSESSMENT_UNAVAILABLE");
    // Persist an old prematurely opened switch: students must still pass the lifecycle guard.
    const beforePosttest = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: {
      runtimeConfig: { ...(beforePosttest.runtimeConfig as object), posttestAccess: { status: "open", version: 0 } },
    } });
    await assertPosttestBlocked("ASSESSMENT_UNAVAILABLE", "POSTTEST_UNAVAILABLE");
    // A finished status alone is insufficient without this student's completion record.
    await begin(4, "FINISHED");
    await assertPosttestBlocked("CLASSROOM_PARTICIPATION_REQUIRED", "CLASSROOM_PARTICIPATION_REQUIRED");
    await prisma.classroomInstance.update({ where: { id: instance.id }, data: {
      status: "TEACHING", runtimeConfig: beforePosttest.runtimeConfig!,
    } });
    const courseActionRoute = await import("../src/app/api/courses/[courseId]/actions/route");
    const endMain = await courseActionRoute.POST(new Request(`http://localhost/api/courses/${instance.id}/actions`, {
      method: "POST", headers: { cookie: `${teacherToken.cookieName}=${teacherToken.token}`, "x-auth-role": "teacher", "Content-Type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ requestId: randomUUID(), action: { type: "END_TEACHING", payload: { id: instance.id } } }),
    }), { params: Promise.resolve({ courseId: instance.id }) });
    assert.equal(endMain.status, 200, await endMain.text());
    assert.ok((await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: first.id } })).completedAt);
    console.log("PASS real PostgreSQL: teaching rejects premature open, reading questions, drafts and submissions even with a persisted open switch; finished status without student completion remains blocked; signed END_TEACHING records completion");
    const opened = await setClassroomPosttestAccess(teacherClaims, instance.id, { status: "open", version: 0 });
    assert.equal((await getStudentExperimentAssessment(studentClaims, instance.id, "posttest")).available, true);
    await saveExperimentAssessmentDraft(studentClaims, instance.id, { phase: "posttest", answers: { post: "保持无关变量不变" }, currentPage: 0, version: 0, accessVersion: opened.access.version });
    assert.deepEqual((await getStudentExperimentAssessment(studentClaims, instance.id, "posttest")).draft?.answers, { post: "保持无关变量不变" });
    await setClassroomPosttestAccess(teacherClaims, instance.id, { status: "closed", version: opened.access.version });
    const reopened = await setClassroomPosttestAccess(teacherClaims, instance.id, { status: "open", version: opened.access.version + 1 });
    await assert.rejects(() => submitExperimentAssessment(studentClaims, instance.id, { phase: "posttest", answers: { post: "旧页答案" }, accessVersion: opened.access.version }), (e: { code: string }) => e.code === "ASSESSMENT_ACCESS_VERSION_CONFLICT");
    const before = (await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: first.id } })).stageProgress;
    await submitExperimentAssessment(studentClaims, instance.id, { phase: "posttest", answers: { post: "保持无关变量不变并多次测量" }, accessVersion: reopened.access.version });
    assert.deepEqual((await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: first.id } })).stageProgress, before);
    assert.equal(await prisma.experimentAssessmentSubmission.count({ where: { instanceId: instance.id, enrollmentId: first.enrollmentId } }), 2);
    assert.deepEqual((await getStudentExperimentAssessment(studentClaims, instance.id, "posttest")).submission?.answers, { post: "保持无关变量不变并多次测量" });
    console.log("PASS real PostgreSQL: posttest remains independently writable after class end, close/reopen rejects stale pages, paired responses and main-stage progress preserved");

    const createSimpleSession = async (position: number) => {
      const simpleActivity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "无实验与互评的课堂", type: "CLASSROOM", position, isOpen: true, config: { experiment: { enabled: false } } } });
      const simple = await prisma.classroomInstance.create({ data: { activityId: simpleActivity.id, templateVersionId: version.id, status: "TEACHING", startedAt: new Date(),
        runtimeConfig: { evaluationContractVersion: 2, currentStageIndex: 0, version: 1, makeArtifactMode: "code", posttestAccess: { status: "closed", version: 0 } } } });
      await prisma.classroomParticipation.create({ data: { enrollmentId: first.enrollmentId, instanceId: simple.id, firstEnteredAt: new Date() } });
      return simple;
    };
    const simple = await createSimpleSession(1);
    const simpleAction = async (type: "SET_STAGE" | "END_TEACHING", index?: number) => {
      const response = await courseActionRoute.POST(new Request(`http://localhost/api/courses/${simple.id}/actions`, {
        method: "POST", headers: { cookie: `${teacherToken.cookieName}=${teacherToken.token}`, "x-auth-role": "teacher", "Content-Type": "application/json", origin: "http://localhost" },
        body: JSON.stringify({ requestId: randomUUID(), action: { type, payload: { id: simple.id, ...(index === undefined ? {} : { index }) } } }),
      }), { params: Promise.resolve({ courseId: simple.id }) });
      assert.equal(response.status, 200, await response.text());
    };
    const initialSimple = await getPblEvaluation(teacherClaims, simple.id);
    assert.equal(initialSimple.config.peerMode, "off");
    for (let index = 1; index <= 4; index++) {
      await simpleAction("SET_STAGE", index);
      assert.equal(((await prisma.classroomInstance.findUniqueOrThrow({ where: { id: simple.id } })).runtimeConfig as { currentStageIndex: number }).currentStageIndex, index);
      if (index === 2) {
        const submissionId = randomUUID(), createdAt = new Date().toISOString();
        const sourceVersions = ["observations = [2]\nprint(observations[0])", "observations = [2, 3, 4]\nprint(sum(observations) / len(observations))"];
        for (const [expectedSubmissionVersion, source] of sourceVersions.entries()) {
          const content = JSON.stringify({ version: 1, language: "python", activeFileId: "main", files: [{ id: "main", path: "main.py", content: source }] });
          const response = await courseActionRoute.POST(new Request(`http://localhost/api/courses/${simple.id}/actions`, {
            method: "POST", headers: { cookie: `${studentToken.cookieName}=${studentToken.token}`, "x-auth-role": "student", "Content-Type": "application/json", origin: "http://localhost" },
            body: JSON.stringify({ requestId: randomUUID(), action: { type: "UPSERT_SUBMISSION", payload: { courseId: simple.id, expectedSubmissionVersion,
              submission: { id: submissionId, courseId: simple.id, studentId: students[0].id, stageKey: "make", type: "code", title: "重复观测求平均", content, status: "draft", createdAt, updatedAt: new Date().toISOString() } } } }),
          }), { params: Promise.resolve({ courseId: simple.id }) });
          assert.equal(response.status, 200, await response.clone().text());
          assert.equal((await response.json()).submissionVersion, expectedSubmissionVersion + 1);
        }
        const participantId = initialSimple.participants[0].participationId;
        const savedEvidence = await readProcessEvidence(participantId);
        assert.equal(savedEvidence.evidence.filter(row => row.kind === "saved-version").length, 2);
        assert.ok(savedEvidence.evidence.some(row => row.kind === "saved-version" && row.content.includes("修改前") && row.content.includes("修改后") && row.content.includes("3, 4")));
        const finalizeRoute = await import("../src/app/api/project-practice/submissions/finalize-code/route");
        const finalization = { courseId: simple.id, submissionId, stageKey: "make", expectedVersion: 2, requestId: randomUUID(), revisionNote: "从单次观测改为三次观测求平均，减少偶然误差。" };
        const finalize = (body: typeof finalization) => finalizeRoute.POST(new Request("http://localhost/api/project-practice/submissions/finalize-code", {
          method: "POST", headers: { cookie: `${studentToken.cookieName}=${studentToken.token}`, "x-auth-role": "student", "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body),
        }));
        const result = await finalize(finalization); assert.equal(result.status, 200, await result.clone().text());
        const receipt = await result.json(); assert.equal(receipt.submissionVersion, 3);
        const replay = await finalize(finalization); assert.equal(replay.status, 200); assert.equal((await replay.json()).versionId, receipt.versionId);
        assert.equal((await finalize({ ...finalization, requestId: randomUUID(), expectedVersion: 1 })).status, 409);
        const artifact = await prisma.artifact.findFirstOrThrow({ where: { participationId: participantId, type: "CODE_ARCHIVE" }, include: { versions: true } });
        assert.equal(artifact.versions.length, 1); assert.equal(artifact.versions[0].id, receipt.versionId); assert.ok(artifact.versions[0].sourceHtml?.includes("sum(observations)"));
        const finalizedEvidence = await readProcessEvidence(participantId);
        assert.ok(finalizedEvidence.evidence.some(row => row.id === `artifact:${receipt.versionId}` && row.content.includes("sum(observations)")));
        assert.ok(finalizedEvidence.evidence.some(row => row.kind === "reflection" && row.content === finalization.revisionNote && row.relatedEvidenceIds.includes(`artifact:${receipt.versionId}`)));
        assert.equal((await getPblEvaluation(teacherClaims, simple.id)).participants[0].artifacts[0].versionId, receipt.versionId);
        console.log("PASS real PostgreSQL + signed HTTP handlers: two CAS code saves produce actual revision evidence; formal CODE_ARCHIVE pins saved source and note, replays once, rejects stale finalization, and appears in the evaluation dossier");
      }
    }
    assert.equal((await getPblEvaluation(studentClaims, simple.id)).stage, "reflection");
    assert.equal(await prisma.evaluation.count({ where: { participation: { instanceId: simple.id } } }), 0);
    assert.equal(await prisma.experimentAssessmentAssignment.count({ where: { instanceId: simple.id } }), 0);
    await simpleAction("END_TEACHING");
    assert.equal((await prisma.classroomInstance.findUniqueOrThrow({ where: { id: simple.id } })).status, "FINISHED");
    console.log("PASS real PostgreSQL + signed action HTTP handlers: fresh no-experiment/no-peer session advances through all five stages and ends without human/AI evaluation blocking");
    if (process.env.OPENPBL_VERIFY_PBL_BROWSER === "1") {
      const { spawn, execFileSync } = await import("node:child_process");
      const { access, mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const { chromium, expect } = await import("@playwright/test");
      const releaseServer = process.env.OPENPBL_VERIFY_RELEASE_SERVER ?? path.resolve(".openpbl-runtime", "releases", (await readFile(".next-build/BUILD_ID", "utf8")).trim(), "server.js");
      await access(path.join(path.dirname(releaseServer), ".release-ready"));
      await access(releaseServer);
      const temporary = await mkdtemp(path.join(tmpdir(), "openpbl-pbl-browser-"));
      const networkGuard = path.join(temporary, "isolation.cjs");
      // Do not load real provider secrets or send model requests from browser fixtures.
      await writeFile(networkGuard, `
const fs = require('node:fs'); const fsp = require('node:fs/promises'); const path = require('node:path');
function fixtureFile(value) { const base = path.basename(String(value)); return base.startsWith('.env') ? '' : ['server-providers.yml','ai-settings.json'].includes(base) ? '{}' : undefined; }
const readSync = fs.readFileSync; fs.readFileSync = function(file, options) { const value = fixtureFile(file); return value === undefined ? readSync.call(this,file,options) : typeof options === 'string' || options?.encoding ? value : Buffer.from(value); };
const readAsync = fsp.readFile; fsp.readFile = async function(file, options) { const value = fixtureFile(file); return value === undefined ? readAsync.call(this,file,options) : typeof options === 'string' || options?.encoding ? value : Buffer.from(value); };
require('node:module').syncBuiltinESMExports(); const realFetch = globalThis.fetch;
globalThis.fetch = (input, options) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) return Promise.reject(new Error('OPENPBL_VERIFICATION_EXTERNAL_NETWORK_BLOCKED')); return realFetch(input,options); };
`);
      const origin = "http://127.0.0.1:3017";
      const isolatedEnvironment = Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key, /API_KEY$|^OPENPBL_LLM_/.test(key) ? "" : value]));
      const redisName = `openpbl-pbl-browser-${randomUUID()}`;
      execFileSync("docker", ["run", "--detach", "--rm", "--name", redisName, "-p", "127.0.0.1::6379", process.env.OPENPBL_VERIFY_REDIS_IMAGE ?? "redis:7.4.5-alpine"], { stdio: "pipe", timeout: 30000 });
      const redisPort = execFileSync("docker", ["port", redisName, "6379/tcp"], { encoding: "utf8", timeout: 10000 }).trim().split(":").at(-1);
      assert.match(redisPort ?? "", /^\d+$/);
      const server = spawn(process.execPath, [releaseServer], { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"], env: {
        ...isolatedEnvironment, NODE_ENV: "production", PORT: "3017", HOSTNAME: "127.0.0.1", NEXT_DIST_DIR: ".next-build", DATABASE_URL: target.href, PROVIDER_CONFIG_DATABASE_URL: target.href, JWT_SECRET: process.env.JWT_SECRET,
        REDIS_URL: `redis://127.0.0.1:${redisPort}`, UPLOAD_DIR: path.join(temporary, "uploads"), CLASSROOM_DATA_DIR: path.join(temporary, "classrooms"), AI_AUDIT_OUTBOX_DIR: path.join(temporary, "audit-outbox"),
        PUBLIC_BASE_URL: origin, TRUST_PROXY_HEADERS: "true", ENABLE_WEBSOCKET: "false", ENABLE_TLDRAW_SYNC: "false", ENABLE_LOAD_TEST_API: "false", OPENPBL_COURSE_READ_WORKERS: "0", OPENPBL_COURSE_READ_DATABASE_URL: "",
        PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString("base64"), INTERNAL_MONITOR_TOKEN: randomBytes(32).toString("hex"),
        // The TS verification loader needs the import condition; the traced CJS
        // production release must use its normal require exports instead.
        NODE_OPTIONS: `${(process.env.NODE_OPTIONS ?? "").replace(/(?:^|\s)--conditions=import(?=\s|$)/g, "")} --require=${networkGuard}`, COURSE_GENERATION_BACKGROUND_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1",
      } });
      let serverOutput = "", browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
      for (const stream of [server.stdout, server.stderr]) stream.on("data", chunk => { serverOutput = (serverOutput + chunk.toString()).slice(-12000); });
      try {
        let ready = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          if (server.exitCode !== null) throw new Error(`Isolated server exited ${server.exitCode}: ${serverOutput}`);
          try { if ((await fetch(`${origin}/api/health/live`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch { /* awaiting startup */ }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.ok(ready, `Isolated production server did not become ready: ${serverOutput}`);
        browser = await chromium.launch({ headless: true });
        const screenshots = path.resolve("test-results", "pbl-evaluation-real"); await mkdir(screenshots, { recursive: true });
        const pageErrors: string[] = [];
        const openPage = async (token: typeof studentToken, viewport: { width: number; height: number }) => {
          const context = await browser!.newContext({ viewport });
          await context.addCookies([{ name: token.cookieName, value: token.token, url: origin, httpOnly: true, sameSite: "Lax" }]);
          const page = await context.newPage(); page.on("pageerror", error => pageErrors.push(error.message));
          await page.route("**/*", route => new URL(route.request().url()).origin === origin || route.request().url().startsWith("data:") ? route.continue() : route.abort());
          return page;
        };
        const checkWidth = async (page: Awaited<ReturnType<typeof openPage>>) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 2, `horizontal overflow at ${page.url()}`);
        await begin(4);
        const teacherPage = await openPage(teacherToken, { width: 1440, height: 900 });
        await teacherPage.goto(`${origin}/teacher/teach/${instance.id}/classroom`);
        await teacherPage.getByRole("button", { name: "课堂操作", exact: true }).click();
        await expect(teacherPage.getByRole("heading", { name: "个人评价档案", exact: true })).toBeVisible();
        await teacherPage.getByRole("combobox", { name: /选择学生/ }).selectOption(first.id);
        await checkWidth(teacherPage); await teacherPage.screenshot({ path: path.join(screenshots, "teacher-stage5.png"), fullPage: true });
        const studentPage = await openPage(studentToken, { width: 390, height: 844 });
        await studentPage.goto(`${origin}/student/classroom/${instance.id}`);
        await studentPage.getByRole("tab", { name: "已发布反馈", exact: true }).click();
        await expect(studentPage.getByRole("heading", { name: "教师定评", exact: true })).toBeVisible();
        await expect(studentPage.getByText(report.summary, { exact: true })).toBeVisible();
        const visible = await (await studentPage.request.get(`${origin}/api/platform/classroom-instances/${instance.id}/evaluation`)).json();
        assert.equal(visible.participants[0].processReport.id, report.id); assert.equal(visible.participants[0].peerEvaluations[0].evaluatorName, undefined);
        await checkWidth(studentPage); await studentPage.screenshot({ path: path.join(screenshots, "student-published-mobile.png"), fullPage: true });
        const secondToken = await signStudentToken({ userId: students[1].id, studentName: students[1].displayName, sessionVersion: 1 });
        const secondPage = await openPage(secondToken, { width: 820, height: 1180 });
        await secondPage.goto(`${origin}/student/classroom/${instance.id}`);
        await secondPage.getByLabel("我的作品与过程证据").fill("真实浏览器填写：固定观察时间后比较蒸发量。");
        await secondPage.getByLabel("我学会了什么").fill("一次只改变一个因素。");
        await secondPage.getByLabel("下次准备如何改进").fill("增加三次重复实验。");
        await expect(secondPage.getByText("草稿已保存", { exact: true })).toBeVisible();
        await secondPage.getByRole("button", { name: "提交自评", exact: true }).click();
        await expect(secondPage.getByText("已提交自评，内容已锁定。需要修改时请教师退回修订。", { exact: true })).toBeVisible();
        assert.equal(((await prisma.evaluation.findUniqueOrThrow({ where: { pblKey: `self:${participants[1].id}` } })).result as { status: string }).status, "submitted");
        await secondPage.getByRole("tab", { name: "已发布反馈", exact: true }).click();
        await expect(secondPage.getByText("教师尚未发布评价结果。自评、互评和 AI 过程报告分别呈现，由教师综合定评。", { exact: true })).toBeVisible();
        const hidden = await (await secondPage.request.get(`${origin}/api/platform/classroom-instances/${instance.id}/evaluation`)).json();
        assert.equal(hidden.participants[0].processReport, null); assert.equal(hidden.participants[0].teacherEvaluation, null);
        await checkWidth(secondPage); await secondPage.screenshot({ path: path.join(screenshots, "student-unpublished.png"), fullPage: true });
        const endedMain = await teacherPage.request.post(`${origin}/api/courses/${instance.id}/actions`, { headers: { origin, "x-auth-role": "teacher" },
          data: { requestId: randomUUID(), action: { type: "END_TEACHING", payload: { id: instance.id } } } });
        assert.equal(endedMain.status(), 200, await endedMain.text());
        assert.ok((await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: participants[1].id } })).completedAt);
        const progressBeforePosttest = (await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: participants[1].id } })).stageProgress;
        await secondPage.goto(`${origin}/student/activities/${activity.id}/assessments/${instance.id}/posttest`);
        await expect(secondPage.getByText("课后解释控制变量", { exact: true })).toBeVisible();
        await secondPage.getByRole("textbox").first().fill("保持其他变量相同并重复三次实验。");
        await secondPage.getByRole("button", { name: "检查并提交", exact: true }).click();
        await secondPage.getByRole("button", { name: /确认提交/ }).click();
        await expect(secondPage.getByText("答案已锁定", { exact: true })).toBeVisible();
        assert.equal(await prisma.experimentAssessmentSubmission.count({ where: { instanceId: instance.id, enrollmentId: participants[1].enrollmentId } }), 2);
        assert.deepEqual((await prisma.classroomParticipation.findUniqueOrThrow({ where: { id: participants[1].id } })).stageProgress, progressBeforePosttest);
        await checkWidth(secondPage); await secondPage.screenshot({ path: path.join(screenshots, "postclass-posttest.png"), fullPage: true });

        const browserSimple = await createSimpleSession(2);
        const actionViaHttp = async (type: "SET_STAGE" | "END_TEACHING", index?: number) => {
          const response = await teacherPage.request.post(`${origin}/api/courses/${browserSimple.id}/actions`, { headers: { origin, "x-auth-role": "teacher" },
            data: { requestId: randomUUID(), action: { type, payload: { id: browserSimple.id, ...(index === undefined ? {} : { index }) } } } });
          assert.equal(response.status(), 200, await response.text());
        };
        for (let index = 1; index <= 4; index++) await actionViaHttp("SET_STAGE", index);
        await studentPage.goto(`${origin}/student/classroom/${browserSimple.id}`);
        await expect(studentPage.getByRole("heading", { name: "项目评价", exact: true })).toBeVisible();
        await expect(studentPage.getByRole("heading", { name: /后测/ })).toHaveCount(0);
        await studentPage.getByRole("tab", { name: "同伴互评 · 0/0", exact: true }).click();
        await expect(studentPage.getByText("本次未安排同伴互评。", { exact: true })).toBeVisible();
        await checkWidth(studentPage); await studentPage.screenshot({ path: path.join(screenshots, "simple-stage5-no-experiment-peer.png"), fullPage: true });
        await teacherPage.goto(`${origin}/teacher/teach/${browserSimple.id}/classroom`);
        await teacherPage.getByRole("button", { name: "结束课堂", exact: true }).click();
        await teacherPage.getByRole("alertdialog").getByRole("button", { name: "结束课堂", exact: true }).click();
        await expect(teacherPage).toHaveURL(`${origin}/teacher/classrooms/${browserSimple.id}`);
        const simpleEnded = await prisma.classroomInstance.findUniqueOrThrow({ where: { id: browserSimple.id } });
        assert.equal(simpleEnded.status, "FINISHED");
        assert.equal((simpleEnded.runtimeConfig as { posttestAccess: { status: string } }).posttestAccess.status, "closed");
        assert.equal(await prisma.evaluation.count({ where: { participation: { instanceId: browserSimple.id } } }), 0);
        assert.deepEqual(pageErrors, []);
        console.log("PASS real production HTTP + Chromium + isolated PostgreSQL: teacher stage5, student frozen publication/anonymous peers, mobile layout, real self autosave/submit, unpublished-report isolation, postclass posttest submit/readback and preserved stage progress; no pageerror/overflow");
        console.log("PASS real production HTTP + Chromium: fresh no-experiment/no-peer session traverses all five stages, shows project evaluation without posttest, and ends with human evaluations missing and no report publication");
      } catch (error) {
        const diagnostics: string[] = [];
        for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) ?? []).entries()) {
          diagnostics.push(`${page.url()}\n${(await page.locator("body").innerText().catch(() => "")).slice(0, 3000)}`);
          await page.screenshot({ path: path.resolve("test-results", "pbl-evaluation-real", `failure-${index}.png`), fullPage: true }).catch(() => {});
        }
        throw new Error(`Real browser verification failed: ${String(error)}\n${diagnostics.join("\n")}\n${serverOutput}`);
      }
      finally {
        await browser?.close(); if (server.pid) { try { process.kill(-server.pid, "SIGTERM"); } catch { /* already stopped */ } }
        for (let attempt = 0; attempt < 30 && server.exitCode === null; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
        if (server.pid && server.exitCode === null) { try { process.kill(-server.pid, "SIGKILL"); } catch { /* already stopped */ } }
        try { execFileSync("docker", ["rm", "--force", redisName], { stdio: "pipe", timeout: 10000 }); } catch { /* already stopped */ }
        await rm(temporary, { recursive: true, force: true });
      }
    }

  } finally { await prisma.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
