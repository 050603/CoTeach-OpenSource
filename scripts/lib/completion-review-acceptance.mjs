/** Focused real-backend acceptance. Invoked by verify-prelaunch-functional's
 * disposable PostgreSQL/Redis/runtime lifecycle; never touches deployed data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { freemem, loadavg } from 'node:os';
import { hash } from '@node-rs/argon2';
import { chromium, expect } from '@playwright/test';
import { inspectBrowserIdentity } from './prelaunch-browser.mjs';
import { desktopSizes, selectLayoutCases, runLayoutCases, deployedLayoutBuild, openLayoutContext, measureLayoutEnvironment, captureLayoutScreenshot, settleLayoutAssets } from './layout-browser.mjs';
import { classifyClassroomRequest, measureClassroomRequestTiming, summarizeClassroomTraffic } from './classroom-acceptance-traffic.mjs';
import { resourceMetricLines } from './classroom-acceptance-soak.mjs';
import { capacityBrowserEnvironment } from '../capacity-network.mjs';
import { createCapacityAudioSink } from '../capacity-audio-sink.mjs';
import { createCompletionResponseTracker, isCompletionResponseCleanupCancellation, inspectCompletionBrowserTraffic } from './completion-review-response-tracker.mjs';
import { completionReviewContextsPerBrowser, completionReviewPreparationConcurrency, completionReviewLayoutPlan } from './completion-review-environment.mjs';
import { summarizeCompletionEventDelivery, inspectCompletionLearningQueue } from './completion-review-delivery.mjs';

const title = '社区生态调查与跨学科项目实践：从观察记录、比较证据到有证据支持的行动方案';
const names = ['观察与记录', '控制比较条件', '证据与结论边界', '观察方法检测'];
const zooms = [.8, .9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const ending = page => page.getByRole('region', { name: '本课学习完成', exact: true });
const expand = page => page.getByRole('button', { name: '展开页面目录', exact: true });
const directory = page => page.getByRole('navigation', { name: '页面目录', exact: true })
  .or(page.getByRole('dialog', { name: '页面目录', exact: true }));

function acceptanceCue() {
  const samples = 8000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(samples, 24); bytes.writeUInt32LE(samples * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 220 / samples) * 1200), 44 + index * 2);
  return bytes;
}

function observeReviewAudio() {
  const NativeAudio = window.Audio;
  const entries = [];
  function ObservedAudio(...args) {
    const audio = new NativeAudio(...args); const events = [];
    entries.push({ audio, events });
    for (const type of ['playing', 'pause', 'ended', 'error']) audio.addEventListener(type, () => events.push({ type, time: audio.currentTime, at: performance.now() }));
    return audio;
  }
  ObservedAudio.prototype = NativeAudio.prototype;
  Object.setPrototypeOf(ObservedAudio, NativeAudio);
  window.Audio = ObservedAudio;
  window.__completionReviewAudio = () => entries.map(({ audio, events }) => ({ source: audio.currentSrc || audio.src,
    currentTime: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : null,
    paused: audio.paused, ended: audio.ended, error: audio.error?.message ?? null, events }));
}

async function all(work) {
  const outcomes = await Promise.allSettled(work);
  const failures = outcomes.filter(item => item.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(item => item.reason),
    `${failures.length}/${outcomes.length} operations failed: ${failures[0].reason.message}`);
  return outcomes.map(item => item.value);
}

function layoutCases() {
  return [
    ...desktopSizes.map(([width, height]) => ({ id: `desktop-${width}x${height}`, viewport: { width, height } })),
    ...[[1024, 768], [768, 1024], [390, 844], [320, 568], [844, 390], [568, 320]].map(([width, height]) =>
      ({ id: `touch-${width}x${height}`, viewport: { width, height }, hasTouch: true, isMobile: true })),
    ...[[1366, 768], [1920, 1080]].flatMap(([width, height]) => zooms.map(zoom =>
      ({ id: `native-${width}x${height}-${zoom}`, viewport: { width, height }, zoom, nativeZoom: true }))),
    ...[1.25, 1.5, 2].map(dpr => ({ id: `dpr-${dpr}`, viewport: { width: 1366, height: 768 }, dpr })),
  ];
}

async function assertUsable(page, locator) {
  await settleLayoutAssets(page);
  const layout = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    broken: [...document.images].filter(image => !image.complete || !image.naturalWidth).length,
  }));
  assert.deepEqual(layout, { horizontalOverflow: false, broken: 0 });
  if (locator) {
    for (const button of await locator.getByRole('button').all()) {
      await button.scrollIntoViewIfNeeded();
      const hit = await button.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const x = Math.min(innerWidth - 1, Math.max(0, bounds.x + bounds.width / 2));
        const y = Math.min(innerHeight - 1, Math.max(0, bounds.y + bounds.height / 2));
        const top = document.elementFromPoint(x, y);
        return { width: bounds.width, height: bounds.height, reachable: !!top && (element === top || element.contains(top)) };
      });
      assert.ok(hit.width >= 44 && hit.height >= 44 && hit.reachable, `Unreachable action: ${JSON.stringify(hit)}`);
    }
  }
}

async function reachEnding(page) {
  for (let step = 0; step <= names.length; step++) {
    if (await ending(page).isVisible()) return;
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await delay(60);
  }
  await expect(ending(page)).toBeVisible();
}

async function playToEnding(page) {
  await page.getByRole('button', { name: '继续讲解', exact: true }).click();
  const confirm = page.getByRole('button', { name: '我已经理解，可以继续', exact: true });
  await expect(ending(page).or(confirm)).toBeVisible({ timeout: 45_000 });
  if (await confirm.isVisible()) await confirm.click();
  await expect(ending(page)).toBeVisible({ timeout: 45_000 });
}

async function selectPage(page, index) {
  if (!await directory(page).isVisible()) await expand(page).click();
  const navigation = directory(page);
  await expect(navigation).toBeVisible();
  const item = navigation.getByRole('button', { name: `第 ${index + 1} 页：${names[index]}`, exact: true });
  await item.scrollIntoViewIfNeeded();
  await item.click();
  if (await page.evaluate(() => innerWidth <= 1023)) await expect(navigation).toBeHidden();
  else await navigation.getByRole('button', { name: '收起页面目录', exact: true }).click();
  await expect(page.getByText(`${index + 1} / ${names.length + 1}`, { exact: true })).toBeVisible();
}

async function assertDirectoryFocusCycle(page) {
  const navigation = directory(page);
  const controls = await navigation.getByRole('button').all();
  assert.ok(controls.length >= names.length + 3);
  await expect(controls.at(-1)).toContainText('学习回顾');
  await controls[0].focus();
  for (const control of controls.slice(1)) {
    await page.keyboard.press('Tab'); await expect(control).toBeFocused();
  }
  await page.keyboard.press('Tab'); await expect(controls[0]).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(controls.at(-1)).toBeFocused();
}

export async function runCompletionReviewAcceptance({ root, origin, env, output, db, password, buildId, courseReadConfiguration, request, record,
  applicationProcessTreeMemory }) {
  const mode = process.env.COMPLETION_REVIEW_MODE || 'full';
  assert.ok(['full', 'layout'].includes(mode), 'Completion review mode must be full or layout');
  const layoutOnly = mode === 'layout';
  const contextsPerBrowser = completionReviewContextsPerBrowser(process.env);
  const count = Number(process.env.COMPLETION_REVIEW_STUDENTS || (layoutOnly ? 2 : 40));
  const minutes = Number(process.env.COMPLETION_REVIEW_MINUTES || (layoutOnly ? .05 : 3));
  assert.ok(Number.isInteger(count) && count >= 2 && count <= 40);
  const preparationConcurrency = completionReviewPreparationConcurrency(process.env, count);
  assert.ok(Number.isFinite(minutes) && minutes >= .05 && minutes <= 15);
  const layoutEnabled = process.env.COMPLETION_REVIEW_LAYOUT !== '0';
  const selectedLayouts = selectLayoutCases(layoutCases(), process.env.COMPLETION_REVIEW_LAYOUT_CASES);
  const runId = `completion-${randomUUID()}`;
  const report = { runId, buildId, mode, courseReadConfiguration, status: 'running', gateFailures: [], target: { students: 40, minutes: 3, browserCounts: { 'google-chrome': 20, 'microsoft-edge': 20 } },
    actual: { students: count, minutes: layoutOnly ? 0 : minutes, reviewSoakPerformed: !layoutOnly, contextsPerBrowser, preparationConcurrency }, evidence: 'browser-real-backend', browserCounts: {}, checks: [], layouts: [], resources: [],
    hostDescriptorSamples: [], browserLifecycleEvents: [], browserProcesses: [],
    limitations: ['Linux Chrome/Edge browsers; native page zoom and emulated DPR do not verify physical Windows system scaling.',
      'A deterministic local PCM cue exercises real playback; this feature acceptance does not validate TTS or authored course content.'] };
  const reportPath = path.join(output, 'completion-review.json');
  let saving = Promise.resolve();
  const save = () => { saving = saving.then(() => writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })); return saving; };
  const check = async (name, action, { continueOnFailure = false } = {}) => {
    try {
      const detail = await action(); report.checks.push({ name, status: 'passed', detail });
      record(`completion-review-${name}`, '通过', detail, 'browser-real-backend'); await save(); return detail;
    } catch (error) {
      report.gateFailures.push({ kind: 'check', name, message: error.message });
      report.checks.push({ name, status: 'failed', detail: error.message });
      record(`completion-review-${name}`, '失败', error.message, 'browser-real-backend'); await save();
      if (!continueOnFailure) throw error;
      return null;
    }
  };
  const configurations = [
    { label: 'google-chrome', executablePath: process.env.COMPLETION_REVIEW_CHROME_PATH || path.join(root, '.cache/browsers/chrome/opt/google/chrome/chrome') },
    { label: 'microsoft-edge', executablePath: process.env.COMPLETION_REVIEW_EDGE_PATH || path.join(root, '.cache/browsers/edge/opt/microsoft/msedge/msedge') },
  ];
  const browsers = []; const browserPools = [[], []]; const audioSinks = []; const contexts = []; const traffic = []; const browserErrors = [];
  const navigationWindows = [];
  report.navigationWindows = navigationWindows;
  const students = []; const trafficStart = new WeakMap(); const receivedHeaders = new WeakMap();
  const responseTrackers = []; let phase = 'preparation';
  let closingBrowsers = false; let descriptorFlight;
  const sampleDescriptors = async () => {
    try {
      const browserProcesses = [...report.browserProcesses];
      const [fileNumbers, driverDescriptors, ...browserDescriptors] = await Promise.all([
        readFile('/proc/sys/fs/file-nr', 'utf8').then(value => value.trim().split(/\s+/).map(Number)),
        readdir('/proc/self/fd').then(value => value.length),
        ...browserProcesses.map(browser => readdir(`/proc/${browser.pid}/fd`).then(value => value.length).catch(() => null)),
      ]);
      report.hostDescriptorSamples.push({ atMs: performance.now(), phase,
        systemAllocatedFileHandles: fileNumbers[0], systemUnusedFileHandles: fileNumbers[1], systemMaximumFileHandles: fileNumbers[2],
        driverDescriptors, browserDescriptors: browserProcesses.map((browser, index) => ({ ...browser, count: browserDescriptors[index] })) });
    } catch (error) { report.descriptorCollectionError = error.message; }
  };
  const descriptorSampler = setInterval(() => {
    if (!descriptorFlight) descriptorFlight = sampleDescriptors().finally(() => { descriptorFlight = null; });
  }, 1000);
  const eachStudent = async (operation, concurrency = students.length) => {
    const visit = async student => {
    try { return await operation(student); }
    catch (error) {
      let timer;
      const evidence = await Promise.race([student.page.evaluate(() => ({ url: location.href,
        visibility: document.visibilityState, focused: document.hasFocus(), text: document.body.innerText.slice(0, 4000),
        audio: window.__completionReviewAudio?.() ?? [],
      })).catch(cause => ({ unavailable: cause.message })), new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'Page diagnostic exceeded 5 seconds' }), 5000); })]);
      clearTimeout(timer);
      report.studentFailures ??= [];
      report.studentFailures.push({ student: student.index, browser: configurations[student.brand].label,
        shard: student.shard, phase, error: error.message, evidence });
      await student.page.screenshot({ path: path.join(output, `completion-review-failure-student-${student.index}.png`), timeout: 5000 }).catch(() => undefined);
      error.message = `student-${student.index}/${configurations[student.brand].label}/shard-${student.shard}: ${error.message}`;
      throw error;
    }
    };
    const results = [];
    for (let index = 0; index < students.length; index += concurrency) results.push(...await all(students.slice(index, index + concurrency).map(visit)));
    return results;
  };
  const navigate = async (client, action, reason = 'reload') => {
    const window = { client, reason, startedAtMs: performance.now(), finishedAtMs: null };
    navigationWindows.push(window);
    try { return await action(); } finally { window.finishedAtMs = performance.now(); }
  };
  const inspectBrowserErrors = (onlyPhase) => {
    const inspected = inspectCompletionBrowserTraffic(browserErrors, navigationWindows, traffic, onlyPhase);
    report.navigationConsoleCancellations = inspected.navigationConsoleCancellations;
    if (onlyPhase === 'layout') report.layoutSynchronizationTimeouts = inspected.requestTimeouts;
    else if (!onlyPhase) report.synchronizationTimeouts = inspected.requestTimeouts;
    return inspected;
  };
  const assertNoBrowserErrors = (onlyPhase) => {
    const inspected = inspectBrowserErrors(onlyPhase);
    if (onlyPhase === 'layout') {
      report.layoutApiFailures = inspected.apiFailures;
      report.layoutBrowserErrors = inspected.unexpectedBrowserErrors;
    }
    assert.equal(inspected.apiFailures.length, 0,
      `Real API failures outside navigation cancellation: ${inspected.apiFailures.length}; first: ${JSON.stringify(inspected.apiFailures.slice(0, 3)
        .map(({ client, path, status, errorCode, errorMessage }) => ({ client, path, status, errorCode, errorMessage })))}`);
    assert.equal(inspected.unexpectedBrowserErrors.length, 0,
      `Unexpected browser errors: ${inspected.unexpectedBrowserErrors.length}; first: ${JSON.stringify(inspected.unexpectedBrowserErrors.slice(0, 3)
        .map(entry => ({ client: entry.client, phase: entry.phase, text: (entry.console ?? entry.error ?? '').slice(0, 300) })))}`);
  };
  const watch = (context, client) => {
    const pageWatchers = [];
    const watchPage = page => {
      const onError = error => browserErrors.push({ client, phase, at: performance.now(), error: error.message });
      const onConsole = message => { if (message.type() === 'error') browserErrors.push({ client, phase, at: performance.now(), console: message.text() }); };
      const onCrash = () => {
        const event = { client, phase, at: performance.now(), error: 'Native browser page crashed' };
        browserErrors.push(event); report.browserLifecycleEvents.push(event);
      };
      page.on('pageerror', onError); page.on('console', onConsole); page.on('crash', onCrash);
      pageWatchers.push({ page, onError, onConsole, onCrash });
    };
    context.on('page', watchPage);
    context.on('request', value => trafficStart.set(value, { phase, startedAtMs: performance.now() }));
    const retain = (value, status, networkFailure) => {
      const url = new URL(value.url()); if (!url.pathname.startsWith('/api/')) return;
      const begun = trafficStart.get(value) ?? { phase, startedAtMs: performance.now() };
      let body; try { body = value.postDataJSON(); } catch { /* no JSON body */ }
      const finishedAtMs = performance.now();
      const browserTiming = value.timing();
      traffic.push({ client, ...begun, finishedAtMs, method: value.method(), path: url.pathname, status, networkFailure,
        ...receivedHeaders.get(value),
        ...(url.pathname === '/api/learning-events' ? { learningEventCount: Array.isArray(body?.events) ? body.events.length : null } : {}),
        ...classifyClassroomRequest({ path: url.pathname, method: value.method(), query: url.searchParams, body }),
        browserTiming, ...measureClassroomRequestTiming(browserTiming, begun.startedAtMs, finishedAtMs) });
    };
    const tracker = createCompletionResponseTracker({ completed: async response => {
      if (response.status() >= 400) {
        try {
          const body = await response.json();
          receivedHeaders.set(response.request(), { ...receivedHeaders.get(response.request()),
            errorCode: typeof body.error === 'string' ? body.error.slice(0, 300) : undefined,
            errorMessage: typeof body.message === 'string' ? body.message.slice(0, 500) : undefined });
        } catch { /* A non-JSON error remains a real HTTP failure. */ }
      }
      retain(response.request(), response.status());
    },
      failed: (metadata, error) => {
        const atMs = performance.now();
        if (isCompletionResponseCleanupCancellation(metadata, error, navigationWindows, atMs)) {
          report.responseCollectionCleanupCancellations ??= [];
          report.responseCollectionCleanupCancellations.push({ ...metadata, atMs, message: error.message });
        } else report.gateFailures.push({ kind: 'response-collector', ...metadata, message: error.message });
      } });
    responseTrackers.push(tracker);
    context.on('requestfailed', value => {
      retain(value, 0, value.failure()?.errorText);
      tracker.requestFailed(value);
    });
    context.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (!pathname.startsWith('/api/')) return;
      const headers = response.headers();
      receivedHeaders.set(response.request(), { httpRequestId: headers['x-openpbl-http-request-id'] ?? null,
        serverTiming: headers['server-timing'] ?? null });
      tracker.response(response, { client, path: pathname, method: response.request().method(), receivedHttpStatus: response.status(),
        startedAtMs: trafficStart.get(response.request())?.startedAtMs });
    });
    return () => {
      context.off('page', watchPage);
      for (const { page, onError, onConsole, onCrash } of pageWatchers) { page.off('pageerror', onError); page.off('console', onConsole); page.off('crash', onCrash); }
    };
  };
  await mkdir(path.join(output, 'completion-layout'), { recursive: true });
  await save();
  let sampler; let sampleFlight; let samplingFailure;
  try {
    await sampleDescriptors();
    assert.equal(await deployedLayoutBuild(origin), buildId, 'Isolated runtime does not match the candidate build');
    report.buildIdentityVerified = true;
    for (const [brand, configuration] of configurations.entries()) {
      const brandCount = brand === 0 ? Math.ceil(count / 2) : Math.floor(count / 2);
      const shards = Math.ceil(brandCount / contextsPerBrowser);
      for (let shard = 0; shard < shards; shard++) {
        const sink = await createCapacityAudioSink(); audioSinks.push(sink);
        const browser = await chromium.launch({ executablePath: configuration.executablePath, headless: true,
          handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
          env: { ...capacityBrowserEnvironment(), ...sink.env },
          args: ['--no-proxy-server', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
        browsers.push(browser); browserPools[brand].push(browser);
        browser.on('disconnected', () => {
          if (closingBrowsers) return;
          const event = { client: `${configuration.label}-browser-${shard}`, phase, at: performance.now(), error: 'Native browser disconnected outside cleanup' };
          report.browserLifecycleEvents.push(event); browserErrors.push(event);
        });
        const browserCdp = await browser.newBrowserCDPSession();
        try {
          const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
          const parent = processInfo.find(process => process.type === 'browser');
          if (parent) report.browserProcesses.push({ browser: configuration.label, shard, pid: parent.id });
        } finally { await browserCdp.detach(); }
      }
      const probe = await browserPools[brand][0].newContext();
      configuration.identity = await inspectBrowserIdentity(configuration, probe); await probe.close();
    }
    report.browserShards = configurations.map((configuration, brand) => ({ browser: configuration.label,
      shards: browserPools[brand].length, maximumContextsPerShard: contextsPerBrowser, audioOutput: 'private-clocked-pulseaudio-null-sink-per-browser' }));
    await check('isolated-users-and-course', async () => {
      const passwordHash = await hash(password);
      const teacherName = `${runId}-teacher`;
      await db.user.create({ data: { username: teacherName, usernameKey: teacherName, displayName: '结课回顾验收教师', role: 'TEACHER', passwordHash } });
      const teacher = await browsers[0].newContext(); contexts.push(teacher);
      await request(teacher, 'POST', '/api/platform/auth/teacher-login', { username: teacherName, password });
      const classroomId = `${runId}-classroom`;
      const sectionId = `${runId}-section`; const quizId = `${runId}-quiz`;
      const ids = [`${runId}-intro`, `${runId}-conditions`, `${runId}-evidence`, quizId];
      await mkdir(path.join(env.CLASSROOM_DATA_DIR, classroomId, 'audio'), { recursive: true });
      await writeFile(path.join(env.CLASSROOM_DATA_DIR, classroomId, 'audio', 'review-cue.wav'), acceptanceCue());
      const speech = (id, index) => [{ id: `${id}-speech`, type: 'speech', text: names[index],
        audioUrl: `/api/openmaic/classroom-media/${classroomId}/audio/review-cue.wav`, audioDurationSec: 1 }];
      const slide = (id, index) => ({ id, stageId: classroomId, outlineId: id, title: names[index], type: 'slide', order: index,
        audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching', actions: speech(id, index),
        content: { type: 'slide', canvas: { id: `canvas-${id}`, viewportSize: 1000, viewportRatio: .5625,
          theme: { backgroundColor: '#ffffff', themeColors: ['#16766d'], fontColor: '#29394f', fontName: 'Noto Sans SC' },
          background: { type: 'solid', color: '#ffffff' }, elements: [{ id: `body-${id}`, type: 'text', left: 60, top: 70, width: 880, height: 400,
            rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#29394f', content: `<p style="font-size:32px">${names[index]}</p><p style="font-size:24px">记录日期、地点、时长和数量，在相同条件下比较，结论限于本次观察。</p>` }] } } });
      const scenes = ids.slice(0, 3).map(slide);
      scenes.push({ id: quizId, stageId: classroomId, outlineId: quizId, lectureSectionId: sectionId, title: names[3], type: 'quiz', order: 3,
        audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching', actions: speech(quizId, 3), content: { type: 'quiz', questions: [
          { id: 'conditions', type: 'single', points: 4, score: 4, question: '比较观察结果时，应该控制什么条件？',
            options: [{ value: 'A', label: '观察时长' }, { value: 'B', label: '凭印象比较' }], answer: ['A'], analysis: '在相同观察时长下比较并保留原始记录。' },
        ] } });
      await mkdir(env.CLASSROOM_DATA_DIR, { recursive: true });
      await writeFile(path.join(env.CLASSROOM_DATA_DIR, `${classroomId}.json`), JSON.stringify({ id: classroomId, revision: 1, createdAt: new Date().toISOString(),
        stage: { id: classroomId, name: title, mode: 'playback', createdAt: Date.now(), updatedAt: Date.now() }, scenes }));
      const template = await request(teacher, 'POST', '/api/platform/templates', { title, snapshot: { schemaVersion: 2, kind: 'pbl-course', design: {
        name: title, subject: '科学', grade: '七年级', hours: 1, drivingQuestion: '如何依据观察证据形成可靠结论？', expectedOutcome: '有原始记录的比较结论',
        aiLearningClassroomId: classroomId, stages: [{ key: 'launch', label: '项目启动', view: 'simple-resource' }, { key: 'ai-learning', label: '知识讲授', view: 'ai-learning' }],
        pblConfig: { makeArtifactMode: 'document' }, content: { pblOutline: title, lessonOutline: [], knowledgePoints: [],
          knowledgeLectureSections: [{ id: sectionId, title: names[3], order: 0, quizOutlineId: quizId, sceneOutlineIds: ids.slice(0, 3), estimatedMinutes: 5, knowledgePointIds: [] }],
          evaluationPlan: { dimensions: [], overallRubric: '' } },
      } } }, 201);
      const offering = (await request(teacher, 'POST', '/api/platform/offerings', { name: title, description: runId }, 201)).offering;
      await request(teacher, 'PATCH', `/api/platform/offerings/${offering.id}`, { status: 'open' });
      const chapter = (await request(teacher, 'POST', `/api/platform/offerings/${offering.id}/chapters`, { title: '结课回顾验收' }, 201)).chapter;
      await request(teacher, 'PATCH', `/api/platform/chapters/${chapter.id}`, { isOpen: true });
      const activity = (await request(teacher, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, { type: 'Classroom', title, templateVersionId: template.versions[0].id }, 201)).activity;
      await request(teacher, 'PATCH', `/api/platform/activities/${activity.id}`, { isOpen: true });
      const instance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: activity.id } });
      await request(teacher, 'POST', `/api/platform/classroom-instances/${instance.id}/start`, {});
      await request(teacher, 'POST', `/api/courses/${instance.id}/actions`, { requestId: randomUUID(), action: { type: 'SET_STAGE', payload: { id: instance.id, index: 1 } } });
      report.fixture = { classroomId, instanceId: instance.id, offeringId: offering.id, sceneIds: ids, sectionId, quizId };
      await all(Array.from({ length: count }, async (_, index) => {
        const username = `${runId}-student-${index}`;
        const user = await db.user.create({ data: { username, usernameKey: username, displayName: `结课验收学生${index}`, role: 'STUDENT', passwordHash } });
        await db.enrollment.create({ data: { offeringId: offering.id, userId: user.id } });
        const brand = index % 2; const shard = Math.floor(Math.floor(index / 2) / contextsPerBrowser);
        const context = await browserPools[brand][shard].newContext({ viewport: { width: 1366, height: 768 } });
        contexts.push(context); await context.addInitScript(() => { if (location.protocol.startsWith('http')) localStorage.setItem('locale', 'zh-CN'); });
        await context.addInitScript(observeReviewAudio);
        await request(context, 'POST', '/api/platform/auth/login', { username, password });
        const authCookie = (await context.cookies()).find(cookie => cookie.name === 'openpbl_student');
        assert.ok(authCookie, 'Real student login did not issue its session cookie');
        const claims = JSON.parse(Buffer.from(authCookie.value.split('.')[1], 'base64url').toString());
        report.credentialLifetimes ??= [];
        report.credentialLifetimes.push({ student: index, issuedAtEpochMs: claims.iat * 1000, expiresAtEpochMs: claims.exp * 1000,
          lifetimeSeconds: claims.exp - claims.iat });
        const participation = (await request(context, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {})).participation;
        const attempt = (await request(context, 'POST', '/api/knowledge-lecture', { action: 'record-attempt', courseId: instance.id, studentId: user.id,
          sectionId, quizOutlineId: quizId, runtimeSceneId: quizId, answers: { conditions: index % 3 === 0 ? 'A' : 'B' } })).attempt;
        watch(context, `student-${index}`);
        const page = await context.newPage();
        students.push({ index, user, context, page, participation, attempt, brand, shard, cycles: 0 });
      }));
      students.sort((a, b) => a.index - b.index);
      report.browserCounts = Object.fromEntries(configurations.map((config, brand) => [config.label, students.filter(student => student.brand === brand).length]));
      report.browsers = configurations.map(config => config.identity);
      return { students: students.length, browserCounts: report.browserCounts, instanceId: instance.id };
    });
    const { instanceId, sceneIds } = report.fixture;
    const route = `${origin}/student/classroom/${instanceId}`;
    const reconcileStudentRecords = async (deliveryLabel) => {
      const deliveryEvents = [];
      for (const student of students) {
        const workspace = await db.studentProjectWorkspace.findUniqueOrThrow({ where: { participationId: student.participation.id } });
        const progress = workspace.projectState.aiLearningProgress;
        assert.deepEqual(progress.knowledgeLectureAttempts, [student.attempt]);
        assert.deepEqual(new Set(progress.completedScenes), new Set(sceneIds));
        assert.equal(progress.completionModelVersion, 2);
        const state = (await request(student.context, 'GET', `/api/courses/${instanceId}/state`)).course;
        assert.ok(Object.keys(state.aiLearningProgress ?? {}).every(id => id === student.user.id), 'Another student progress leaked');
        const writes = await db.domainEvent.count({ where: { classroomInstanceId: instanceId, actorId: student.user.id, eventType: 'UPDATE_STUDENT_PROGRESS' } });
        assert.equal(writes, report.baseline.find(row => row.studentId === student.user.id).progressWrites, 'Review repeated completed progress writes');
        const events = await db.learningEvent.findMany({ where: { classroomInstanceId: instanceId, userId: student.user.id } });
        deliveryEvents.push(...events);
        const queued = report.reviewDrain?.students.find(row => row.student === student.index)?.before.pendingWindowEventIds ?? [];
        const receivedIds = new Set(events.map(event => event.metadata?.legacy?.id));
        assert.ok(queued.every(id => receivedIds.has(id)), 'A fact pending at the end of the measured review window never reached the database');
        assert.ok(events.length > 0 && events.every(event => event.participationId === student.participation.id));
        assert.equal(events.filter(event => event.eventType === 'stage-goal-complete').length, 1,
          'Review must retain exactly one stage completion event');
        const keys = events.map(event => event.idempotencyKey).filter(Boolean);
        assert.equal(new Set(keys).size, keys.length);
        assert.ok(events.some(event => event.eventType === 'scene-enter' || event.eventType === 'scene-view'), 'Review did not retain page learning events');
      }
      assert.equal(traffic.filter(row => row.phase === 'review' && row.path === '/api/knowledge-lecture' && row.operation === 'record-attempt').length, 0);
      if (deliveryLabel && report.actual.reviewStartedAtEpochMs && report.actual.reviewFinishedAtEpochMs) {
        report[deliveryLabel] = summarizeCompletionEventDelivery(deliveryEvents,
          { fromEpochMs: report.actual.reviewStartedAtEpochMs, toEpochMs: report.actual.reviewFinishedAtEpochMs });
      }
      return { students: count, unchangedAttempts: true, completedProgressMonotonic: true, noRepeatedProgressWrites: true };
    };
    const drainResponses = async () => {
      try {
        await Promise.all(responseTrackers.map(tracker => tracker.drain(10_000)));
      } catch (error) {
        const failure = { kind: 'response-drain', phase, message: error.message, pending: responseTrackers.flatMap(tracker => [...tracker.pending.values()]) };
        report.gateFailures.push(failure); report.responseDrainFailures ??= []; report.responseDrainFailures.push(failure);
        record('completion-review-response-drain', '失败', error.message, 'browser-real-backend');
        await save();
      }
    };
    await check('initial-completion-and-directory-locked', async () => {
      report.initialCompletionWindow = { startedAtMs: performance.now(), startedAtEpochMs: Date.now() };
      await eachStudent(async student => {
        await student.page.goto(route, { waitUntil: 'domcontentloaded' });
        await expect(student.page.getByRole('button', { name: '下一页', exact: true })).toBeVisible({ timeout: 30_000 });
        await expect(expand(student.page)).toHaveCount(0);
        // Let the real engine/audio exhaust each page. Merely skipping pages
        // must not fabricate completion.
        await playToEnding(student.page);
        await expect(ending(student.page).getByRole('heading', { name: '本课学习完成', exact: true })).toBeVisible();
      }, preparationConcurrency);
      report.initialCompletionWindow.finishedAtMs = performance.now(); report.initialCompletionWindow.finishedAtEpochMs = Date.now();
      await delay(2000);
      report.baseline = await all(students.map(async student => ({ studentId: student.user.id,
        progressWrites: await db.domainEvent.count({ where: { classroomInstanceId: instanceId, actorId: student.user.id, eventType: 'UPDATE_STUDENT_PROGRESS' } }),
      })));
      return { students: students.length, uncompletedDirectoryInitiallyHidden: true };
    });
    if (!layoutOnly) {
    await check('review-does-not-autoplay-or-advance', async () => {
      await eachStudent(async student => {
        const { page } = student;
        for (let repeat = 0; repeat < 3; repeat++) {
          if (repeat) await playToEnding(page);
          await ending(page).getByRole('button', { name: '回顾本课内容', exact: true }).click();
          await expect(directory(page)).toBeVisible();
          await directory(page).getByRole('button', { name: '收起页面目录', exact: true }).click();
          await expect(page.getByRole('button', { name: '继续讲解', exact: true })).toBeVisible();
          await delay(3500);
          await expect(page.getByText(`1 / ${names.length + 1}`, { exact: true })).toBeVisible();
          await expect(page.getByRole('button', { name: '继续讲解', exact: true })).toBeVisible();
        }
        await reachEnding(page);
      });
      return { students: count, realPlaybackCompletionsPerStudent: 3, firstPageRetainedMilliseconds: 3500, playbackPaused: true };
    });
    phase = 'review';
    const sample = async () => {
      const response = await fetch(`${origin}/api/metrics`, { headers: { Authorization: `Bearer ${env.INTERNAL_MONITOR_TOKEN}` }, signal: AbortSignal.timeout(5000) });
      assert.ok(response.ok, 'Isolated metrics unavailable');
      const runtime = resourceMetricLines(await response.text());
      const rss = Number(runtime.find(line => line.startsWith('process_resident_memory_bytes '))?.split(' ')[1]);
      report.resources.push({ at: new Date().toISOString(), freeMemoryBytes: freemem(), loadAverage: loadavg(),
        runtime, applicationRssBytes: Number.isFinite(rss) && rss > 0 ? rss : null,
        applicationRssSource: 'prometheus-process_resident_memory_bytes', processTreeMemory: await applicationProcessTreeMemory() });
      await save();
    };
    const sampleSafely = () => sample().catch(error => { samplingFailure ??= error; });
    await sampleSafely();
    sampler = setInterval(() => {
      if (!sampleFlight) sampleFlight = sampleSafely()
        .finally(() => { sampleFlight = null; });
    }, 15_000);
    await check('concurrent-browser-review-soak', async () => {
      const begun = Date.now(); const until = begun + minutes * 60_000;
      report.actual.reviewStartedAtEpochMs = begun;
      await eachStudent(async student => {
        const { page } = student;
        do {
          if (!await ending(page).isVisible()) await reachEnding(page);
          const reviewName = student.cycles % 2 ? '回顾本课内容' : student.index % 3 === 0 ? '回看小测' : '回看错题与解析';
          await ending(page).getByRole('button', { name: reviewName, exact: true }).click();
          await expect(directory(page)).toBeVisible();
          await expect(expand(page)).toHaveCount(0);
          await selectPage(page, (student.index + student.cycles) % 3);
          await selectPage(page, 3);
          await reachEnding(page);
          if (student.cycles % 3 === 0) {
            await ending(page).getByRole('button', { name: '回顾本课内容', exact: true }).click();
            await expect(directory(page)).toBeVisible();
            await navigate(`student-${student.index}`, () => page.reload({ waitUntil: 'domcontentloaded' }));
            await expect(expand(page)).toBeVisible({ timeout: 30_000 });
            await expect(expand(page)).toHaveAttribute('aria-expanded', 'false');
          }
          student.cycles++;
          await delay(500);
        } while (Date.now() < until);
      });
      report.actual.reviewFinishedAtEpochMs = Date.now();
      report.actual.durationSeconds = (report.actual.reviewFinishedAtEpochMs - begun) / 1000;
      assert.ok(report.actual.durationSeconds >= minutes * 60);
      report.cycles = students.map(student => ({ studentId: student.user.id, count: student.cycles }));
      return { students: count, durationSeconds: report.actual.durationSeconds, minimumCycles: Math.min(...students.map(student => student.cycles)) };
    });
    clearInterval(sampler); sampler = null; await sampleFlight; await sampleSafely();
    report.memoryFailures = report.resources.filter(sample => Number.isFinite(sample.applicationRssBytes)).length >= 2
      ? [] : [{ kind: 'memory', message: 'At least two measured authoritative Prometheus application RSS samples are required' }];
    report.gateFailures.push(...report.memoryFailures);
    if (samplingFailure) report.gateFailures.push({ kind: 'resource-collection', message: samplingFailure.message });
    await check('flush-and-acknowledge-original-review-queues', async () => {
      report.reviewDrain = { trigger: 'existing-pagehide-flush-hook', startedAtEpochMs: Date.now(), students: [] };
      await eachStudent(async student => {
        const scope = { courseId: instanceId, studentId: student.user.id,
          fromEpochMs: report.actual.reviewStartedAtEpochMs, toEpochMs: report.actual.reviewFinishedAtEpochMs };
        const snapshot = { student: student.index, before: await student.page.evaluate(inspectCompletionLearningQueue, scope) };
        report.reviewDrain.students.push(snapshot);
        // Wake the existing sender without navigating or manufacturing facts.
        await student.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
        await expect.poll(async () => {
          snapshot.after = await student.page.evaluate(inspectCompletionLearningQueue, scope);
          return snapshot.after.eventEntries + snapshot.after.batchEntries;
        }, { timeout: 30_000, message: `Student ${student.index} still has durable review facts awaiting ACK` }).toBe(0);
        snapshot.finishedAtEpochMs = Date.now();
      });
      await drainResponses();
      report.reviewDrain.finishedAtEpochMs = Date.now();
      return { students: count, pendingEvents: 0, pendingCheckpoints: 0,
        durationSeconds: (report.reviewDrain.finishedAtEpochMs - report.reviewDrain.startedAtEpochMs) / 1000,
        windowFactsPendingBeforeFlush: report.reviewDrain.students.reduce((total, student) => total + student.before.pendingWindowEventIds.length, 0) };
    }, { continueOnFailure: true });
    await check('persisted-isolation-no-repeat-completion-or-grading', async () => {
      await delay(2500);
      await drainResponses();
      return reconcileStudentRecords('eventDeliveryAfterSoak');
    }, { continueOnFailure: true });
    await check('request-performance-and-browser-errors', async () => {
      const inspected = inspectBrowserErrors();
      const timeoutRequests = new Set(inspected.requestTimeouts.map(match => match.request));
      report.traffic = summarizeClassroomTraffic(traffic, 'review', { timeoutRequests });
      report.initialProgressTraffic = Object.fromEntries(Object.entries(summarizeClassroomTraffic(traffic, 'preparation', { timeoutRequests }))
        .filter(([operation]) => operation.startsWith('POST /api/openmaic/progress ')));
      assert.ok(Object.keys(report.initialProgressTraffic).length, 'Initial real progress writes must be measured');
      await writeFile(path.join(output, 'completion-review-traffic.json'), JSON.stringify(traffic, null, 2), { mode: 0o600 });
      report.performanceFailures = [...Object.entries(report.traffic), ...Object.entries(report.initialProgressTraffic)]
        .filter(([, value]) => value.failures || value.unmeasured || value.p95Ms === null || value.p95Ms > (value.category === 'read' ? 1000 : 2000))
        .map(([operation, value]) => ({ kind: 'performance', operation, p95Ms: value.p95Ms,
          budgetMs: value.category === 'read' ? 1000 : 2000, failures: value.failures, unmeasured: value.unmeasured, timeouts: value.timeouts }));
      report.gateFailures.push(...report.performanceFailures);
      report.unexpectedBrowserErrors = inspected.unexpectedBrowserErrors; report.apiFailures = inspected.apiFailures;
      if (inspected.unexpectedBrowserErrors.length) report.gateFailures.push({ kind: 'browser', count: inspected.unexpectedBrowserErrors.length });
      if (inspected.apiFailures.length) report.gateFailures.push({ kind: 'api', count: inspected.apiFailures.length });
      report.totalRequests = traffic.filter(row => row.phase === 'review').length;
      report.requestsPerStudentSecond = report.totalRequests / count / report.actual.durationSeconds;
      // The UI adds no polling. Bound a runaway loop independently of the latency gate.
      if (report.requestsPerStudentSecond >= 8) report.gateFailures.push({ kind: 'traffic', requestsPerStudentSecond: report.requestsPerStudentSecond });
      assert.deepEqual(report.gateFailures, [], 'Acceptance gates failed; retain every independent failure');
      return { operations: Object.keys(report.traffic).length, requests: report.totalRequests,
        requestsPerStudentSecond: report.requestsPerStudentSecond, errors: 0 };
    }, { continueOnFailure: true });
    }
    if (layoutEnabled) {
      phase = 'layout';
      const requireMergedSignals = !layoutOnly && count === 40 && minutes >= 3 && selectedLayouts.length === layoutCases().length;
      if (requireMergedSignals) await check('retain-real-idle-review-pages-during-layout', async () => {
        // These two identities are not reused by the cross-browser layout
        // profiles. Leave their genuine quiz reviews open while the matrix
        // runs, so the real heartbeat can reach the dwell allowance naturally.
        const probes = students.slice(2, 4);
        await all(probes.map(async student => {
          await reachEnding(student.page);
          await ending(student.page).getByRole('button', { name: student.index % 3 === 0 ? '回看小测' : '回看错题与解析', exact: true }).click();
          await expect(directory(student.page)).toBeVisible();
          await directory(student.page).getByRole('button', { name: '收起页面目录', exact: true }).click();
          await expect(student.page.getByText(`4 / ${names.length + 1}`, { exact: true })).toBeVisible();
        }));
        report.idleReviewProbe = { students: probes.map(student => student.index), startedAtMs: performance.now() };
        return { students: report.idleReviewProbe.students, nativeHeartbeat: true, expectedDurationSec: 30, dwellAllowanceSec: 120 };
      }, { continueOnFailure: true });
      await check('chrome-edge-responsive-native-zoom-dpr', async () => {
        report.layoutIdentityStrategy = 'rotate-opposite-brand-completed-students-excluding-idle-probes';
        report.layoutConcurrencyByBrand = {};
        for (const [brand, configuration] of configurations.entries()) {
          const plan = completionReviewLayoutPlan(students, brand, selectedLayouts.length, report.idleReviewProbe?.students);
          report.layoutConcurrencyByBrand[configuration.label] = plan.concurrency;
          // Complete each pair before leasing identities to the next pair.
          // This guarantees distinct in-flight identities even in tiny rosters.
          for (let offset = 0; offset < selectedLayouts.length; offset += plan.concurrency) {
          await runLayoutCases(selectedLayouts.slice(offset, offset + plan.concurrency), plan.concurrency, async scenario => {
            const { id, ...layout } = scenario;
            const opened = await openLayoutContext({ browser: browserPools[brand][0], label: configuration.label,
              executablePath: configuration.executablePath, ...layout,
              ...(scenario.nativeZoom ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}) });
            let stopWatching;
            try {
              const context = opened.context;
              // Restore a learner completed in the other browser brand. No
              // local review key is transferred to this fresh browser profile.
              const sourceStudent = students.find(student => student.index === plan.sourceStudentIndices[selectedLayouts.indexOf(scenario)]);
              await context.addCookies(await sourceStudent.context.cookies());
              await context.addInitScript(() => { if (location.protocol.startsWith('http')) localStorage.setItem('locale', 'zh-CN'); });
              const client = `${configuration.label}-${scenario.id}`;
              stopWatching = watch(context, client);
              const page = await context.newPage(); await page.goto(route, { waitUntil: 'domcontentloaded' });
              await expect(expand(page)).toBeVisible({ timeout: 30_000 });
              await selectPage(page, 3); await reachEnding(page);
              const review = ending(page);
              await expect(review.getByText(title, { exact: true })).toBeVisible();
              await review.evaluate(element => { element.scrollTop = 0; });
              const environment = await measureLayoutEnvironment(page, { ...scenario, physicalWidth: scenario.viewport.width, physicalHeight: scenario.viewport.height });
              const artifact = path.join(output, 'completion-layout', `${configuration.label}-${scenario.id}`);
              const animationState = () => review.evaluate(element => ({ scrollTop: element.scrollTop,
                running: element.getAnimations({ subtree: true }).filter(animation => animation.pending || animation.playState === 'running')
                  .map(animation => ({ playState: animation.playState, currentTime: animation.currentTime })),
                badgeInViewport: (() => { const badge = element.querySelector('svg')?.getBoundingClientRect(); const root = element.getBoundingClientRect();
                  return !!badge && badge.top >= root.top - 1 && badge.bottom <= root.bottom + 1; })(),
              }));
              await page.waitForTimeout(400);
              const animationBefore = await animationState();
              assert.ok(animationBefore.running.length && animationBefore.badgeInViewport && animationBefore.scrollTop === 0,
                'Animation capture must show an actually running badge at the top of the ending page');
              await captureLayoutScreenshot(page, `${artifact}-animation.png`, scenario.nativeZoom);
              const animationAfter = await animationState();
              assert.ok(animationAfter.running.length, 'Animation ended before screenshot capture completed');
              await expect.poll(() => review.evaluate(element => element.getAnimations({ subtree: true })
                .filter(animation => animation.pending || animation.playState === 'running').length), { timeout: 6000 }).toBe(0);
              await assertUsable(page, review);
              await captureLayoutScreenshot(page, `${artifact}-ending.png`, scenario.nativeZoom);
              await review.getByRole('button', { name: '回顾本课内容', exact: true }).click();
              await expect(directory(page)).toBeVisible();
              await expect(expand(page)).toHaveCount(0);
              await assertUsable(page);
              await captureLayoutScreenshot(page, `${artifact}-directory-default-expanded.png`, scenario.nativeZoom);
              await directory(page).getByRole('button', { name: '收起页面目录', exact: true }).click();
              await expect(expand(page)).toHaveAttribute('aria-expanded', 'false');
              await expand(page).focus(); await page.keyboard.press('Enter');
              await expect(directory(page)).toBeVisible(); await assertUsable(page);
              await captureLayoutScreenshot(page, `${artifact}-directory.png`, scenario.nativeZoom);
              if (await page.evaluate(() => innerWidth <= 1023)) {
                await assertDirectoryFocusCycle(page);
                await page.keyboard.press('Escape'); await expect(directory(page)).toBeHidden(); await expect(expand(page)).toBeFocused();
              }
              await selectPage(page, 2); await assertUsable(page);
              await navigate(client, () => page.reload({ waitUntil: 'domcontentloaded' }));
              await expect(expand(page)).toBeVisible({ timeout: 30_000 });
              await expect(expand(page)).toHaveAttribute('aria-expanded', 'false');
              report.layouts.push({ browser: configuration.label, sourceBrowser: configurations[sourceStudent.brand].label, studentIndex: sourceStudent.index,
                id, status: 'passed', environment, animationCapture: { before: animationBefore, after: animationAfter } });
              await save();
            } catch (error) {
              error.message = `${configuration.label}/${scenario.id}: ${error.message}`;
              throw error;
            } finally {
              stopWatching?.();
              await navigate(`${configuration.label}-${scenario.id}`, () => opened.close(), 'context-close');
            }
          });
          }
        }
        assertNoBrowserErrors('layout');
        return { cases: report.layouts.length, browsers: configurations.map(configuration => configuration.label), desktopSizes: desktopSizes.length,
          nativeZoomPercentages: zooms.map(zoom => Math.round(zoom * 100)), dprs: [1.25, 1.5, 2] };
      }, { continueOnFailure: true });
      if (!layoutOnly) await check('post-layout-isolation-and-persisted-merged-signals', async () => {
        await delay(2500); await drainResponses();
        const consistency = await reconcileStudentRecords('eventDeliveryAfterLayout');
        const signals = await db.learningSignal.findMany({ where: { participationId: { in: students.map(student => student.participation.id) } } });
        const merged = signals.filter(row => Array.isArray(row.payload?.components)
          && row.payload.components.some(component => component.kind === 'dwell-overrun')
          && row.payload.components.some(component => component.kind === 'repeated-playback'));
        report.postLayoutMergedSignals = merged.map(row => {
          const { view, components } = row.payload;
          const union = [...new Set(components.flatMap(component => component.evidenceEventIds))];
          assert.deepEqual(new Set(view.evidenceEventIds), new Set(union), 'Merged signal lost source evidence');
          const rank = { notice: 0, warning: 1, high: 2 };
          assert.equal(rank[view.severity], Math.max(...components.map(component => rank[component.severity])), 'Merged signal weakened severity');
          return { student: students.find(student => student.user.id === row.userId)?.index,
            id: row.id, componentKinds: components.map(component => component.kind), evidenceCount: union.length, severity: view.severity };
        });
        const probeDurationSeconds = report.idleReviewProbe ? (performance.now() - report.idleReviewProbe.startedAtMs) / 1000 : null;
        if (requireMergedSignals && report.layouts.length === selectedLayouts.length * configurations.length) {
          assert.ok(probeDurationSeconds >= 120, 'Real idle review did not reach its dwell allowance');
          assert.ok(merged.length, 'At least one real idle review must persist both dwell and repeated-playback reasons');
        }
        report.postLayoutRecordVerification = { status: 'passed', ...consistency, mergedSignalRows: merged.length,
          studentsWithMergedSignals: new Set(merged.map(row => row.userId)).size, idleProbeDurationSeconds: probeDurationSeconds };
        return { ...consistency, mergedSignalRows: merged.length, studentsWithMergedSignals: new Set(merged.map(row => row.userId)).size,
          originalStudentPagesRetained: students.length, idleProbeDurationSeconds: probeDurationSeconds, mergedSignalRequired: requireMergedSignals };
      }, { continueOnFailure: true });
      await check('post-layout-browser-and-api-errors', async () => {
        assertNoBrowserErrors();
        return { browserErrors: 0, apiErrors: 0, observedStudentPages: students.length };
      }, { continueOnFailure: true });
    }
    if (report.gateFailures.length) throw new Error(`Acceptance gates failed: ${JSON.stringify(report.gateFailures)}`);
    report.status = !layoutOnly && count === 40 && minutes >= 3 && layoutEnabled && selectedLayouts.length === layoutCases().length ? 'passed' : 'partial';
    if (report.status === 'partial') report.limitations.push(layoutOnly
      ? 'Layout-only scope; no forty-session soak or performance acceptance was performed.'
      : 'Reduced roster, duration or skipped layout is a smoke check, not full requested acceptance.');
  } catch (error) {
    report.status = 'failed'; report.error = String(error.stack ?? error).slice(0, 4000);
    if (error instanceof AggregateError) report.failures = error.errors.map(cause => String(cause.stack ?? cause).slice(0, 2000));
    await save();
    await Promise.allSettled(students.slice(0, 2).map(student => student.page.screenshot({
      path: path.join(output, `completion-review-failure-student-${student.index}.png`), timeout: 5000,
    })));
    report.browserErrors = browserErrors; record('completion-review', '失败', error.message, 'browser-real-backend'); throw error;
  } finally {
    clearInterval(descriptorSampler); await descriptorFlight; await sampleDescriptors();
    clearInterval(sampler); await sampleFlight?.catch(() => undefined);
    report.finishedAt = new Date().toISOString(); await save();
    await writeFile(path.join(output, 'completion-review-traffic.json'), JSON.stringify(traffic, null, 2), { mode: 0o600 });
    closingBrowsers = true;
    await Promise.allSettled(contexts.map(context => context.close()));
    await Promise.allSettled(browsers.map(browser => browser.close()));
    await Promise.allSettled(audioSinks.map(sink => sink.stop()));
  }
}
