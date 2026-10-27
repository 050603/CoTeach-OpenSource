import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { appendSaveRecoveryText } from './classroom-acceptance-save-recovery.mjs';
import { confirmSubmissionSave, observeSubmissionSaveReceipts } from './classroom-acceptance-save-confirmation.mjs';

const view = row => row.payload?.view ?? row.payload;
const editorFor = page => page.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first();
async function until(read, message, errors, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  do { if (errors.length) throw errors[0]; const result = await read(); if (result) return result; await delay(100); } while (Date.now() < end);
  throw new Error(message);
}
// Strictly shorter than the existing browser's ten-second request budget.
// An exceeded injection window fails this tool; it never extends product timeouts.
function heldResponse(request, startedAt = Date.now()) {
  let release; let timer;
  const remaining = 7500 - (Date.now() - startedAt);
  assert.ok(remaining > 0, 'Actual backend request consumed the injection time budget');
  const promise = new Promise((resolve, reject) => {
    release = resolve;
    timer = setTimeout(() => reject(new Error('Save-concurrency injection exceeded 7.5 seconds')), remaining);
  });
  void promise.catch(() => undefined); // Observe immediately while durable evidence is being read.
  return { request, at: Date.now(), promise, release: () => { clearTimeout(timer); release(); }, clear: () => clearTimeout(timer) };
}
async function storage(page, studentId, courseId) {
  return page.evaluate(({ studentId, courseId }) => {
    const records = Object.keys(localStorage).map(key => ({ key, raw: localStorage.getItem(key) }))
      .filter(({ key }) => key.startsWith(`openpbl:submission-save:v1:${encodeURIComponent(studentId)}:`)
        || key.startsWith('openpbl:document-draft:v1:'))
      .map(({ key, raw }) => ({ key, value: JSON.parse(raw) }));
    return {
      outbox: records.filter(({ key, value }) => key.startsWith('openpbl:submission-save:')
        && value.actorId === studentId && value.action?.payload?.courseId === courseId).map(row => row.value),
      drafts: records.filter(({ key, value }) => key.startsWith('openpbl:document-draft:')
        && value.scope === `${courseId}:${studentId}:make:document`).map(row => row.value),
    };
  }, { studentId, courseId });
}

export function assertCrossSessionConflictProof(proof) {
  const { initialVersion, first, conflict, adopted, final, archived, lateDraft } = proof;
  assert.equal(proof.storageRelationship, 'separate-contexts-same-actor');
  assert.equal(conflict.status, 409); assert.equal(conflict.ack.code, 'DRAFT_VERSION_CONFLICT');
  assert.equal(conflict.request.action.payload.expectedSubmissionVersion, initialVersion);
  assert.equal(conflict.ack.details.currentSubmission.content, first.request.action.payload.submission.content);
  assert.equal(conflict.ack.details.currentSubmission.version, initialVersion + 1);
  assert.equal(first.ack.submissionVersion, initialVersion + 1);
  assert.equal(adopted.request.action.payload.expectedSubmissionVersion, initialVersion + 1);
  assert.equal(adopted.ack.submissionVersion, initialVersion + 2);
  assert.equal(final.request.action.payload.expectedSubmissionVersion, initialVersion + 2);
  assert.equal(final.ack.submissionVersion, initialVersion + 3);
  assert.equal(new Set([first.request.requestId, conflict.request.requestId, adopted.request.requestId, final.request.requestId]).size, 4);
  assert.equal(archived.state, 'resolved'); assert.equal(archived.requestId, conflict.request.requestId);
  assert.deepEqual(archived.action, conflict.request.action);
  assert.equal(archived.remote.content, first.request.action.payload.submission.content);
  assert.equal(lateDraft.content, final.request.action.payload.submission.content);
  assert.notEqual(lateDraft.content, adopted.request.action.payload.submission.content);
  assert.equal(proof.beforeAdoptionVersion, initialVersion + 1);
  assert.equal(proof.finalVersion, initialVersion + 3);
  assert.equal(proof.bothSidesVisible, true); assert.equal(proof.explicitChoice, 'local');
  assert.equal(proof.conflictedRequestReceipt, null);
  for (const item of [first, conflict, adopted, final]) {
    assert.equal(item.request.action.payload.courseId, proof.courseId);
    assert.equal(item.request.action.payload.submission.studentId, proof.studentId);
  }
}

