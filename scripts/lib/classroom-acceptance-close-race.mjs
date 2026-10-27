import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const stages = [
  ['launch', '项目启动', 'simple-resource'], ['ai-learning', '知识讲授', 'ai-learning'],
  ['make', '项目实践', 'ai-collaboration'], ['showcase', '成果汇报与评价', 'showcase-reporting'],
  ['reflection', '后测', 'experiment-posttest'],
].map(([key, label, view]) => ({ key, label, view, description: label }));

async function until(read, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do { const result = await read(); if (result) return result; await delay(100); } while (Date.now() < deadline);
  throw new Error(message);
}

const bodyOf = request => { try { return request.postDataJSON(); } catch { return null; } };

/** The classroom UI commits its stage gate + timing as UPDATE_COURSE. Match
 * the requested transition, not unrelated initialization/timer updates.
 */
export function isRaceTransition(body, transition, instanceId) {
  const action = body?.action;
  if (action?.payload?.id !== instanceId) return false;
  if (transition === 'finish') return action.type === 'END_TEACHING';
  if (transition !== 'stage') return false;
  return (action.type === 'SET_STAGE' && action.payload.index === 3)
    || (action.type === 'UPDATE_COURSE' && action.payload.patch?.currentStageIndex === 3);
}

export function assertRaceReceipt({ body, status, receipt, stored, event, localDrafts = [] }) {
  const submitted = body.action.payload.submission;
  if (status === 200) {
    assert.equal(receipt.requestId, body.requestId);
    assert.equal(stored.content, submitted.content, 'A successful save was overwritten by the classroom transition');
    assert.equal(stored.version, receipt.submissionVersion, 'Stored revision differs from the successful acknowledgement');
    assert.deepEqual(event?.payload?.ack, receipt, 'The successful acknowledgement has no identical durable receipt');
    assert.equal(event.payload.action.payload.submission.content, submitted.content);
  } else {
    assert.equal(status, 409, 'Race rejection must be a genuine closed classroom/version conflict');
    assert.ok(['CLASSROOM_READ_ONLY', 'DRAFT_VERSION_CONFLICT', 'VERSION_CONFLICT'].includes(receipt.code), receipt.code);
    assert.equal(event, undefined, 'A rejected request created a durable success receipt');
    assert.ok(localDrafts.some(draft => draft.content === submitted.content), 'Rejected content was not retained as a local draft');
  }
}

/** A real row lock, scoped to a newly created disposable classroom. No route is
 * fulfilled or delayed by Playwright; browser requests contend in PostgreSQL.
 */
export async function withClassroomRaceBarrier(db, instanceId, action) {
  let unlock;
  let acquired;
  let failed;
  let watchdog;
  const locked = new Promise((resolve, reject) => { acquired = resolve; failed = reject; });
  const release = new Promise(resolve => { unlock = resolve; });
  const timing = {};
  const transaction = db.$transaction(async tx => {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    const rows = await tx.$queryRaw`SELECT "id" FROM "ClassroomInstance" WHERE "id" = ${instanceId} FOR UPDATE`;
    assert.equal(rows.length, 1, 'Race barrier classroom disappeared');
    timing.acquiredAt = new Date().toISOString();
    watchdog = setTimeout(unlock, 20_000);
    acquired();
    await release;
  }, { maxWait: 5000, timeout: 30_000 }).then(value => ({ value }), error => { failed(error); return { error }; });
  try {
    await locked;
    await action(timing);
  } finally {
    clearTimeout(watchdog);
    timing.releasedAt = new Date().toISOString();
    unlock();
    const result = await transaction;
    if (result.error) throw result.error;
  }
  assert.ok(Date.parse(timing.releasedAt) - Date.parse(timing.acquiredAt) < 20_000, 'Race barrier watchdog expired before the requests were issued');
  return timing;
}

