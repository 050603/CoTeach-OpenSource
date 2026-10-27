import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';

const view = row => row.payload?.view ?? row.payload;
const sha = content => createHash('sha256').update(content).digest('hex');
async function until(read, message, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  do { const result = await read(); if (result) return result; await delay(200); } while (Date.now() < end);
  throw new Error(message);
}
export function assertSaveRecoveryProof({ originalRequest, replayRequest, originalAck, replayAck, receipt, beforeVersion, saved, marker }) {
  assert.equal(originalRequest.action.type, 'UPSERT_SUBMISSION');
  assert.deepEqual({ requestId: replayRequest?.requestId, action: replayRequest?.action },
    { requestId: originalRequest.requestId, action: originalRequest.action }, 'Recovery changed the immutable request or action');
  assert.ok(originalAck.eventCursor && originalAck.requestId && Number.isSafeInteger(originalAck.submissionVersion), 'Missing original durable ACK');
  assert.deepEqual(replayAck, originalAck, 'Recovery did not return the original receipt');
  assert.deepEqual(receipt?.payload?.ack, originalAck, 'Database receipt differs from the actual ACK');
  assert.equal(receipt.actorId, originalRequest.action.payload.submission.studentId);
  assert.equal(receipt.idempotencyKey, `course-action:${receipt.actorId}:${originalRequest.requestId}`);
  assert.equal(saved.version, beforeVersion + 1, 'Recovery created an additional draft revision');
  assert.equal(saved.version, originalAck.submissionVersion);
  assert.equal(saved.content, originalRequest.action.payload.submission.content, 'Recovered content differs from the real edited request');
  assert.ok(saved.content.includes(marker), 'Recovered content lacks the new browser edit');
}

/** Native input must reach an actual Slate paragraph before any save assertion.
 * An editor shell is hundreds of pixels taller than its empty paragraph. A
 * center click followed immediately by Select All is not evidence of a caret.
 */
export async function appendSaveRecoveryText(page, editor, marker, observations = []) {
  await expect(editor).toBeVisible({ timeout: 45000 });
  await page.bringToFront();
  const block = editor.locator('[data-slate-node="element"]').last();
  await block.scrollIntoViewIfNeeded();
  await block.click({ position: { x: 8, y: 8 } });
  const settledCaret = async label => {
    let stableSince;
    let previous;
    await expect.poll(async () => {
      const snapshot = await editor.evaluate(element => {
        const selection = window.getSelection();
        const blocks = [...element.querySelectorAll('[data-slate-node="element"]')];
        const last = blocks.at(-1);
        return { focused: document.activeElement === element && document.hasFocus(),
          collapsed: selection?.isCollapsed === true,
          inLastBlock: Boolean(last && selection?.focusNode && last.contains(selection.focusNode)),
          anchorText: selection?.anchorNode?.textContent ?? null, anchorOffset: selection?.anchorOffset,
          focusText: selection?.focusNode?.textContent ?? null, focusOffset: selection?.focusOffset };
      });
      const signature = JSON.stringify(snapshot);
      const ready = snapshot.focused && snapshot.collapsed && snapshot.inLastBlock;
      if (!ready || signature !== previous) stableSince = ready ? Date.now() : undefined;
      previous = signature;
      observations.push({ label, ...snapshot });
      // Slate throttles native selection updates; wait for an observed stable
      // caret rather than issuing keys against a merely visible empty shell.
      return ready && Date.now() - stableSince >= 250;
    }, { timeout: 10000, intervals: [100] }).toBe(true);
  };
  await settledCaret('clicked-paragraph');
  await page.keyboard.press('ControlOrMeta+End');
  await settledCaret('document-end');
  if ((await editor.textContent()).replace(/[\u200B-\u200D\uFEFF]/gu, '').trim()) {
    await page.keyboard.press('Enter');
    await settledCaret('new-paragraph');
  }
  await page.keyboard.insertText(marker);
  await expect(editor).toContainText(marker);
}

