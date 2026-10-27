import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { observePendingResponse } from './classroom-acceptance-promise-lifecycle.mjs';
import { RETRYABLE_TUTOR_ERRORS, tutorQuestionFingerprint, snapshotTutorTask, assertTutorTaskReceipt, assertTutorUiRecovery } from './classroom-acceptance-tutor-recovery.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Authored synthetic teaching content, served through the real classroom APIs. */
export function createAcceptanceLearningFixture({ classroomId, timestamp = new Date().toISOString() }) {
  const sectionId = 'acceptance-observation-section';
  const quizOutlineId = 'acceptance-observation-quiz';
  const lectureSceneId = 'acceptance-observation-lecture';
  const comparisonSceneId = 'acceptance-observation-comparison';
  const quizSceneId = 'acceptance-observation-quiz-scene';
  const speechId = 'acceptance-observation-speech';
  const lectureText = '科学观察需要留下可以复查的证据。比较两处绿地的鸟类数量时，应保持相同的观察时长，记录日期、地点和鸟类数量。不同的观察时长可能影响记录到的数量，因此不能只比较两个原始总数。请先核对比较条件，再解释观察结果。';
  const comparisonText = '观察记录包含日期、地点、观察时长和数量。一次观察只能支持这次观察条件下的描述，不能直接证明整个校园的长期变化。提出结论时，需要说明证据的范围，保留原始记录，并避免把没有测量的原因写成已经证实的事实。';
  const questions = [
    { id: 'acceptance-duration-question', type: 'single', format: 'single_choice', points: 2,
      question: '比较两处绿地的鸟类数量时，哪种观察方法更可靠？',
      options: [{ value: 'A', label: '保持相同观察时长并记录日期、地点与数量' }, { value: 'B', label: '任选不同观察时长，仅比较鸟类总数' }],
      answer: ['A'], analysis: '比较应保持观察时长一致，并保存日期、地点与数量记录，避免把观察时长不同造成的差异误判为地点差异。', knowledgePointIds: ['acceptance-observation'] },
    { id: 'acceptance-boundary-question', type: 'single', format: 'single_choice', points: 3,
      question: '只观察一次校园东侧绿地，能够支持下列哪项结论？',
      options: [{ value: 'A', label: '描述本次观察条件下东侧绿地的记录结果' }, { value: 'B', label: '证明整个校园所有绿地的鸟类数量长期增加' }],
      answer: ['A'], analysis: '一次局部观察只能支持本次观察条件下的描述，不能据此推断整个校园的长期变化。', knowledgePointIds: ['acceptance-evidence'] },
  ];
  const slide = (id, title, text, order, point, speech) => ({
    id, stageId: classroomId, outlineId: id, lectureSectionId: sectionId, type: 'slide', title, order,
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching', knowledgePointIds: [point],
    content: { type: 'slide', canvas: { id: `canvas-${id}`, viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#16766d'], fontColor: '#29394f', fontName: 'Noto Sans SC' },
      background: { type: 'solid', color: '#ffffff' }, elements: [
        { id: `${id}-title`, type: 'text', left: 48, top: 48, width: 900, height: 75, rotate: 0,
          defaultFontName: 'Noto Sans SC', defaultColor: '#29394f', content: `<p style="font-size:34px">${title}</p>` },
        { id: `${id}-body`, type: 'text', left: 48, top: 158, width: 900, height: 300, rotate: 0,
          defaultFontName: 'Noto Sans SC', defaultColor: '#29394f', content: `<p style="font-size:26px;line-height:1.6">${text}</p>` },
      ] } },
    actions: [
      // The generated media has a decoded duration but no word alignment. These authored
      // cues deliberately start at media time zero; semantic anchors require alignment.
      { id: `${id}-board-open`, type: 'wb_open', speechId: speech, speechOffsetMs: 0 },
      { id: `${id}-board-note`, type: 'wb_draw_text', elementId: `${id}-note`, content: title,
        x: 40, y: 100, fontSize: 28, speechId: speech, speechOffsetMs: 0 },
      { id: speech, type: 'speech', text },
      { id: `${id}-board-close`, type: 'wb_close' },
    ],
  });
  const scenes = [slide(lectureSceneId, '科学观察与公平比较', lectureText, 0, 'acceptance-observation', speechId),
    slide(comparisonSceneId, '证据范围与结论', comparisonText, 1, 'acceptance-evidence', 'acceptance-comparison-speech'),
    { id: quizSceneId, stageId: classroomId, outlineId: quizOutlineId, lectureSectionId: sectionId,
      type: 'quiz', title: '观察方法与证据边界检测', order: 2, audience: 'student', stageKey: 'ai-learning',
      generationPurpose: 'knowledge-teaching', knowledgePointIds: ['acceptance-observation', 'acceptance-evidence'],
      content: { type: 'quiz', questions }, actions: [] }];
  const courseMindMap = { schemaVersion: 1, sourceFingerprint: digest([lectureText, comparisonText]),
    bindingFingerprint: digest(scenes.map(scene => [scene.id, scene.actions])), rootId: 'observation-root', diagnostics: [],
    nodes: [{ id: 'observation-root', label: '科学观察', knowledgePointIds: [], order: 0 },
      { id: 'fair-comparison', parentId: 'observation-root', label: '公平比较', description: questions[0].analysis, knowledgePointIds: ['acceptance-observation'], order: 0 },
      { id: 'evidence-boundary', parentId: 'observation-root', label: '证据范围', description: questions[1].analysis, knowledgePointIds: ['acceptance-evidence'], order: 1 }],
    relations: [{ id: 'conditions-to-conclusion', source: 'fair-comparison', target: 'evidence-boundary', label: '共同约束结论', rationale: '比较条件和证据范围共同约束观察结论。' }],
    bindings: [{ sceneId: lectureSceneId, defaultNodeId: 'fair-comparison', cues: [{ speechId, nodeId: 'fair-comparison', anchor: { quote: '相同的观察时长' } }] },
      { sceneId: comparisonSceneId, defaultNodeId: 'evidence-boundary', cues: [] },
      { sceneId: quizSceneId, defaultNodeId: 'observation-root', cues: [] }] };
  return { classroom: { id: classroomId, revision: 1, createdAt: timestamp, updatedAt: timestamp,
    stage: { id: classroomId, name: '科学观察整课验收', createdAt: timestamp, updatedAt: timestamp }, scenes },
  designContent: { pblOutline: '独立记录观察条件，使用可复查的证据形成结论。', lessonOutline: [],
    knowledgePoints: [{ id: 'acceptance-observation', name: '公平比较', description: questions[0].analysis },
      { id: 'acceptance-evidence', name: '证据范围', description: questions[1].analysis }],
    knowledgeLectureSections: [{ id: sectionId, title: '科学观察', order: 0, quizOutlineId,
      sceneOutlineIds: [lectureSceneId, comparisonSceneId], estimatedMinutes: 5, knowledgePointIds: ['acceptance-observation', 'acceptance-evidence'] }],
    teachingBlueprint: { sections: [{ id: sectionId, units: [] }] }, evaluationPlan: { dimensions: [], overallRubric: '' }, courseMindMap },
  question: questions[0], questions, sectionId, quizOutlineId, lectureSceneId, comparisonSceneId, quizSceneId, speechId, lectureText, comparisonText };
}

/** Observe detached native audio elements without changing playback or transport. */
function observeAudio() {
  if (window.__classroomAcceptanceAudio) return;
  const NativeAudio = window.Audio;
  const entries = [];
  function ObservedAudio(...args) {
    const audio = new NativeAudio(...args);
    const events = [];
    entries.push({ audio, events });
    for (const type of ['playing', 'pause', 'ended', 'error']) audio.addEventListener(type, () => {
      events.push({ type, time: audio.currentTime });
    });
    return audio;
  }
  ObservedAudio.prototype = NativeAudio.prototype;
  Object.setPrototypeOf(ObservedAudio, NativeAudio);
  window.Audio = ObservedAudio;
  const snapshot = ({ audio, events }, index) => {
    const source = audio.currentSrc || audio.src;
    return { id: index, src: source.startsWith('data:') ? source.slice(0, source.indexOf(',') + 1) : source,
      sourceLength: source.length, currentTime: audio.currentTime, duration: audio.duration,
      paused: audio.paused, ended: audio.ended, error: audio.error?.message ?? null, events };
  };
  window.__classroomAcceptanceAudio = () => entries.map(snapshot);
  // Match the actual generated bytes once, without serializing the base64
  // source on every playback sample or replacing the native audio element.
  window.__classroomAcceptanceAudioForSource = source => entries.flatMap((entry, index) =>
    (entry.audio.currentSrc || entry.audio.src) === source ? [snapshot(entry, index)] : []);
}