export function assertSharedOutboxProof(proof) {
  const { original, replay, newer, initialVersion } = proof;
  assert.equal(proof.storageRelationship, 'same-context-two-pages');
  assert.equal(proof.recoveryTrigger, 'peer-page-reload');
  for (const key of ['ackHeldAt', 'draftBeforeReloadObservedAt', 'reloadStartedAt', 'reloadCompletedAt', 'peerReplayObservedAt', 'ackReleasedAt']) {
    assert.ok(Number.isSafeInteger(proof[key]) && proof[key] > 0, `Missing actual ${key} clock`);
  }
  assert.ok(proof.ackHeldAt <= proof.draftBeforeReloadObservedAt
    && proof.draftBeforeReloadObservedAt <= proof.reloadStartedAt
    && proof.reloadStartedAt <= proof.reloadCompletedAt
    && proof.reloadCompletedAt <= proof.peerReplayObservedAt
    && proof.peerReplayObservedAt <= proof.ackReleasedAt);
  assert.equal(proof.activeOriginalHandlersAtReplay, 1);
  assert.equal(proof.originalResponseCountAtReplay, 0);
  // Preserve both complete HTTP bodies as evidence. Only the existing course
  // projection envelope may advance on hydration; the immutable action includes
  // the editor's exact expectedSubmissionVersion and every business field.
  const immutableBody = request => Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'expectedVersion'));
  assert.deepEqual(immutableBody(replay.request), immutableBody(original.request));
  assert.deepEqual(replay.ack, original.ack);
  assert.equal(original.ack.submissionVersion, initialVersion + 1);
  assert.equal(proof.versionAfterReplay, initialVersion + 1);
  assert.notEqual(newer.request.requestId, original.request.requestId);
  assert.equal(newer.request.action.payload.expectedSubmissionVersion, initialVersion + 1);
  assert.equal(newer.ack.submissionVersion, initialVersion + 2);
  assert.equal(proof.pendingBeforeReplay.requestId, original.request.requestId);
  assert.deepEqual(proof.pendingBeforeReplay.action, original.request.action);
  assert.equal(proof.draftAfterReplay.content, newer.request.action.payload.submission.content);
  assert.equal(proof.draftBeforeReload.content, proof.draftAfterReplay.content);
  assert.equal(proof.draftBeforeReload.key, proof.draftAfterReplay.key);
  assert.notEqual(proof.draftAfterReplay.content, original.request.action.payload.submission.content);
  assert.equal(proof.finalVersion, initialVersion + 2);
  assert.equal(proof.bothPagesRestored, true);
  for (const item of [original, replay, newer]) {
    assert.equal(item.request.action.payload.courseId, proof.courseId);
    assert.equal(item.request.action.payload.submission.studentId, proof.studentId);
  }
}

/** Runs only inside the existing dedicated make-stage recovery classroom.
 * Cross-session conflict is deliberately distinct from shared localStorage
 * replay: neither case waits for two different pending POSTs to be emitted.
 */