export function assertInitialSaveProof({ request, ack, receipt, row, courseId, studentId, participationId, marker, submissionType = 'document' }) {
  assert.equal(request?.action?.type, 'UPSERT_SUBMISSION');
  assert.equal(request.action.payload.courseId, courseId);
  const submission = request.action.payload.submission;
  assert.equal(submission.studentId, studentId);
  assert.equal(submission.stageKey, 'make');
  assert.equal(submission.type, submissionType);
  assert.ok(submission.content.includes(marker), 'Initial browser request lacks the typed marker');
  assert.equal(ack?.requestId, request.requestId);
  assert.ok(ack.eventCursor && Number.isSafeInteger(ack.submissionVersion) && ack.submissionVersion > 0);
  assert.equal(receipt?.actorId, studentId);
  assert.equal(receipt?.idempotencyKey, `course-action:${studentId}:${request.requestId}`);
  assert.deepEqual(receipt?.payload?.ack, ack);
  assert.equal(row?.participationId, participationId);
  const saved = view(row);
  assert.equal(saved.id, submission.id);
  assert.equal(saved.studentId, studentId);
  assert.equal(saved.stageKey, 'make');
  assert.equal(saved.type, submissionType);
  assert.equal(saved.content, submission.content);
  assert.equal(saved.version, ack.submissionVersion);
}