/** Read a clone of the actual response without replacing or delaying its body.
 * Browser-owned storage avoids CDP's evictable Network.getResponseBody cache.
 */
export function observeLectureChatStreams({ endpoint }) {
  if (window.__classroomAcceptanceLectureStreams?.endpoint === endpoint) return;
  const nativeFetch = window.fetch;
  const entries = [];
  window.__classroomAcceptanceLectureStreams = { endpoint, entries };
  window.fetch = function observedFetch(input, init) {
    const url = input instanceof Request ? input.url : String(input);
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (new URL(url, location.href).pathname !== endpoint || method !== 'POST') {
      return Reflect.apply(nativeFetch, this, [input, init]);
    }
    const requestBody = typeof init?.body === 'string' ? init.body : null;
    let requestId = null;
    try { requestId = JSON.parse(requestBody)?.requestId ?? null; } catch { /* Preserve malformed input as an observation. */ }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const entry = { requestId, requestBody, startedAt: performance.now(), completedAt: null,
      state: 'pending', status: null, contentType: null, body: null, error: null, aborted: null };
    entries.push(entry);
    const onAbort = () => { entry.aborted = { name: signal.reason?.name ?? 'AbortError', message: String(signal.reason?.message ?? signal.reason ?? 'Aborted') }; };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const finish = () => { entry.completedAt = performance.now(); signal?.removeEventListener('abort', onAbort); };
    const failure = (state, error) => {
      entry.state = state; entry.error = { name: error?.name ?? 'Error', message: String(error?.message ?? error) }; finish();
    };
    let pending;
    try { pending = Reflect.apply(nativeFetch, this, [input, init]); }
    catch (error) { failure('fetch-failed', error); throw error; }
    return pending.then(response => {
      entry.status = response.status; entry.contentType = response.headers.get('content-type');
      try {
        // Never await this promise before returning the untouched live response.
        void response.clone().text().then(body => {
          entry.body = body; entry.state = 'complete'; finish();
        }, error => failure('body-failed', error));
      } catch (error) { failure('clone-failed', error); }
      return response;
    }, error => { failure('fetch-failed', error); throw error; });
  };
}

const host = page => page.locator('[data-stage-host-mode="student"]').filter({ visible: true }).first();
const round2 = value => Math.round(value * 100) / 100;
const hasPath = (candidate, expected, origin) => {
  try { return new URL(candidate, origin).pathname === new URL(expected, origin).pathname; } catch { return false; }
};
async function until(read, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  do { const result = await read(); if (result) return result; await delay(350); } while (Date.now() < deadline);
  throw new Error(message);
}
function parseStreamResult(status, text) {
  assert.equal(status, 200, `Lecture chat HTTP ${status}: ${text.slice(0, 250)}`);
  const events = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const errors = events.filter(event => event.type === 'error');
  assert.deepEqual(errors, [], 'A streamed provider or persistence error is not a successful answer');
  const doneEvents = events.filter(event => event.type === 'done');
  assert.equal(doneEvents.length, 1, 'The live stream must contain exactly one committed done event');
  assert.equal(events.at(-1)?.type, 'done', 'The native response ended before its final done event');
  const done = doneEvents[0];
  assert.ok(done?.thread?.messages?.some(message => message.role === 'assistant' && message.content.trim()), 'Stream lacks a committed assistant answer');
  return done.thread;
}
async function streamResult(response) {
  return parseStreamResult(response.status(), await response.text());
}