export async function runClassroomSaveConcurrency({ students, instance, db, origin, record, output, watch }) {
  assert.equal(typeof watch, 'function', 'New contexts must retain original traffic/error observation');
  const directory = path.join(output, 'save-concurrency'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const results = { crossSession: [], sharedOutbox: [] };
  for (const brand of ['google-chrome', 'microsoft-edge']) {
    const student = students.find(item => item.label === brand); assert.ok(student);
    const firstPage = student.page;
    const url = new URL(`/student/ai-collaboration/${instance.id}`, origin).href;
    const actionUrl = new URL(`/api/courses/${instance.id}/actions`, origin).href;
    const owned = { courseId: instance.id, studentId: student.user.id, participationId: student.participation.id };
    const readRow = async () => (await db.classroomSubmission.findMany({ where: { participationId: owned.participationId } }))
      .find(row => view(row).stageKey === 'make' && view(row).type === 'document');
    const observe = page => observeSubmissionSaveReceipts(page, { origin, ...owned });
    const confirm = async (page, observer, marker, row) => confirmSubmissionSave({ page, db, ...owned,
      submission: row ?? await readRow(), marker, observations: observer.entries });
    const ready = async page => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await expect(editorFor(page)).toBeVisible({ timeout: 45000 });
      await until(async () => (await storage(page, owned.studentId, owned.courseId)).outbox.every(row => row.state === 'resolved'), 'Existing save did not settle', []);
    };
    const edit = async (page, marker, evidence) => appendSaveRecoveryText(page, editorFor(page), marker, evidence.selection ??= []);
    const findSuccess = (observer, marker) => observer.entries.find(row => row.status === 200
      && row.request.action.payload.submission.content.includes(marker) && row.ack?.requestId === row.request.requestId);

    const cross = { brand, ...owned, storageRelationship: 'separate-contexts-same-actor', passed: false };
    results.crossSession.push(cross);
    let isolatedContext, secondPage, observerA, observerB, pauseBeforeSend, pauseAck;
    const errors = []; let handler; let activeHandlers = 0;
    try {
      await ready(firstPage);
      isolatedContext = await student.context.browser().newContext({ viewport: { width: 1366, height: 768 } });
      watch(isolatedContext, `save-cross-session-${student.index}`);
      // Copy only signed cookies: never copy pending drafts/outboxes into the second session.
      await isolatedContext.addCookies(await student.context.cookies(origin));
      await isolatedContext.addInitScript(() => { if (location.protocol !== 'about:') localStorage.setItem('locale', 'zh-CN'); });
      secondPage = await isolatedContext.newPage();
      observerA = observe(firstPage); observerB = observe(secondPage);
      await ready(secondPage);
      const base = view(await readRow()); cross.initialVersion = base.version;
      await expect(editorFor(firstPage)).toHaveText(await editorFor(secondPage).textContent());
      // Five meaningful characters per new paragraph: exercise saving without
      // adding a new paragraph eligible for the existing six-character AI policy.
      const markerA = `A${randomUUID().slice(0, 4)}`, markerB = `B${randomUUID().slice(0, 4)}`, markerC = `C${randomUUID().slice(0, 4)}`;
      let mode = 'hold-before-send';
      handler = async route => {
        const interceptedAt = Date.now();
        const req = route.request(); const body = req.method() === 'POST' ? req.postDataJSON() : null;
        if (body?.action?.type !== 'UPSERT_SUBMISSION' || !body.action.payload.submission.content.includes(markerB)) return route.fallback();
        activeHandlers++;
        let hold;
        try {
          if (mode === 'hold-before-send') {
            mode = 'pass'; hold = pauseBeforeSend = heldResponse(body);
            await hold.promise; await route.fallback();
          } else if (mode === 'hold-adoption-ack' && body.requestId !== cross.conflict.request.requestId) {
            const response = await route.fetch({ timeout: 7500 });
            if (response.status() !== 200) { await route.fulfill({ response }); return; }
            mode = 'pass'; hold = pauseAck = heldResponse(body, interceptedAt);
            cross.adoptedWire = { request: body, ack: await response.json() };
            cross.adoptedRow = await readRow();
            await hold.promise; await route.fulfill({ response });
          } else await route.fallback();
        } catch (error) { errors.push(error); await route.abort('failed').catch(() => undefined); }
        finally { hold?.clear(); activeHandlers--; }
      };
      await secondPage.route(actionUrl, handler);
      await edit(secondPage, markerB, cross);
      await until(() => pauseBeforeSend, 'No real B request to pause', errors);
      assert.equal(pauseBeforeSend.request.action.payload.expectedSubmissionVersion, base.version);
      await edit(firstPage, markerA, cross);
      await until(() => findSuccess(observerA, markerA), 'A did not obtain its real ACK', errors);
      cross.first = await confirm(firstPage, observerA, markerA);
      pauseBeforeSend.release();
      cross.conflict = await until(() => observerB.entries.find(row => row.status === 409 && row.ack?.code === 'DRAFT_VERSION_CONFLICT'), 'B did not receive a real draft conflict', errors);
      assert.deepEqual(cross.conflict.request.action, pauseBeforeSend.request.action);
      assert.equal(cross.conflict.request.requestId, pauseBeforeSend.request.requestId);
      const panel = secondPage.getByRole('alert').filter({ hasText: '其他窗口已更新草稿' });
      await expect(panel).toBeVisible(); await panel.locator('summary').click();
      await expect(panel.locator('pre').nth(0)).toContainText(markerB);
      await expect(panel.locator('pre').nth(1)).toContainText(markerA);
      await expect(panel.getByRole('button', { name: '采用服务器版本继续编辑', exact: true })).toBeVisible();
      cross.bothSidesVisible = true; cross.beforeAdoptionVersion = view(await readRow()).version;
      mode = 'hold-adoption-ack';
      await panel.getByRole('button', { name: '采用当前本机内容并保存', exact: true }).click();
      cross.explicitChoice = 'local';
      await until(() => pauseAck && cross.adoptedWire, 'No actual adopted-save ACK to delay', errors);
      cross.ackHeldAt = pauseAck.at;
      await edit(secondPage, markerC, cross);
      cross.lateDraft = await until(async () => (await storage(secondPage, owned.studentId, owned.courseId)).drafts.find(draft => draft.content.includes(markerC)), 'Newer C edit was not durable before old ACK', errors);
      cross.newEditRetainedAt = Date.now(); cross.ackReleasedAt = Date.now();
      pauseAck.release();
      await until(() => findSuccess(observerB, markerC), 'Newer C edit did not obtain its own ACK', errors);
      cross.final = await confirm(secondPage, observerB, markerC);
      cross.adopted = await confirm(secondPage, observerB, markerB, cross.adoptedRow);
      assert.deepEqual(cross.adopted.ack, cross.adoptedWire.ack);
      cross.archived = (await storage(secondPage, owned.studentId, owned.courseId)).outbox.find(row => row.requestId === cross.conflict.request.requestId);
      cross.conflictedRequestReceipt = await db.domainEvent.findUnique({ where: { idempotencyKey: `course-action:${owned.studentId}:${cross.conflict.request.requestId}` } });
      cross.finalVersion = view(await readRow()).version;
      assertCrossSessionConflictProof(cross);
      await expect(editorFor(secondPage)).toContainText(markerC); assert.equal(errors.length, 0); cross.passed = true;
    } catch (error) { cross.error = String(error.stack ?? error); }
    finally {
      pauseBeforeSend?.release(); pauseAck?.release();
      if (secondPage && handler) await secondPage.unroute(actionUrl, handler);
      await until(() => activeHandlers === 0, 'Owned route handlers did not settle', [], 10000).catch(error => { cross.passed = false; cross.cleanupError = String(error); });
      await observerA?.close(); await observerB?.close(); await isolatedContext?.close();
      await writeFile(path.join(directory, `${brand}-cross-session.json`), JSON.stringify(cross, null, 2) + '\n', { mode: 0o600 });
    }

    const shared = { brand, ...owned, storageRelationship: 'same-context-two-pages', passed: false };
    results.sharedOutbox.push(shared);
    if (!cross.passed) { shared.error = 'Not run after failed cross-session scenario; no success inferred'; continue; }
    let peer, ownObserver, peerObserver, held, sharedHandler;
    const sharedErrors = []; let activeSharedHandlers = 0;
    try {
      await ready(firstPage); peer = await student.context.newPage();
      ownObserver = observe(firstPage); peerObserver = observe(peer); await ready(peer);
      shared.initialVersion = view(await readRow()).version;
      const markerD = `D${randomUUID().slice(0, 4)}`, markerE = `E${randomUUID().slice(0, 4)}`;
      sharedHandler = async route => {
        const interceptedAt = Date.now();
        const req = route.request(); const body = req.method() === 'POST' ? req.postDataJSON() : null;
        if (held || body?.action?.type !== 'UPSERT_SUBMISSION' || !body.action.payload.submission.content.includes(markerD)) return route.fallback();
        activeSharedHandlers++;
        try {
          const response = await route.fetch({ timeout: 7500 });
          if (response.status() !== 200) { await route.fulfill({ response }); return; }
          held = heldResponse(body, interceptedAt); shared.original = { request: body, ack: await response.json() }; shared.originalRow = await readRow();
          await held.promise; await route.fulfill({ response });
        } catch (error) { sharedErrors.push(error); await route.abort('failed').catch(() => undefined); }
        finally { held?.clear(); activeSharedHandlers--; }
      };
      // Page-only injection: the peer's legitimate original-ID replay goes directly to the backend.
      await firstPage.route(actionUrl, sharedHandler);
      await edit(firstPage, markerD, shared);
      await until(() => held && shared.original, 'No shared-outbox original ACK', sharedErrors);
      shared.ackHeldAt = held.at;
      shared.pendingBeforeReplay = (await storage(peer, owned.studentId, owned.courseId)).outbox.find(row => row.requestId === shared.original.request.requestId);
      await edit(firstPage, markerE, shared);
      shared.draftBeforeReload = (await storage(firstPage, owned.studentId, owned.courseId)).drafts.find(draft => draft.content.includes(markerE));
      assert.ok(shared.draftBeforeReload, 'Newer edit must be durable before peer recovery');
      shared.draftBeforeReloadObservedAt = Date.now();
      // Chromium automation emulates focus per page; bringToFront is not proof
      // of a focus event. A real reload deterministically invokes mount recovery
      // in this already initialized peer, while the original page keeps editing.
      shared.recoveryTrigger = 'peer-page-reload'; shared.reloadStartedAt = Date.now();
      await peer.reload({ waitUntil: 'domcontentloaded', timeout: 7500 });
      shared.reloadCompletedAt = Date.now();
      const replay = await until(() => peerObserver.entries.find(row => row.status === 200 && row.request.requestId === shared.original.request.requestId && row.ack), 'Peer did not recover shared immutable request', sharedErrors);
      shared.replay = replay; shared.versionAfterReplay = view(await readRow()).version;
      shared.draftAfterReplay = (await storage(firstPage, owned.studentId, owned.courseId)).drafts.find(draft => draft.content.includes(markerE));
      assert.ok(shared.draftAfterReplay, 'Peer ACK erased the other page newer draft');
      shared.peerReplayObservedAt = Date.now();
      shared.activeOriginalHandlersAtReplay = activeSharedHandlers;
      shared.originalResponseCountAtReplay = ownObserver.entries.filter(row => row.request.requestId === shared.original.request.requestId).length;
      assert.equal(sharedErrors.length, 0);
      assert.equal(shared.activeOriginalHandlersAtReplay, 1, 'Original ACK must remain held while the peer replays');
      assert.equal(shared.originalResponseCountAtReplay, 0, 'Original page consumed its ACK before peer recovery');
      shared.ackReleasedAt = Date.now();
      held.release();
      await until(() => findSuccess(ownObserver, markerE), 'Newer edit did not receive a distinct ACK', sharedErrors);
      shared.newer = await confirm(firstPage, ownObserver, markerE);
      shared.originalProof = await confirm(firstPage, ownObserver, markerD, shared.originalRow);
      shared.replayProof = await confirm(peer, peerObserver, markerD, shared.originalRow);
      await ready(firstPage); await ready(peer);
      await expect(editorFor(firstPage)).toContainText(markerE); await expect(editorFor(peer)).toContainText(markerE);
      shared.bothPagesRestored = true; shared.finalVersion = view(await readRow()).version;
      assertSharedOutboxProof(shared); assert.equal(sharedErrors.length, 0); shared.passed = true;
    } catch (error) { shared.error = String(error.stack ?? error); }
    finally {
      held?.release(); if (sharedHandler) await firstPage.unroute(actionUrl, sharedHandler);
      await until(() => activeSharedHandlers === 0, 'Owned shared route handler did not settle', [], 10000).catch(error => { shared.passed = false; shared.cleanupError = String(error); });
      await ownObserver?.close(); await peerObserver?.close(); await peer?.close();
      await writeFile(path.join(directory, `${brand}-shared-outbox.json`), JSON.stringify(shared, null, 2) + '\n', { mode: 0o600 });
    }
  }
  for (const [key, name] of [['crossSession', 'draft-save-cross-session-conflict'], ['sharedOutbox', 'draft-save-same-context-replay']]) {
    const rows = results[key]; record(name, rows.length === 2 && rows.every(row => row.passed) ? '通过' : '失败', { students: rows, businessResponsesMocked: false }, 'browser-real-backend');
  }
  return results;
}
