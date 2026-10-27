import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { assertTutorUiRecovery, selectVerifiedTutorTask, snapshotTutorTask, tutorQuestionFingerprint } from './classroom-acceptance-tutor-recovery.mjs';
import { classifyClassroomRequest, summarizeClassroomAiTraffic } from './classroom-acceptance-traffic.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const question = { action: 'tutor-message', courseId: 'course', studentId: 'student',
  attemptId: 'quiz-attempt', questionId: 'question', message: '为什么观察时长必须相同？' };
function task(requestId, completed) {
  const id = `task-${requestId}`;
  const raw = completed ? '{"answer":"比较条件应一致","boardNotes":[]}' : '{"answer":"未闭合';
  const student = { id: `${id}:student`, role: 'user', userId: 'student', content: question.message,
    metadata: { requestId }, createdAt: '2026-10-16T00:00:01.000Z' };
  const assistant = { id: `${id}:assistant`, role: 'assistant', content: '比较条件应一致',
    metadata: { requestId }, createdAt: '2026-10-16T00:00:20.000Z' };
  const event = (message, role) => ({ id: `audit-${message.id}`, taskId: id, requestId, userId: 'student',
    participationId: 'participation', conversationId: 'conversation', eventType: role === 'student' ? 'message' : 'response',
    actor: role, content: message.content, createdAt: message.createdAt });
  return { id, taskType: 'KNOWLEDGE_LECTURE_TUTOR', createdById: 'student', conversationId: 'conversation',
    status: completed ? 'COMPLETED' : 'FAILED', error: completed ? null : 'TUTOR_INVALID_OUTPUT',
    startedAt: '2026-10-16T00:00:01.000Z', completedAt: '2026-10-16T00:00:20.000Z',
    input: { ...question, requestId, initial: false, threadId: 'thread', classroomId: 'resource', token: 'must-not-export' },
    output: { modelOutput: { raw, sha256: hash(raw) }, ...(completed ? { thread: { id: 'thread',
      messages: [{ id: `${id}:assistant`, role: 'assistant', content: assistant.content }] } } : {}) },
    conversation: { id: 'conversation', userId: 'student', participationId: 'participation',
      messages: completed ? [student, assistant] : [student] },
    interactionEvents: completed ? [event(student, 'student'), event(assistant, 'assistant')] : [event(student, 'student')] };
}
function evidence() {
  const first = snapshotTutorTask(task('first', false));
  const final = snapshotTutorTask(task('final', true));
  return { status: 'completed', phase: 'ai-learning', client: 'student-4', studentIndex: 4, participationId: 'participation',
    startedAtMs: 1000, completeMs: 21000, questionFingerprint: tutorQuestionFingerprint(question),
    attempts: [
      { status: 503, errorCode: 'TUTOR_REQUEST_FAILED', body: { ...question, requestId: 'first' }, task: first, observedAtMs: 11000 },
      { status: 200, body: { ...question, requestId: 'final' }, task: final, observedAtMs: 21000 },
    ],
    ui: { errorText: 'TUTOR_REQUEST_FAILED', retainedQuestion: question.message, sendEnabled: true, retryClicks: 1, retryClickedAtMs: 12000 },
    failedTaskAfterRetry: structuredClone(first), finalTaskAfterReplay: structuredClone(final),
    visibleAnswer: '比较条件应一致', replay: { requestId: 'final', thread: structuredClone(final.output.thread) },
    audio: { status: 'passed', taskId: final.id, requestId: 'final', studentId: 'student',
      sha256: 'a'.repeat(64), events: [{ type: 'playing' }, { type: 'ended' }] } };
}
function traffic(chain) {
  return chain.attempts.map(attempt => ({ client: chain.client, phase: chain.phase, injected: false,
    path: '/api/knowledge-lecture', method: 'POST', ...classifyClassroomRequest({ path: '/api/knowledge-lecture', method: 'POST', body: attempt.body }),
    requestId: attempt.body.requestId, status: attempt.status, errorCode: attempt.errorCode,
    finishedAtMs: attempt.observedAtMs, elapsedMs: 10000 }));
}
const summary = (rows, chains) => Object.values(summarizeClassroomAiTraffic(rows, 'ai-learning', { tutorUiRecoveries: chains }))[0];

