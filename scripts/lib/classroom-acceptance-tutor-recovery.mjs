import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const sha = text => createHash('sha256').update(text).digest('hex');
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value?.[key]]));
const ordered = rows => rows.sort((a, b) => a.id.localeCompare(b.id));
export const RETRYABLE_TUTOR_ERRORS = Object.freeze(['TUTOR_REQUEST_FAILED', 'TUTOR_REQUEST_TIMEOUT']);

/** Only the exact authenticated question can link two explicit UI attempts. */
export function tutorQuestionFingerprint(body) {
  const values = ['action', 'courseId', 'studentId', 'attemptId', 'questionId', 'message'].map(key => body?.[key]);
  if (body?.action !== 'tutor-message' || values.some(value => typeof value !== 'string' || !value.trim())) return undefined;
  return sha(JSON.stringify(values));
}

/** Keep paid-output evidence and immutable audit, excluding internal lease tokens. */
export function snapshotTutorTask(task) {
  const requestId = task.input?.requestId;
  return JSON.parse(JSON.stringify({
    ...pick(task, ['id', 'taskType', 'createdById', 'conversationId', 'status', 'error', 'createdAt', 'startedAt', 'completedAt', 'updatedAt', 'output']),
    input: pick(task.input, ['courseId', 'studentId', 'classroomId', 'requestId', 'threadId', 'attemptId', 'questionId', 'message', 'initial']),
    conversation: pick(task.conversation, ['id', 'userId', 'participationId']),
    messages: ordered((task.conversation?.messages ?? []).filter(row => row.metadata?.requestId === requestId).map(row => ({
      ...pick(row, ['id', 'userId', 'role', 'content', 'createdAt']), requestId: row.metadata.requestId,
    }))),
    audit: ordered((task.interactionEvents ?? []).map(row => pick(row,
      ['id', 'taskId', 'requestId', 'userId', 'participationId', 'conversationId', 'eventType', 'actor', 'content', 'createdAt']))),
  }));
}

export function assertTutorTaskReceipt(task, body, participationId, status) {
  assert.ok(tutorQuestionFingerprint(body), 'Tutor question identity is incomplete');
  assert.equal(task.taskType, 'KNOWLEDGE_LECTURE_TUTOR');
  assert.equal(task.status, status);
  assert.equal(task.createdById, body.studentId);
  assert.equal(task.input.initial, false);
  for (const key of ['requestId', 'courseId', 'studentId', 'attemptId', 'questionId', 'message']) assert.equal(task.input[key], body[key], key);
  assert.equal(task.conversation.userId, body.studentId);
  assert.equal(task.conversation.participationId, participationId);
  assert.equal(task.conversation.id, task.conversationId);
  assert.ok(task.input.threadId && task.input.classroomId);
  const questions = task.messages.filter(row => row.role === 'user');
  const answers = task.messages.filter(row => row.role === 'assistant');
  assert.equal(questions.length, 1); assert.equal(questions[0].content, body.message);
  assert.equal(task.messages.length, status === 'COMPLETED' ? 2 : 1);
  for (const row of task.messages) assert.equal(row.requestId, body.requestId);
  const questionAudit = task.audit.filter(row => row.eventType === 'message' && row.actor === 'student');
  assert.equal(questionAudit.length, 1); assert.equal(questionAudit[0].content, body.message);
  assert.equal(task.audit.length, status === 'COMPLETED' ? 2 : 1);
  for (const row of task.audit) {
    assert.equal(row.taskId, task.id); assert.equal(row.requestId, body.requestId);
    assert.equal(row.userId, body.studentId); assert.equal(row.participationId, participationId);
    assert.equal(row.conversationId, task.conversationId);
  }
  const raw = task.output?.modelOutput?.raw;
  if (raw !== undefined) {
    assert.equal(typeof raw, 'string'); assert.equal(task.output.modelOutput.sha256, sha(raw));
  }
  if (status === 'COMPLETED') {
    assert.ok(raw?.trim(), 'Completed tutor must retain its actual model output');
    const serverMs = Date.parse(task.completedAt) - Date.parse(task.startedAt);
    assert.ok(Number.isFinite(serverMs) && serverMs >= 0 && serverMs <= 150_000, 'Tutor server deadline remains 150 seconds');
    assert.equal(answers.length, 1); assert.ok(answers[0].content.trim());
    const responseAudit = task.audit.filter(row => row.eventType === 'response' && row.actor === 'assistant');
    assert.equal(responseAudit.length, 1); assert.equal(responseAudit[0].content, answers[0].content);
    assert.ok(task.output.thread.messages.some(row => row.role === 'assistant' && row.content === answers[0].content));
  } else {
    assert.ok(task.error, 'Failed tutor must retain its real diagnostic');
    if (task.error === 'TUTOR_INVALID_OUTPUT') assert.equal(typeof raw, 'string', 'A parse failure must retain the actual rejected text');
  }
}

