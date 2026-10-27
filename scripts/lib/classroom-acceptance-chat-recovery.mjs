import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';

/** Deliberate network fault in its own classroom and authenticated browser context. */
export async function runLectureChatRecoveryAcceptance({ teacher, students, offering, chapter, classroomId, fixture,
  origin, db, request, record, output }) {
  const name = 'learning-interrupted-chat-recovery';
  const evidence = { scope: 'supplementary-isolated-stream-recovery', classroomId,
    browserErrors: [], requests: [], responses: [], networkFailures: [], historySnapshots: [],
    businessApiMocks: false, regeneratedCourseOrAudio: false };
  let context;
  let page;
  let instance;
  let chatEndpoint;
  let finished = false;
  let faultActive = false;
  await mkdir(output, { recursive: true });
  try {
    const student = students[0];
    assert.ok(student?.user?.id); assert.ok(fixture.lectureSceneId);
    evidence.studentId = student.user.id;
    const browser = student.context.browser();
    assert.ok(browser, 'The recovery scenario needs a separate authenticated browser context');
    context = await browser.newContext({ storageState: await student.context.storageState(), viewport: { width: 1366, height: 768 } });
    await context.addInitScript(() => { if (location.protocol !== 'about:') localStorage.setItem('locale', 'zh-CN'); });
    page = await context.newPage();
    page.on('pageerror', error => evidence.browserErrors.push({ message: error.message, faultActive }));
    context.on('request', req => {
      const pathname = new URL(req.url()).pathname;
      if (pathname === chatEndpoint && req.method() === 'POST') {
        evidence.requests.push({ pathname, method: req.method(), at: new Date().toISOString(), body: req.postDataJSON(), faultActive });
      }
    });
    context.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname.startsWith('/api/')) evidence.responses.push({ pathname, status: response.status(), faultActive });
    });
    context.on('requestfailed', req => evidence.networkFailures.push({ pathname: new URL(req.url()).pathname,
      method: req.method(), error: req.failure()?.errorText, faultActive }));
    const template = await request(teacher.context, 'POST', '/api/platform/templates', { title: '随课答疑断网恢复专项', snapshot: {
      schemaVersion: 2, kind: 'pbl-course', design: { name: '随课答疑断网恢复专项', subject: '科学', grade: '七年级', hours: 1,
        stages: [{ key: 'launch', label: '项目启动', view: 'simple-resource', description: '复用已发布资源' },
          { key: 'ai-learning', label: '知识讲授', view: 'ai-learning', description: '流式答疑恢复' }],
        drivingQuestion: '为什么公平比较需要相同观察时长？', expectedOutcome: '依据教材说明比较条件与证据范围',
        pblConfig: { makeArtifactMode: 'document' }, aiLearningClassroomId: classroomId, content: fixture.designContent,
      } } }, 201);
    const activity = (await request(teacher.context, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
      type: 'Classroom', title: '随课答疑断网恢复专项', templateVersionId: template.versions[0].id,
    }, 201)).activity;
    await request(teacher.context, 'PATCH', `/api/platform/activities/${activity.id}`, { isOpen: true });
    instance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: activity.id } });
    evidence.instanceId = instance.id;
    await request(teacher.context, 'POST', `/api/platform/classroom-instances/${instance.id}/start`, {});
    const participation = (await request(context, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {})).participation;
    evidence.participationId = participation.id;
    await request(teacher.context, 'POST', `/api/courses/${instance.id}/actions`, {
      requestId: randomUUID(), action: { type: 'SET_STAGE', payload: { id: instance.id, index: 1 } },
    });
    const pageUrl = `${origin}/student/classroom/${instance.id}`;
    chatEndpoint = `/api/courses/${instance.id}/lecture-chat`;
    const historyEndpoint = `${chatEndpoint}?classroomId=${encodeURIComponent(classroomId)}&sceneId=${encodeURIComponent(fixture.lectureSceneId)}`;
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const input = page.getByPlaceholder('这里没听懂？问一下');
    await expect(input).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-stage-host-mode="student"]').filter({ visible: true }).first())
      .toHaveAttribute('data-active-scene-id', fixture.lectureSceneId);
    const before = await request(context, 'GET', historyEndpoint);
    assert.equal(before.thread.messages.length, 0); assert.equal(before.requests.length, 0);
    const message = '请依据本页教材解释：为什么比较两处绿地的鸟类数量必须保持观察时长一致？举一个观察时长不同导致误判的具体例子，并说明一次观察结论的适用范围。';
    evidence.question = message;
    await input.fill(message);
    const headers = page.waitForResponse(response => new URL(response.url()).pathname === chatEndpoint
      && response.request().method() === 'POST', { timeout: 240_000 });
    await page.getByRole('button', { name: '发送问题', exact: true }).click();
    const response = await headers;
    assert.equal(response.status(), 200);
    const body = response.request().postDataJSON();
    evidence.request = body;
    assert.ok(body.requestId); assert.equal(body.message, message);
    const taskWhere = { taskType: 'LECTURE_CHAT', createdById: student.user.id,
      input: { path: ['requestId'], equals: body.requestId } };
    const running = await db.aiTask.findFirstOrThrow({ where: taskWhere });
    evidence.taskBeforeDisconnect = { id: running.id, status: running.status, input: running.input, output: running.output };
    assert.equal(running.status, 'RUNNING', 'Fault must interrupt an actual running model answer, not an already completed result');
    evidence.disconnectedAt = new Date().toISOString();
    faultActive = true;
    try { await context.setOffline(true); await delay(700); }
    finally { await context.setOffline(false); }
    // Keep the fault window open through navigation: it intentionally discards the old reader.
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    faultActive = false;
    evidence.reconnectedAt = new Date().toISOString();
    let recovered;
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const history = await request(context, 'GET', historyEndpoint);
      const receipt = history.requests.find(item => item.requestId === body.requestId);
      evidence.historySnapshots.push({ at: new Date().toISOString(), requestCount: history.requests.length,
        messageCount: history.thread.messages.length, receipt });
      if (receipt?.status === 'FAILED' || receipt?.status === 'CANCELLED') throw new Error(`Interrupted answer ended ${receipt.status}: ${receipt.error}`);
      if (receipt?.status === 'COMPLETED') { recovered = history; break; }
      await delay(700);
    }
    assert.ok(recovered, 'Real model answer did not complete durably after reconnect');
    evidence.recoveredHistory = recovered;
    assert.equal(recovered.requests.length, 1); assert.equal(recovered.thread.messages.length, 2);
    assert.equal(recovered.thread.messages.filter(item => item.role === 'student').length, 1);
    assert.equal(recovered.thread.messages.find(item => item.role === 'student').content, message);
    const answer = recovered.thread.messages.find(item => item.role === 'assistant');
    assert.equal(answer?.requestId, body.requestId); assert.ok(answer.content.trim());
    await page.getByRole('button', { name: /本页问答/ }).click({ timeout: 30_000 });
    await expect(page.getByText(message, { exact: true })).toBeVisible();
    const rendered = page.locator('[data-lecture-chat-answer="true"][data-answer-complete="true"]').last();
    await expect(rendered).toBeVisible({ timeout: 30_000 });
    assert.ok((await rendered.innerText()).trim(), 'Recovered assistant answer must actually render');
    if (fixture.adoptedSource) {
      assert.ok(answer.citations?.length, 'The recovered answer must retain its adopted textbook source');
      for (const citation of answer.citations) {
        assert.equal(citation.revisionId, fixture.adoptedSource.revisionId);
        assert.ok(fixture.adoptedSource.sourceBlockIds.includes(citation.sourceBlockId));
        assert.ok(citation.quote.trim());
      }
      await expect(page.getByRole('group', { name: '教材出处', exact: true }).last()).toBeVisible();
    }
    const tasks = await db.aiTask.findMany({ where: { taskType: 'LECTURE_CHAT', createdById: student.user.id,
      input: { path: ['courseId'], equals: instance.id } }, include: { conversation: { include: { messages: true } } } });
    evidence.retainedTasks = tasks;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].id, running.id); assert.equal(tasks[0].status, 'COMPLETED');
    assert.ok(tasks[0].output?.raw?.trim(), 'A completed answer must retain actual provider output');
    assert.equal(tasks[0].conversation.userId, student.user.id);
    assert.equal(tasks[0].conversation.participationId, participation.id);
    assert.equal(tasks[0].conversation.messages.length, 2);
    assert.equal(new Set(tasks[0].conversation.messages.map(item => item.id)).size, 2);
    assert.ok(tasks[0].conversation.messages.every(item => item.metadata?.requestId === body.requestId));
    assert.equal(evidence.requests.length, 1, 'Reload must recover history without resending the question');
    assert.deepEqual(evidence.browserErrors, []);
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    await request(teacher.context, 'POST', `/api/platform/classroom-instances/${instance.id}/finish`, {}); finished = true;
    evidence.status = '通过';
    record(name, '通过', { scope: evidence.scope, instanceId: instance.id, studentId: student.user.id,
      taskId: running.id, statusBeforeDisconnect: 'RUNNING', statusAfterReconnect: 'COMPLETED',
      offlineMs: 700, questionPosts: evidence.requests.length, persistedMessages: 2, providerOutputRetained: true,
      separateAuthenticatedContext: true }, 'browser-real-provider');
  } catch (error) {
    evidence.status = '失败'; evidence.error = String(error?.stack || error).slice(0, 3500);
    if (page) await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => undefined);
    if (instance && students[0]) evidence.failureTasks = await db.aiTask.findMany({ where: { taskType: 'LECTURE_CHAT',
      createdById: students[0].user.id, input: { path: ['courseId'], equals: instance.id } } }).catch(() => []);
    record(name, '失败', { scope: evidence.scope, error: evidence.error }, 'browser-real-provider');
  } finally {
    if (context) await context.setOffline(false).catch(() => undefined);
    if (instance && !finished) {
      try { await request(teacher.context, 'POST', `/api/platform/classroom-instances/${instance.id}/finish`, {}); }
      catch (error) { evidence.cleanupError = String(error.message); }
    }
    if (context) await context.close();
    await writeFile(path.join(output, `${name}.json`), JSON.stringify(evidence, null, 2));
  }
  return evidence;
}