test('explicit same-question UI recovery retains the first failed raw/audit and transport attempt', () => {
  const chain = evidence();
  assert.equal(assertTutorUiRecovery(chain), chain);
  assert.equal('token' in chain.attempts[0].task.input, false);
  const rows = traffic(chain);
  assert.equal(summary(rows, []).unrecoveredFailures, 1, 'A later new-ID 200 alone is not recovery');
  const measured = summary(rows, [chain]);
  assert.equal(measured.firstAttemptFailures, 1); assert.equal(measured.recoveredFailures, 0);
  assert.equal(measured.logicalRecoveredFailures, 1); assert.equal(measured.unrecoveredFailures, 0);
  assert.equal(measured.failedHttpAttempts, 1); assert.equal(measured.failedLogicalRequests, 1);
  assert.equal(measured.recoveredLogicalRequests, 1); assert.equal(measured.unrecoveredLogicalRequests, 0);
  assert.equal(measured.failedAttempts[0].requestId, 'first'); assert.equal(measured.failedAttempts[0].status, 503);
  assert.deepEqual(measured.logicalRecoveries[0], { client: 'student-4', failedRequestId: 'first', completedRequestId: 'final',
    questionFingerprint: chain.questionFingerprint, completeMs: 21000 });
});

test('unrelated responses, question identities and incomplete UI/native/receipt proof cannot hide the failed request', () => {
  for (const mutate of [
    (chain, rows) => { rows[1].client = 'student-8'; },
    (chain, rows) => { rows[1].requestId = 'unrelated'; },
    (chain, rows) => { rows[1].tutorQuestionFingerprint = tutorQuestionFingerprint({ ...question, message: '另一问题' }); },
    (chain, rows) => { rows[0].tutorQuestionFingerprint = undefined; },
    (chain, rows) => { rows[1].status = 202; },
    (chain, rows) => { rows[1].injected = true; },
    chain => { chain.attempts[1].body.courseId = 'other-course'; },
    chain => { chain.attempts[1].task.input.studentId = 'other-student'; },
    chain => { chain.ui.retryClicks = 2; },
    chain => { chain.ui.retainedQuestion = ''; },
    chain => { chain.audio.events = [{ type: 'playing' }]; },
    chain => { chain.finalTaskAfterReplay.audit.push({ id: 'duplicate' }); },
    chain => { chain.failedTaskAfterRetry.status = 'COMPLETED'; },
    chain => { chain.attempts[0].task.output.modelOutput.raw = 'changed'; },
    chain => { chain.completeMs = 180001; },
    chain => { chain.status = 'failed'; },
  ]) {
    const chain = evidence(); const rows = traffic(chain); mutate(chain, rows);
    const measured = summary(rows, [chain]);
    assert.equal(measured.firstAttemptFailures, 1); assert.equal(measured.unrecoveredFailures, 1);
    assert.equal(measured.logicalRecoveredFailures, 0);
    assert.equal(measured.failedHttpAttempts, 1); assert.equal(measured.failedLogicalRequests, 1);
    assert.equal(measured.recoveredLogicalRequests, 0); assert.equal(measured.unrecoveredLogicalRequests, 1);
  }
  const chain = evidence();
  assert.equal(summary(traffic(chain), [chain, structuredClone(chain)]).unrecoveredFailures, 1, 'Ambiguous proof must fail closed');
});

test('manifest selects the independently verified final receipt regardless of task order', () => {
  const failed = task('first', false); const completed = task('final', true); const unrelated = task('other', true);
  const receipt = [{ studentId: 'student', requestId: 'final', taskId: completed.id }];
  const scope = { studentId: 'student', courseId: 'course' };
  for (const tasks of [[failed, unrelated, completed], [completed, failed, unrelated]]) {
    assert.equal(selectVerifiedTutorTask(tasks, receipt, scope), completed);
  }
  assert.equal(selectVerifiedTutorTask([failed, unrelated], receipt, scope), undefined);
  assert.equal(selectVerifiedTutorTask([completed], receipt, { ...scope, courseId: 'other' }), undefined);
  assert.equal(selectVerifiedTutorTask([completed], [...receipt, ...receipt], scope), undefined);
  assert.equal(selectVerifiedTutorTask([completed], [{ ...receipt[0], requestId: 'first' }], scope), undefined);
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.error, 'TUTOR_INVALID_OUTPUT');
});