/** Re-evaluated before any original HTTP failure is classified as recovered. */
export function assertTutorUiRecovery(chain) {
  assert.equal(chain.status, 'completed');
  assert.equal(chain.phase, 'ai-learning');
  assert.equal(chain.client, `student-${chain.studentIndex}`);
  assert.ok(Number.isInteger(chain.studentIndex) && chain.studentIndex >= 0);
  assert.ok(chain.participationId);
  assert.equal(chain.attempts.length, 2, 'At most one explicit user retry is permitted');
  const [first, final] = chain.attempts;
  assert.equal(first.status, 503); assert.ok(RETRYABLE_TUTOR_ERRORS.includes(first.errorCode));
  assert.equal(final.status, 200);
  assert.notEqual(first.body.requestId, final.body.requestId);
  const { requestId: firstId, ...question } = first.body;
  const { requestId: finalId, ...retryQuestion } = final.body;
  assert.ok(firstId && finalId); assert.deepEqual(retryQuestion, question);
  assert.equal(chain.questionFingerprint, tutorQuestionFingerprint(first.body));
  assert.ok(chain.questionFingerprint);
  assertTutorTaskReceipt(first.task, first.body, chain.participationId, 'FAILED');
  assertTutorTaskReceipt(final.task, final.body, chain.participationId, 'COMPLETED');
  assert.notEqual(first.task.id, final.task.id);
  assert.equal(first.task.conversationId, final.task.conversationId);
  assert.equal(first.task.input.threadId, final.task.input.threadId);
  assert.equal(first.task.input.classroomId, final.task.input.classroomId);
  assert.deepEqual(chain.failedTaskAfterRetry, first.task, 'User recovery must not rewrite the first failed attempt');
  assert.equal(chain.ui.errorText, first.errorCode);
  assert.equal(chain.ui.retainedQuestion, first.body.message);
  assert.equal(chain.ui.sendEnabled, true); assert.equal(chain.ui.retryClicks, 1);
  assert.ok(Number.isFinite(chain.startedAtMs) && Number.isFinite(first.observedAtMs)
    && Number.isFinite(chain.ui.retryClickedAtMs) && Number.isFinite(final.observedAtMs)
    && chain.startedAtMs <= first.observedAtMs && first.observedAtMs <= chain.ui.retryClickedAtMs
    && chain.ui.retryClickedAtMs <= final.observedAtMs);
  assert.ok(Number.isFinite(chain.completeMs) && chain.completeMs > 0 && chain.completeMs <= 180_000);
  assert.ok(final.observedAtMs - chain.startedAtMs <= chain.completeMs);
  assert.equal(chain.visibleAnswer, final.task.messages.find(row => row.role === 'assistant').content);
  assert.equal(chain.replay.requestId, finalId);
  assert.deepEqual(chain.replay.thread, final.task.output.thread);
  assert.deepEqual(chain.finalTaskAfterReplay, final.task, 'Completed replay must not create or alter task/audit/messages');
  assert.equal(chain.audio.status, 'passed'); assert.equal(chain.audio.requestId, finalId);
  assert.equal(chain.audio.taskId, final.task.id); assert.equal(chain.audio.studentId, final.body.studentId);
  assert.match(chain.audio.sha256, /^[a-f0-9]{64}$/);
  assert.ok(chain.audio.events.some(event => event.type === 'playing') && chain.audio.events.some(event => event.type === 'ended'));
  return chain;
}

/** Invalid or unrelated evidence must not conceal any transport failure. */
export function matchTutorUiRecovery(failure, entries, chains = []) {
  if (failure.path !== '/api/knowledge-lecture' || failure.method !== 'POST' || failure.operation !== 'tutor-message') return undefined;
  const matches = chains.filter(chain => {
    try { assertTutorUiRecovery(chain); } catch { return false; }
    const [first, final] = chain.attempts;
    return chain.phase === failure.phase && chain.client === failure.client
      && first.status === failure.status && first.errorCode === failure.errorCode
      && first.body.requestId === failure.requestId && chain.questionFingerprint === failure.tutorQuestionFingerprint
      && entries.some(row => row.client === chain.client && row.phase === chain.phase && !row.injected
        && row.method === failure.method && row.path === failure.path && row.operation === failure.operation
        && row.requestId === final.body.requestId && row.tutorQuestionFingerprint === chain.questionFingerprint
        && row.status === 200 && row.finishedAtMs >= failure.finishedAtMs);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Bind the manifest to observed final evidence, never an arbitrary task order. */
export function selectVerifiedTutorTask(tasks, followups, { studentId, courseId }) {
  const receipts = (followups ?? []).filter(row => row.studentId === studentId);
  if (receipts.length !== 1) return undefined;
  const receipt = receipts[0];
  const matches = tasks.filter(task => task.id === receipt.taskId && task.input?.requestId === receipt.requestId
    && task.input?.studentId === studentId && task.input?.courseId === courseId
    && task.taskType === 'KNOWLEDGE_LECTURE_TUTOR' && task.input.initial === false && task.status === 'COMPLETED');
  return matches.length === 1 ? matches[0] : undefined;
}
