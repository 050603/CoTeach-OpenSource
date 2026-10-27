import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import templateModule from '../../src/lib/platform/pbl-template.ts';

const { createPblTemplateCourse, encodePblTemplate } = templateModule;
const hash = value => createHash('sha256').update(value).digest('hex');
const view = row => row.payload?.view ?? row.payload;
const json = value => JSON.parse(JSON.stringify(value));
const completionBudgetMs = 120000, executionBudgetMs = 110000;

/** One real interactive code-review request, outside the sustained load. No
 * sandbox run, automatic-review substitute or fabricated completion is used.
 */
export async function runIncrementalCodeAiAcceptance({ students, teachers, instance, db, origin, env, output, send, record }) {
  const url = new URL(origin), database = new URL(env.DATABASE_URL);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port && !['80', '443', '3000', '3002'].includes(url.port), 'Code AI requires the isolated application');
  assert.equal(database.hostname, '127.0.0.1');
  assert.ok(database.port && database.port !== '5432', 'Code AI requires disposable PostgreSQL');
  assert.equal(env.PRELAUNCH_REAL_PROVIDERS, '1', 'Code AI requires the actual configured model');
  assert.ok(env.OPENPBL_VERIFICATION_MARKER);
  const marker = await db.$queryRaw`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${env.OPENPBL_VERIFICATION_MARKER}`;
  assert.equal(marker.length, 1, 'Code AI database has no matching disposable marker');
  const original = students.find(student => student.label === 'google-chrome');
  assert.ok(original?.context && original.user?.id && original.participation?.id && original.page, 'Missing Chrome representative');
  assert.equal(teachers.length, 2);
  const originalPage = original.page, originalUrl = original.page.url();
  const initialMainRow = await db.classroomSubmission.findFirstOrThrow({ where: { participationId: original.participation.id } });
  const initialMain = json(view(initialMainRow));
  const directory = path.join(output, 'incremental-code-ai');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { status: 'running', startedAt: new Date().toISOString(), mainInstanceId: instance.id,
    execution: 'real-next-api-and-configured-provider', language: 'python', intent: 'review',
    budgets: { completionMs: completionBudgetMs, executionMs: executionBudgetMs },
    sandboxExecuted: false, insideSustainedLoad: false, attempts: [], fixture: null };
  const save = () => writeFile(path.join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  let failure;
  try {
    const design = createPblTemplateCourse(randomUUID(), { name: '代码AI增量真实后端专项', subject: '信息科技', grade: '七年级',
      drivingQuestion: '如何复核观测样本平均值的计算？', expectedOutcome: '识别平均值分母与实际样本数量的关系',
      pblConfig: { makeArtifactMode: 'python' }, content: { pblOutline: '保留已有代码，先核对样本数量与分母，再讨论修改。',
        knowledgePoints: [{ id: 'mean', name: '平均值', description: '样本值之和除以实际样本数量。' }], lessonOutline: [],
        evaluationPlan: { dimensions: [], overallRubric: '' } } });
    const template = await db.classroomTemplate.create({ data: { id: design.id, ownerId: teachers[0].user.id,
      title: design.name, status: 'PUBLISHED', versions: { create: { version: 1, status: 'PUBLISHED', snapshot: encodePblTemplate(design) } } }, include: { versions: true } });
    const offering = await db.courseOffering.create({ data: { name: design.name, status: 'OPEN',
      teachers: { create: teachers.map(teacher => ({ userId: teacher.user.id })) } } });
    evidence.fixture = { templateId: template.id, templateVersionId: template.versions[0].id, offeringId: offering.id,
      studentId: original.user.id, sourceClient: original.client };
    const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: '代码AI最小链', position: 0, isOpen: true } });
    const activity = await db.activity.create({ data: { chapterId: chapter.id, title: design.name, type: 'CLASSROOM', position: 0, isOpen: true } });
    const course = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: template.versions[0].id,
      status: 'TEACHING', startedAt: new Date(), runtimeConfig: { version: 1, currentStageIndex: 2,
        classConfig: { groupMode: 'solo', totalStudents: 1, perGroup: 1, crossClass: false } } } });
    const enrollment = await db.enrollment.create({ data: { offeringId: offering.id, userId: original.user.id } });
    const participation = await db.classroomParticipation.create({ data: { instanceId: course.id, enrollmentId: enrollment.id, firstEnteredAt: new Date() } });
    const groupId = `grp-${original.user.id}`;
    const group = await db.projectGroup.create({ data: { id: `${offering.id}:${groupId}`, offeringId: offering.id,
      name: '代码AI个人组', members: { create: { userId: original.user.id, participationId: participation.id } } } });
    Object.assign(evidence.fixture, { chapterId: chapter.id, activityId: activity.id, instanceId: course.id,
      enrollmentId: enrollment.id, participationId: participation.id, groupId, storedGroupId: group.id });
    assert.notEqual(course.id, instance.id);
    const actor = { role: 'student', context: original.context, user: original.user, client: `code-ai-${original.client}`, participation };
    const codeMarker = `INC_CODE_AI_${randomUUID()}`;
    const artifact = { version: 1, language: 'python', activeFileId: 'main', files: [{ id: 'main', path: 'main.py',
      content: `# ${codeMarker}\nobservations = [12, 18, 24]\nmean = sum(observations) / (len(observations) + 1)\nprint(mean)\n` }] };
    const now = new Date().toISOString();
    const submission = { id: randomUUID(), courseId: course.id, studentId: original.user.id, studentName: original.user.displayName,
      groupId, stageKey: 'make', type: 'code', title: '平均值代码核对', content: JSON.stringify(artifact), status: 'draft', version: 1,
      createdAt: now, updatedAt: now };
    const saveId = randomUUID();
    const ack = await send(actor, 'POST', `/api/courses/${course.id}/actions`, { requestId: saveId,
      action: { type: 'UPSERT_SUBMISSION', payload: { courseId: course.id, expectedSubmissionVersion: 0, submission } } });
    assert.equal(ack.requestId, saveId); assert.equal(ack.submissionVersion, 1);
    const savedRows = await db.classroomSubmission.findMany({ where: { participationId: participation.id } });
    assert.equal(savedRows.length, 1); const saved = view(savedRows[0]);
    assert.equal(saved.courseId, course.id); assert.equal(saved.studentId, original.user.id);
    assert.equal(saved.version, 1); assert.deepEqual(JSON.parse(saved.content), artifact);
    evidence.savedCode = { requestId: saveId, ack, submission, contentSha256: hash(submission.content),
      referenceArithmetic: { sampleCount: 3, sum: 54, expectedMean: 18, expressionMean: 13.5 } };
    const historyQuery = { courseId: course.id, studentId: original.user.id, stageKey: 'make', language: 'python' };
    const history = await send(actor, 'GET', `/api/ai-collaboration/code?${new URLSearchParams(historyQuery)}`);
    assert.ok(history.conversationId && history.messages.length === 0, 'New code fixture already has conversation messages');
    const body = { ...historyQuery, requestId: randomUUID(), conversationId: history.conversationId, intent: 'review', mode: 'discuss', artifact,
      message: '请检查 main.py 的平均值计算。只依据已有三个观测值指出可定位的分母问题，并解释实际样本数量与分母应有什么关系；先讨论，不直接改写代码。' };
    evidence.request = body; await save();
    const began = performance.now(), deadline = began + completionBudgetMs;
    const request = async (method, endpoint, data, timeoutMs) => {
      const start = performance.now();
      const attempt = { method, startedAt: new Date().toISOString(), elapsedMs: null, status: 0 };
      evidence.attempts.push(attempt);
      try {
        const response = await actor.context.request.fetch(`${origin}${endpoint}`, { method,
          headers: { Origin: origin, 'X-OpenPBL-Role': 'student' }, ...(data === undefined ? {} : { data }), timeout: timeoutMs });
        attempt.status = response.status(); attempt.body = await response.json();
        return { status: response.status(), body: attempt.body };
      } catch (error) { attempt.error = String(error.message ?? error).slice(0, 1500); throw error; }
      finally { attempt.elapsedMs = performance.now() - start; await save(); }
    };
    let receipt = await request('POST', '/api/ai-collaboration/code', body, completionBudgetMs);
    evidence.admission = receipt;
    assert.ok([200, 202].includes(receipt.status), JSON.stringify(receipt).slice(0, 1000));
    const receiptEndpoint = `/api/ai-collaboration/code?${new URLSearchParams({ ...historyQuery,
      requestId: body.requestId, conversationId: body.conversationId })}`;
    while (receipt.body.status === 'processing' && performance.now() < deadline) {
      await delay(Math.min(1000, Math.max(0, deadline - performance.now())));
      if (performance.now() >= deadline) break;
      receipt = await request('GET', receiptEndpoint, undefined, Math.max(1, Math.ceil(deadline - performance.now())));
      assert.ok([200, 202].includes(receipt.status), JSON.stringify(receipt).slice(0, 1000));
    }
    evidence.completionMs = performance.now() - began; evidence.final = receipt;
    assert.equal(receipt.status, 200); assert.equal(receipt.body.status, 'completed');
    assert.equal(receipt.body.requestId, body.requestId);
    assert.ok(evidence.completionMs <= completionBudgetMs, 'Code AI exceeded its existing 120-second completion budget');
    assert.equal(receipt.body.artifactVersion, hash(JSON.stringify(artifact)));
    assert.ok(receipt.body.result?.message?.trim() && Array.isArray(receipt.body.result.findings), 'Code AI returned no inspectable result');
    for (const finding of receipt.body.result.findings) {
      const file = artifact.files.find(file => file.path === finding.filePath);
      assert.ok(file && Number.isInteger(finding.startLine) && Number.isInteger(finding.endLine));
      assert.ok(finding.startLine >= 1 && finding.endLine >= finding.startLine && finding.endLine <= file.content.split('\n').length);
      assert.ok(finding.quotedCode?.trim() && file.content.includes(finding.quotedCode), 'Code finding does not quote the saved source');
    }
    const tasksWhere = { createdById: original.user.id, AND: [
      { input: { path: ['requestId'], equals: body.requestId } },
      { input: { path: ['participationId'], equals: participation.id } },
      { input: { path: ['workspaceKind'], equals: 'code:python' } },
    ] };
    const tasks = await db.aiTask.findMany({ where: tasksWhere, include: { conversation: { include: { participation: true } } } });
    assert.equal(tasks.length, 1); const task = tasks[0];
    assert.equal(task.id, `document-ai-${hash(JSON.stringify([participation.id, body.requestId]))}`);
    assert.equal(task.taskType, 'DOCUMENT_COLLABORATION'); assert.equal(task.status, 'COMPLETED');
    assert.equal(task.offeringId, offering.id); assert.equal(task.createdById, original.user.id);
    assert.equal(task.input.intent, 'review'); assert.equal(task.input.message, body.message);
    assert.equal(task.input.documentVersion, receipt.body.artifactVersion);
    assert.equal(task.input.conversationId, body.conversationId);
    assert.equal(task.conversation.userId, original.user.id); assert.equal(task.conversation.offeringId, offering.id);
    assert.equal(task.conversation.participationId, participation.id); assert.equal(task.conversation.participation.instanceId, course.id);
    assert.ok(task.startedAt && task.completedAt);
    evidence.executionMs = task.completedAt - task.startedAt;
    assert.ok(evidence.executionMs >= 0 && evidence.executionMs <= executionBudgetMs, 'Code AI exceeded its existing 110-second execution budget');
    const messageWhere = { conversationId: task.conversationId }, eventWhere = { taskId: task.id };
    const [messages, events] = await Promise.all([db.aiMessage.findMany({ where: messageWhere, orderBy: { id: 'asc' } }),
      db.aiInteractionEvent.findMany({ where: eventWhere, orderBy: { id: 'asc' } })]);
    assert.equal(messages.length, 2); assert.equal(receipt.body.messages.length, 2);
    for (const message of receipt.body.messages) {
      const persisted = messages.find(row => row.id === message.id);
      assert.ok(persisted); assert.equal(persisted.content, message.content);
      assert.equal(persisted.role, message.role === 'student' ? 'user' : 'assistant');
      assert.equal(persisted.userId, message.role === 'student' ? original.user.id : null);
      assert.equal(persisted.metadata.requestId, body.requestId); assert.equal(persisted.metadata.taskId, task.id);
    }
    assert.ok(messages.some(message => message.role === 'user' && message.content === body.message));
    assert.ok(messages.some(message => message.role === 'assistant' && message.content === receipt.body.result.message));
    for (const event of events) {
      assert.equal(event.participationId, participation.id); assert.equal(event.userId, original.user.id);
      assert.equal(event.offeringId, offering.id); assert.equal(event.requestId, body.requestId);
    }
    assert.ok(events.some(event => event.eventType === 'request' && event.content === body.message));
    assert.ok(events.some(event => event.eventType === 'response' && event.content === receipt.body.result.message));
    evidence.task = json(task); evidence.messages = json(messages); evidence.events = json(events); await save();
    const originalReceipt = await request('GET', receiptEndpoint, undefined, 30000);
    assert.deepEqual(originalReceipt, receipt);
    const replay = await request('POST', '/api/ai-collaboration/code', body, 30000);
    assert.deepEqual(replay, receipt);
    const [afterTasks, afterMessages, afterEvents] = await Promise.all([
      db.aiTask.findMany({ where: tasksWhere, include: { conversation: { include: { participation: true } } } }),
      db.aiMessage.findMany({ where: messageWhere, orderBy: { id: 'asc' } }), db.aiInteractionEvent.findMany({ where: eventWhere, orderBy: { id: 'asc' } }),
    ]);
    assert.deepEqual(json(afterTasks), json(tasks)); assert.deepEqual(json(afterMessages), json(messages)); assert.deepEqual(json(afterEvents), json(events));
    const currentHistory = await send(actor, 'GET', `/api/ai-collaboration/code?${new URLSearchParams(historyQuery)}`);
    assert.deepEqual(currentHistory.messages.map(message => [message.id, message.content]).sort(),
      receipt.body.messages.map(message => [message.id, message.content]).sort());
    assert.equal(view(await db.classroomSubmission.findUniqueOrThrow({ where: { id: savedRows[0].id } })).content, submission.content,
      'A review silently changed the saved code');
    evidence.replay = { sameReceipt: true, uniqueTasks: afterTasks.length, messagesUnchanged: true, eventsUnchanged: true, codeUnchanged: true };
    evidence.status = 'passed';
  } catch (error) { failure = error; evidence.status = 'failed'; evidence.error = String(error.stack ?? error).slice(0, 6000); }
  finally {
    try {
      assert.equal(original.page, originalPage); assert.equal(original.page.url(), originalUrl);
      const current = view(await db.classroomSubmission.findUniqueOrThrow({ where: { id: initialMainRow.id } }));
      assert.equal(current.courseId, instance.id); assert.equal(current.studentId, original.user.id);
      assert.ok(current.version >= initialMain.version);
      if (current.version === initialMain.version) assert.equal(current.content, initialMain.content);
      assert.equal(current.content.includes('INC_CODE_AI_'), false, 'Independent code fixture leaked into the main draft');
      evidence.mainCourseIsolated = true;
    } catch (error) { failure ??= error; evidence.status = 'failed'; evidence.isolationError = String(error.stack ?? error).slice(0, 3000); }
    evidence.finishedAt = new Date().toISOString(); await save();
  }
  if (failure) throw failure;
  const result = { status: 'passed', courseId: evidence.fixture.instanceId, studentId: original.user.id,
    requestId: evidence.request.requestId, initialStatus: evidence.admission.status, finalStatus: evidence.final.status,
    completionMs: evidence.completionMs, executionMs: evidence.executionMs, uniqueTasks: 1, messages: evidence.messages.length,
    originalIdReplayMatched: true, mainCourseIsolated: true, sandboxExecuted: false, evidence: path.join(directory, 'evidence.json') };
  record('incremental-code-ai-real-next-provider', '通过', result, 'real-provider-api');
  return result;
}