export async function runCloseRaceAcceptance({ teacher, students, origin, db, request, record, output, offering, chapter }) {
  const url = new URL(origin);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && ['3197', '3198'].includes(url.port), 'Race acceptance requires the isolated prelaunch application');
  assert.ok(students.length >= 2 && students.length <= 30);
  const directory = path.join(output, 'classroom-close-race');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { startedAt: new Date().toISOString(), students: students.length, passed: false, rounds: [] };
  const save = () => writeFile(path.join(directory, 'receipts.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  try {
    for (const transition of ['stage', 'finish']) {
      const round = { transition, passed: false, requests: [], responses: [], students: [] };
      evidence.rounds.push(round);
      const template = await request(teacher.context, 'POST', '/api/platform/templates', {
        title: `文稿保存与${transition}竞争验收`, snapshot: { schemaVersion: 2, kind: 'pbl-course', design: {
          name: '真实在途保存竞争', subject: '科学', grade: '七年级', hours: 1, stages,
          drivingQuestion: '阶段变化时已确认的文稿是否完整保留？', expectedOutcome: '可对账的文稿与保存回执',
          pblConfig: { makeArtifactMode: 'document' }, content: { pblOutline: '真实浏览器编辑与保存。', knowledgePoints: [],
            lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' } },
        } },
      }, 201);
      const activity = (await request(teacher.context, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
        type: 'Classroom', title: `在途保存 ${transition}`, templateVersionId: template.versions[0].id,
      }, 201)).activity;
      await request(teacher.context, 'PATCH', `/api/platform/activities/${activity.id}`, { isOpen: true });
      const instance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: activity.id } });
      assert.ok(instance.createdAt.getTime() >= Date.parse(evidence.startedAt), 'Only this run\'s newly created classroom may be locked');
      round.instanceId = instance.id;
      const endpoint = `/api/courses/${instance.id}/actions`;
      await request(teacher.context, 'POST', `/api/platform/classroom-instances/${instance.id}/start`, {});
      await request(teacher.context, 'POST', endpoint, { requestId: randomUUID(), action: { type: 'SET_STAGE', payload: { id: instance.id, index: 2 } } });
      const participants = new Map();
      const baseline = await Promise.allSettled(students.map(async student => {
        await request(student.context, 'GET', `/api/platform/activities/${activity.id}`);
        const entered = await request(student.context, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {});
        participants.set(student.user.id, entered.participation.id);
        await student.page.goto(`${origin}/student/ai-collaboration/${instance.id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const editor = student.page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
        await editor.waitFor({ timeout: 60_000 });
        const marker = `BASELINE_${transition}_${student.index}`;
        await editor.fill(marker);
        await student.page.getByRole('button', { name: '保存', exact: true }).click();
        const saved = await until(async () => {
          const rows = await db.classroomSubmission.findMany({ where: { participationId: entered.participation.id } });
          return rows.find(row => (row.payload?.view ?? row.payload)?.content?.includes(marker));
        }, `Student ${student.index} initial document was not saved`);
        return { student, initial: saved.payload.view ?? saved.payload, editor, marker: `IN_FLIGHT_${transition}_${student.index}_${randomUUID()}` };
      }));
      const setupErrors = baseline.filter(item => item.status === 'rejected');
      assert.equal(setupErrors.length, 0, setupErrors.map(item => item.reason.message).join('\n'));
      const roster = baseline.map(item => item.value);
      await teacher.page.goto(`${origin}/teacher/teach/${instance.id}/classroom`, { waitUntil: 'domcontentloaded' });
      await teacher.page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).first().click();
      if (transition === 'finish') await teacher.page.getByRole('button', { name: '结束课堂', exact: true }).filter({ visible: true }).first().click();
      else await teacher.page.getByLabel('全屏教学阶段', { exact: true }).selectOption('3');
      const confirm = transition === 'finish'
        ? teacher.page.getByRole('alertdialog').getByRole('button', { name: '结束课堂', exact: true })
        : teacher.page.getByRole('dialog').getByRole('button', { name: /进入|切换|回退/ });
      await confirm.waitFor({ state: 'visible' });
      const isAction = (req, type) => new URL(req.url()).pathname === endpoint && req.method() === 'POST' && bodyOf(req)?.action?.type === type;
      const isTransition = req => new URL(req.url()).pathname === endpoint && req.method() === 'POST' && isRaceTransition(bodyOf(req), transition, instance.id);
      const pendingReceipts = [];
      const listeners = [];
      for (const [who, page] of [['teacher', teacher.page], ...students.map(student => [student.user.id, student.page])]) {
        const belongsToRace = req => who === 'teacher' ? isTransition(req)
          : isAction(req, 'UPSERT_SUBMISSION') && bodyOf(req).action.payload.submission.content.includes(roster.find(row => row.student.user.id === who).marker);
        const onRequest = req => { if (belongsToRace(req)) round.requests.push({ who, at: new Date().toISOString(), body: bodyOf(req) }); };
        const onResponse = response => {
          if (!belongsToRace(response.request())) return;
          const row = { who, at: new Date().toISOString(), body: bodyOf(response.request()), status: response.status() };
          round.responses.push(row);
          pendingReceipts.push(response.json().then(receipt => { row.receipt = receipt; }, error => { row.error = error.message; }));
        };
        page.on('request', onRequest); page.on('response', onResponse); listeners.push([page, onRequest, onResponse]);
      }
      const responseWaits = roster.map(({ student, marker }) => student.page.waitForResponse(response => isAction(response.request(), 'UPSERT_SUBMISSION')
        && bodyOf(response.request()).action.payload.submission.content.includes(marker), { timeout: 45_000 }));
      responseWaits.push(teacher.page.waitForResponse(response => isTransition(response.request()) && response.status() === 200, { timeout: 45_000 }));
      const settledResponses = Promise.allSettled(responseWaits);
      try {
        round.barrier = await withClassroomRaceBarrier(db, instance.id, async timing => {
          round.barrier = timing;
          const requests = roster.map(({ student, marker }) => student.page.waitForRequest(req => isAction(req, 'UPSERT_SUBMISSION')
            && bodyOf(req).action.payload.submission.content.includes(marker), { timeout: 15_000 }));
          requests.push(teacher.page.waitForRequest(isTransition, { timeout: 15_000 }));
          const allIssued = Promise.allSettled(requests);
          const edits = await Promise.allSettled(roster.map(({ editor, marker }) => editor.fill(marker)));
          assert.ok(edits.every(result => result.status === 'fulfilled'), 'A browser failed to edit during the barrier');
          // The UI's real 900ms debounce sends saves; no save API is called here.
          await confirm.click();
          const issued = await allIssued;
          const missing = issued.flatMap((result, index) => result.status === 'fulfilled' ? [] : [index === roster.length ? 'teacher transition' : `student ${index} autosave`]);
          assert.equal(missing.length, 0, `Not every browser issued its operation while the row was locked: ${missing.join(', ')}`);
          assert.equal(round.responses.length, 0, 'A business response escaped the held classroom barrier');
          round.issuedWhileLocked = issued.length;
          round.lockAcquiredAt = timing.acquiredAt;
        });
        const responses = await settledResponses;
        assert.ok(responses.every(result => result.status === 'fulfilled'), 'Some in-flight operations never returned a successful transition or save result');
        await Promise.all(pendingReceipts);
        for (const row of round.requests) assert.ok(Date.parse(row.at) >= Date.parse(round.barrier.acquiredAt), 'Operation preceded the race barrier');
        const instanceAfter = await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
        assert.equal(instanceAfter.status, transition === 'finish' ? 'FINISHED' : 'TEACHING');
        const teacherState = (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
        if (transition === 'stage') assert.equal(teacherState.currentStageIndex, 3);
        for (const { student, initial } of roster) {
          const rows = await db.classroomSubmission.findMany({ where: { participationId: participants.get(student.user.id), stageKey: 'make:document' } });
          assert.equal(rows.length, 1, 'The race duplicated a student submission');
          const stored = rows[0].payload.view ?? rows[0].payload;
          const localDrafts = await student.page.evaluate(({ instanceId, studentId }) => Object.entries(localStorage)
            .filter(([key]) => key.startsWith('openpbl:document-draft:v1:'))
            .flatMap(([, value]) => { try { const draft = JSON.parse(value); return draft.scope?.startsWith(`${instanceId}:${studentId}:`) ? [draft] : []; } catch { return []; } }), { instanceId: instance.id, studentId: student.user.id });
          const studentResponses = round.responses.filter(row => row.who === student.user.id && row.body?.action?.type === 'UPSERT_SUBMISSION');
          assert.ok(studentResponses.length, 'No real autosave receipt was captured');
          for (const row of studentResponses) {
            const events = await db.domainEvent.findMany({ where: { idempotencyKey: `course-action:${student.user.id}:${row.body.requestId}` } });
            assert.equal(events.length, row.status === 200 ? 1 : 0, 'A request produced duplicate or unacknowledged success receipts');
            assertRaceReceipt({ ...row, stored, event: events[0], localDrafts });
            if (row.status === 200) {
              const replay = await student.context.request.post(`${origin}${endpoint}`, { data: row.body, headers: { Origin: origin }, timeout: 30_000 });
              assert.equal(replay.status(), 200); assert.deepEqual(await replay.json(), row.receipt);
              assert.equal(await db.domainEvent.count({ where: { idempotencyKey: `course-action:${student.user.id}:${row.body.requestId}` } }), 1);
            }
          }
          if (!studentResponses.some(row => row.status === 200)) assert.equal(stored.content, initial.content, 'Rejected saves changed the confirmed baseline');
          assert.ok(teacherState.submissions.some(row => row.studentId === student.user.id && row.content === stored.content), 'Teacher state disagrees with durable content');
          if (transition === 'finish') {
            const body = structuredClone(studentResponses[0].body); body.requestId = randomUUID();
            body.action.payload.expectedSubmissionVersion = stored.version;
            body.action.payload.submission.content = `AFTER_CLOSED_${randomUUID()}`;
            const late = await student.context.request.post(`${origin}${endpoint}`, { data: body, headers: { Origin: origin }, timeout: 30_000 });
            const receipt = await late.json(); assert.equal(late.status(), 409); assert.equal(receipt.code, 'CLASSROOM_READ_ONLY');
            const after = await db.classroomSubmission.findUniqueOrThrow({ where: { id: rows[0].id } });
            assert.deepEqual(after.payload, rows[0].payload);
            assert.equal(await db.domainEvent.count({ where: { idempotencyKey: `course-action:${student.user.id}:${body.requestId}` } }), 0);
            round.responses.push({ who: student.user.id, afterClosed: true, body, status: late.status(), receipt });
          }
          round.students.push({ studentId: student.user.id, version: stored.version, accepted: studentResponses.filter(row => row.status === 200).length,
            rejected: studentResponses.filter(row => row.status !== 200).length, localDraftRetained: localDrafts.length > 0 });
        }
        round.passed = true;
      } finally {
        for (const [page, onRequest, onResponse] of listeners) { page.off('request', onRequest); page.off('response', onResponse); }
        await settledResponses; await Promise.allSettled(pendingReceipts); await save();
      }
    }
    evidence.passed = evidence.rounds.length === 2 && evidence.rounds.every(round => round.passed);
    record('classroom-write-close-race', '通过', { students: students.length, transitions: ['stage', 'finish'], realRowBarrier: true }, 'browser-real-backend');
  } catch (error) {
    evidence.error = String(error.stack ?? error);
    record('classroom-write-close-race', '失败', String(error.message), 'browser-real-backend');
  } finally { evidence.finishedAt = new Date().toISOString(); await save(); }
  return evidence;
}