/** Real browsers + real backend; individual failed checks remain failures while later stages can run. */
export async function runLearningAcceptance({ teacher, students, instance, classroomId, origin, db,
  request, record, output, realAi, fixture, observeAiAdmission }) {
  assert.ok(students.length > 0, 'Learning acceptance requires enrolled students');
  const evidence = { students: students.length, courseId: instance.id, checks: [], chat: [], streams: [], quizzes: [], audio: [], snapshots: [] };
  const browserErrors = [];
  const roster = students.map((student, position) => ({ ...student, position,
    band: Math.min(2, Math.floor(position * 3 / students.length)), attempt: null, chatInput: null }));
  const endpoint = `/api/courses/${instance.id}`;
  const chatEndpoint = `${endpoint}/lecture-chat`;
  const pageUrl = `${origin}/student/classroom/${instance.id}`;
  let chatPassed = false;
  let preparedPassed = false;
  let followupPassed = false;
  let personalAudioPassed = false;
  await mkdir(output, { recursive: true });
  const saveEvidence = () => writeFile(path.join(output, 'learning-acceptance.json'), JSON.stringify(evidence, null, 2));
  const check = async (name, operation, category = 'browser-real-backend') => {
    try {
      const aiBatch = { 'learning-all-student-private-chat-and-durable-replay': 'private-chat',
        'learning-all-student-personal-tutor-followup-and-replay': 'personal-tutor' }[name];
      const detail = await (aiBatch ? observeAiAdmission(aiBatch, operation) : operation());
      evidence.checks.push({ name, status: '通过', detail }); record(name, '通过', detail, category);
      return true;
    } catch (error) {
      const detail = String(error?.stack || error).slice(0, 1800);
      evidence.checks.push({ name, status: '失败', detail }); record(name, '失败', detail, category);
      await roster[0].page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true }).catch(() => undefined);
      return false;
    } finally { await saveEvidence(); }
  };
  const unverified = (name, detail) => {
    evidence.checks.push({ name, status: '未验证', detail }); record(name, '未验证', detail, 'not-covered');
  };
  const each = async (selected, action) => {
    const outcomes = await Promise.allSettled(selected.map(async student => {
      try { return await action(student); }
      catch (error) { throw new Error(`student ${student.position + 1} (${student.user.id}): ${error.message}`, { cause: error }); }
    }));
    const failures = outcomes.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason),
      `${failures.length}/${selected.length} students failed: ${failures.slice(0, 3).map(result => result.reason.message).join('; ')}`);
    return outcomes.map(result => result.value);
  };
  const audioSnapshot = page => page.evaluate(() => window.__classroomAcceptanceAudio?.() ?? []);
  const nativeChatStream = async (student, response) => {
    const body = response.request().postData();
    const requestId = student.chatInput.requestId;
    const read = () => student.page.evaluate(id => window.__classroomAcceptanceLectureStreams?.entries
      .filter(entry => entry.requestId === id) ?? [], requestId);
    let observation;
    let validationError = null;
    try {
      observation = await until(async () => {
        const entries = await read();
        assert.ok(entries.length <= 1, 'A question unexpectedly issued multiple browser fetch requests');
        return entries[0]?.state !== 'pending' ? entries[0] : null;
      }, `No terminal native fetch observation for question ${requestId}`, 180_000);
      assert.equal(observation.state, 'complete', `Actual lecture transport interrupted: ${JSON.stringify({ state: observation.state, error: observation.error, aborted: observation.aborted })}`);
      assert.equal(observation.aborted, null, 'The actual lecture fetch was aborted');
      assert.equal(observation.requestBody, body, 'The observed stream belongs to different submitted content');
      assert.equal(observation.status, response.status());
      return parseStreamResult(observation.status, observation.body);
    } catch (error) {
      validationError = error.message; throw error;
    } finally {
      observation ??= (await read().catch(() => []))[0];
      const filename = `private-chat-stream-${student.position + 1}.ndjson`;
      if (typeof observation?.body === 'string') await writeFile(path.join(output, filename), observation.body, { mode: 0o600 });
      evidence.streams.push({ studentId: student.user.id, requestId, source: 'actual-native-fetch-response-clone',
        state: observation?.state ?? 'missing-observation', status: observation?.status ?? null,
        contentType: observation?.contentType ?? null, error: observation?.error ?? null, aborted: observation?.aborted ?? null,
        validationError,
        durationMs: observation?.completedAt === null || !observation ? null : observation.completedAt - observation.startedAt,
        bodyCharacters: observation?.body?.length ?? null,
        bodySha256: typeof observation?.body === 'string' ? createHash('sha256').update(observation.body).digest('hex') : null,
        artifact: typeof observation?.body === 'string' ? filename : null });
    }
  };
  const currentScene = page => host(page).getAttribute('data-active-scene-id');
  const goToScene = async (page, id) => {
    const desired = fixture.classroom.scenes.findIndex(scene => scene.id === id);
    assert.ok(desired >= 0);
    for (let step = 0; step < fixture.classroom.scenes.length + 1; step++) {
      const active = await currentScene(page);
      if (active === id) return;
      const index = fixture.classroom.scenes.findIndex(scene => scene.id === active);
      const direction = index > desired ? '上一页' : '下一页';
      await page.getByRole('button', { name: direction, exact: true }).filter({ visible: true }).first().click();
      await until(async () => (await currentScene(page)) !== active, `Page did not change after ${direction}`, 15_000);
    }
    await expect(host(page)).toHaveAttribute('data-active-scene-id', id);
  };
  const closeChat = async page => {
    const collapse = page.getByRole('button', { name: '收起答疑', exact: true });
    if (await collapse.isVisible()) await collapse.click();
  };
  const pause = async page => {
    const control = page.getByRole('button', { name: '暂停讲解', exact: true }).filter({ visible: true });
    if (await control.count()) await control.first().click();
  };
  const errorListeners = [];
  for (const student of roster) {
    const listener = error => browserErrors.push({ studentId: student.user.id, message: error.message });
    student.page.on('pageerror', listener); errorListeners.push([student.page, listener]);
    await student.context.addInitScript(observeAudio);
    await student.context.addInitScript(observeLectureChatStreams, { endpoint: chatEndpoint });
  }
  try {
    await check('learning-all-student-real-player-entry', async () => {
      await each(roster, async ({ page }) => {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
        await expect(page.getByPlaceholder('这里没听懂？问一下')).toBeVisible({ timeout: 60_000 });
        await expect(host(page)).toHaveAttribute('data-active-scene-id', fixture.lectureSceneId);
      });
      return { students: roster.length, businessApiMocks: false };
    });

    const firstSpeech = fixture.classroom.scenes[0].actions.find(action => action.type === 'speech');
    if (firstSpeech?.audioUrl) {
      await check('learning-concurrent-audio-and-map-pause-resume', async () => {
        await each(roster, async ({ page, user }) => {
          await page.getByRole('button', { name: '继续讲解', exact: true }).click({ timeout: 30_000 });
          await until(async () => (await audioSnapshot(page)).some(audio => hasPath(audio.src, firstSpeech.audioUrl, origin)
            && audio.currentTime > 0.3 && !audio.paused && !audio.error), 'Native lecture audio did not advance', 45_000);
          await expect(page.locator('[data-whiteboard-page-mode="live"]')).toBeVisible({ timeout: 15_000 });
          await expect(page.locator('[data-whiteboard-page-mode="live"]').getByText(fixture.classroom.scenes[0].title, { exact: true })).toBeVisible();
          await page.getByRole('button', { name: '完整浏览课程思维导图', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: '课程思维导图', exact: true });
          await expect(dialog).toBeVisible();
          await until(async () => (await audioSnapshot(page)).filter(audio => hasPath(audio.src, firstSpeech.audioUrl, origin)).every(audio => audio.paused), 'Opening map did not pause lecture audio');
          await expect(dialog.getByText('公平比较', { exact: true }).first()).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(dialog).toBeHidden();
          await until(async () => (await audioSnapshot(page)).some(audio => hasPath(audio.src, firstSpeech.audioUrl, origin) && !audio.paused), 'Closing map did not restore playing lecture');
          await pause(page);
          evidence.audio.push({ studentId: user.id, lecture: await audioSnapshot(page) });
        });
        return { students: roster.length, observation: 'Native audio clock, map pause and resume; no physical speaker assertion' };
      }, 'browser-media');
    } else unverified('learning-concurrent-audio-and-map-pause-resume', '主课fixture未提供真实TTS音频URL。');

    if (realAi) chatPassed = await check('learning-all-student-private-chat-and-durable-replay', async () => {
      await each(roster, async student => {
        const { page, context, user } = student;
        await goToScene(page, fixture.lectureSceneId);
        const input = page.getByPlaceholder('这里没听懂？问一下');
        const message = `验收学生${student.position + 1}：为什么比较两处绿地的鸟类数量需要保持观察时长一致？请说明一个可能的误判。`;
        let composingRequests = 0;
        const count = req => { if (req.method() === 'POST' && new URL(req.url()).pathname === chatEndpoint) composingRequests++; };
        page.on('request', count);
        try {
          await input.fill(message);
          await input.dispatchEvent('compositionstart');
          await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
          await delay(150);
          assert.equal(composingRequests, 0, 'IME Enter must not send a question');
          await input.dispatchEvent('compositionend');
          const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === chatEndpoint
            && response.request().method() === 'POST', { timeout: 240_000 });
          await page.evaluate(() => {
            const timing = { startedAt: performance.now(), firstTextMs: null, completeMs: null };
            const observer = new MutationObserver(() => {
              const answer = document.querySelector('[data-lecture-chat-answer="true"]');
              if (!answer) return;
              timing.firstTextMs ??= performance.now() - timing.startedAt;
              if (answer.getAttribute('data-answer-complete') === 'true') timing.completeMs ??= performance.now() - timing.startedAt;
            });
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
            window.__acceptanceLectureTiming = { timing, observer };
          });
          await page.getByRole('button', { name: '发送问题', exact: true }).click();
          const response = await responsePromise;
          student.chatInput = response.request().postDataJSON();
          const thread = await nativeChatStream(student, response);
          const answer = thread.messages.find(item => item.requestId === student.chatInput.requestId && item.role === 'assistant');
          assert.ok(answer?.content.trim());
          const liveAnswer = page.locator(`[data-lecture-chat-answer="true"][data-answer-complete="true"][data-request-id="${student.chatInput.requestId}"]`);
          await expect(liveAnswer).toHaveCount(1, { timeout: 30_000 });
          await expect(liveAnswer).toBeVisible({ timeout: 30_000 });
          if (fixture.adoptedSource) {
            assert.ok(answer.citations?.length, 'An answer about the adopted source must retain its actual citation');
            const sources = page.getByRole('group', { name: '教材出处', exact: true }).last();
            await sources.getByRole('button', { name: `查看教材来源：${fixture.adoptedSource.textbookTitle}`, exact: true }).click();
            const source = page.getByRole('dialog', { name: '教材来源', exact: true });
            await expect(source).toBeVisible();
            await source.getByText('查看原文', { exact: true }).first().click();
            await expect(source.getByText(answer.citations[0].quote, { exact: true })).toBeVisible();
            await source.getByRole('button', { name: '关闭教材来源', exact: true }).click();
          }
          assert.equal(await currentScene(page), fixture.lectureSceneId, 'Chat must prevent automatic page advance');
          const history = await request(context, 'GET', `${chatEndpoint}?classroomId=${encodeURIComponent(classroomId)}&sceneId=${fixture.lectureSceneId}`);
          assert.deepEqual(history.thread, thread, 'The real streamed done thread differs from durable browser history');
          assert.equal(history.thread.messages.filter(item => item.role === 'student').length, 1);
          assert.equal(history.thread.messages.find(item => item.role === 'student').content, message);
          const tasks = await db.aiTask.findMany({ where: { taskType: 'LECTURE_CHAT', createdById: user.id,
            input: { path: ['courseId'], equals: instance.id } }, include: { conversation: { include: { messages: true } } } });
          assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'COMPLETED');
          assert.ok(tasks[0].output?.raw?.trim(), 'Committed lecture answer must retain real provider output');
          const timing = await page.evaluate(() => { const observed = window.__acceptanceLectureTiming; observed.observer.disconnect(); return observed.timing; });
          const serverMs = tasks[0].completedAt - tasks[0].startedAt;
          const taskTimestampDeltaMs = tasks[0].startedAt - tasks[0].createdAt;
          assert.ok(timing.firstTextMs !== null && timing.completeMs !== null && timing.completeMs <= 180000, 'Lecture UI exceeded its 180-second recovery deadline');
          assert.ok(tasks[0].startedAt && tasks[0].completedAt && serverMs >= 0 && serverMs <= 150000, 'Lecture server exceeded 150 seconds');
          assert.equal(tasks[0].conversation.participationId, student.participation.id);
          assert.equal(tasks[0].conversation.userId, user.id); assert.equal(tasks[0].conversation.messages.length, 2);
          assert.equal(tasks[0].conversation.messages.find(item => item.role === 'assistant')?.content, answer.content,
            'The actual streamed answer differs from the saved assistant message');
          const replay = await context.request.post(`${origin}${chatEndpoint}`, { data: student.chatInput,
            headers: { Origin: origin }, timeout: 60_000 });
          assert.deepEqual(await streamResult(replay), thread, 'Repeated request must return the same complete thread');
          assert.equal(await db.aiMessage.count({ where: { conversationId: tasks[0].conversationId } }), 2);
          evidence.chat.push({ studentId: user.id, requestId: student.chatInput.requestId, taskId: tasks[0].id,
            answerCharacters: answer.content.length, citations: answer.citations ?? [], completed: true,
            firstTextMs: timing.firstTextMs, completeMs: timing.completeMs, serverMs, taskTimestampDeltaMs,
            taskCreatedAt: tasks[0].createdAt, taskStartedAt: tasks[0].startedAt, taskCompletedAt: tasks[0].completedAt });
          await closeChat(page);
          await goToScene(page, fixture.comparisonSceneId);
          const nextHistory = await request(context, 'GET', `${chatEndpoint}?classroomId=${encodeURIComponent(classroomId)}&sceneId=${fixture.comparisonSceneId}`);
          assert.equal(nextHistory.thread.messages.length, 0, 'A different page must not inherit private messages');
          await goToScene(page, fixture.lectureSceneId);
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.getByRole('button', { name: /本页问答/ }).click({ timeout: 30_000 });
          await expect(page.getByText(message, { exact: true })).toBeVisible();
          await closeChat(page);
        } finally {
          page.off('request', count);
          await page.evaluate(() => window.__acceptanceLectureTiming?.observer.disconnect()).catch(() => undefined);
          await closeChat(page);
        }
      });
      return { students: roster.length, expectedTasks: roster.length, messagesPerStudent: 2, separatePages: true,
        streamSource: 'actual-native-fetch-response-clone', capturedStreams: evidence.streams.length };
    }, 'browser-real-provider');
    else unverified('learning-all-student-private-chat-and-durable-replay', '本轮未启用真实模型；不能以fixture回应代替随课提问验收。');

    if (realAi) await check('learning-private-chat-access-boundaries', async () => {
      assert.ok(chatPassed);
      const historyUrl = `${chatEndpoint}?classroomId=${encodeURIComponent(classroomId)}&sceneId=${fixture.lectureSceneId}`;
      // This student-only route explicitly requests the student-role session cookie.
      // A valid teacher session therefore receives the auth guard's 401, not a 403.
      assert.equal((await request(teacher.context, 'GET', `${endpoint}/state`)).course.id, instance.id);
      const denied = await request(teacher.context, 'GET', historyUrl, undefined, 401);
      assert.equal(denied.code, 'UNAUTHORIZED'); assert.equal(denied.thread, undefined);
      assert.equal((await request(teacher.context, 'GET', `${endpoint}/state`)).course.id, instance.id);
      await each(roster, async student => {
        const foreign = roster[(student.position + 1) % roster.length];
        const history = await request(student.context, 'GET', `${historyUrl}&studentId=${encodeURIComponent(foreign.user.id)}`);
        const questions = history.thread.messages.filter(item => item.role === 'student');
        assert.equal(questions.length, 1); assert.equal(questions[0].requestId, student.chatInput.requestId);
      });
      return { teacherRead: '401 UNAUTHORIZED (student-role session required)', teacherSessionStillValid: true,
        students: roster.length, clientSuppliedIdentityIgnored: true };
    });

    const speeches = fixture.classroom.scenes.filter(scene => scene.type === 'slide').map(scene => ({
      sceneId: scene.id, speech: scene.actions.find(action => action.type === 'speech'),
    }));
    if (speeches.every(item => item.speech?.audioUrl)) await check('learning-all-student-complete-lecture-playback', async () => {
      await each(roster, async ({ page }) => {
        for (const { sceneId, speech } of speeches) {
          await goToScene(page, sceneId);
          const resume = page.getByRole('button', { name: '继续讲解', exact: true });
          const ready = await until(async () => {
            if ((await audioSnapshot(page)).some(audio => hasPath(audio.src, speech.audioUrl, origin)
              && !audio.error && (audio.ended || !audio.paused))) return 'playing-or-ended';
            return await resume.isVisible() ? 'resume' : null;
          }, `Lecture ${sceneId} never reached a stable playback state`, 30_000);
          if (ready === 'resume') await resume.click();
          await until(async () => (await audioSnapshot(page)).some(audio => hasPath(audio.src, speech.audioUrl, origin)
            && audio.ended && !audio.error), `Lecture ${sceneId} did not finish its real audio`, Math.max(60_000, (speech.audioDurationSec || 90) * 1800));
        }
      });
      return { students: roster.length, lecturePages: speeches.length, evidence: 'Every native audio ended event observed' };
    }, 'browser-media');
    else unverified('learning-all-student-complete-lecture-playback', '并非每个讲授页都有真实TTS音频；不把手动翻页算作完整播放。');

    const answersFor = student => Object.fromEntries(fixture.questions.map((question, index) =>
      [question.id, student.band === 0 || (student.band === 1 && index === 0) ? 'A' : 'B']));
    const scoreFor = student => student.band === 0 ? 5 : student.band === 1 ? 2 : 0;
    const submit = async student => {
      const { page, context } = student;
      await closeChat(page);
      await goToScene(page, fixture.quizSceneId);
      await page.getByRole('button', { name: /^(开始答题|Start Quiz)$/ }).click({ timeout: 30_000 });
      const answers = answersFor(student);
      for (const question of fixture.questions) {
        const label = question.options.find(option => option.value === answers[question.id]).label;
        await page.getByRole('button', { name: new RegExp(label) }).click();
      }
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/knowledge-lecture'
        && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'record-attempt', { timeout: 120_000 });
      await page.getByRole('button', { name: /^(提交答案|Submit Answers)$/ }).click();
      const response = await responsePromise;
      assert.equal(response.status(), 200);
      const submitted = await response.json();
      student.attempt = submitted.attempt;
      assert.equal(student.attempt.score, scoreFor(student)); assert.equal(student.attempt.maxScore, 5);
      assert.equal(student.attempt.gradingStatus, 'graded'); assert.equal(student.attempt.questions.length, 2);
      const replay = await request(context, 'POST', '/api/knowledge-lecture', response.request().postDataJSON());
      assert.deepEqual(replay.attempt, student.attempt, 'Repeated submission must not create a second attempt');
      await expect(page.getByText(fixture.question.analysis, { exact: true })).toBeVisible({ timeout: 30_000 });
      evidence.quizzes.push({ studentId: student.user.id, attemptId: student.attempt.id, score: student.attempt.score,
        expectedScore: scoreFor(student), answers });
    };
    const reconcile = async (name, submittedStudents) => {
      const state = (await request(teacher.context, 'GET', `${endpoint}/state`)).course;
      const ownedIds = new Set(roster.map(student => student.user.id));
      assert.equal(state.students.filter(student => ownedIds.has(student.id)).length, roster.length);
      let scores = [];
      for (const student of roster) {
        const expected = submittedStudents.includes(student);
        const attempts = (state.aiLearningProgress?.[student.user.id]?.knowledgeLectureAttempts ?? []).filter(attempt => attempt.quizOutlineId === fixture.quizOutlineId);
        assert.equal(attempts.length, expected ? 1 : 0, `Teacher must retain unfinished student ${student.position + 1}`);
        if (!expected) continue;
        assert.equal(attempts[0].score, scoreFor(student)); assert.equal(attempts[0].id, student.attempt.id);
        const workspace = await db.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: student.participation.id } });
        const saved = workspace.projectState?.aiLearningProgress?.knowledgeLectureAttempts?.filter(attempt => attempt.quizOutlineId === fixture.quizOutlineId);
        assert.equal(saved?.length, 1); assert.deepEqual(saved[0], attempts[0]);
        scores.push(scoreFor(student));
      }
      const snapshot = { name, students: roster.length, answered: submittedStudents.length,
        completedPercent: Math.round(submittedStudents.length / roster.length * 100),
        averageScore: scores.length ? round2(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null };
      const pulse = teacher.page.getByRole('region', { name: '知识讲授课堂数据速览', exact: true });
      await expect(pulse.getByText('小测覆盖', { exact: true }).locator('..').locator('dd'))
        .toHaveText(`${submittedStudents.length}/${roster.length}`, { timeout: 30_000 });
      evidence.snapshots.push(snapshot); return snapshot;
    };
    const early = roster.filter(student => student.band !== 2);
    await check('learning-quiz-mixed-scores-with-unsubmitted-checkpoint', async () => {
      await each(early, submit);
      return reconcile('partial', early);
    });
    await check('learning-quiz-all-student-scores-database-and-teacher-state', async () => {
      await each(roster.filter(student => student.band === 2), submit);
      assert.ok(roster.every(student => student.attempt), 'All students need successful browser submission');
      return reconcile('complete', roster);
    });

    if (realAi) preparedPassed = await check('learning-shared-prepared-explanation-audio-and-no-personal-records', async () => {
      await until(async () => {
        const resources = await db.knowledgeExplanation.findMany({ where: { status: 'COMPLETED',
          input: { path: ['classroomId'], equals: classroomId } } });
        return resources.filter(row => row.audio).length >= fixture.questions.length;
      }, 'Shared question explanations and audio were not prepared', 240_000);
      const userIds = roster.map(student => student.user.id);
      const counts = async () => ({ tasks: await db.aiTask.count({ where: { createdById: { in: userIds } } }),
        conversations: await db.aiConversation.count({ where: { userId: { in: userIds } } }),
        messages: await db.aiMessage.count({ where: { conversation: { userId: { in: userIds } } } }) });
      const before = await counts();
      const explanations = await each(roster, async student => {
        assert.ok(student.attempt);
        const { page } = student;
        const responsePromise = observePendingResponse(page.waitForResponse(response => new URL(response.url()).pathname === '/api/knowledge-lecture'
          && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'tutor-explain', { timeout: 60_000 }));
        await page.getByRole('button', { name: '助教讲解', exact: true }).first().click();
        const response = await responsePromise;
        assert.equal(response.status(), 200);
        const { explanation } = await response.json();
        assert.equal(explanation.source, 'prepared'); assert.ok(explanation.audioUrl); assert.ok(explanation.text.trim());
        assert.equal(response.request().postDataJSON().requestId, undefined);
        const dialog = page.getByRole('dialog', { name: '助教题目讲解', exact: true });
        await expect(dialog.getByLabel('统一题目讲解', { exact: true })).toHaveText(explanation.text);
        await until(async () => (await audioSnapshot(page)).some(audio => hasPath(audio.src, explanation.audioUrl, origin)
          && audio.currentTime > 0.2 && !audio.error), 'Prepared explanation audio did not play', 45_000);
        const previousAudios = (await audioSnapshot(page)).length;
        await dialog.getByRole('button', { name: '再听一遍', exact: true }).click();
        await until(async () => (await audioSnapshot(page)).length > previousAudios, 'Replay did not create native playback');
        await dialog.getByRole('button', { name: '关闭讲解', exact: true }).click();
        await expect(dialog).toBeHidden({ timeout: 30_000 });
        await until(async () => (await audioSnapshot(page)).filter(audio => hasPath(audio.src, explanation.audioUrl, origin)).every(audio => audio.paused), 'Closing explanation did not stop its audio');
        return { id: explanation.id, text: explanation.text, audioUrl: explanation.audioUrl };
      });
      for (const item of explanations) assert.deepEqual(item, explanations[0], 'All students must read the same prepared resource');
      assert.deepEqual(await counts(), before, 'Opening/replaying a shared resource must not create personal AI records');
      return { students: roster.length, explanationId: explanations[0].id, personalRecordCounts: before, audio: explanations[0].audioUrl };
    }, 'browser-media');
    else unverified('learning-shared-prepared-explanation-audio-and-no-personal-records', '未启用真实模型/预生成音频，不声称共享讲解验收通过。');

    if (realAi) followupPassed = await check('learning-all-student-personal-tutor-followup-and-replay', async () => {
      evidence.tutorFollowups = [];
      evidence.tutorAudio = [];
      evidence.tutorAttempts = [];
      evidence.tutorRecoveries = [];
      await each(roster, async student => {
        assert.ok(student.attempt);
        const { page, context, user } = student;
        await page.getByRole('button', { name: '助教讲解', exact: true }).first().click();
        const dialog = page.getByRole('dialog', { name: '助教题目讲解', exact: true });
        const input = dialog.getByPlaceholder('把不明白的地方告诉助教…');
        const message = `学生${student.position + 1}追问：假如两个地点观察时长不同，直接比较鸟类总数会出现什么问题？请结合我的作答解释。`;
        await input.fill(message);
        const before = await db.aiTask.count({ where: { createdById: user.id, taskType: 'KNOWLEDGE_LECTURE_TUTOR' } });
        await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
        await delay(150);
        assert.equal(await db.aiTask.count({ where: { createdById: user.id, taskType: 'KNOWLEDGE_LECTURE_TUTOR' } }), before);
        const attemptEvidence = { studentIndex: student.index, client: `student-${student.index}`, phase: 'ai-learning',
          participationId: student.participation.id, attempts: [], ui: { retryClicks: 0 } };
        evidence.tutorAttempts.push(attemptEvidence);
        const saveAttempt = () => writeFile(path.join(output, `tutor-attempt-student-${student.index}.json`),
          JSON.stringify(attemptEvidence, null, 2), { mode: 0o600 });
        const readTask = async body => {
          const rows = await db.aiTask.findMany({ where: { createdById: user.id, taskType: 'KNOWLEDGE_LECTURE_TUTOR',
            input: { path: ['requestId'], equals: body.requestId } },
            include: { conversation: { include: { messages: true } }, interactionEvents: true } });
          assert.equal(rows.length, 1, 'Every observed tutor attempt needs its own durable task');
          return snapshotTutorTask(rows[0]);
        };
        const started = performance.now();
        attemptEvidence.startedAtMs = started;
        const remainingTextMs = () => {
          const remaining = 180000 - (performance.now() - started);
          assert.ok(remaining > 0, 'Tutor browser response exceeded the original 180 second total budget');
          return remaining;
        };
        const nextResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/knowledge-lecture'
          && response.request().method() === 'POST' && response.request().postDataJSON()?.action === 'tutor-message',
        { timeout: remainingTextMs() });
        const responsePromise = nextResponse();
        const synthesisResponses = [];
        const onSynthesis = response => {
          if (new URL(response.url()).pathname !== '/api/openmaic/generate/tts' || response.request().method() !== 'POST') return;
          const body = response.request().postDataJSON();
          if (typeof body?.audioId === 'string' && body.audioId.startsWith(`knowledge_tutor_${student.attempt.id}_`)) synthesisResponses.push(response);
        };
        page.on('response', onSynthesis);
        try {
        const send = dialog.getByRole('button', { name: '发送追问', exact: true });
        await send.click();
        let response = await responsePromise;
        let reply = await response.json();
        const retainResponse = () => {
          const observedAtMs = performance.now();
          const attemptStartedAtMs = attemptEvidence.attempts.length ? attemptEvidence.ui.retryClickedAtMs : started;
          const attempt = { body: response.request().postDataJSON(), status: response.status(), errorCode: reply.error,
            observedAtMs, elapsedMs: observedAtMs - attemptStartedAtMs, sinceFirstClickMs: observedAtMs - started };
          attemptEvidence.attempts.push(attempt);
          return attempt;
        };
        const first = retainResponse();
        await saveAttempt();
        if (first.status === 503 && RETRYABLE_TUTOR_ERRORS.includes(first.errorCode)) {
          first.task = await readTask(first.body);
          assertTutorTaskReceipt(first.task, first.body, student.participation.id, 'FAILED');
          await saveAttempt();
          await expect(dialog.getByText(first.errorCode, { exact: true })).toBeVisible({ timeout: remainingTextMs() });
          await expect(input).toHaveValue(message, { timeout: remainingTextMs() });
          await expect(send).toBeEnabled({ timeout: remainingTextMs() });
          Object.assign(attemptEvidence.ui, { errorText: first.errorCode, retainedQuestion: await input.inputValue(), sendEnabled: true });
          attemptEvidence.questionFingerprint = tutorQuestionFingerprint(first.body);
          // This is one witnessed user action after a terminal error. Never retry
          // by changing a task, bypassing the UI, or restarting the elapsed clock.
          const retryResponse = nextResponse();
          attemptEvidence.ui.retryClickedAtMs = performance.now();
          await send.click();
          attemptEvidence.ui.retryClicks = 1;
          response = await retryResponse;
          reply = await response.json();
          const retried = retainResponse();
          if (retried.status !== 200) {
            try { retried.task = await readTask(retried.body); }
            catch (error) { retried.taskReadError = String(error.message); }
          }
          await saveAttempt();
        }
        assert.equal(response.status(), 200, `Student ${user.id}: ${JSON.stringify(reply)}`);
        assert.equal(reply.resultSource, 'personalized');
        const answer = reply.thread?.messages?.findLast(item => item.role === 'assistant');
        assert.ok(answer?.content.trim());
        await expect(dialog.getByText(answer.content, { exact: true })).toBeVisible({ timeout: remainingTextMs() });
        const completeMs = performance.now() - started;
        attemptEvidence.completeMs = completeMs;
        attemptEvidence.visibleAnswer = answer.content;
        assert.ok(completeMs <= 180000, 'Tutor browser response exceeded 180 seconds');
        const body = response.request().postDataJSON();
        assert.ok(body.requestId);
        // Only a recovery chain needs the additional pre-replay snapshot.
        let finalTask = attemptEvidence.ui.retryClicks ? await readTask(body) : undefined;
        if (finalTask) assertTutorTaskReceipt(finalTask, body, student.participation.id, 'COMPLETED');
        const replay = await request(context, 'POST', '/api/knowledge-lecture', body);
        assert.deepEqual(replay.thread, reply.thread);
        attemptEvidence.replay = { requestId: body.requestId, thread: replay.thread };
        const tasks = await db.aiTask.findMany({ where: { createdById: user.id, taskType: 'KNOWLEDGE_LECTURE_TUTOR',
          input: { path: ['requestId'], equals: body.requestId } }, include: { conversation: { include: { messages: true } }, interactionEvents: true } });
        assert.equal(tasks.length, 1); assert.equal(tasks[0].status, 'COMPLETED');
        attemptEvidence.finalTaskAfterReplay = snapshotTutorTask(tasks[0]);
        if (finalTask) assert.deepEqual(attemptEvidence.finalTaskAfterReplay, finalTask, 'Tutor replay changed durable task/messages/audit');
        else finalTask = attemptEvidence.finalTaskAfterReplay;
        assertTutorTaskReceipt(finalTask, body, student.participation.id, 'COMPLETED');
        attemptEvidence.attempts.at(-1).task = finalTask;
        assert.equal(tasks[0].conversation.userId, user.id);
        assert.equal(tasks[0].conversation.participationId, student.participation.id);
        assert.equal(tasks[0].conversation.messages.filter(item => item.metadata?.requestId === body.requestId).length, 2);
        assert.equal(tasks[0].interactionEvents.length, 2);
        assert.ok(tasks[0].output?.modelOutput?.raw?.trim(), 'Real tutor reply needs its retained provider output');
        assert.ok(tasks[0].startedAt && tasks[0].completedAt && tasks[0].completedAt - tasks[0].startedAt <= 150000,
          'Tutor server response exceeded 150 seconds');
        for (const fact of tasks[0].interactionEvents) {
          assert.equal(fact.userId, user.id); assert.equal(fact.participationId, student.participation.id);
        }
        evidence.tutorFollowups.push({ studentId: user.id, requestId: body.requestId, taskId: tasks[0].id,
          answerCharacters: answer.content.length, retainedRawOutput: true, completeMs,
          serverMs: tasks[0].completedAt - tasks[0].startedAt, taskTimestampDeltaMs: tasks[0].startedAt - tasks[0].createdAt,
          taskCreatedAt: tasks[0].createdAt, taskStartedAt: tasks[0].startedAt, taskCompletedAt: tasks[0].completedAt });
        const voice = { studentId: user.id, requestId: body.requestId, taskId: tasks[0].id,
          textCharacters: answer.content.trim().slice(0, 3500).length, status: 'running' };
        evidence.tutorAudio.push(voice);
        try {
          const tts = await until(() => synthesisResponses.find(item => item.request().postDataJSON()?.text === answer.content.trim().slice(0, 3500)),
            'No actual personalized speech response; prepared audio or browser speech cannot substitute', 180_000);
          const audioPayload = await tts.json();
          voice.httpStatus = tts.status();
          assert.equal(tts.status(), 200, `Personalized TTS HTTP ${tts.status()}: ${JSON.stringify(audioPayload).slice(0, 300)}`);
          const base64 = audioPayload.base64 ?? audioPayload.data?.base64;
          const format = audioPayload.format ?? audioPayload.data?.format ?? 'mp3';
          assert.equal(typeof base64, 'string'); assert.ok(base64.length > 100);
          const bytes = Buffer.from(base64, 'base64');
          const source = `data:audio/${format};base64,${base64}`;
          const actualAudio = await until(() => page.evaluate(value => {
            const audio = window.__classroomAcceptanceAudioForSource?.(value)?.[0];
            return audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio : null;
          }, source),
            'Personalized speech bytes were never opened by native Audio', 30_000);
          const finished = await until(async () => {
            const observed = (await audioSnapshot(page)).find(item => item.id === actualAudio.id);
            assert.ok(!observed?.error, `Personalized speech decode error: ${observed?.error}`);
            return observed?.ended && observed.events.some(event => event.type === 'playing') && observed.events.some(event => event.type === 'ended') ? observed : null;
          }, 'Personalized speech did not finish native playback', Math.max(90_000, (actualAudio.duration || 90) * 1800));
          Object.assign(voice, { status: 'passed', format, bytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'), durationSeconds: finished.duration,
            currentTime: finished.currentTime, nativeAudioId: finished.id, events: finished.events,
            availableAndPlaybackMs: performance.now() - started, audioId: tts.request().postDataJSON().audioId });
        } catch (error) { Object.assign(voice, { status: 'failed', error: String(error?.stack || error).slice(0, 1800) }); }
        attemptEvidence.audio = voice;
        attemptEvidence.status = voice.status === 'passed' ? 'completed' : 'failed';
        if (attemptEvidence.ui.retryClicks === 1) {
          attemptEvidence.failedTaskAfterRetry = await readTask(first.body);
          assertTutorUiRecovery(attemptEvidence);
          evidence.tutorRecoveries.push(attemptEvidence);
        }
        await dialog.getByRole('button', { name: '关闭讲解', exact: true }).click();
        await expect(dialog).toBeHidden({ timeout: 30_000 });
        } catch (error) {
          attemptEvidence.status = 'failed'; attemptEvidence.error = String(error?.stack || error).slice(0, 1800); throw error;
        } finally { page.off('response', onSynthesis); await saveAttempt(); }
      });
      return { students: roster.length, personalReceipts: evidence.tutorFollowups.length, replayDuplications: 0 };
    }, 'browser-real-provider');
    else unverified('learning-all-student-personal-tutor-followup-and-replay', '本轮未启用真实模型。');

    if (realAi) personalAudioPassed = await check('learning-all-student-personal-tutor-native-audio', async () => {
      assert.ok(followupPassed, 'Personalized text did not complete for every student');
      assert.equal(evidence.tutorAudio?.length, roster.length);
      const failed = evidence.tutorAudio.filter(item => item.status !== 'passed');
      assert.equal(failed.length, 0, `${failed.length}/${roster.length} personalized voices failed: ${JSON.stringify(failed.map(item => ({ studentId: item.studentId, httpStatus: item.httpStatus, error: item.error }))).slice(0, 1400)}`);
      return { students: roster.length, nativeCompleted: evidence.tutorAudio.length,
        evidence: 'Actual generated response bytes matched native Audio and ended; original provider configuration retained' };
    }, 'browser-media');
    else unverified('learning-all-student-personal-tutor-native-audio', '未启用真实语音，不以追问文本完成代替个人语音通过。');

    if (realAi) await check('real-ai', async () => {
      assert.ok(chatPassed, 'Private lecture chat did not complete and reconcile for every student');
      assert.ok(preparedPassed, 'Prepared explanations/audio did not pass for every student');
      assert.ok(followupPassed, 'Personal tutor follow-up did not complete and reconcile for every student');
      assert.ok(personalAudioPassed, 'Personal tutor speech did not finish native playback for every student');
      assert.equal(evidence.chat.length, roster.length);
      assert.equal(evidence.tutorFollowups.length, roster.length);
      return { students: roster.length, privateAnswers: evidence.chat.length, sharedAudio: true,
        personalTutorAnswers: evidence.tutorFollowups.length };
    }, 'real-provider-api');

    await check('learning-student-ending-review-refresh-and-process-retention', async () => {
      await each(roster, async student => {
        assert.ok(student.attempt);
        const { page, user } = student;
        const dialog = page.getByRole('dialog', { name: '助教题目讲解', exact: true });
        if (await dialog.isVisible()) await dialog.getByRole('button', { name: '关闭讲解', exact: true }).click();
        await expect(dialog).toBeHidden({ timeout: 30_000 });
        await closeChat(page);
        const release = page.getByRole('button', { name: '我已经理解，可以继续', exact: true });
        const ending = page.getByRole('region', { name: '本课学习完成' });
        const confirmed = page.getByRole('button', { name: '已确认理解', exact: true });
        const ready = await until(async () => {
          if (await ending.isVisible()) return 'ending';
          if (await release.isVisible() && await release.isEnabled()) return 'review';
          return await confirmed.isVisible() ? 'confirmed' : null;
        }, 'Quiz never reached its review confirmation or completion page', 30_000);
        if (ready === 'review') await release.click();
        // This fixture's final quiz has no staged speech. Confirmation advances
        // to completion; clicking Next during that transition can race its DOM.
        await expect(ending).toBeVisible({ timeout: 30_000 });
        await expect(ending.getByText(`${scoreFor(student)} / 5 分`, { exact: true })).toBeVisible();
        await expect(ending.getByText('2 / 2 题', { exact: true })).toBeVisible();
        await ending.getByRole('button', { name: student.band === 0 ? '回看小测' : '回看错题与解析', exact: true }).click();
        await expect(page.getByText(fixture.question.analysis, { exact: true })).toBeVisible();
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByText(fixture.question.analysis, { exact: true })).toBeVisible({ timeout: 30_000 });
        const events = await until(async () => {
          const rows = await db.learningEvent.findMany({ where: { userId: user.id, classroomInstanceId: instance.id } });
          return rows.length ? rows : null;
        }, 'No retained learning process events for student', 30_000);
        assert.ok(events.every(event => event.participationId === student.participation.id));
        const keys = events.map(event => event.idempotencyKey).filter(Boolean);
        assert.equal(new Set(keys).size, keys.length, 'Process event retries must not duplicate stored keys');
      });
      return { students: roster.length, scoreGroups: [5, 2, 0], totalPoints: 5, refresh: 'server attempt retained' };
    });

    await check('learning-teacher-normal-and-fullscreen-statistics', async () => {
      assert.ok(roster.every(student => student.attempt));
      const average = round2(roster.reduce((sum, student) => sum + scoreFor(student), 0) / roster.length);
      const page = teacher.page;
      await page.goto(`${origin}/teacher/teach/${instance.id}/classroom`, { waitUntil: 'domcontentloaded' });
      const pulse = page.getByRole('region', { name: '知识讲授课堂数据速览', exact: true });
      await expect(pulse.getByText('小测覆盖', { exact: true }).locator('..').locator('dd'))
        .toHaveText(`${roster.length}/${roster.length}`, { timeout: 30_000 });
      try {
        await page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).first().click();
        await page.getByRole('button', { name: '班级学情', exact: true }).filter({ visible: true }).first().click();
        await expect(page.getByRole('img', { name: '章节测验完成率100%', exact: true }).filter({ visible: true }).first()).toBeVisible();
        await expect(page.getByRole('img', { name: `小测累计班级均分${average}分`, exact: true }).filter({ visible: true }).first()).toBeVisible();
      } finally {
        const exit = page.getByRole('button', { name: '退出全屏', exact: true }).filter({ visible: true });
        if (await exit.count()) await exit.first().click();
      }
      return { completion: 100, independentlyCalculatedAverage: average, students: roster.length };
    });
    await check('learning-no-uncaught-browser-errors', async () => { assert.deepEqual(browserErrors, []); return { students: roster.length }; });
    evidence.coverageNotes = { multiFormat: '独立 grading-acceptance 专项使用同一真实学生账号验证配对、填空和简答题。',
      lateGradingUi: '真实专项核对批阅期间及完成后的教师状态；结束页迟到回执的界面行为由独立 E2E fixture 组验证。' };
    if (fixture.adoptedSource && realAi) await check('learning-grounded-textbook-citations', async () => {
      const { revisionId, textbookTitle, sourceBlockIds } = fixture.adoptedSource;
      assert.ok(chatPassed);
      assert.equal(evidence.chat.length, roster.length);
      const blocks = await db.textbookSourceBlock.findMany({ where: { revisionId, id: { in: sourceBlockIds } } });
      assert.equal(blocks.length, new Set(sourceBlockIds).size);
      for (const reply of evidence.chat) {
        assert.ok(reply.citations.length, `Student ${reply.studentId} has no source citation`);
        for (const citation of reply.citations) {
          assert.equal(citation.revisionId, revisionId); assert.equal(citation.textbookTitle, textbookTitle);
          assert.ok(sourceBlockIds.includes(citation.sourceBlockId)); assert.ok(citation.quote.trim());
          assert.equal(citation.quote, blocks.find(block => block.id === citation.sourceBlockId).content,
            'Citation must preserve the complete original adopted block');
        }
      }
      return { students: roster.length, revisionId, citationsMatchAdoptedSources: true };
    });
    else unverified('learning-grounded-textbook-citations', '本轮fixture未提供实际教材修订及原文块绑定，不能将模型常识回答标记为教材引用验证。');
    return evidence;
  } finally {
    for (const [page, listener] of errorListeners) page.off('pageerror', listener);
    evidence.browserErrors = browserErrors;
    await saveEvidence();
  }
}