export async function prepareSaveRecoveryDocument({ student, instance, db, origin, output }) {
  const { page } = student;
  const directory = path.join(output, 'save-recovery');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { courseId: instance.id, studentId: student.user.id, participationId: student.participation.id,
    brand: student.label, passed: false, selection: [], requests: [], responses: [] };
  const actionPath = `/api/courses/${instance.id}/actions`;
  const marker = `保存恢复专项学生${student.index}：保留实际编辑与原始回执。`;
  const responseTasks = [];
  const onRequest = request => {
    if (new URL(request.url()).pathname === actionPath && request.method() === 'POST') evidence.requests.push(request.postDataJSON());
  };
  const onResponse = response => {
    if (new URL(response.url()).pathname !== actionPath || response.request().method() !== 'POST') return;
    responseTasks.push(response.json().then(body => evidence.responses.push({ status: response.status(),
      requestId: response.request().postDataJSON()?.requestId, body })).catch(error => evidence.responses.push({ error: String(error) })));
  };
  page.on('request', onRequest); page.on('response', onResponse);
  try {
    await page.goto(new URL(`/student/ai-collaboration/${instance.id}`, origin).href, { waitUntil: 'domcontentloaded' });
    const editor = page.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first();
    await appendSaveRecoveryText(page, editor, marker, evidence.selection);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const response = await until(() => evidence.responses.find(item => item.status === 200
      && evidence.requests.some(request => request.requestId === item.requestId
        && request.action?.type === 'UPSERT_SUBMISSION' && request.action.payload.submission.content.includes(marker))),
    'No actual browser save ACK followed the verified initial editor input');
    const request = evidence.requests.find(item => item.requestId === response.requestId);
    const rows = await db.classroomSubmission.findMany({ where: { participationId: student.participation.id } });
    const row = rows.find(item => view(item).id === request.action.payload.submission.id);
    const receipt = await db.domainEvent.findUnique({ where: { idempotencyKey: `course-action:${student.user.id}:${request.requestId}` } });
    assertInitialSaveProof({ request, ack: response.body, receipt, row, courseId: instance.id,
      studentId: student.user.id, participationId: student.participation.id, marker });
    evidence.receiptId = receipt.id; evidence.savedVersion = view(row).version; evidence.passed = true;
    student.saved = row;
    return evidence;
  } catch (error) {
    evidence.error = String(error.stack ?? error);
    throw error;
  } finally {
    page.off('request', onRequest); page.off('response', onResponse);
    await Promise.allSettled(responseTasks);
    evidence.page = await page.evaluate(({ actorId, courseId }) => ({ url: location.href,
      editorText: document.querySelector('.pbl-document-editor [data-slate-editor="true"]')?.textContent,
      alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent),
      outbox: Object.keys(localStorage).filter(key => key.startsWith(`openpbl:submission-save:v1:${encodeURIComponent(actorId)}:`))
        .map(key => ({ key, value: localStorage.getItem(key) })).filter(item => item.value.includes(courseId)),
    }), { actorId: student.user.id, courseId: instance.id }).catch(error => ({ error: String(error) }));
    await writeFile(path.join(directory, `fixture-${student.label}.json`), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
}

/** Real browser write, real database commit, intentionally lost browser ACK, then a real reload/replay.
 * The caller prepares a separate teaching instance in its make stage, after the normal classroom.
 * Only two representative pages are touched; main-classroom drafts and frozen hashes stay intact.
 * No storage is cleared, no business response is fabricated, and this scenario does not force a stale GET snapshot.
 */
export async function runClassroomSaveRecovery({ teacher, students, instance, db, origin, record, output }) {
  const directory = path.join(output, 'save-recovery');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { courseId: instance.id, startedAt: new Date().toISOString(),
    fault: 'real-commit-browser-ack-aborted-then-reload', businessResponsesMocked: false, passed: false, students: [] };
  const save = () => writeFile(path.join(directory, 'save-recovery.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  try {
    for (const brand of ['google-chrome', 'microsoft-edge']) {
      const student = students.find(item => item.label === brand);
      assert.ok(student, `Save recovery needs a ${brand} student`);
      const { page, context } = student;
      const result = { brand, studentId: student.user.id, passed: false };
      evidence.students.push(result);
      const actionPath = `/api/courses/${instance.id}/actions`;
      const actionUrl = new URL(actionPath, origin).href;
      const marker = `SAVE_RECOVERY_${brand}_${randomUUID()}`;
      const editor = page.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first();
      const readDraft = async () => {
        const rows = await db.classroomSubmission.findMany({ where: { participationId: student.participation.id } });
        return rows.find(row => view(row).stageKey === 'make' && view(row).type === 'document');
      };
      const pending = () => page.evaluate(({ actorId, courseId }) => Object.keys(localStorage)
        .filter(key => key.startsWith(`openpbl:submission-save:v1:${encodeURIComponent(actorId)}:`))
        .map(key => JSON.parse(localStorage.getItem(key)))
        .filter(item => item.action?.payload?.courseId === courseId && item.state !== 'resolved'),
      { actorId: student.user.id, courseId: instance.id });
      let originalRequest;
      let originalAck;
      let replayRequest;
      let injectionStarted = false;
      let reloading = false;
      let navigationCommitted = false;
      let releaseAbort;
      const abortAfterNavigationStarts = new Promise(resolve => { releaseAbort = resolve; });
      const onNavigation = frame => { if (reloading && frame === page.mainFrame()) navigationCommitted = true; };
      page.on('framenavigated', onNavigation);
      let completeInjection;
      let failInjection;
      const injected = new Promise((resolve, reject) => { completeInjection = resolve; failInjection = reject; });
      void injected.catch(() => undefined);
      const routeHandler = async route => {
        const request = route.request();
        const body = request.method() === 'POST' ? request.postDataJSON() : null;
        if (body?.action?.type !== 'UPSERT_SUBMISSION' || body.action.payload.submission.studentId !== student.user.id
          || !body.action.payload.submission.content.includes(marker)) { await route.fallback(); return; }
        if (injectionStarted) {
          if (!navigationCommitted) { await route.abort('failed').catch(() => undefined); return; }
          replayRequest = body;
          await route.fallback();
          return;
        }
        injectionStarted = true;
        originalRequest = body;
        try {
          const response = await route.fetch({ timeout: 45000 });
          assert.equal(response.status(), 200, `The actual draft write failed before ACK injection: ${await response.text()}`);
          originalAck = await response.json();
          const receipt = await db.domainEvent.findUnique({ where: { idempotencyKey: `course-action:${student.user.id}:${body.requestId}` } });
          assert.deepEqual(receipt?.payload?.ack, originalAck, 'Do not inject ACK loss until its durable receipt is verified');
          // Hold the original browser response until navigation begins, preventing an old-page retry
          // from being mistaken for recovery by the newly loaded document.
          completeInjection();
          await abortAfterNavigationStarts;
          await route.abort('failed').catch(() => undefined);
        } catch (error) { failInjection(error); await route.abort('failed').catch(() => undefined); }
      };
      let routeInstalled = false;
      try {
        if (!page.url().includes(`/student/ai-collaboration/${instance.id}`)) await page.goto(new URL(`/student/ai-collaboration/${instance.id}`, origin).href, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.bringToFront();
        await expect(editor).toBeVisible({ timeout: 45000 });
        await expect(page.getByText('已保存', { exact: true }).first()).toBeVisible({ timeout: 45000 });
        await until(async () => (await pending()).length === 0, 'Existing draft writes did not settle before ACK-loss injection');
        const before = view(await readDraft());
        assert.ok(Number.isSafeInteger(before.version) && before.version > 0);
        result.beforeVersion = before.version; result.beforeContentSha256 = sha(before.content);
        await context.route(actionUrl, routeHandler); routeInstalled = true;
        result.selection = [];
        await appendSaveRecoveryText(page, editor, marker, result.selection);
        const timer = setTimeout(() => failInjection(new Error('No actual edited draft commit was observed within 45 seconds')), 45000);
        try { await injected; } finally { clearTimeout(timer); }
        const pendingAtReload = await pending();
        assert.ok(pendingAtReload.some(item => item.requestId === originalRequest.requestId), 'Unacknowledged request was not durable before reload');
        result.requestId = originalRequest.requestId;
        result.originalAck = originalAck;
        result.pendingAtReload = pendingAtReload.map(item => ({ requestId: item.requestId, state: item.state, draftKey: item.draftKey }));
        const replayResponse = page.waitForResponse(response => new URL(response.url()).pathname === actionPath
          && response.request().method() === 'POST' && response.request().postDataJSON()?.requestId === originalRequest.requestId
          && response.status() === 200, { timeout: 45000 });
        // Register the observer before navigation; never resend through an APIRequestContext as a substitute for UI recovery.
        reloading = true;
        const navigation = page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
        releaseAbort();
        const [response] = await Promise.all([replayResponse, navigation]);
        const replayAck = await response.json();
        await expect(editor).toContainText(marker, { timeout: 45000 });
        await expect(page.getByText('已保存', { exact: true }).first()).toBeVisible({ timeout: 45000 });
        await until(async () => (await pending()).length === 0, 'The replayed draft did not leave the pending outbox');
        const savedRow = await readDraft();
        const saved = view(savedRow);
        const receipt = await db.domainEvent.findUnique({ where: { idempotencyKey: `course-action:${student.user.id}:${originalRequest.requestId}` } });
        assertSaveRecoveryProof({ originalRequest, replayRequest, originalAck, replayAck, receipt, beforeVersion: before.version, saved, marker });
        const teacherResponse = await teacher.context.request.get(new URL(`/api/courses/${instance.id}/state`, origin).href, { timeout: 30000 });
        assert.equal(teacherResponse.status(), 200);
        const teacherCourse = (await teacherResponse.json()).course;
        assert.equal(teacherCourse.submissions?.find(item => item.id === saved.id)?.content, saved.content, 'Teacher read did not observe the recovered real draft');
        student.saved = savedRow;
        Object.assign(result, { passed: true, replayAck, receiptId: receipt.id, savedVersion: saved.version, contentSha256: sha(saved.content), marker });
      } catch (error) { result.error = String(error.stack ?? error); }
      finally { releaseAbort(); page.off('framenavigated', onNavigation); if (routeInstalled) await context.unroute(actionUrl, routeHandler); await save(); }
    }
    evidence.passed = evidence.students.length === 2 && evidence.students.every(item => item.passed);
  } catch (error) { evidence.error = String(error.stack ?? error); }
  evidence.finishedAt = new Date().toISOString();
  await save();
  record('draft-save-ack-recovery', evidence.passed ? '通过' : '失败', evidence, 'browser-real-backend');
  return evidence;
}
