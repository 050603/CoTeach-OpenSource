import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import templateModule from '../../src/lib/platform/pbl-template.ts';
import tutorModule from '../../src/lib/courses/knowledge-tutor-payload.ts';
import { createAcceptanceLearningFixture } from './classroom-acceptance-learning.mjs';
import { assertIncrementalIsolation } from './incremental-classroom-contract.mjs';

const { createPblTemplateCourse, encodePblTemplate } = templateModule;
const { TUTOR_EXECUTION_MS, parseTutorPayload } = tutorModule;
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => JSON.parse(JSON.stringify(value));
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));

/** Real configured tutor, deliberately separate from the stopped mixed-load class.
 * Fixture authoring is direct; attempts, questions, answers and receipts must all
 * be created by the shipped API. No initial reference-only explanation is used.
 */
export async function runIncrementalTutorAcceptance({ students, teachers, instance, db, origin, env, output, send, record }) {
  const marker = (await db.$queryRaw`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${env.OPENPBL_VERIFICATION_MARKER}`)[0]?.marker;
  assertIncrementalIsolation({ origin, environment: env, marker });
  assert.ok(env.CLASSROOM_DATA_DIR && path.isAbsolute(env.CLASSROOM_DATA_DIR));
  assert.ok(teachers[0]?.user?.id && teachers[0]?.context);
  const representatives = ['google-chrome', 'microsoft-edge'].map(brand => {
    const student = students.find(actor => actor.label === brand);
    assert.ok(student?.user?.id && student.context && student.participation?.id, `Missing ${brand} actor`);
    return student;
  });
  const directory = path.join(output, 'incremental-tutor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { status: 'running', startedAt: new Date().toISOString(), mainInstanceId: instance.id,
    scope: 'Real backend and one configured-model tutor follow-up; both brands submit real quiz attempts through authenticated BrowserContext APIs',
    modelExecutionBudgetMs: TUTOR_EXECUTION_MS, fixture: {}, attempts: [], http: [], stages: [],
    boundary: 'No browser tutor editing/audio assertion here; browser entry is separate evidence. No model substitution or new retry request ID.',
    cleanup: 'Fixture IDs and authored classroom file retained for the caller disposable-instance backup and exact-run teardown' };
  const original = [], learners = [];
  let course, body, failure;
  const save = () => writeFile(path.join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const stage = async (name, work) => {
    const step = { name, startedAt: new Date().toISOString(), status: 'running' };
    evidence.stages.push(step);
    try { const value = await work(); step.status = 'passed'; return value; }
    catch (error) { step.status = 'failed'; step.error = String(error.stack ?? error).slice(0, 4000); throw error; }
    finally { step.finishedAt = new Date().toISOString(); await save(); }
  };
  const scopedSend = (actor, method, endpoint, value, expected = 200) => {
    assert.ok(course, 'Tutor fixture has not been created');
    const url = new URL(endpoint, origin);
    assert.equal(url.origin, new URL(origin).origin);
    assert.ok(url.pathname === '/api/knowledge-lecture' || url.pathname === `/api/courses/${course.id}/state`);
    if (value) assert.equal(value.courseId, course.id);
    return send(actor, method, `${url.pathname}${url.search}`, value, expected,
      value?.action === 'tutor-message' ? 'tutor-message' : value?.action);
  };
  const taskRows = () => db.aiTask.findMany({ where: { taskType: 'KNOWLEDGE_LECTURE_TUTOR', createdById: body.studentId,
    AND: [{ input: { path: ['courseId'], equals: course.id } }, { input: { path: ['requestId'], equals: body.requestId } }] },
  include: { conversation: { include: { messages: { orderBy: { id: 'asc' } } } }, interactionEvents: { orderBy: { id: 'asc' } } } });
  const snapshot = task => ({ ...pick(task, ['id', 'conversationId', 'offeringId', 'createdById', 'taskType', 'status', 'error',
    'startedAt', 'completedAt', 'createdAt', 'updatedAt', 'output']),
  input: pick(task.input, ['courseId', 'classroomId', 'studentId', 'requestId', 'threadId', 'attemptId', 'questionId', 'message', 'initial']),
  conversation: task.conversation, interactionEvents: task.interactionEvents });
  try {
    await stage('independent-authored-fixture', async () => {
      assert.equal((await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).status, 'TEACHING');
      for (const actor of representatives) {
        const workspace = await db.studentProjectWorkspace.findUnique({ where: { participationId: actor.participation.id } });
        original.push({ actor, participationId: actor.participation.id, page: actor.page, url: actor.page?.url(),
          projectStateSha256: hash(JSON.stringify(workspace?.projectState ?? null)) });
      }
      const classroomId = `incremental-tutor-${randomUUID()}`;
      const fixture = createAcceptanceLearningFixture({ classroomId });
      const design = createPblTemplateCourse(randomUUID(), { name: '增量补测：助教真实调用', subject: '科学', grade: '七年级',
        aiLearningClassroomId: classroomId, content: fixture.designContent });
      const stageIndex = design.stages.findIndex(item => item.key === 'ai-learning');
      assert.ok(stageIndex >= 0, 'Authored template lacks its knowledge stage');
      await mkdir(env.CLASSROOM_DATA_DIR, { recursive: true });
      const classroomFile = path.join(env.CLASSROOM_DATA_DIR, `${classroomId}.json`);
      const authored = JSON.stringify(fixture.classroom);
      await writeFile(classroomFile, authored, { flag: 'wx', mode: 0o600 });
      Object.assign(evidence.fixture, { classroomId, classroomFile, classroomSha256: hash(authored),
        sectionId: fixture.sectionId, quizOutlineId: fixture.quizOutlineId, runtimeSceneId: fixture.quizSceneId });
      const template = await db.classroomTemplate.create({ data: { id: design.id, ownerId: teachers[0].user.id,
        title: design.name, status: 'PUBLISHED', versions: { create: { version: 1, status: 'PUBLISHED', snapshot: encodePblTemplate(design) } } },
      include: { versions: true } });
      Object.assign(evidence.fixture, { templateId: template.id, templateVersionId: template.versions[0].id });
      const offering = await db.courseOffering.create({ data: { name: design.name, status: 'OPEN',
        description: classroomId, teachers: { create: teachers.map(actor => ({ userId: actor.user.id })) } } });
      evidence.fixture.offeringId = offering.id;
      const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: design.name, position: 0, isOpen: true } });
      evidence.fixture.chapterId = chapter.id;
      const activity = await db.activity.create({ data: { chapterId: chapter.id, title: design.name, position: 0, type: 'CLASSROOM', isOpen: true } });
      evidence.fixture.activityId = activity.id;
      course = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: template.versions[0].id,
        status: 'TEACHING', startedAt: new Date(), runtimeConfig: { version: 1, currentStageIndex: stageIndex,
          classConfig: { groupMode: 'solo', totalStudents: representatives.length, perGroup: 1, crossClass: false } } } });
      assert.notEqual(course.id, instance.id);
      evidence.fixture.instanceId = course.id;
      evidence.fixture.participants = [];
      for (const actor of representatives) {
        const enrollment = await db.enrollment.create({ data: { offeringId: offering.id, userId: actor.user.id } });
        const participation = await db.classroomParticipation.create({ data: { instanceId: course.id,
          enrollmentId: enrollment.id, firstEnteredAt: new Date() } });
        learners.push({ ...actor, client: `tutor-${actor.client}`, enrollment, participation });
        evidence.fixture.participants.push({ brand: actor.label, userId: actor.user.id, enrollmentId: enrollment.id, participationId: participation.id });
      }
      const state = await scopedSend(teachers[0], 'GET', `/api/courses/${course.id}/state`);
      assert.equal(state.course.id, course.id);
      for (const learner of learners) assert.ok(state.course.students.some(item => item.id === learner.user.id));
    });
    await stage('real-record-attempt-and-replay', async () => {
      for (const learner of learners) {
        const submission = { action: 'record-attempt', courseId: course.id, studentId: learner.user.id,
          sectionId: evidence.fixture.sectionId, quizOutlineId: evidence.fixture.quizOutlineId,
          runtimeSceneId: evidence.fixture.runtimeSceneId,
          answers: { 'acceptance-duration-question': 'B', 'acceptance-boundary-question': 'A' } };
        const result = await scopedSend(learner, 'POST', '/api/knowledge-lecture', submission);
        const attempt = result.attempt;
        assert.ok(attempt?.id); assert.equal(attempt.gradingSource, 'server'); assert.equal(attempt.gradingStatus, 'graded');
        assert.equal(attempt.runtimeSceneId, evidence.fixture.runtimeSceneId);
        assert.equal(attempt.quizOutlineId, evidence.fixture.quizOutlineId); assert.equal(attempt.questions.length, 2);
        const question = attempt.questions.find(item => item.questionId === 'acceptance-duration-question');
        assert.equal(question?.correct, false); assert.equal(question.earned, 0); assert.ok(question.authoredQuestionFingerprint);
        const workspace = await db.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: learner.participation.id } });
        const progress = workspace.projectState.aiLearningProgress;
        assert.equal(progress.classroomId, evidence.fixture.classroomId); assert.equal(progress.studentId, learner.user.id);
        assert.deepEqual(progress.knowledgeLectureAttempts, [attempt]);
        assert.equal(progress.knowledgeLectureTutorThreads?.length ?? 0, 0, 'The fixture must not contain synthetic tutor answers');
        assert.deepEqual(await scopedSend(learner, 'POST', '/api/knowledge-lecture', submission), result);
        learner.attempt = attempt;
        evidence.attempts.push({ brand: learner.label, userId: learner.user.id, participationId: learner.participation.id,
          submission, result, replayMatched: true });
      }
    });
    await stage('configured-model-followup-and-final-receipt', async () => {
      const learner = learners[0];
      body = { action: 'tutor-message', courseId: course.id, studentId: learner.user.id, requestId: randomUUID(),
        attemptId: learner.attempt.id, questionId: 'acceptance-duration-question',
        message: '我刚才选了B。如果一处观察10分钟记录8只，另一处观察20分钟记录12只，为什么不能仅凭12比8大就判断第二处鸟更多？请结合本题说明公平比较的方法和结论的范围。' };
      evidence.request = body;
      const started = performance.now(), deadline = started + TUTOR_EXECUTION_MS;
      let receipt;
      do {
        const remaining = Math.floor(deadline - performance.now());
        assert.ok(remaining > 0, 'Tutor did not produce a final receipt within TUTOR_EXECUTION_MS');
        const entry = { requestId: body.requestId, action: body.action, startedAt: new Date().toISOString(), status: 'pending' };
        evidence.http.push(entry); await save();
        try {
          const response = await learner.context.request.post(`${origin}/api/knowledge-lecture`, { data: body,
            headers: { Origin: origin, 'X-OpenPBL-Role': 'student' }, timeout: remaining });
          entry.status = response.status(); entry.response = await response.json();
          assert.ok([200, 202].includes(entry.status), `Tutor HTTP ${entry.status}: ${JSON.stringify(entry.response).slice(0, 500)}`);
          if (entry.status === 200) { receipt = entry.response; break; }
          assert.equal(entry.response.status, 'RUNNING');
        } catch (error) { entry.error = String(error.message ?? error); throw error; }
        finally { entry.finishedAt = new Date().toISOString(); entry.elapsedMs = performance.now() - started; await save(); }
        await delay(Math.min(500, Math.max(0, deadline - performance.now())));
      } while (performance.now() < deadline);
      assert.ok(receipt?.thread, 'A pending 202 is not a completed tutor response');
      assert.equal(receipt.resultSource, 'personalized', 'Reference/shared explanation does not establish a real tutor follow-up');
      assert.equal(receipt.thread.attemptId, body.attemptId); assert.equal(receipt.thread.questionId, body.questionId);
      evidence.receipt = receipt; evidence.completionMs = performance.now() - started;
      const rows = await taskRows(); assert.equal(rows.length, 1, 'One client request must have one durable tutor task');
      const task = rows[0], conversation = task.conversation;
      assert.equal(task.id, `lecture-tutor:${hash(JSON.stringify([course.id, body.studentId, body.requestId]))}`);
      assert.equal(task.status, 'COMPLETED'); assert.equal(task.error, null); assert.equal(task.offeringId, learner.enrollment.offeringId);
      assert.equal(task.input.initial, false); assert.equal(task.input.classroomId, evidence.fixture.classroomId);
      for (const key of ['courseId', 'studentId', 'requestId', 'attemptId', 'questionId', 'message']) assert.equal(task.input[key], body[key]);
      assert.equal(task.input.threadId, receipt.thread.id);
      assert.equal(conversation.userId, body.studentId); assert.equal(conversation.participationId, learner.participation.id);
      assert.equal(conversation.offeringId, learner.enrollment.offeringId);
      const messages = conversation.messages;
      assert.equal(messages.length, 2); assert.deepEqual(messages.map(item => item.id).sort(), [`${task.id}:assistant`, `${task.id}:student`]);
      const question = messages.find(item => item.role === 'user'), answer = messages.find(item => item.role === 'assistant');
      assert.equal(question.content, body.message); assert.ok(answer?.content.trim());
      for (const message of messages) { assert.equal(message.metadata.requestId, body.requestId); assert.equal(message.metadata.taskId, task.id); }
      assert.deepEqual(receipt.thread.messages.map(item => [item.role, item.content]), [['student', body.message], ['assistant', answer.content]]);
      const raw = task.output?.modelOutput?.raw;
      assert.ok(typeof raw === 'string' && raw.trim()); assert.equal(task.output.modelOutput.sha256, hash(raw));
      const parsed = parseTutorPayload(raw, receipt.thread.updatedAt);
      assert.equal(parsed.answer, answer.content); assert.deepEqual(parsed.notes, receipt.thread.boardNotes);
      assert.equal(task.output.modelOutput.syntaxRepair, parsed.syntaxRepair);
      assert.equal(task.output.resultSource, 'personalized'); assert.equal(task.output.schemaVersion, 2);
      assert.equal(task.output.threadReceipt.messages.length, 2);
      assert.deepEqual(task.output.threadReceipt.messages.map(item => item.messageId).sort(), messages.map(item => item.id).sort());
      const serverMs = task.completedAt.getTime() - task.startedAt.getTime();
      assert.ok(serverMs >= 0 && serverMs <= TUTOR_EXECUTION_MS, 'Server tutor execution exceeded its unchanged budget');
      assert.equal(task.interactionEvents.length, 2);
      for (const event of task.interactionEvents) {
        assert.equal(event.requestId, body.requestId); assert.equal(event.taskId, task.id); assert.equal(event.userId, body.studentId);
        assert.equal(event.participationId, learner.participation.id); assert.equal(event.offeringId, learner.enrollment.offeringId);
        assert.equal(event.conversationId, conversation.id); assert.equal(event.content, null);
        assert.equal(event.payload.schemaVersion, 2); assert.equal(event.payload.detail.contentRef, 'AiMessage');
        assert.equal(event.payload.detail.attemptId, body.attemptId); assert.equal(event.payload.detail.questionId, body.questionId);
        const expectedRole = event.eventType === 'message' ? 'student' : 'assistant';
        assert.ok(['message', 'response'].includes(event.eventType)); assert.equal(event.actor, expectedRole);
        assert.equal(event.payload.detail.messageId, expectedRole === 'student' ? question.id : answer.id);
      }
      assert.deepEqual(task.interactionEvents.map(item => item.eventType).sort(), ['message', 'response']);
      evidence.task = json(snapshot(task)); evidence.serverMs = serverMs;
      const beforeReplay = json(snapshot(task));
      assert.deepEqual(await scopedSend(learner, 'POST', '/api/knowledge-lecture', body), receipt);
      const replayed = await taskRows(); assert.equal(replayed.length, 1);
      assert.deepEqual(json(snapshot(replayed[0])), beforeReplay, 'Same-ID replay altered task, messages, raw output or audit');
      evidence.replay = { requestId: body.requestId, matched: true, recordsUnchanged: true, taskCount: 1, messageCount: 2, auditCount: 2 };
      const workspace = await db.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: learner.participation.id } });
      assert.deepEqual(workspace.projectState.aiLearningProgress.knowledgeLectureTutorThreads, [receipt.thread]);
      const other = await db.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: learners[1].participation.id } });
      assert.equal(other.projectState.aiLearningProgress.knowledgeLectureTutorThreads?.length ?? 0, 0, 'Tutor answer leaked to the other student');
      const state = await scopedSend(teachers[0], 'GET', `/api/courses/${course.id}/state`);
      assert.deepEqual(state.course.aiLearningProgress[body.studentId].knowledgeLectureTutorThreads, [receipt.thread]);
    });
    evidence.status = 'passed';
  } catch (error) {
    failure = error; evidence.status = 'failed'; evidence.error = String(error.stack ?? error).slice(0, 6000);
    if (body) {
      try { evidence.failedTasks = json((await taskRows()).map(snapshot)); }
      catch (readError) { evidence.failedTaskReadError = String(readError.message ?? readError); }
    }
  } finally {
    try {
      await stage('main-classroom-remains-isolated', async () => {
        evidence.mainClassroom = [];
        for (const item of original) {
          assert.equal(item.actor.participation.id, item.participationId); assert.equal(item.actor.page, item.page);
          assert.equal(item.actor.page?.url(), item.url);
          const workspace = await db.studentProjectWorkspace.findUnique({ where: { participationId: item.participationId } });
          assert.equal(hash(JSON.stringify(workspace?.projectState ?? null)), item.projectStateSha256, 'Tutor fixture altered the main classroom workspace');
          evidence.mainClassroom.push({ studentId: item.actor.user.id, participationId: item.participationId, projectStateUnchanged: true, originalPagePreserved: true });
        }
      });
    } catch (error) { failure ??= error; evidence.status = 'failed'; evidence.isolationError = String(error.stack ?? error).slice(0, 4000); }
    evidence.finishedAt = new Date().toISOString(); await save();
  }
  if (failure) {
    record('incremental-tutor-real-backend', '失败', { error: evidence.error ?? evidence.isolationError,
      evidence: path.join(directory, 'evidence.json') }, 'real-backend-and-real-provider');
    throw failure;
  }
  const result = { status: 'passed', instanceId: course.id, mainInstanceId: instance.id,
    realQuizAttempts: learners.length, realModelFollowups: 1, requestId: body.requestId, taskId: evidence.task.id,
    modelExecutionBudgetMs: TUTOR_EXECUTION_MS, completionMs: evidence.completionMs, replayUnique: true,
    mainClassroomUnchanged: true, evidence: path.join(directory, 'evidence.json') };
  record('incremental-tutor-real-backend', '通过', result, 'real-backend-and-real-provider');
  return result;
}
