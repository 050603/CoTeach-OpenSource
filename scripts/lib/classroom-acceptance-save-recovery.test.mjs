import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { appendSaveRecoveryText, assertInitialSaveProof, assertSaveRecoveryProof } from './classroom-acceptance-save-recovery.mjs';
const request = { requestId: 'request', action: { type: 'UPSERT_SUBMISSION', payload: { submission: { studentId: 'student', content: '<p>MARKER</p>' } } } };
const ack = { requestId: 'request', eventCursor: 'cursor', submissionVersion: 2, courseVersion: 6 };
const proof = { originalRequest: request, replayRequest: structuredClone(request), originalAck: ack, replayAck: { ...ack },
  receipt: { actorId: 'student', idempotencyKey: 'course-action:student:request', payload: { ack } }, beforeVersion: 1,
  saved: { version: 2, content: '<p>MARKER</p>' }, marker: 'MARKER' };
test('accepts only an actual receipt replay with unchanged version and edited content', () => {
  assertSaveRecoveryProof(proof);
  assert.throws(() => assertSaveRecoveryProof({ ...proof, receipt: null }), /Database receipt/);
  assert.throws(() => assertSaveRecoveryProof({ ...proof, replayRequest: { ...request, requestId: 'different' } }), /immutable/);
  assert.throws(() => assertSaveRecoveryProof({ ...proof, saved: { ...proof.saved, version: 3 } }), /additional draft revision/);
  assert.throws(() => assertSaveRecoveryProof({ ...proof, replayAck: { ...ack, eventCursor: 'new' } }), /original receipt/);
  assert.throws(() => assertSaveRecoveryProof({ ...proof, saved: { ...proof.saved, content: 'old content' } }), /real edited request/);
});


test('initial fixture requires the real browser ACK, actor, participation and saved content to agree', () => {
  const submission = { id: 'submission', studentId: 'student', stageKey: 'make', type: 'document', content: '<p>MARKER</p>' };
  const initial = { request: { requestId: 'request', action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', submission } } },
    ack, receipt: proof.receipt, row: { participationId: 'participation', payload: { view: { ...submission, version: 2 } } },
    courseId: 'course', studentId: 'student', participationId: 'participation', marker: 'MARKER' };
  assertInitialSaveProof(initial);
  assertInitialSaveProof({ ...initial, row: { participationId: 'participation', payload: { ...submission, version: 2 } } });
  assert.throws(() => assertInitialSaveProof({ ...initial, studentId: 'other-actor' }));
  assert.throws(() => assertInitialSaveProof({ ...initial, participationId: 'old-classroom-participation' }));
  assert.throws(() => assertInitialSaveProof({ ...initial, ack: { ...ack, requestId: 'another-write' } }));
  assert.throws(() => assertInitialSaveProof({ ...initial, row: { ...initial.row, payload: { view: { ...submission, version: 3 } } } }));
  assert.throws(() => assertInitialSaveProof({ ...initial, row: { ...initial.row, payload: { view: { ...submission, content: 'old', version: 2 } } } }));
});

const executablePath = [process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  '.cache/browsers/chrome/opt/google/chrome/chrome', chromium.executablePath()].find(candidate => candidate && existsSync(candidate));
test('native input waits for a stable caret in the empty paragraph of a tall editor', { skip: !executablePath }, async () => {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    // A DOM-only input test, with no business endpoints or fabricated save ACKs.
    await page.setContent('<div data-slate-editor="true" contenteditable="true" style="min-height:700px"><p data-slate-node="element" style="min-height:24px"><br></p></div>');
    const editor = page.locator('[contenteditable="true"]');
    const observations = [];
    await appendSaveRecoveryText(page, editor, '真实原生输入', observations);
    assert.equal(await editor.textContent(), '真实原生输入');
    for (const label of ['clicked-paragraph', 'document-end']) {
      const ready = observations.filter(item => item.label === label && item.focused && item.collapsed && item.inLastBlock);
      assert.ok(ready.length >= 3, `${label} skipped stable native selection observations`);
    }
  } finally { await browser.close(); }
});


test('the same actual-request proof can verify a code artifact without accepting a document receipt', () => {
  const code = { id: 'submission', studentId: 'student', stageKey: 'make', type: 'code', content: '{"files":[{"content":"MARKER"}]}' };
  const value = { request: { requestId: 'request', action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', submission: code } } },
    ack, receipt: proof.receipt, row: { participationId: 'participation', payload: { view: { ...code, version: 2 } } },
    courseId: 'course', studentId: 'student', participationId: 'participation', marker: 'MARKER', submissionType: 'code' };
  assertInitialSaveProof(value);
  assert.throws(() => assertInitialSaveProof({ ...value, submissionType: 'document' }));
});
