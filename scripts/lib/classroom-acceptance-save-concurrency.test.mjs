import test from 'node:test';
import assert from 'node:assert/strict';
import { assertCrossSessionConflictProof, assertSharedOutboxProof } from './classroom-acceptance-save-concurrency.mjs';

const save = (id, baseline, content) => ({ request: { requestId: id, action: { type: 'UPSERT_SUBMISSION',
  payload: { courseId: 'course', expectedSubmissionVersion: baseline, submission: { studentId: 'student', content } } } },
ack: { requestId: id, submissionVersion: baseline + 1 } });
function cross() {
  const first = save('A', 3, 'A'), conflict = save('B', 3, 'B');
  conflict.status = 409; conflict.ack = { code: 'DRAFT_VERSION_CONFLICT', details: { currentSubmission: { content: 'A', version: 4 } } };
  return { courseId: 'course', studentId: 'student', storageRelationship: 'separate-contexts-same-actor', initialVersion: 3,
    first, conflict, adopted: save('adopt-B', 4, 'B'), final: save('C', 5, 'B+C'),
    archived: { requestId: 'B', state: 'resolved', action: structuredClone(conflict.request.action), remote: { content: 'A' } },
    lateDraft: { content: 'B+C' }, beforeAdoptionVersion: 4, finalVersion: 6,
    bothSidesVisible: true, explicitChoice: 'local', conflictedRequestReceipt: null };
}
function shared() {
  const original = save('D', 6, 'D');
  return { courseId: 'course', studentId: 'student', storageRelationship: 'same-context-two-pages', initialVersion: 6,
    original, replay: structuredClone(original), newer: save('E', 7, 'D+E'), versionAfterReplay: 7,
    pendingBeforeReplay: { requestId: 'D', action: structuredClone(original.request.action) },
    draftBeforeReload: { key: 'draft-E', content: 'D+E' }, draftAfterReplay: { key: 'draft-E', content: 'D+E' },
    recoveryTrigger: 'peer-page-reload', ackHeldAt: 1000, draftBeforeReloadObservedAt: 2000,
    reloadStartedAt: 2100, reloadCompletedAt: 2300, peerReplayObservedAt: 2500, ackReleasedAt: 2600,
    activeOriginalHandlersAtReplay: 1, originalResponseCountAtReplay: 0,
    finalVersion: 8, bothPagesRestored: true };
}
test('cross-session evidence requires the exact conflict, explicit adoption and newer-edit version chain', () => {
  assertCrossSessionConflictProof(cross());
  for (const mutate of [
    p => { p.storageRelationship = 'same-context-two-pages'; },
    p => { p.conflict.ack.code = 'VERSION_CONFLICT'; },
    p => { p.conflict.ack.details.currentSubmission.content = 'unrelated'; },
    p => { p.adopted.request.requestId = 'B'; },
    p => { p.final.request.action.payload.expectedSubmissionVersion = 4; },
    p => { p.archived.state = 'pending'; },
    p => { p.lateDraft.content = 'B'; },
    p => { p.beforeAdoptionVersion = 5; },
    p => { p.conflictedRequestReceipt = { id: 'unexpected-write' }; },
    p => { p.final.request.action.payload.submission.studentId = 'another'; },
  ]) { const proof = cross(); mutate(proof); assert.throws(() => assertCrossSessionConflictProof(proof)); }
});
test('shared localStorage accepts original-ID replay but rejects extra versions, changed payload and lost newer drafts', () => {
  assertSharedOutboxProof(shared());
  const refreshed = shared(); refreshed.original.request.expectedVersion = 10; refreshed.replay.request.expectedVersion = 11;
  assertSharedOutboxProof(refreshed);
  for (const mutate of [
    p => { p.replay.request.requestId = 'another'; },
    p => { p.replay.request.action.payload.submission.content = 'different'; },
    p => { p.replay.request.extraEnvelope = 'not-an-allowed-change'; },
    p => { p.replay.ack.submissionVersion = 8; },
    p => { p.versionAfterReplay = 8; },
    p => { p.newer.request.requestId = 'D'; },
    p => { p.draftAfterReplay.content = 'D'; },
    p => { p.bothPagesRestored = false; },
    p => { p.newer.request.action.payload.courseId = 'another'; },
  ]) { const proof = shared(); mutate(proof); assert.throws(() => assertSharedOutboxProof(proof)); }
});
test('peer reload proof requires durable newer input and an original ACK still held at actual replay', () => {
  assertSharedOutboxProof(shared());
  for (const mutate of [
    p => { p.recoveryTrigger = 'bring-to-front'; },
    p => { delete p.reloadCompletedAt; },
    p => { p.reloadStartedAt = p.draftBeforeReloadObservedAt - 1; },
    p => { p.ackReleasedAt = p.peerReplayObservedAt - 1; },
    p => { p.activeOriginalHandlersAtReplay = 0; },
    p => { p.originalResponseCountAtReplay = 1; },
    p => { p.draftBeforeReload.content = 'D'; },
    p => { p.draftAfterReplay.key = 'another-editor'; },
  ]) { const proof = shared(); mutate(proof); assert.throws(() => assertSharedOutboxProof(proof)); }
});