/** Separate real-service grading scope; it does not change the main lesson's authored score distribution. */
export async function runGradingAcceptance({ teacher, students, origin, env, db, request, record, output, offering, chapter }) {
  const classroomId = `acceptance-grading-${randomUUID()}`;
  const sectionId = 'acceptance-grading-section';
  const quizOutlineId = 'acceptance-grading-quiz';
  const timestamp = new Date().toISOString();
  const evidence = { scope: 'supplementary-multi-format-real-service', classroomId, checks: [], attempts: [],
    pendingSnapshots: [], records: [], limitations: ['本专项通过真实 HTTP 提交及查询，题型交互界面和结束页迟到回执另由 E2E fixture 组检查。'] };
  const roster = students.map((student, position) => ({ ...student, position }));
  let instance;
  const save = () => writeFile(path.join(output, 'grading-acceptance.json'), JSON.stringify(evidence, null, 2));
  await mkdir(output, { recursive: true });
  const check = async (name, operation, category = 'real-provider-api') => {
    try {
      const detail = { scope: evidence.scope, ...await operation() };
      evidence.checks.push({ name, status: '通过', detail }); record(name, '通过', detail, category);
      return true;
    } catch (error) {
      const detail = { scope: evidence.scope, error: String(error?.stack || error).slice(0, 2200) };
      evidence.checks.push({ name, status: '失败', detail }); record(name, '失败', detail, category);
      return false;
    } finally { await save(); }
  };
  const all = async work => {
    const outcomes = await Promise.allSettled(work);
    const failures = outcomes.filter(item => item.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(item => item.reason),
      `${failures.length}/${outcomes.length} requests failed: ${failures.slice(0, 3).map(item => item.reason.message).join('; ')}`);
    return outcomes.map(item => item.value);
  };
  const questions = [
    { id: 'grading-matching', type: 'matching', format: 'matching', points: 2,
      question: '将观察要求与对应做法配对。',
      matchingPairs: [{ leftId: 'L1', left: '公平比较', rightId: 'R1', right: '保持相同观察时长' },
        { leftId: 'L2', left: '证据范围', rightId: 'R2', right: '只描述本次观察条件下的结果' }],
      answer: ['L1:R1', 'L2:R2'], analysis: '公平比较需要相同观察时长；结论应限定在实际观察的范围内。', knowledgePointIds: ['grading-observation'] },
    { id: 'grading-fill', type: 'short_answer', format: 'fill_blank', points: 2,
      question: '比较两处绿地的鸟类数量时，应保持______一致。', referenceAnswer: '观察时长',
      commentPrompt: '满分2分。填写观察时长、观察时间或等价表述得2分，其他答案得0分。',
      analysis: '保持观察时长一致，避免把观察时间不同造成的差异当作地点差异。', knowledgePointIds: ['grading-observation'] },
    { id: 'grading-deep', type: 'short_answer', format: 'short_answer', points: 6,
      question: '如何公平比较两处绿地的鸟类数量，并说明一次观察可以支持的结论范围？',
      referenceAnswer: '记录日期、地点、观察时长和鸟类数量，在相同观察时长下比较数量；结论只描述本次观察范围，不能推断全校园长期变化。',
      commentPrompt: '满分6分。明确相同观察时长得2分；保留日期、地点、时长和数量的原始记录得2分；说明结论仅限本次观察、不能推断全校园长期变化得2分。接受等价表述。',
      analysis: '公平条件、原始记录与结论边界缺一不可。', knowledgePointIds: ['grading-observation'] },
  ];
  const setup = await check('grading-multi-format-isolated-classroom', async () => {
    assert.ok(roster.length > 0); assert.ok(env.CLASSROOM_DATA_DIR);
    const classroom = { id: classroomId, revision: 1, createdAt: timestamp, updatedAt: timestamp,
      stage: { id: classroomId, name: '题型评分专项', createdAt: timestamp, updatedAt: timestamp },
      scenes: [{ id: quizOutlineId, stageId: classroomId, outlineId: quizOutlineId, lectureSectionId: sectionId,
        type: 'quiz', title: '配对、填空与深度简答评分', order: 0, audience: 'student', stageKey: 'ai-learning',
        generationPurpose: 'knowledge-teaching', content: { type: 'quiz', questions }, actions: [] }] };
    await mkdir(env.CLASSROOM_DATA_DIR, { recursive: true });
    await writeFile(path.join(env.CLASSROOM_DATA_DIR, `${classroomId}.json`), JSON.stringify(classroom));
    const template = await request(teacher.context, 'POST', '/api/platform/templates', { title: '题型真实评分专项', snapshot: {
      schemaVersion: 2, kind: 'pbl-course', design: { name: '题型真实评分专项', subject: '科学', grade: '七年级', hours: 1,
        stages: [{ key: 'launch', label: '项目启动', view: 'simple-resource', description: '项目启动' },
          { key: 'ai-learning', label: '知识讲授', view: 'ai-learning', description: '配对、填空与简答' }],
        drivingQuestion: '如何公平比较并限定证据结论？', expectedOutcome: '有原始记录的比较结论',
        pblConfig: { makeArtifactMode: 'document' }, aiLearningClassroomId: classroomId,
        content: { pblOutline: '题型评分专项', lessonOutline: [],
          knowledgePoints: [{ id: 'grading-observation', name: '科学观察', description: questions[0].analysis }],
          knowledgeLectureSections: [{ id: sectionId, title: '科学观察评分', order: 0, quizOutlineId,
            sceneOutlineIds: [], estimatedMinutes: 5, knowledgePointIds: ['grading-observation'] }],
          teachingBlueprint: { sections: [{ id: sectionId, units: [] }] }, evaluationPlan: { dimensions: [], overallRubric: '' } },
      } } }, 201);
    const activity = (await request(teacher.context, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
      type: 'Classroom', title: '题型评分专项', templateVersionId: template.versions[0].id,
    }, 201)).activity;
    await request(teacher.context, 'PATCH', `/api/platform/activities/${activity.id}`, { isOpen: true });
    instance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: activity.id } });
    evidence.instanceId = instance.id;
    await request(teacher.context, 'POST', `/api/platform/classroom-instances/${instance.id}/start`, {});
    await all(roster.map(async student => {
      student.gradingParticipation = (await request(student.context, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {})).participation;
    }));
    await request(teacher.context, 'POST', `/api/courses/${instance.id}/actions`, {
      requestId: randomUUID(), action: { type: 'SET_STAGE', payload: { id: instance.id, index: 1 } },
    });
    return { instanceId: instance.id, students: roster.length, formats: questions.map(question => question.format), maxScore: 10 };
  }, 'isolated-backend');
  if (!setup) return evidence;
  const submitted = await check('grading-concurrent-matching-fill-and-deep-real-model', async () => {
    let settled = false;
    const work = all(roster.map(async student => {
      const answers = { 'grading-matching': student.position % 2 ? ['L1:R2', 'L2:R1'] : ['L1:R1', 'L2:R2'],
        'grading-fill': '观察时长', 'grading-deep': questions[2].referenceAnswer };
      student.gradingBody = { action: 'record-attempt', courseId: instance.id, studentId: student.user.id,
        sectionId, quizOutlineId, runtimeSceneId: quizOutlineId, answers };
      const started = performance.now();
      const response = await student.context.request.post(`${origin}/api/knowledge-lecture`, {
        headers: { Origin: origin }, data: student.gradingBody, timeout: 240_000,
      });
      assert.equal(response.status(), 200, await response.text());
      const { attempt } = await response.json();
      student.gradingAttempt = attempt;
      assert.equal(attempt.gradingSource, 'server'); assert.equal(attempt.gradingStatus, 'graded');
      assert.equal(attempt.questions.length, questions.length); assert.equal(attempt.maxScore, 10);
      for (const question of attempt.questions) {
        assert.equal(question.gradingStatus, 'graded'); assert.ok(question.feedback.trim());
        assert.ok(Number.isFinite(question.earned) && question.earned >= 0 && question.earned <= question.points);
      }
      assert.equal(attempt.questions.find(question => question.questionId === 'grading-matching').earned, student.position % 2 ? 0 : 2);
      assert.equal(attempt.score, attempt.questions.reduce((sum, question) => sum + question.earned, 0));
      evidence.attempts.push({ studentId: student.user.id, attempt, elapsedMs: Math.round(performance.now() - started) });
    })).then(result => ({ result }), error => ({ error })).finally(() => { settled = true; });
    // Observe actual in-flight persistence. No mocked delay or synthetic late grade is introduced.
    while (!settled) {
      try {
        const state = (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
        const attempts = roster.flatMap(student => state.aiLearningProgress?.[student.user.id]?.knowledgeLectureAttempts ?? []);
        evidence.pendingSnapshots.push({ at: new Date().toISOString(), submitted: attempts.length,
          pending: attempts.filter(attempt => attempt.gradingStatus === 'pending').length,
          graded: attempts.filter(attempt => attempt.gradingStatus === 'graded').length });
      } catch (error) { evidence.pendingSnapshotError = String(error.message); }
      if (!settled) await delay(1000);
    }
    const outcome = await work; if (outcome.error) throw outcome.error;
    return { students: roster.length, submitted: evidence.attempts.length,
      realSubjectiveQuestions: roster.length * 2, observedPending: evidence.pendingSnapshots.some(snapshot => snapshot.pending > 0) };
  });
  await check('grading-receipts-raw-model-evidence-and-teacher-reconciliation', async () => {
    assert.ok(submitted, 'Every student must complete real server grading before a passing reconciliation');
    const { verifyCapacityGradingRecords } = await import('../verify-capacity-grading-records.mjs');
    await all(roster.map(async student => {
      const factsWhere = { participationId: student.gradingParticipation.id, userId: student.user.id,
        payload: { path: ['detail', 'attemptId'], equals: student.gradingAttempt.id } };
      const before = await db.aiInteractionEvent.count({ where: factsWhere });
      const replay = await request(student.context, 'POST', '/api/knowledge-lecture', student.gradingBody);
      assert.deepEqual(replay.attempt, student.gradingAttempt);
      assert.equal(await db.aiInteractionEvent.count({ where: factsWhere }), before, 'Idempotent replay must not regrade');
      const summary = await verifyCapacityGradingRecords({ db, user: student.user, attemptId: student.gradingAttempt.id,
        fixture: { instanceId: instance.id, offeringId: offering.id, classroomId }, expectedInvocations: 2 });
      assert.equal(summary.success, 2); assert.equal(summary.raw, 2); assert.equal(summary.error, 0);
      evidence.records.push(summary);
      const workspace = await db.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: student.gradingParticipation.id } });
      const saved = workspace.projectState.aiLearningProgress.knowledgeLectureAttempts;
      assert.equal(saved.length, 1); assert.deepEqual(saved[0], student.gradingAttempt);
    }));
    const state = (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
    for (const student of roster) {
      assert.ok(state.students.some(item => item.id === student.user.id));
      const attempts = state.aiLearningProgress?.[student.user.id]?.knowledgeLectureAttempts;
      assert.equal(attempts?.length, 1); assert.deepEqual(attempts[0], student.gradingAttempt);
    }
    const average = round2(roster.reduce((sum, student) => sum + student.gradingAttempt.score, 0) / roster.length);
    evidence.finalSnapshot = { students: roster.length, graded: roster.length, average, maxScore: 10 };
    return { ...evidence.finalSnapshot, modelOutputs: evidence.records.reduce((sum, item) => sum + item.raw, 0),
      unchangedAfterReplay: true, matchesTeacherAndWorkspace: true };
  });
  await check('grading-finished-classroom-keeps-accepted-grades', async () => {
    await request(teacher.context, 'POST', `/api/platform/classroom-instances/${instance.id}/finish`, {});
    const state = (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
    assert.equal(evidence.attempts.length, roster.length);
    for (const student of roster) {
      assert.deepEqual(state.aiLearningProgress?.[student.user.id]?.knowledgeLectureAttempts?.[0], student.gradingAttempt);
    }
    return { instanceId: instance.id, retainedStudents: roster.length };
  }, 'isolated-backend');
  return evidence;
}
