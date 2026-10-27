import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readBrowserExportReceipts, assertDocumentRequestExport, assertResearchExportRowContent } from './classroom-acceptance-exports.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const students = [0, 1].map(index => ({ index, user: { id: `student-${index}` },
  participation: { id: `participation-${index}`, enrollmentId: `enrollment-${index}` } }));
const receipt = index => ({ student: index, requestId: `request-${index}`, status: 'rejected', error: 'Browser received a timeout',
  requestBody: { requestId: `request-${index}`, courseId: 'classroom-1', studentId: `student-${index}`, stageKey: 'make', message: 'Keep the original observation.' } });

test('failed browser requests use attempts only when the success file is absent', async () => {
  const calls = [];
  const result = await readBrowserExportReceipts('/output', students, async filename => {
    calls.push(filename);
    if (!filename.endsWith('-attempts.json')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return JSON.stringify(students.map(student => receipt(student.index)));
  });
  assert.equal(calls.length, 2); assert.ok(result.filename.endsWith('-attempts.json'));
  assert.equal(result.receipts[0].status, 'rejected');
  assert.equal(result.receipts[0].error, 'Browser received a timeout');
});

test('an incomplete or malformed existing success report cannot be replaced by attempts', async () => {
  for (const contents of ['{invalid', JSON.stringify([receipt(0)])]) {
    let reads = 0;
    await assert.rejects(readBrowserExportReceipts('/output', students, async () => { reads++; return contents; }));
    assert.equal(reads, 1);
  }
});

test('missing, duplicated or unobserved browser request identities cannot certify export coverage', async () => {
  const valid = students.map(student => receipt(student.index));
  for (const rows of [[valid[0], valid[0]], [valid[0], { ...valid[1], requestId: '' }],
    [valid[0], { ...valid[1], requestBody: undefined }], [valid[0], { ...valid[1], requestId: valid[0].requestId }]]) {
    await assert.rejects(readBrowserExportReceipts('/output', students, async filename => {
      if (!filename.endsWith('-attempts.json')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return JSON.stringify(rows);
    }));
  }
});

function example(status = 'COMPLETED') {
  const student = students[0]; const browserReceipt = receipt(0);
  const input = { requestId: browserReceipt.requestId, participationId: student.participation.id,
    stageKey: 'make', workspaceKind: 'document', conversationId: 'legacy', message: browserReceipt.requestBody.message };
  const task = { id: `document-ai-${hash(JSON.stringify([student.participation.id, input.requestId]))}`,
    taskType: 'DOCUMENT_COLLABORATION', createdById: student.user.id, offeringId: 'offering-1', status, input,
    conversationId: 'conversation-1', conversation: { id: 'conversation-1', userId: student.user.id, offeringId: 'offering-1',
      participationId: student.participation.id, participation: { instanceId: 'classroom-1', enrollmentId: student.participation.enrollmentId } },
    error: status === 'FAILED' ? 'AI_COLLABORATION_TIMEOUT' : null,
    output: status === 'COMPLETED' ? { response: { requestId: input.requestId, messages: [
      { role: 'student', content: input.message }, { role: 'agent', content: 'Record the date and duration.' },
    ] } } : null };
  const event = (eventType, actorRole, content, payload = {}) => ({ courseId: 'classroom-1', studentId: student.user.id,
    stageKey: 'make', conversationId: 'legacy', requestId: input.requestId, eventType, actorRole, content, payload });
  const auditEvents = [event('request', 'student', input.message)];
  if (status === 'COMPLETED') {
    auditEvents.push(event('response', 'ai', 'Record the date and duration.'));
    const raw = '{"answer":"Record the date and duration."}';
    auditEvents.push(event('response', 'system', raw, { kind: 'model-output', rawSha256: hash(raw) }));
  } else if (status === 'FAILED') auditEvents.push(event('error', 'system', 'The provider deadline elapsed.'));
  const archive = { course: { id: 'classroom-1' }, student: { id: student.user.id }, auditEvents,
    interactions: [{ messages: (task.output?.response.messages ?? []).map(message => ({ role: message.role === 'agent' ? 'ai' : message.role, content: message.content })) }] };
  return { archive, task, receipt: browserReceipt, student, instanceId: 'classroom-1', offeringId: 'offering-1' };
}

test('complete exported answers do not erase the independently failed browser result', () => {
  const value = example(); const summary = assertDocumentRequestExport(value);
  assert.equal(summary.status, 'COMPLETED'); assert.equal(summary.browserStatus, 'rejected');
  assert.equal(summary.browserError, 'Browser received a timeout');
  const missingAnswer = structuredClone(value); missingAnswer.archive.interactions[0].messages.pop();
  assert.throws(() => assertDocumentRequestExport(missingAnswer), /omitted a committed answer/);
  const missingRaw = structuredClone(value); missingRaw.archive.auditEvents.pop();
  assert.throws(() => assertDocumentRequestExport(missingRaw), /raw provider evidence/);
});

test('a provider timeout exports its original question and error without inventing raw output', () => {
  const value = example('FAILED'); const summary = assertDocumentRequestExport(value);
  assert.equal(summary.status, 'FAILED'); assert.equal(summary.rawModelOutputs, 0);
  const noQuestion = structuredClone(value); noQuestion.archive.auditEvents.shift();
  assert.throws(() => assertDocumentRequestExport(noQuestion), /omitted the actual student question/);
  const noError = structuredClone(value); noError.archive.auditEvents.pop();
  assert.throws(() => assertDocumentRequestExport(noError), /failure diagnostic/);
  const noTaskError = structuredClone(value); noTaskError.task.error = null;
  assert.throws(() => assertDocumentRequestExport(noTaskError), /lost its diagnostic/);
});

test('running requests remain running, while retained invalid raw output must be exact', () => {
  const value = example('RUNNING');
  assert.equal(assertDocumentRequestExport(value).status, 'RUNNING');
  const raw = 'invalid first model output';
  value.archive.auditEvents.push({ ...value.archive.auditEvents[0], eventType: 'error', actorRole: 'system', content: raw,
    payload: { kind: 'invalid-model-response', rawSha256: hash(raw) } });
  assert.equal(assertDocumentRequestExport(value).rawModelOutputs, 1);
  value.archive.auditEvents.at(-1).content = 'replaced first model output';
  assert.throws(() => assertDocumentRequestExport(value), /changed retained raw model output/);
});

test('a correct-looking transcript cannot hide a foreign or mismatched durable task', () => {
  for (const change of [value => { value.task.createdById = 'another-student'; },
    value => { value.task.id = 'unrelated-task'; }, value => { value.task.offeringId = 'another-offering'; },
    value => { value.task.input.participationId = 'another-participation'; },
    value => { value.task.conversation.participation.instanceId = 'another-classroom'; },
    value => { value.task.input.message = 'different question'; }]) {
    const value = example(); change(value); assert.throws(() => assertDocumentRequestExport(value));
  }
});

const researchExportExamples = [
  ['events', { eventType: 'heartbeat', durationMs: 0, metadata: { legacy: { visible: false } } }],
  ['ai', { eventType: 'answer', content: '实际原始回复', payload: { detail: { requestId: 'request-1' } } }],
  ['outcomes', { eventType: 'CLASSROOM_FINISHED', payload: { completedStudents: 30 } }],
  ['domain', { eventType: 'COMPANION_PROCESS_RECORDED', payload: { recordId: 'record-1' } }],
  ['experiments', { phase: 'posttest', objectiveScore: 0, objectiveTotal: 0,
    questionnaire: { questions: [{ id: 'question-1' }] }, answers: { 'question-1': '保留真实作答' } }],
  ['submissions', { activitySnapshot: { title: '项目成果' }, payload: { content: '已确认正文' } }],
];

for (const [type, content] of researchExportExamples) {
  test(`${type} research export rejects every missing required field and retains exact source content`, () => {
    const source = { id: 'row-1', researchKey: 'participant-research-key', ...content };
    assertResearchExportRowContent(type, structuredClone(source), source);
    for (const key of Object.keys(source)) {
      const missing = structuredClone(source); delete missing[key];
      assert.throws(() => assertResearchExportRowContent(type, missing, source), /Export omitted required field/, key);
      const changed = structuredClone(source); changed[key] = 'changed';
      assert.throws(() => assertResearchExportRowContent(type, changed, source), /differs from its persisted source/, key);
    }
  });
}

test('nullable export content remains a required own property, not an optional field', () => {
  const source = { id: 'ai-1', researchKey: null, eventType: 'error', content: null, payload: null };
  assertResearchExportRowContent('ai', { ...source }, source);
  const missing = { ...source }; delete missing.content;
  assert.throws(() => assertResearchExportRowContent('ai', missing, source), /required field content/);
  const inherited = Object.assign(Object.create({ content: null }), missing);
  assert.throws(() => assertResearchExportRowContent('ai', inherited, source), /required field content/);
  assert.throws(() => assertResearchExportRowContent('unknown', source, source), /Unknown research export type/);
});
