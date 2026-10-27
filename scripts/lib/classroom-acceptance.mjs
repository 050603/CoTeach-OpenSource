import { observeSubmissionSaveReceipts, confirmSubmissionSave } from './classroom-acceptance-save-confirmation.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { Prisma } from '@prisma/client';
import experimentTemplates from '../../src/lib/platform/experiment-templates.ts';
import { inspectBrowserIdentity } from './prelaunch-browser.mjs';
import { CLASSROOM_PERFORMANCE_PHASES } from './classroom-acceptance-contract.mjs';
import { createAcceptanceLearningFixture, runLearningAcceptance, runGradingAcceptance } from './classroom-acceptance-learning.mjs';
import { runArtifactModesAcceptance } from './classroom-acceptance-artifacts.mjs';
import { classifyClassroomRequest, summarizeClassroomTraffic, summarizeClassroomAiTraffic, measureClassroomRequestTiming, isClassroomObservedRequestPath } from './classroom-acceptance-traffic.mjs';
import { observeAiAdmissionBatch } from './classroom-acceptance-ai-admission.mjs';
import { runCloseRaceAcceptance } from './classroom-acceptance-close-race.mjs';
import { runEventVolumeAcceptance } from './classroom-acceptance-event-volume.mjs';
import { runCompleteExportsAcceptance, assertResearchExportRowContent } from './classroom-acceptance-exports.mjs';
import { runResearchSourceAcceptance, assertNonemptyResearchExport } from './classroom-acceptance-research-sources.mjs';
import { runResourceMediaAcceptance } from './classroom-acceptance-resource-media.mjs';
import { runLectureChatRecoveryAcceptance } from './classroom-acceptance-chat-recovery.mjs';
import { runTeacherArtifactPreviews } from './classroom-acceptance-teacher-previews.mjs';
import { runPreparationAcceptance } from './classroom-acceptance-preparation.mjs';
import { runDocumentEditorAcceptance } from './classroom-acceptance-document-editor.mjs';
import { runDocumentAiAcceptance } from './classroom-acceptance-document-ai.mjs';
import { selectVerifiedTutorTask } from './classroom-acceptance-tutor-recovery.mjs';
import { DOCUMENT_REVIEW_SETTLEMENT_CHECK, runDocumentReviewSettlement, removeAcknowledgedDocumentDrafts } from './classroom-acceptance-document-review-settlement.mjs';
import { verifyRestoredClassroom } from './classroom-acceptance-restored-app.mjs';
import { runClassroomSaveRecovery, prepareSaveRecoveryDocument } from './classroom-acceptance-save-recovery.mjs';
import { runClassroomSaveConcurrency } from './classroom-acceptance-save-concurrency.mjs';
import { parseResourceSample, resourceMetricLines } from './classroom-acceptance-soak.mjs';
import { readNativeHttpRequestId } from './prelaunch-http-diagnostics.mjs';

const stages = [
  ['launch', '项目启动', 'simple-resource', 8],
  ['ai-learning', '知识讲授', 'ai-learning', 22],
  ['make', '项目实践', 'ai-collaboration', 30],
  ['showcase', '成果汇报与评价', 'showcase-reporting', 10],
  ['reflection', '后测', 'experiment-posttest', 20],
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
function fileManifest(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return fileManifest(path.join(directory, entry.name), relative);
    assert.ok(entry.isFile(), 'A classroom backup must not follow an unexpected symbolic link');
    const bytes = readFileSync(path.join(directory, entry.name));
    return [{ path: relative, bytes: bytes.length, sha256: sha(bytes) }];
  });
}

async function all(work) {
  const outcomes = await Promise.allSettled(work);
  const failures = outcomes.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), failures.map(result => String(result.reason)).join('\n'));
  return outcomes.map(result => result.value);
}

// Read only the unmerged tables authored by this acceptance flow. XML DOM
// decodes entities; joining w:t preserves text split across formatting runs.
function readAcceptanceWordTables(xml) {
  const dom = new JSDOM(xml, { contentType: 'text/xml' });
  const namespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const children = (node, name) => [...node.children].filter(child => child.namespaceURI === namespace && child.localName === name);
  try {
    return [...dom.window.document.getElementsByTagNameNS(namespace, 'tbl')].map(table => children(table, 'tr').map(row => children(row, 'tc').map(cell => {
      for (const properties of children(cell, 'tcPr')) {
        for (const span of children(properties, 'gridSpan')) {
          assert.equal(span.getAttributeNS(namespace, 'val'), '1', 'Word changed an unmerged acceptance table into spanned cells');
        }
        assert.equal(children(properties, 'hMerge').length + children(properties, 'vMerge').length, 0,
          'Word changed an unmerged acceptance table into merged cells');
      }
      return [...cell.getElementsByTagNameNS(namespace, 't')].map(text => text.textContent).join('').trim();
    })));
  } finally { dom.window.close(); }
}

export async function runClassroomAcceptance({ root, origin, env, output, teacher: teacherContext, browser, db, password,
  request, record: parentRecord, checkpoint, disconnectSockets, restart, backupRestore, bootRestored, runPublicDiscussion,
  sequence = 1, sustainedOnly = false, afterSustainedClass, applicationPid, applicationProcessTreeMemory }) {
  const studentCount = Number(process.env.CLASSROOM_ACCEPTANCE_STUDENTS || 30);
  const minutes = Number(process.env.CLASSROOM_ACCEPTANCE_MINUTES || 90);
  assert.ok(Number.isInteger(studentCount) && studentCount >= 2 && studentCount <= 30);
  assert.ok(Number.isFinite(minutes) && minutes > 0 && minutes <= 180);
  const runId = process.env.CLASSROOM_ACCEPTANCE_RUN_ID || randomUUID();
  const report = { schemaVersion: 1, runId, teachers: 1, students: studentCount, actualDurationSeconds: 0,
    browserCounts: { 'google-chrome': 0, 'microsoft-edge': 0 }, checks: [], phaseTiming: [], metrics: {}, continuitySnapshots: [], processSamples: [], phase: 'preparation',
    performanceScopes: { 'artifact-modes': { modes: ['python', 'c', 'other'], includedInClassroomDuration: false,
      aggregation: 'Combined supplementary phase; P95 remains separate for each method, path and operation, with the same 1000 ms read / 2000 ms write limits.',
      traffic: 'Real browser read/write requests without injected faults; AI and code execution retain their independent categories.' } } };
  const configured = Object.entries(env).filter(([key]) => /MODEL|PROVIDER|TTS|SPEECH|AI_|KNOWLEDGE_|DOCUMENT_|PROACTIVE_REVIEW_|WEBSOCKET|CODE_RUNNER|PUBLIC_DISCUSSION|COURSE_MUTATION|OPENPBL_COURSE_READ_|NEXT_PUBLIC_OPENPBL_SYSTEM_MODE/.test(key)).sort(([a], [b]) => a.localeCompare(b));
  report.runtimeConfiguration = { sha256: sha(json(configured)), keys: configured.map(([key]) => key),
    explanationWarmup: env.KNOWLEDGE_EXPLANATION_WARMUP_ENABLED,
    proactiveDocumentReview: env.DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED, publicDiscussion: env.ENABLE_PUBLIC_DISCUSSION,
    realProviders: process.env.PRELAUNCH_REAL_PROVIDERS === '1', transport: 'websocket-with-http-recovery',
    courseReadWorkers: Number(env.OPENPBL_COURSE_READ_WORKERS || '0') };
  const record = (name, status, detail = '', evidence = 'browser-real-backend') => {
    report.checks.push({ name, status, detail, evidence }); parentRecord(name, status, detail, evidence); checkpoint(report);
  };
  const save = (name, data) => writeFileSync(path.join(output, name), JSON.stringify(data, null, 2), { mode: 0o600 });
  const observeAiAdmission = (label, action) => observeAiAdmissionBatch({ label, output,
    readMetrics: async () => {
      const response = await fetch(`${origin}/api/metrics`, { headers: { Authorization: `Bearer ${env.INTERNAL_MONITOR_TOKEN}` }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`AI_CAPACITY_METRICS_HTTP_${response.status}`);
      return response.text();
    },
    onObservation: observation => {
      report.aiCapacityAdmission ??= {}; report.aiCapacityAdmission[label] = observation;
      const measured = observation.status === 'observed'
        && Object.values(observation.groups).some(group => group.status === 'observed' && group.count > 0);
      record(`ai-capacity-admission-${label}`, measured ? '通过' : '未验证', observation, 'isolated-backend');
    },
  }, action);
  const check = async (name, action, evidence) => {
    try { const result = await (name === 'concurrent-ai-save-projection' ? observeAiAdmission('document-ai', action) : action()); record(name, '通过', result ?? '', evidence); return result; }
    catch (error) { record(name, '失败', String(error.stack ?? error).slice(0, 2000), evidence); return null; }
  };
  const waitFor = async (predicate, message = 'Condition did not become true', timeout = 30000) => {
    const deadline = Date.now() + timeout; let last;
    do { try { const result = await predicate(); if (result) return result; } catch (error) { last = error; } await delay(250); } while (Date.now() < deadline);
    throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
  };
  const students = []; const browsers = []; const errors = []; const traffic = []; const pending = new Set();
  const trafficJournal = path.join(output, 'browser-traffic.ndjson');
  writeFileSync(trafficJournal, '', { flag: 'wx', mode: 0o600 });
  const retainTraffic = row => {
    traffic.push(row);
    // Preserve already observed attempts even if the outer isolation process
    // must stop before this function's final summary is reached.
    appendFileSync(trafficJournal, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  };
  let continuityTimer; let continuityFlight;
  let providerConfigurationSha256; let configurationFailure; let providerConfigurationChecks = 0;
  const socketClients = new Set(); let injected = false; let stageTransition = false; let transitionEndedAt = -Infinity;
  const requestCategory = req => {
    const url = new URL(req.url());
    let body;
    try { body = req.postDataJSON(); } catch { /* multipart or no body */ }
    return classifyClassroomRequest({ path: url.pathname, query: url.searchParams, method: req.method(), body });
  };
  const requestTiming = req => {
    try { return req.timing(); } catch { return null; }
  };
  const watch = (context, client) => {
    context.on('page', page => {
      page.on('pageerror', error => errors.push({ client, phase: report.phase, error: error.message }));
      page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
        try { if (JSON.parse(String(payload)).type === 'subscribed') socketClients.add(client); } catch { /* ignore frames outside the application protocol */ }
      }));
    });
    const starts = new WeakMap();
    const receivedResponseHeaders = new WeakMap();
    context.on('request', req => starts.set(req, { startedAtMs: performance.now(), phase: report.phase, injected,
      stageTransition: stageTransition || performance.now() - transitionEndedAt < 5000 }));
    context.on('requestfailed', req => {
      const pathname = new URL(req.url()).pathname;
      const start = starts.get(req) ?? { startedAtMs: performance.now(), phase: report.phase, injected, stageTransition };
      const finishedAtMs = performance.now(); const browserRequestTiming = requestTiming(req);
      if (isClassroomObservedRequestPath(pathname)) retainTraffic({ client, ...start, path: pathname, method: req.method(), status: 0,
        ...requestCategory(req), ...measureClassroomRequestTiming(browserRequestTiming, start.startedAtMs, finishedAtMs), finishedAtMs,
        requestTiming: browserRequestTiming, ...receivedResponseHeaders.get(req),
        networkFailure: req.failure()?.errorText ?? 'Network request failed' });
    });
    context.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (!isClassroomObservedRequestPath(pathname)) return;
      // Keep already received headers even if the response body is later cancelled.
      // These fields are evidence only: requestfailed still records status 0.
      const responseHeaders = response.headers();
      const httpRequestId = readNativeHttpRequestId(responseHeaders['x-openpbl-http-request-id']) ?? null;
      receivedResponseHeaders.set(response.request(), { receivedHttpStatus: response.status(),
        receivedServerTiming: responseHeaders['server-timing'] ?? null, receivedHttpRequestId: httpRequestId });
      const start = starts.get(response.request()) ?? { startedAtMs: performance.now(), phase: report.phase, injected, stageTransition };
      const promise = response.finished().then(async error => {
        if (error) return; // requestfailed retains an interrupted body once.
        const finishedAtMs = performance.now();
        const browserRequestTiming = requestTiming(response.request());
        const serverTiming = await response.headerValue('server-timing').catch(() => null);
        const errorBody = response.status() >= 400 ? await response.json().catch(() => ({})) : undefined;
        const errorCode = typeof errorBody?.code === 'string' ? errorBody.code : typeof errorBody?.error === 'string' ? errorBody.error : undefined;
        retainTraffic({ client, ...start, path: pathname, method: response.request().method(), status: response.status(),
          requestTiming: browserRequestTiming, serverTiming, httpRequestId,
          ...requestCategory(response.request()), ...measureClassroomRequestTiming(browserRequestTiming, start.startedAtMs, finishedAtMs), finishedAtMs,
          errorCode, ...(typeof errorBody?.message === 'string' ? { errorMessage: errorBody.message } : {}) });
      }).catch(() => undefined).finally(() => pending.delete(promise));
      pending.add(promise);
    });
  };
  await teacherContext.addInitScript(() => { if (location.protocol !== 'about:') localStorage.setItem('locale', 'zh-CN'); });
  watch(teacherContext, 'teacher');
  const teacher = { context: teacherContext, page: await teacherContext.newPage() };
  const snapshots = [];
  const resourceJournal = path.join(output, 'resource-snapshots.ndjson');
  writeFileSync(resourceJournal, '', { flag: 'wx', mode: 0o600 });
  const retainResourceSnapshot = sample => {
    snapshots.push(sample);
    appendFileSync(resourceJournal, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
  };
  let instance; let fixture; let offering; let chapter; let activity; let classroomId; let pdfReferences; let learningEvidence;
  const teacherState = async () => (await request(teacherContext, 'GET', `/api/courses/${instance.id}/state`)).course;
  const providerConfiguration = async () => {
    const [publicSettings, globalSettings] = await Promise.all([
      Promise.all(['/api/server-providers', '/api/openmaic/provider-config?section=providers', '/api/openmaic/provider-config?section=tts']
        .map(url => request(teacherContext, 'GET', url))),
      db.providerCredential.findMany({ where: { ownerId: null }, orderBy: { id: 'asc' } }),
    ]);
    // Hash the complete encrypted configuration in memory; never put its
    // values in reports. This also covers feature settings absent from APIs.
    return sha(json({ publicSettings, globalSettings }));
  };
  const assertProviderConfiguration = async () => {
    const actual = await providerConfiguration();
    providerConfigurationChecks++;
    if (actual !== providerConfigurationSha256) {
      configurationFailure = 'Configured provider/model/voice metadata changed during the classroom';
      throw new Error(configurationFailure);
    }
    return actual;
  };
  const sampleContinuity = () => {
    if (continuityFlight) return continuityFlight;
    continuityFlight = (async () => {
      const stageKey = report.phase; const at = new Date().toISOString();
      const auth = async (page, role, id) => {
        const deadline = Date.now() + 8000;
        do {
          if (page.isClosed()) return false;
          const alive = await page.evaluate(async ({ role, id }) => {
            const response = await fetch('/api/auth/me', { cache: 'no-store', headers: { 'X-OpenPBL-Role': role }, signal: AbortSignal.timeout(3000) });
            const data = await response.json();
            return response.ok && data.user?.role === role && (!id || data.user?.sub === id) && document.readyState !== 'loading';
          }, { role, id }).catch(() => false);
          if (alive) return true;
          await delay(200);
        } while (Date.now() < deadline);
        return false;
      };
      const [teacherAlive, authenticated] = await Promise.all([
        auth(teacher.page, 'teacher'), Promise.all(students.map(student => auth(student.page, 'student', student.user.id))),
      ]);
      const configurationSha256 = await assertProviderConfiguration();
      const sample = { at, stageKey, students: students.length, teacherAlive, authenticatedStudents: authenticated.filter(Boolean).length,
        providerConfigurationSha256: configurationSha256 };
      const metricsRequestedAt = new Date().toISOString();
      const metricsResponse = await fetch(`${origin}/api/metrics`, {
        headers: { Authorization: `Bearer ${env.INTERNAL_MONITOR_TOKEN}` }, signal: AbortSignal.timeout(5000),
      });
      const metricsHeadersAt = new Date().toISOString();
      assert.ok(metricsResponse.ok, 'Isolated runtime metrics became unavailable');
      const runtime = resourceMetricLines(await metricsResponse.text());
      const metricsReceivedAt = new Date().toISOString();
      // `at` begins continuity/auth checks, not the subsequent metrics scrape.
      // prom-client event-loop histograms reset on every collection; retain the
      // actual fetch interval without treating an unknown prior window as zero.
      const metricsCapture = { requestedAt: metricsRequestedAt, headersAt: metricsHeadersAt, receivedAt: metricsReceivedAt,
        eventLoopWindow: 'since previous collection; other captures may reset it' };
      const pid = applicationPid?.() ?? null;
      const processTreeMemory = await applicationProcessTreeMemory?.() ?? null;
      report.processSamples.push({ at, stageKey, metricsCapture, pid, processTreeMemory, values: parseResourceSample(runtime.join('\n')) });
      retainResourceSnapshot({ at, phase: stageKey, metricsCapture, pid, processTreeMemory, loadGeneratorMemory: process.memoryUsage(), serverMetrics: runtime });
      report.continuitySnapshots.push(sample); checkpoint(report);
      if (!teacherAlive || sample.authenticatedStudents !== studentCount) record('browser-continuity', '失败', sample);
    })().finally(() => { continuityFlight = null; });
    return continuityFlight;
  };
  const goStage = async index => {
    stageTransition = true;
    try {
    await teacher.page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).first().click();
    await teacher.page.getByLabel('全屏教学阶段', { exact: true }).selectOption(String(index));
    const dialog = teacher.page.getByRole('dialog');
    await dialog.getByRole('button', { name: /进入|切换|回退/ }).click();
    await waitFor(async () => (await teacherState()).currentStageIndex === index, 'Teacher UI stage transition was not committed');
    await teacher.page.getByRole('button', { name: '退出全屏', exact: true }).click();
    } finally { stageTransition = false; transitionEndedAt = performance.now(); }
  };
  const modes = async index => {
    const state = await teacherState(); assert.equal(state.currentStageIndex, index);
    assert.equal(state.students.length, studentCount);
    await teacher.page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).first().click();
    await expect(teacher.page.getByRole('heading', { name: stages[index][1], exact: true }).first()).toBeVisible();
    const header = teacher.page.locator('header').filter({ hasText: `已进入 ${studentCount}` });
    await expect(header.first()).toBeVisible();
    const analytics = teacher.page.getByRole('button', { name: '班级学情', exact: true });
    if (index !== 4) { await analytics.click(); await expect(analytics).toHaveAttribute('aria-pressed', 'true'); }
    save(`teacher-${stages[index][0]}-display.json`, { state, text: await teacher.page.locator('body').innerText() });
    await teacher.page.screenshot({ path: path.join(output, `teacher-${stages[index][0]}-display.png`) });
    if (index !== 4) await teacher.page.getByRole('button', { name: '授课展示', exact: true }).click();
    await teacher.page.getByRole('button', { name: '退出全屏', exact: true }).click();
  };
  async function assessment(student, phase) {
    const page = student.page;
    await request(student.context, 'GET', `/api/platform/activities/${activity.id}`);
    await page.goto(`${origin}/student/activities/${activity.id}/assessments/${instance.id}/${phase}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('radio', { name: '不知道', exact: true }).first().waitFor({ timeout: 30000 });
    const visited = [];
    for (let step = 0; step < 110; step++) {
      const unknown = page.getByRole('radio', { name: '不知道', exact: true });
      const choices = await unknown.count() ? unknown : page.getByRole('radio', { name: '4 分', exact: true });
      assert.ok(await choices.count(), 'Assessment page has no expected answer controls');
      for (const choice of await choices.all()) { visited.push(await choice.getAttribute('name')); await choice.locator('..').click(); }
      const next = page.getByRole('button', { name: '下一步', exact: true });
      if (!await next.count()) break;
      await next.click();
    }
    await page.getByRole('button', { name: '检查并提交', exact: true }).click();
    await page.getByText('所有题目已完成', { exact: true }).waitFor();
    const submitted = page.waitForResponse(res => new URL(res.url()).pathname.endsWith('/experiment') && res.request().method() === 'POST');
    await page.getByRole('button', { name: `确认提交${phase === 'pretest' ? '前测' : '后测'}`, exact: true }).click();
    const response = await submitted; assert.equal(response.status(), 200, await response.text());
    const result = await response.json();
    const expected = phase === 'pretest' ? 9 : 53;
    assert.equal(new Set(visited).size, expected);
    assert.equal(Object.keys(response.request().postDataJSON().answers).length, expected);
    student[phase] = result.submission;
    await expect(page.getByText(`${phase === 'pretest' ? '前测' : '后测'}已提交，答案已保存到本次课堂记录。`, { exact: true })).toBeVisible();
    const stored = await db.experimentAssessmentSubmission.findUniqueOrThrow({ where: { id: result.submission.id } });
    assert.equal(stored.objectiveTotal, 0, 'Template without answer keys must not invent a possible score');
    assert.equal(stored.objectiveScore, 0);
  }
  const hold = async (until, tick = async () => {}) => {
    if (configurationFailure) throw new Error(configurationFailure);
    while (Date.now() < until) {
      if (configurationFailure) throw new Error(configurationFailure);
      await tick();
      retainResourceSnapshot({ at: new Date().toISOString(), phase: report.phase, memory: process.memoryUsage(), students: students.length });
      checkpoint(report);
      await delay(Math.min(15000, Math.max(0, until - Date.now())));
    }
  };
  async function phase(index, fn) {
    report.phase = stages[index][0]; const started = Date.now();
    console.log(`Classroom phase ${index + 1}/5: ${stages[index][1]} (${minutes * stages[index][3] / 90} minutes)`);
    const end = started + minutes * 60000 * stages[index][3] / 90;
    if (index) await goStage(index);
    await check(`student-live-stage-${stages[index][0]}`, async () => {
      await all(students.map(student => expect(student.page.getByText(`阶段 ${index + 1}/5 · ${stages[index][1]}`, { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 30000 })));
      return { students: studentCount, automaticTransition: index > 0, noReloadBeforeAssertion: true };
    });
    await continuityFlight; await sampleContinuity();
    await check(`phase-${report.phase}`, async () => {
      const first = report.checks.length;
      const result = await fn(end);
      const failures = report.checks.slice(first).filter(item => item.status !== '通过');
      assert.equal(failures.length, 0, `Stage contains unsuccessful checks: ${failures.map(item => item.name).join(', ')}`);
      return result;
    });
    await hold(end);
    await check(`teacher-display-${report.phase}`, () => modes(index));
    await sampleContinuity();
    report.phaseTiming.push({ stageKey: report.phase, startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(), actualDurationSeconds: (Date.now() - started) / 1000 }); checkpoint(report);
  }
  const documentText = student => `自动验收学生${student.index}：我们在相同观察时长下记录两个地点的日期、地点和鸟类数量，保留原始数据，并限定结论适用范围。`;
  const savedDocument = async student => waitFor(async () => {
    const rows = await db.classroomSubmission.findMany({ where: { participationId: student.participation.id } });
    return rows.find(row => (row.payload?.view ?? row.payload)?.content?.includes(documentText(student)));
  }, `Student ${student.index} document was not saved`);
  try {
    assert.equal(process.env.PRELAUNCH_REAL_PROVIDERS, '1', 'Real provider configuration is required for the whole-class profile');
    for (const key of ['KNOWLEDGE_EXPLANATION_WARMUP_ENABLED', 'DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED', 'ENABLE_PUBLIC_DISCUSSION']) assert.equal(env[key], 'true', `${key} must be enabled for formal classroom behavior`);
    if (sequence === 1) await request(teacherContext, 'POST', '/api/platform/auth/teacher-register', { username: 'acceptance-teacher', displayName: '课堂验收教师', password, confirmPassword: password }, 201);
    else await request(teacherContext, 'POST', '/api/platform/auth/teacher-login', { username: 'acceptance-teacher', password });
    providerConfigurationSha256 = await providerConfiguration();
    report.runtimeConfiguration.publicProviderConfigurationSha256 = providerConfigurationSha256;
    report.runtimeConfiguration.sha256 = sha(json({ environment: configured, publicProviderConfigurationSha256: providerConfigurationSha256 }));
    record('runtime-config-binding', '通过', report.runtimeConfiguration, 'isolated-backend');
    offering = (await request(teacherContext, 'POST', '/api/platform/offerings', { name: `整课验收 ${runId}`, term: '2026秋季', description: '自动化隔离验收' }, 201)).offering;
    await request(teacherContext, 'PATCH', `/api/platform/offerings/${offering.id}`, { status: 'open' });
    const invitation = (await request(teacherContext, 'POST', `/api/platform/offerings/${offering.id}/invitation`, {})).invitation;
    chapter = (await request(teacherContext, 'POST', `/api/platform/offerings/${offering.id}/chapters`, { title: '科学观察' }, 201)).chapter;
    await request(teacherContext, 'PATCH', `/api/platform/chapters/${chapter.id}`, { isOpen: true });
    classroomId = `acceptance-${runId}-class-${sequence}`;
    fixture = createAcceptanceLearningFixture({ classroomId });
    await check('adopted-textbook-publication', async () => {
      const zip = new JSZip();
      zip.file('word/styles.xml', '<w:styles xmlns:w="urn:w"><w:style w:type="paragraph" w:styleId="h"><w:name w:val="heading 1"/><w:outlineLvl w:val="0"/></w:style><w:style w:type="paragraph" w:styleId="h2"><w:name w:val="heading 2"/><w:outlineLvl w:val="1"/></w:style></w:styles>');
      zip.file('word/document.xml', '<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="h"/></w:pPr><w:r><w:t>科学观察</w:t></w:r></w:p>'
        + [fixture.lectureText, fixture.comparisonText].map((text, index) => `<w:p><w:pPr><w:pStyle w:val="h2"/></w:pPr><w:r><w:t>${index ? '证据范围' : '公平比较'}</w:t></w:r></w:p><w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>');
      const response = await teacherContext.request.post(`${origin}/api/textbooks`, { headers: { Origin: origin }, timeout: 90000,
        multipart: { file: { name: 'acceptance-textbook.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await zip.generateAsync({ type: 'nodebuffer' }) }, title: '科学观察验收教材' } });
      const body = await response.json(); assert.equal(response.status(), 201, JSON.stringify(body).slice(0, 300));
      const book = await waitFor(async () => {
        const details = await request(teacherContext, 'GET', `/api/textbooks/${body.textbook.id}`);
        return details.sourceBlocks?.some(block => block.content.includes('比较两处绿地')) ? details : null;
      }, 'Authored textbook did not finish parsing', 90000);
      const items = fixture.designContent.knowledgePoints.map((point, index) => {
        const block = book.sourceBlocks.find(item => item.content.includes(index ? '一次观察' : '比较两处绿地'));
        assert.ok(block, 'Parsed textbook lost an authored source block');
        const section = book.sections.find(item => item.id === block.sectionId);
        const source = { textbookId: body.textbook.id, textbookTitle: '科学观察验收教材', revisionId: book.revision.id,
          revisionVersion: book.revision.version, sectionId: block.sectionId, sectionPath: [section?.title ?? '科学观察'], sourceBlockId: block.id, quote: block.content };
        point.evidenceItemIds = [`acceptance-source-${index}`];
        return { id: point.evidenceItemIds[0], kind: 'source-block', title: point.name, content: block.content, source,
          completeSourceBlocks: [{ sourceBlockId: block.id, content: block.content, source }] };
      });
      const selections = [{ revisionId: book.revision.id, primary: true, sectionIds: [...new Set(items.map(item => item.source.sectionId))] }];
      fixture.designContent.textbookSelections = selections;
      fixture.designContent.courseEvidence = { schemaVersion: 2, version: 1, fingerprint: sha(JSON.stringify(items)), createdAt: new Date().toISOString(),
        retrievalMode: 'lexical-degraded', selections, items, mappings: [], warnings: [] };
      fixture.adoptedSource = { textbookTitle: '科学观察验收教材', revisionId: book.revision.id,
        sectionPath: items[0].source.sectionPath, sourceBlockIds: items.map(item => item.source.sourceBlockId) };
      return { revisionId: book.revision.id, sourceBlocks: items.length };
    });
    mkdirSync(env.CLASSROOM_DATA_DIR, { recursive: true });
    await check('real-lecture-audio-preparation', async () => {
      const config = await request(teacherContext, 'GET', '/api/openmaic/provider-config?section=tts');
      const [providerId, provider] = Object.entries(config.providers).find(([id, item]) => id !== 'browser-native-tts' && item.enabled !== false && item.hasApiKey) ?? [];
      assert.ok(providerId, 'No real TTS provider configured');
      for (const scene of fixture.classroom.scenes) for (const speech of scene.actions.filter(item => item.type === 'speech')) {
        const generated = await teacherContext.request.post(`${origin}/api/openmaic/generate/tts`, { headers: { Origin: origin }, timeout: 180000,
          data: { audioId: randomUUID(), text: speech.text, ttsProviderId: providerId,
            ttsVoice: provider.defaultVoice || provider.scenarioConfigs?.['realtime-interaction']?.voiceId,
            ttsModelId: provider.defaultModel || provider.models?.[0] } });
        const body = await generated.json(); assert.equal(generated.status(), 200, JSON.stringify(body).slice(0, 300));
        const data = body.data ?? body; const bytes = Buffer.from(data.base64, 'base64'); assert.ok(bytes.length > 500);
        const filename = `${speech.id}.${data.format || 'wav'}`;
        const folder = path.join(env.CLASSROOM_DATA_DIR, classroomId, 'audio'); mkdirSync(folder, { recursive: true });
        writeFileSync(path.join(folder, filename), bytes);
        speech.audioUrl = `/api/openmaic/classroom-media/${classroomId}/audio/${filename}`;
        // Read actual decoded duration; do not insert an estimated timing.
        const page = await teacherContext.newPage(); await page.goto(`${origin}/teacher/classes`);
        speech.audioDurationSec = await page.evaluate(async url => {
          const audio = new Audio(url); await new Promise((resolve, reject) => { audio.onloadedmetadata = resolve; audio.onerror = () => reject(new Error('Cannot decode generated speech')); });
          return audio.duration;
        }, `data:audio/${data.format || 'wav'};base64,${data.base64}`); await page.close();
        assert.ok(Number.isFinite(speech.audioDurationSec) && speech.audioDurationSec > 0);
      }
    }, 'real-provider-api');
    writeFileSync(path.join(env.CLASSROOM_DATA_DIR, `${classroomId}.json`), JSON.stringify(fixture.classroom));
    report.resourceFingerprint = sha(JSON.stringify(fixture)); save('learning-fixture.json', fixture);
    const template = await request(teacherContext, 'POST', '/api/platform/templates', { title: '整课验收模板', snapshot: { schemaVersion: 2, kind: 'pbl-course', design: {
      name: '科学观察完整课堂验收', subject: '科学', grade: '七年级', hours: 2,
      stages: stages.map(([key, label, view]) => ({ key, label, view, description: label })),
      drivingQuestion: '如何依据公平比较和可复查证据提出结论？', expectedOutcome: '有记录支撑的观察报告',
      pblConfig: { makeArtifactMode: 'document' }, aiLearningClassroomId: classroomId, content: fixture.designContent,
    } } }, 201);
    const experiment = experimentTemplates.createCoTeachAssessmentTemplate();
    activity = (await request(teacherContext, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
      type: 'Classroom', title: '完整五阶段课堂', templateVersionId: template.versions[0].id,
      config: { schemaVersion: 1, experiment },
    }, 201)).activity;
    await request(teacherContext, 'PATCH', `/api/platform/activities/${activity.id}`, { isOpen: true });
    instance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: activity.id } });
    report.instanceId = instance.id; report.offeringId = offering.id; checkpoint(report);
    await request(teacherContext, 'POST', `/api/platform/classroom-instances/${instance.id}/start`, {});
    const edgeExecutable = process.env.PRELAUNCH_EDGE_EXECUTABLE_PATH || path.join(root, '.cache/browsers/edge/opt/microsoft/msedge/msedge');
    const edge = await chromium.launch({ executablePath: edgeExecutable }); browsers.push(edge);
    for (let index = 0; index < studentCount; index++) {
      const label = index < Math.ceil(studentCount / 2) ? 'google-chrome' : 'microsoft-edge';
      const context = await (label === 'google-chrome' ? browser : edge).newContext({ viewport: { width: 1366, height: 768 } });
      await context.addInitScript(() => { if (location.protocol !== 'about:') localStorage.setItem('locale', 'zh-CN'); });
      if (!report.browserCounts[label]) report[label] = await inspectBrowserIdentity({ label,
        executablePath: label === 'google-chrome' ? process.env.PRELAUNCH_E2E_EXECUTABLE_PATH : edgeExecutable }, context);
      report.browserCounts[label]++; watch(context, `student-${index}`);
      const username = `acceptance-student-${sequence}-${index}`;
      await request(context, 'POST', '/api/platform/auth/register', { invitationCode: invitation.code, username, displayName: `验收学生${index}`, password, confirmPassword: password }, 201);
      const user = await db.user.findFirstOrThrow({ where: { username } });
      students.push({ context, page: await context.newPage(), index, user, label });
    }
    await all(students.map(student => assessment(student, 'pretest')));
    await all(students.map(async student => { student.participation = (await request(student.context, 'POST', `/api/platform/classroom-instances/${instance.id}/enter`, {})).participation; }));
    await runPreparationAcceptance({ teacher, students, template, instance, fixture, offering, chapter,
      origin, db, request, record, output, classroomDataDir: env.CLASSROOM_DATA_DIR });
    const pdf = await PDFDocument.create(); for (const title of ['SAME OBSERVATION DURATION', 'RECORD THE EVIDENCE']) pdf.addPage([960, 540]).drawText(title, { x: 40, y: 350, size: 30 });
    const pdfBytes = Buffer.from(await pdf.save());
    const upload = await teacherContext.request.post(`${origin}/api/uploads`, { multipart: {
      file: { name: 'acceptance-slides.pdf', mimeType: 'application/pdf', buffer: pdfBytes },
      title: '整课验收两页课件', courseId: instance.id, stageKey: 'launch', bindAsCourseResource: 'true', pdfDisplayMode: 'slides',
    }, headers: { Origin: origin } }); assert.equal(upload.status(), 201, await upload.text());
    await teacher.page.goto(`${origin}/teacher/teach/${instance.id}/classroom`, { waitUntil: 'domcontentloaded' });
    await all(students.map(student => student.page.goto(`${origin}/student/classroom/${instance.id}`, { waitUntil: 'domcontentloaded' })));
    await waitFor(() => socketClients.size === studentCount + 1, 'Not every browser subscribed to real WebSocket', 60000);
    record('roster', '通过', `${studentCount + 1} independent authenticated browser contexts with real WebSocket subscriptions`);
    const lectureStart = Date.now();
    report.startedAt = new Date(lectureStart).toISOString();
    continuityTimer = setInterval(() => { void sampleContinuity().catch(error => record('browser-continuity', '失败', error.message)); }, 15000);
    await phase(0, async end => {
      await teacher.page.getByRole('button', { name: /^(同步到学生|投屏)$/ }).filter({ visible: true }).first().click();
      await all(students.map(student => student.page.locator('[data-teacher-resource-projection] canvas[aria-label="PPT 第 1 页"]').waitFor({ timeout: 60000 })));
      const references = {};
      for (const brand of ['google-chrome', 'microsoft-edge']) {
        const page = students.find(student => student.label === brand)?.page;
        if (!page) continue;
        await page.waitForFunction(() => document.querySelector('[data-teacher-resource-projection] canvas')?.width > 300);
        references[brand] = await page.evaluate(async base64 => {
          const pdfjs = await import('/vendor/pdfjs/pdf.legacy.min.mjs');
          pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.legacy.min.mjs';
          const documentPdf = await pdfjs.getDocument({ data: Uint8Array.from(atob(base64), c => c.charCodeAt(0)) }).promise;
          const reference = {};
          const width = document.querySelector('[data-teacher-resource-projection] canvas').width;
          for (let number = 1; number <= 2; number++) {
            const pdfPage = await documentPdf.getPage(number);
            const viewport = pdfPage.getViewport({ scale: width / pdfPage.getViewport({ scale: 1 }).width });
            const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
            const context = canvas.getContext('2d');
            await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
            const hash = await crypto.subtle.digest('SHA-256', context.getImageData(0, 0, canvas.width, canvas.height).data);
            reference[number] = { width: canvas.width, height: canvas.height, hash: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('') };
          }
          await documentPdf.destroy(); return reference;
        }, pdfBytes.toString('base64'));
      }
      pdfReferences = references;
      const latencies = [];
      const flip = async pageNumber => {
        const start = performance.now();
        await teacher.page.getByRole('button', { name: pageNumber === 2 ? '下一页' : '上一页', exact: true }).filter({ visible: true }).first().click();
        await all(students.map(async student => {
          await student.page.waitForFunction(async ({ number, reference }) => {
            const canvas = document.querySelector(`[data-teacher-resource-projection] canvas[aria-label="PPT 第 ${number} 页"]`);
            if (!canvas || canvas.width !== reference.width || canvas.height !== reference.height) return false;
            const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
            if ([...bytes].map(value => value.toString(16).padStart(2, '0')).join('') !== reference.hash) return false;
            await new Promise(requestAnimationFrame); return true;
          }, { number: pageNumber, reference: references[student.label][pageNumber] }, { timeout: 15000, polling: 100 });
          latencies.push({ student: student.index, elapsedMs: performance.now() - start });
        }));
      };
      await flip(2); await flip(1);
      let pageNumber = 1;
      await hold(end, async () => { pageNumber = pageNumber === 1 ? 2 : 1; await flip(pageNumber); });
      save('projection-render-timings.json', latencies);
      record('projection-render-latency', latencies.every(item => item.elapsedMs <= 1000) ? '通过' : '失败', { maxMs: Math.max(...latencies.map(item => item.elapsedMs)), samples: latencies.length });
      await teacher.page.getByRole('button', { name: /^(停止同步|停止投屏|结束投屏)$/ }).filter({ visible: true }).first().click();
      await all(students.map(student => student.page.locator('[data-teacher-resource-projection]').waitFor({ state: 'detached', timeout: 15000 })));
    });
    await phase(1, async end => {
      learningEvidence = await runLearningAcceptance({ teacher, students, instance, classroomId, origin, db, request, record, output, realAi: true, fixture, observeAiAdmission });
      await check('real-public-discussion', async () => {
        const first = report.checks.length;
        await runPublicDiscussion({ teacher, students, instance, fixture, record });
        const observations = report.checks.slice(first);
        for (const name of ['real-ai-public-discussion-answer-idempotent-replay', 'real-ai-public-discussion-invited-display-observer-snapshot', 'real-ai-public-discussion-finish-summary']) {
          assert.ok(observations.some(item => item.name === name && item.status === '通过'), `Missing real discussion evidence: ${name}`);
        }
        assert.ok(observations.every(item => item.status === '通过'));
        return { realModelAnswer: true, durableSummary: true, invitedAndObserverBrowsers: true, control: 'Existing public discussion APIs; invited and observer UI verified' };
      }, 'real-provider-api');
      await hold(end, async () => { const state = await teacherState(); assert.equal(state.students.length, studentCount); });
    });
    await phase(2, async end => {
      await all(students.map(async student => {
        const observedSaves = observeSubmissionSaveReceipts(student.page, { origin, courseId: instance.id, studentId: student.user.id });
        try {
          await student.page.goto(`${origin}/student/ai-collaboration/${instance.id}`, { waitUntil: 'domcontentloaded' });
          const editor = student.page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
          await editor.waitFor({ timeout: 60000 }); await editor.fill(documentText(student));
          await student.page.getByRole('button', { name: '保存', exact: true }).click(); student.saved = await savedDocument(student);
          student.initialDocumentSaveReceipt = await confirmSubmissionSave({ page: student.page, db,
            courseId: instance.id, studentId: student.user.id, participationId: student.participation.id,
            submission: student.saved, observations: () => observedSaves.entries, marker: documentText(student) });
        } finally { await observedSaves.close(); }
      }));
      save('initial-document-save-receipts.json', students.map(student => ({ index: student.index, brand: student.label,
        ...student.initialDocumentSaveReceipt })));
      const initial = await teacherState();
      assert.equal(new Set(initial.submissions.filter(row => row.stageKey === 'make').map(row => row.studentId)).size, studentCount);
      const documentEditorEvidence = await runDocumentEditorAcceptance({ teacher, students, instance, db, request, record, output, origin });
      await check('concurrent-ai-save-projection', async () => {
        const viewingPages = students.map(student => ({ page: student.page, student }));
        const clientId = randomUUID();
        const asset = await teacherContext.request.post(`${origin}/api/uploads`, { headers: { Origin: origin }, multipart: {
          file: { name: 'practice-comparison.pdf', mimeType: 'application/pdf', buffer: pdfBytes },
          title: '实践同步核对资料', courseId: instance.id, stageKey: 'make', bindAsCourseResource: 'true', pdfDisplayMode: 'slides',
        } });
        assert.equal(asset.status(), 201); const resource = await asset.json();
        const project = async page => {
          const current = await teacherState();
          return request(teacherContext, 'POST', `/api/courses/${instance.id}/actions`, { requestId: randomUUID(),
          action: { type: 'SET_UI_STATE', payload: { courseId: instance.id, projectionControl: { clientId, takeover: true, baseStageVersion: current.stageVersion ?? 1, stageKey: current.stages[current.currentStageIndex].key },
            patch: { resourceProjection: page ? { resourceId: resource.id, stageKey: 'make', title: '实践同步核对资料', startedAt: new Date().toISOString(),
              viewState: { page, scrollRatio: 0, updatedAt: new Date().toISOString(), revision: Date.now() } } : null } } } });
        };
        let jobsPromise;
        const attempts = new Map();
        try {
          const readySignals = students.map(() => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; });
          const readyPromise = Promise.allSettled(readySignals.map(signal => signal.promise));
          const jobs = students.map(async (student, index) => {
            try {
            const { page } = student;
            // A rich-text selection opens the inline AI tool. Collapse it with
            // the same keyboard action a student uses before opening a member.
            const workspaceEditor = page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
            await workspaceEditor.press('ControlOrMeta+End');
            await page.getByRole('button', { name: 'AI 组员', exact: true }).click();
            const panel = page.getByRole('region', { name: 'AI 组员工作区', exact: true });
            const message = `学生${student.index}：请检查比较两个地点时还需要保留哪些原始证据，给出具体核验建议，不修改我的正文。`;
            await panel.locator('textarea').fill(message);
            const matchesQuestion = req => new URL(req.url()).pathname === '/api/ai-collaboration/document'
              && req.method() === 'POST' && req.postDataJSON()?.message === message;
            const sent = page.waitForRequest(matchesQuestion, { timeout: 30000 });
            const reply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ai-collaboration/document'
              && response.request().method() === 'POST' && response.request().postDataJSON()?.message === message, { timeout: 150000 });
            void sent.catch(() => undefined); void reply.catch(() => undefined);
            const requestStartedAt = performance.now();
            await panel.getByRole('button', { name: '发送给 AI 组员', exact: true }).click();
            const body = (await sent).postDataJSON();
            assert.ok(body.requestId, 'The actual browser question has no request identity');
            student.documentAiRequestId = body.requestId;
            attempts.set(student.index, { requestId: body.requestId, requestSentAt: new Date().toISOString(),
              requestBody: { requestId: body.requestId, courseId: body.courseId, studentId: body.studentId, stageKey: body.stageKey,
                conversationId: body.conversationId, message: body.message } });
            // This edit happens while the real request is in flight. Preserve
            // its original input when replaying its durable receipt below.
            const marker = `并发AI期间保留学生${student.index}的自主核验。`;
            const editor = page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
            await editor.press('ControlOrMeta+End'); await page.keyboard.insertText(marker);
            await page.getByRole('button', { name: '保存', exact: true }).click();
            await waitFor(async () => { const saved = await savedDocument(student); return (saved.payload.view ?? saved.payload).content.includes(marker); }, 'Saving during AI lost a student edit');
            readySignals[index].resolve();
            const response = await reply;
            attempts.get(student.index).firstStatus = response.status();
            assert.ok([200, 202].includes(response.status()), await response.text());
            assert.deepEqual(response.request().postDataJSON(), body);
            const startedAt = performance.now();
            let result = await response.json();
            while (result.status === 'processing' && performance.now() - startedAt < 125000) {
              await delay(1000);
              result = await request(student.context, 'GET', `/api/ai-collaboration/document?${new URLSearchParams({ courseId: instance.id, studentId: student.user.id, stageKey: 'make', requestId: body.requestId })}`);
            }
            assert.equal(result.status, 'completed', JSON.stringify(result).slice(0, 250));
            const completeMs = performance.now() - requestStartedAt;
            assert.ok(completeMs <= 120000, 'Document AI browser completion exceeded 120 seconds');
            const task = await db.aiTask.findFirstOrThrow({ where: { createdById: student.user.id, input: { path: ['requestId'], equals: body.requestId } } });
            const serverMs = task.completedAt - task.startedAt;
            assert.ok(task.startedAt && task.completedAt && serverMs >= 0 && serverMs <= 110000, 'Document AI server exceeded 110 seconds');
            const replay = await request(student.context, 'POST', '/api/ai-collaboration/document', body);
            assert.equal(replay.requestId, body.requestId); assert.equal(replay.status, 'completed');
            const answerId = result.messages?.find(message => message.role === 'agent')?.id;
            assert.ok(answerId, 'The completed answer lacks its durable message identity');
            await expect(panel.locator(`article[id="${answerId}"]`)).toBeAttached({ timeout: 30000 });
            for (const name of ['保留原文', '暂不采用']) {
              const decision = panel.getByRole('button', { name, exact: true }); if (await decision.isVisible()) await decision.click();
            }
            await panel.getByRole('button', { name: '收起 AI 组员', exact: true }).click();
            student.documentAiBrowserCompleted = true;
            return { student: student.index, requestId: body.requestId, conversationId: result.conversationId, editRetained: true,
              completeMs, firstResponseMs: startedAt - requestStartedAt, serverMs, taskTimestampDeltaMs: task.startedAt - task.createdAt,
              taskCreatedAt: task.createdAt, taskStartedAt: task.startedAt, taskCompletedAt: task.completedAt };
            } catch (error) {
              const contextual = new Error(`Student ${student.index} (${student.user.id}): ${error.message}`, { cause: error });
              readySignals[index].reject(contextual);
              await student.page.screenshot({ path: path.join(output, `concurrent-ai-failure-${student.index}.png`) }).catch(() => undefined);
              throw contextual;
            }
          });
          jobsPromise = Promise.allSettled(jobs);
          const ready = await readyPromise;
          assert.ok(ready.every(result => result.status === 'fulfilled'), ready.filter(result => result.status === 'rejected').map(result => String(result.reason)).join('\n'));
          const runningAtProjection = await db.aiTask.count({ where: { status: 'RUNNING', taskType: 'DOCUMENT_COLLABORATION',
            OR: [...attempts.values()].map(attempt => ({ input: { path: ['requestId'], equals: attempt.requestId } })), createdById: { in: students.map(student => student.user.id) },
            conversation: { participation: { instanceId: instance.id } } } });
          assert.ok(runningAtProjection > 0, 'The projection must start while actual AI work is still running');
          await project(1);
          await all(viewingPages.map(({ page }) => page.locator('[data-teacher-resource-projection] canvas[aria-label="PPT 第 1 页"]').waitFor({ timeout: 30000 })));
          // Waiters start before the teacher update; successful polling cannot
          // stand in for the corresponding visible PDF in each browser.
          const render = viewingPages.map(async ({ page, student }) => {
            const reference = pdfReferences[student.label][2];
            await page.waitForFunction(async reference => {
              const canvas = document.querySelector('[data-teacher-resource-projection] canvas[aria-label="PPT 第 2 页"]');
              if (!canvas || canvas.width !== reference.width || canvas.height !== reference.height) return false;
              const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
              const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', pixels));
              return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('') === reference.hash;
            }, reference, { timeout: 30000, polling: 100 });
          });
          const outcomesPromise = Promise.allSettled(render);
          await delay(1000); await project(2);
          const renderOutcomes = await outcomesPromise;
          await project(null); // restore workspace controls while the real AI jobs finish.
          const outcomes = [...await jobsPromise, ...renderOutcomes];
          const failures = outcomes.filter(item => item.status === 'rejected');
          assert.equal(failures.length, 0, failures.map(item => String(item.reason)).join('\n'));
          save('concurrent-ai-save-projection.json', outcomes.slice(0, studentCount).map(item => ({ ...item.value, runningAtProjection })));
          return `${studentCount} simultaneous real document AI requests, edits saved during requests, and full PDF pixels checked in the same student workspaces`;
        } finally {
          // A readiness/render failure must not leave real requests running
          // into final submission or the next stage. Restore controls first.
          const cleanup = await Promise.allSettled([project(null)]);
          const jobs = jobsPromise ? await jobsPromise : [];
          save('concurrent-ai-save-projection-attempts.json', jobs.map((item, index) => ({ student: students[index].index, ...attempts.get(students[index].index),
            status: item.status, ...(item.status === 'fulfilled' ? item.value : { error: String(item.reason.stack ?? item.reason) }) })));
          await Promise.allSettled(students.map(async student => {
            const panel = student.page.getByRole('region', { name: 'AI 组员工作区', exact: true });
            const close = panel.getByRole('button', { name: '收起 AI 组员', exact: true });
            if (await close.isVisible()) await close.click();
          }));
          const failure = cleanup.find(item => item.status === 'rejected');
          if (failure) throw failure.reason;
        }
      });
      await runDocumentAiAcceptance({ students, instance, origin, db, request, record, output });
      let revision = 0;
      await hold(end, async () => {
        revision++;
        await all(students.map(async student => {
          const marker = `第${revision}轮记录核对${student.index}。`;
          const previous = await savedDocument(student);
          const editor = student.page.locator('[data-slate-editor="true"][contenteditable="true"]').first();
          await editor.press('ControlOrMeta+End'); await student.page.keyboard.insertText(marker);
          await student.page.getByRole('button', { name: '保存', exact: true }).click();
          student.saved = await waitFor(async () => {
            const saved = await savedDocument(student);
            const view = saved.payload?.view ?? saved.payload;
            return view.content.includes(marker) && saved.updatedAt.getTime() > previous.updatedAt.getTime() ? saved : null;
          }, 'A sustained document revision has no server acknowledgement');
        }));
      });
      const artifactEvidence = { expectedStudents: studentCount, students: students.map(student => ({
        index: student.index, userId: student.user.id, finalization: { status: 'pending' }, restore: { status: 'pending' },
      })) };
      const saveArtifactEvidence = () => save('artifact-reconciliation.json', artifactEvidence);
      saveArtifactEvidence();
      await check('artifact-reconciliation', async () => {
        const finalizations = await Promise.allSettled(students.map(async (student, index) => {
          const row = artifactEvidence.students[index];
          student.artifactReconciled = false;
          try {
            const submitted = student.page.waitForResponse(response => new URL(response.url()).pathname === '/api/project-practice/submissions/finalize'
              && response.request().method() === 'POST', { timeout: 30000 });
            void submitted.catch(() => undefined);
            await student.page.getByRole('button', { name: '提交最终版', exact: true }).click();
            const acknowledgement = await submitted;
            row.acknowledgement = { at: new Date().toISOString(), status: acknowledgement.status() };
            saveArtifactEvidence();
            row.acknowledgement.receipt = await acknowledgement.json();
            saveArtifactEvidence();
            assert.equal(acknowledgement.status(), 200, `Student ${student.index} Word finalization failed: ${JSON.stringify(row.acknowledgement.receipt)}`);
            student.saved = await savedDocument(student);
            const savedView = student.saved.payload?.view ?? student.saved.payload;
            row.saved = { id: student.saved.id, status: student.saved.status, version: savedView.version,
              updatedAt: student.saved.updatedAt, contentSha256: sha(savedView.content) };
            saveArtifactEvidence();
            const link = student.page.getByRole('link', { name: '下载第 1 版 Word', exact: true }); await link.waitFor({ timeout: 120000 });
            const response = await student.context.request.get(new URL(await link.getAttribute('href'), origin).href);
            row.download = { status: response.status() }; assert.equal(response.status(), 200);
            const bytes = await response.body(); student.artifactSha256 = sha(bytes);
            row.download = { ...row.download, bytes: bytes.length, sha256: student.artifactSha256 };
            saveArtifactEvidence();
            const zip = await JSZip.loadAsync(bytes);
            row.download.entries = Object.keys(zip.files).sort();
            const documentXml = zip.file('word/document.xml'); assert.ok(documentXml, 'Word archive has no document.xml');
            const archivedXml = await documentXml.async('string');
            row.archive = { documentXmlSha256: sha(archivedXml), hasExpectedText: archivedXml.includes(documentText(student)) };
            row.archive.tables = readAcceptanceWordTables(archivedXml);
            row.archive.hasTable = row.archive.tables.length > 0;
            const archivedImages = await Promise.all(Object.values(zip.files).filter(file => !file.dir && file.name.startsWith('word/media/'))
              .map(async file => ({ path: file.name, sha256: sha(await file.async('nodebuffer')) })));
            row.archive.images = archivedImages;
            const rich = documentEditorEvidence.students.find(item => item.index === student.index && item.studentId === student.user.id);
            row.richInput = { restoredWithoutLocalDraft: rich?.restoredWithoutLocalDraft === true,
              tableAcknowledged: Boolean(rich?.savedHtml?.includes('<table') && rich?.finalStructure?.tables?.length),
              expectedTables: rich?.finalStructure?.tables ?? null,
              imageSha256: student.richDocumentImageSha256 ?? null, originalError: rich?.error ?? null };
            const failures = [];
            if (!rich || rich.error || !row.richInput.restoredWithoutLocalDraft || !row.richInput.tableAcknowledged || !row.richInput.imageSha256) {
              failures.push('RICH_EDIT_PRECONDITION_INCOMPLETE: 前置编辑未完成；不能将尚未确认插入/保存的表格或图片诊断为归档丢失');
            }
            if (student.saved.status !== 'SUBMITTED') failures.push('FINAL_SUBMISSION_NOT_RETAINED: 成功提交回执后的服务器状态不是 SUBMITTED');
            if (!row.archive.hasExpectedText) failures.push('WORD_TEXT_PERSISTENCE_MISSING: 已保存的原始正文未出现在下载文档');
            if (row.richInput.tableAcknowledged) {
              try {
                assert.deepEqual(row.archive.tables, row.richInput.expectedTables,
                  `Student ${student.index} Word table count, row/column dimensions, cell order or text differs from the saved rich document`);
                row.archive.tableReconciled = true;
              } catch (error) {
                row.archive.tableReconciled = false;
                failures.push(`WORD_TABLE_PERSISTENCE_MISMATCH: 已确认保存的表格行列或文字在下载文档中缺失/变化: ${error.message}`);
              }
            }
            if (row.richInput.imageSha256 && !archivedImages.some(image => image.sha256 === row.richInput.imageSha256)) {
              failures.push('WORD_IMAGE_PERSISTENCE_MISSING: 已确认保存的图片字节未出现在下载文档');
            }
            row.finalization.failures = failures;
            assert.equal(failures.length, 0, `Student ${student.index}: ${failures.join('; ')}`);
            row.finalization.status = 'passed';
          } catch (error) {
            row.finalization.status = 'failed'; row.finalization.error = String(error.stack ?? error); throw error;
          } finally { saveArtifactEvidence(); }
        }));
        // Restore every available acknowledged document, even if its rich input
        // or Word check failed. A restore alone cannot satisfy the rich gate.
        const restores = await Promise.allSettled(students.map(async (student, index) => {
          const row = artifactEvidence.students[index];
          try {
            const submission = student.saved?.id
              ? await db.classroomSubmission.findUniqueOrThrow({ where: { id: student.saved.id } })
              : await savedDocument(student);
            student.saved = submission;
            const savedView = submission.payload?.view ?? submission.payload;
            row.restore.source = { id: submission.id, status: submission.status, version: savedView.version, contentSha256: sha(savedView.content) };
            await removeAcknowledgedDocumentDrafts(student.page, { courseId: instance.id, studentId: student.user.id, submission });
            const freshSnapshot = student.page.waitForResponse(response => response.request().method() === 'GET'
              && new URL(response.url()).pathname === '/api/courses' && response.status() === 200, { timeout: 30000 })
              .then(response => response.json()).then(value => ({ value }), error => ({ error }));
            await student.page.reload({ waitUntil: 'domcontentloaded' });
            const fresh = await freshSnapshot;
            if (fresh.error) throw fresh.error;
            const restored = fresh.value.courses?.find(course => course.id === instance.id)?.submissions?.find(item => item.id === savedView.id
              && item.studentId === student.user.id && item.stageKey === savedView.stageKey);
            assert.equal(restored?.content, savedView.content,
              `Student ${student.index} reload did not receive the acknowledged document from the real backend`);
            await expect(student.page.locator('[data-slate-editor="true"]').first()).toContainText(documentText(student));
            row.restore.status = 'passed';
            student.artifactReconciled = row.finalization.status === 'passed';
          } catch (error) {
            row.restore.status = 'failed'; row.restore.error = String(error.stack ?? error); throw error;
          } finally { saveArtifactEvidence(); }
        }));
        const failures = [...finalizations, ...restores].filter(item => item.status === 'rejected');
        assert.equal(students.length, studentCount);
        assert.equal(failures.length, 0, failures.map(item => String(item.reason)).join('\n'));
        assert.ok(students.every(student => student.artifactReconciled === true));
        return `${studentCount} rich documents and Word archives reconciled, then restored from actual backend snapshots without acknowledged local drafts`;
      });
      const previewChecksStart = report.checks.length;
      try {
        await runTeacherArtifactPreviews({ teacher, students, instance, origin, db, request, record, output, mode: 'document' });
      } catch (error) {
        // The helper normally records its own failure. Preserve an unexpected
        // setup/cleanup exception without emitting a conflicting duplicate.
        const recorded = report.checks.slice(previewChecksStart).some(item => item.name === 'teacher-artifact-preview-document');
        record(recorded ? 'teacher-artifact-preview-document-execution' : 'teacher-artifact-preview-document',
          '失败', String(error.stack ?? error).slice(0, 2000));
      } finally {
        await check(DOCUMENT_REVIEW_SETTLEMENT_CHECK, () => runDocumentReviewSettlement({
          students, instance, db, env, traffic, output,
          onEvidence: evidence => { report.documentReviewSettlement = evidence; checkpoint(report); },
        }));
      }
    });
    await phase(3, async end => {
      await all(students.map(student => student.page.goto(`${origin}/student/classroom/${instance.id}`, { waitUntil: 'domcontentloaded' })));
      const endpoint = `/api/courses/${instance.id}/showcase/presentation`;
      const data = await request(teacherContext, 'GET', endpoint);
      assert.equal(data.students.filter(row => row.artifacts?.length).length, studentCount);
      const first = data.queue.find(row => row.groupId && row.artifacts?.some(item => item.kind === 'document'));
      assert.ok(first, 'No submitted document is ready to present');
      await request(teacherContext, 'POST', endpoint, { action: 'assign', groupId: first.groupId, studentId: first.studentId });
      const artifact = first.artifacts.find(item => item.kind === 'document');
      await teacher.page.getByRole('button', { name: '教师发起投屏', exact: true }).click();
      await waitFor(async () => (await request(teacherContext, 'GET', endpoint)).activePresentation, 'Teacher did not start a real presentation');
      const started = (await request(teacherContext, 'GET', endpoint)).activePresentation;
      assert.equal(started.artifactVersionId, artifact.versionId);
      await request(teacherContext, 'POST', endpoint, { action: 'end', presentationId: started.id });
      await request(teacherContext, 'POST', endpoint, { action: 'finish-evaluation', presentationId: started.id, note: '以可复查记录支撑结论。' });
      assert.equal(await db.showcasePresentation.count({ where: { participation: { instanceId: instance.id } } }), 1);
      await hold(end);
    });
    await phase(4, async end => {
      // First leave half as drafts: the teacher must not count these as submitted.
      const half = Math.floor(studentCount / 2);
      await all(students.slice(half).map(async student => {
        await student.page.goto(`${origin}/student/activities/${activity.id}/assessments/${instance.id}/posttest`, { waitUntil: 'domcontentloaded' });
        const first = student.page.getByRole('radio', { name: '不知道', exact: true }).first();
        await first.locator('..').click();
        await waitFor(async () => {
          const draft = await db.experimentAssessmentDraft.findFirst({ where: { phase: 'posttest', assignment: { instanceId: instance.id, enrollmentId: student.participation.enrollmentId } } });
          return draft && Object.keys(draft.answers).length === 1;
        }, 'First answer did not become a persisted posttest draft');
      }));
      await all(students.slice(0, half).map(student => assessment(student, 'posttest')));
      const resultEndpoint = `/api/platform/classroom-instances/${instance.id}/experiment/results`;
      const partial = await request(teacherContext, 'GET', resultEndpoint); save('posttest-half.json', partial);
      assert.equal(partial.posttestCount, half); assert.equal(partial.participantCount, studentCount);
      assert.equal(partial.posttestDraftCount, studentCount - half);
      assert.equal(partial.pretestCount, studentCount); assert.equal(partial.enrollmentCount, studentCount);
      assert.equal(await db.experimentAssessmentSubmission.count({ where: { instanceId: instance.id, phase: 'posttest' } }), half);
      await all(students.slice(half).map(student => assessment(student, 'posttest')));
      await all(students.map(async student => {
        const rows = await db.experimentAssessmentSubmission.findMany({ where: { instanceId: instance.id, enrollmentId: student.participation.enrollmentId } });
        assert.equal(rows.length, 2); assert.ok(rows.every(row => row.objectiveScore === 0 && row.objectiveTotal === 0));
        assert.equal(Object.keys(rows.find(row => row.phase === 'posttest').answers).length, 53);
      }));
      const complete = await request(teacherContext, 'GET', resultEndpoint);
      assert.equal(complete.posttestCount, studentCount); assert.equal(complete.posttestDraftCount, 0);
      assert.equal(complete.studentRows.filter(row => row.status === 'submitted').length, studentCount);
      await check('teacher-assessment-answer-view', async () => {
        await teacher.page.getByRole('button', { name: '刷新进度', exact: true }).filter({ visible: true }).click();
        await expect(teacher.page.getByText(`${studentCount}/${studentCount} 人已提交正式后测。草稿不计入提交人数。`, { exact: true })).toBeVisible({ timeout: 30000 });
        for (const student of students) {
          const row = teacher.page.locator(`[id="posttest-student-${student.user.id}"]`);
          await row.locator('summary').click();
          const submissions = await db.experimentAssessmentSubmission.findMany({ where: { instanceId: instance.id, enrollmentId: student.participation.enrollmentId } });
          for (const phase of ['pretest', 'posttest']) {
            const stored = submissions.find(item => item.phase === phase);
            const section = row.getByRole('region', { name: `${phase === 'pretest' ? '前测' : '后测'}正式答案`, exact: true });
            await expect(section).toBeVisible();
            const expected = stored.questionnaire[phase].map(question => {
              const value = stored.answers[question.id];
              return `学生作答：${Array.isArray(value) ? value.join('、') : value === 'true' ? '正确' : value === 'false' ? '错误' : value || '未作答'}`;
            });
            assert.deepEqual(await section.locator('p.font-medium').allTextContents(), stored.questionnaire[phase].map((question, index) => `${index + 1}. ${question.prompt}`));
            assert.deepEqual(await section.getByText(/^学生作答：/).allTextContents(), expected, 'Teacher answer display differs from durable formal answers');
            await expect(section.getByText('无计分题', { exact: true })).toBeVisible();
          }
          await row.locator('summary').click();
        }
        return { students: studentCount, pretestQuestions: 9, posttestQuestions: 53, actualUiAnswersMatchStorage: true };
      });
      record('teacher-metrics', '通过', 'Actual teacher result counts independently match half/all submissions, enrollment and participation; templates have no scored answer keys');
      await hold(end);
    });
    report.actualDurationSeconds = (Date.now() - lectureStart) / 1000;
    report.finishedAt = new Date().toISOString();
    clearInterval(continuityTimer); await continuityFlight;
    await assertProviderConfiguration();
    record('runtime-config-stability', '通过', { publicProviderConfigurationSha256: providerConfigurationSha256,
      checks: providerConfigurationChecks, observation: 'Configured model/voice/capability metadata is hashed without publishing credentials' }, 'isolated-backend');
    record('five-stage-flow', '通过', report.phaseTiming);
    if (afterSustainedClass) report.quietWindow = await afterSustainedClass(report);
    if (sustainedOnly) {
      await check('soak-classroom-finished', async () => {
        await teacher.page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).first().click();
        await teacher.page.getByRole('button', { name: '结束课堂', exact: true }).filter({ visible: true }).first().click();
        await teacher.page.getByRole('alertdialog').getByRole('button', { name: '结束课堂', exact: true }).click();
        await waitFor(async () => (await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).status === 'FINISHED');
        return { sequence, withoutRestart: true };
      });
      return report;
    }
    report.phase = 'recovery'; injected = true;
    await check('recovery', async () => {
      const offline = students.at(-1); await offline.context.setOffline(true); await disconnectSockets();
      const offlineStarted = Date.now();
      await delay(process.env.CLASSROOM_ACCEPTANCE_SMOKE === '1' ? 1000 : 60000);
      await offline.context.setOffline(false);
      const offlineSeconds = (Date.now() - offlineStarted) / 1000;
      await offline.page.reload({ waitUntil: 'domcontentloaded' });
      await offline.page.getByText('后测已提交，答案已保存到本次课堂记录。', { exact: true }).waitFor({ timeout: 30000 });
      const before = await db.classroomSubmission.findMany({ where: { participation: { instanceId: instance.id } }, orderBy: { id: 'asc' } });
      await restart();
      await teacher.page.reload({ waitUntil: 'domcontentloaded' });
      const after = await db.classroomSubmission.findMany({ where: { participation: { instanceId: instance.id } }, orderBy: { id: 'asc' } });
      assert.deepEqual(after, before);
      return { offlineSeconds, shortenedSmoke: process.env.CLASSROOM_ACCEPTANCE_SMOKE === '1', isolatedRestart: true, confirmedSubmissionsUnchanged: true };
    });
    injected = false;
    report.phase = 'research-export-sources';
    await runResearchSourceAcceptance({ teacher, students, instance, offering, chapter, db, request, record, output });
    report.phase = 'finish-and-export';
    await check('finish-and-export', async () => {
      await teacher.page.getByRole('button', { name: '全屏授课', exact: true }).filter({ visible: true }).first().click();
      await teacher.page.getByRole('button', { name: '结束课堂', exact: true }).filter({ visible: true }).first().click();
      await teacher.page.getByRole('alertdialog').getByRole('button', { name: '结束课堂', exact: true }).click();
      await waitFor(async () => (await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).status === 'FINISHED');
      const types = ['events', 'submissions', 'experiments', 'outcomes', 'ai', 'domain'];
      const until = new Date();
      const enrollmentRows = await db.enrollment.findMany({ where: { offeringId: offering.id, userId: { in: students.map(student => student.user.id) } } });
      assert.equal(enrollmentRows.length, studentCount);
      const researchKeys = enrollmentRows.map(row => row.researchKey);
      const coverage = [];
      for (const type of types) {
        const rows = []; const cursors = new Set(); let cursor; let pageCount = 0;
        do {
          // One first row forces a real cursor for every nonempty roster;
          // later pages use the public maximum to avoid excessive observer load.
          const query = new URLSearchParams({ type, take: pageCount ? '500' : '1', includeContent: 'true', until: until.toISOString(), ...(cursor ? { cursor } : {}) });
          const page = await request(teacherContext, 'GET', `/api/platform/offerings/${offering.id}/research-export?${query}`);
          assert.equal(page.type, type); assert.equal(page.window.until, until.toISOString());
          assert.ok(Array.isArray(page.rows), 'Export omitted rows');
          rows.push(...page.rows); pageCount++; cursor = page.nextCursor;
          if (cursor) { assert.ok(!cursors.has(cursor), 'Export repeated a cursor'); cursors.add(cursor); }
        } while (cursor);
        save(`export-${type}.json`, rows);
        if (type === 'experiments') assert.equal(rows.length, studentCount * 2);
        const model = { events: 'learningEvent', submissions: 'activitySubmission', experiments: 'experimentAssessmentSubmission',
          outcomes: 'domainEvent', ai: 'aiInteractionEvent', domain: 'domainEvent' }[type];
        const where = type === 'submissions' ? { enrollment: { offeringId: offering.id }, activity: { chapter: { offeringId: offering.id } }, submittedAt: { lte: until } }
          : type === 'experiments' ? { instance: { activity: { chapter: { offeringId: offering.id } } }, enrollment: { offeringId: offering.id }, submittedAt: { lte: until } }
            : { offeringId: offering.id, [type === 'events' ? 'receivedAt' : 'createdAt']: { lte: until }, ...(type === 'outcomes' ? { eventType: { startsWith: 'CLASSROOM_' } } : {}) };
        const expected = await db[model].findMany({ where });
        const typeCoverage = assertNonemptyResearchExport({ type, rows, expected, pageCount, researchKeys });
        for (const row of rows) {
          const saved = expected.find(item => item.id === row.id);
          assertResearchExportRowContent(type, row, saved);
        }
        coverage.push(typeCoverage);
        save('export-coverage.json', { until: until.toISOString(),
          scope: 'Offering-level exports include the normal classroom and separately identified supplemental Assignment/reflection records', types: coverage });
      }
      return { detail: 'Six nonempty export types follow real cursors and reconcile every enrolled identity and required content field against the database', coverage };
    });
    const studentManifest = [];
    await check('process-data-reconciliation', async () => {
      assert.equal(await db.classroomParticipation.count({ where: { instanceId: instance.id } }), studentCount);
      const state = await teacherState();
      for (const student of students) {
        const [submission, pretest, posttest, workspace, processEvents, tasks] = await Promise.all([
          db.classroomSubmission.findFirst({ where: { participationId: student.participation.id, stageKey: 'make:document' } }),
          db.experimentAssessmentSubmission.findFirst({ where: { instanceId: instance.id, enrollment: { userId: student.user.id }, phase: 'pretest' } }),
          db.experimentAssessmentSubmission.findFirst({ where: { instanceId: instance.id, enrollment: { userId: student.user.id }, phase: 'posttest' } }),
          db.studentProjectWorkspace.findUnique({ where: { participationId: student.participation.id } }),
          db.learningEvent.findMany({ where: { userId: student.user.id, classroomInstanceId: instance.id }, select: { participationId: true, idempotencyKey: true } }),
          db.aiTask.findMany({ where: { createdById: student.user.id, conversation: { participationId: student.participation.id } },
            select: { id: true, taskType: true, status: true, input: true } }),
        ]);
        const quiz = workspace?.projectState?.aiLearningProgress?.knowledgeLectureAttempts?.filter(item => item.quizOutlineId === fixture.quizOutlineId) ?? [];
        const teacherQuiz = state.aiLearningProgress?.[student.user.id]?.knowledgeLectureAttempts?.filter(item => item.quizOutlineId === fixture.quizOutlineId) ?? [];
        const expectedScore = [5, 2, 0][Math.min(2, Math.floor(student.index * 3 / studentCount))];
        const chat = learningEvidence?.chat.find(item => item.studentId === student.user.id);
        const personalTutor = selectVerifiedTutorTask(tasks, learningEvidence?.tutorFollowups,
          { studentId: student.user.id, courseId: instance.id });
        const personalAudio = learningEvidence?.tutorAudio?.find(item => item.studentId === student.user.id
          && item.taskId === personalTutor?.id && item.requestId === personalTutor?.input.requestId);
        const documentAi = tasks.find(task => task.input?.requestId === student.documentAiRequestId);
        const row = { index: student.index, userId: student.user.id, participationId: student.participation.id,
          pretestId: pretest?.id, pretestAnswers: Object.keys(pretest?.answers ?? {}).length,
          posttestId: posttest?.id, posttestAnswers: Object.keys(posttest?.answers ?? {}).length,
          quizAttemptId: quiz[0]?.id, expectedQuizScore: expectedScore, quizScore: quiz[0]?.score,
          teacherQuizScore: teacherQuiz[0]?.score, quizFullScore: quiz[0]?.maxScore,
          submissionId: submission?.id, documentStatus: submission?.status, artifactSha256: student.artifactSha256, artifactReconciled: student.artifactReconciled === true,
          retainedProcessEvents: processEvents.length, privateChatRequestId: chat?.requestId,
          personalTutorStatus: personalTutor?.status, documentAiRequestId: student.documentAiRequestId, documentAiStatus: documentAi?.status,
          personalTutorAudioStatus: personalAudio?.status, personalTutorAudioSha256: personalAudio?.sha256,
          aiTasks: tasks.length, failedAiTasks: tasks.filter(task => task.status === 'FAILED').length, completedAiTasks: tasks.filter(task => task.status === 'COMPLETED').length };
        const errors = [];
        const verify = (condition, message) => { if (!condition) errors.push(message); };
        verify(submission?.participationId === student.participation.id && submission?.status === 'SUBMITTED', 'Final document is not durably submitted for its owner');
        verify(row.artifactReconciled, 'Rich editing, downloaded Word content and backend restore have not all reconciled');
        verify(row.pretestAnswers === 9 && row.posttestAnswers === 53, 'Assessment answer counts differ from the configured templates');
        verify(quiz.length === 1 && teacherQuiz.length === 1 && quiz[0].id === teacherQuiz[0].id
          && quiz[0].score === expectedScore && teacherQuiz[0].score === expectedScore && quiz[0].maxScore === 5,
        'Independent quiz score/identity does not match student DB and teacher data');
        verify(processEvents.length > 0 && processEvents.every(event => event.participationId === student.participation.id), 'Process records are absent or assigned to another participation');
        const eventKeys = processEvents.map(event => event.idempotencyKey).filter(Boolean);
        verify(eventKeys.length === new Set(eventKeys).size, 'Process event retry created duplicate keys');
        verify(Boolean(chat), 'Live private chat and its saved answer have not reconciled');
        verify(personalTutor?.status === 'COMPLETED' && learningEvidence?.tutorFollowups?.some(item => item.studentId === student.user.id),
          'The personal tutor has not completed and reconciled in the real browser');
        verify(personalAudio?.status === 'passed' && personalAudio.sha256 && personalAudio.events?.some(event => event.type === 'ended'),
          'The personal tutor audio has not completed real native playback for its owner');
        verify(documentAi?.status === 'COMPLETED' && student.documentAiBrowserCompleted,
          'The document question has not completed all live browser/receipt/DB checks');
        studentManifest.push({ ...row, status: errors.length ? '失败' : '通过', errors: errors.join('; ') });
      }
      save('student-manifest.json', studentManifest);
      assert.ok(studentManifest.every(row => row.status === '通过'), JSON.stringify(studentManifest.filter(row => row.status !== '通过')));
      return `${studentCount} students reconciled individually: 9/53 assessment answers, independent quiz scores, teacher data, documents/download hashes, chat identities and process ownership`;
    });
    if (!studentManifest.length) save('student-manifest.json', students.map(student => ({ index: student.index, userId: student.user.id,
      participationId: student.participation?.id, status: '未验证', errors: 'Reconciliation could not reach this student' })));
    report.phase = 'artifact-modes';
    await runArtifactModesAcceptance({ teacher, students, offering, chapter, origin, db, request, record, output });
    report.phase = 'save-recovery'; injected = true;
    await check('draft-save-recovery-fixture', async () => {
      // Fault injection runs after the normal classroom in its own instance,
      // preserving main-course documents, archives and frozen student hashes.
      const recoveryActivity = (await request(teacherContext, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
        type: 'Classroom', title: '保存回执恢复专项', templateVersionId: template.versions[0].id,
      }, 201)).activity;
      await request(teacherContext, 'PATCH', `/api/platform/activities/${recoveryActivity.id}`, { isOpen: true });
      const recoveryInstance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: recoveryActivity.id } });
      await request(teacherContext, 'POST', `/api/platform/classroom-instances/${recoveryInstance.id}/start`, {});
      await request(teacherContext, 'POST', `/api/courses/${recoveryInstance.id}/actions`, {
        requestId: randomUUID(), action: { type: 'SET_STAGE', payload: { id: recoveryInstance.id, index: 2 } },
      });
      const representatives = [];
      try {
        for (const brand of ['google-chrome', 'microsoft-edge']) {
          const source = students.find(student => student.label === brand);
          const participation = (await request(source.context, 'POST', `/api/platform/classroom-instances/${recoveryInstance.id}/enter`, {})).participation;
          const representative = { ...source, participation };
          await prepareSaveRecoveryDocument({ student: representative, instance: recoveryInstance, db, origin, output });
          representatives.push(representative);
        }
        const recovery = await runClassroomSaveRecovery({ teacher, students: representatives, instance: recoveryInstance, db, origin, record, output });
        const concurrency = await runClassroomSaveConcurrency({ students: representatives, instance: recoveryInstance, db, origin, record, output, watch });
        return { recovery, concurrency };
      } finally {
        await request(teacherContext, 'POST', `/api/courses/${recoveryInstance.id}/actions`, {
          requestId: randomUUID(), action: { type: 'END_TEACHING', payload: { id: recoveryInstance.id } },
        });
      }
    });
    injected = false;
    report.phase = 'grading';
    await runGradingAcceptance({ teacher, students, offering, chapter, origin, env, db, request, record, output });
    report.phase = 'write-close-race';
    await runCloseRaceAcceptance({ teacher, students, offering, chapter, origin, db, request, record, output });
    report.phase = 'resource-media';
    await runResourceMediaAcceptance({ teacher, students, instance, offering, chapter, origin, db, request, record, output, browser });
    report.phase = 'chat-recovery';
    await runLectureChatRecoveryAcceptance({ teacher, students, offering, chapter, classroomId, fixture, origin, db, request, record, output });
    report.phase = 'event-volume';
    await runEventVolumeAcceptance({ teacher, students, instance, offering, origin, db, request, record, output });
    report.phase = 'final-exports';
    await runCompleteExportsAcceptance({ teacher, students, instance, offering, origin, db, request, record, output });
    report.phase = 'final-backup-restore'; injected = true;
    const verifiedRestore = await check('final-backup-restore', async () => {
      // Stop browser producers before the last snapshot. backupRestore then
      // stops only this isolated application so source rows/files stay fixed.
      await all([...students.map(student => student.page.close()), teacher.page.close()]);
      const restored = await backupRestore();
      try {
        const models = Object.values(Prisma.ModelName);
        assert.ok(models.length > 0, 'Generated database models are unavailable');
        const tables = [];
        for (const name of models) {
          const model = name[0].toLowerCase() + name.slice(1);
          const [target, source] = await Promise.all([restored[model].findMany(), db[model].findMany()]);
          const sourceHash = sha(json(source.map(row => json(row)).sort()));
          const restoredHash = sha(json(target.map(row => json(row)).sort()));
          assert.equal(restoredHash, sourceHash, `${name} restored content changed`);
          tables.push({ model: name, records: source.length, sha256: sourceHash, restoredSha256: restoredHash });
        }
        const manifests = {};
        for (const [name, directory] of Object.entries({ uploads: env.UPLOAD_DIR, classrooms: env.CLASSROOM_DATA_DIR, whiteboards: env.WHITEBOARD_DATA_DIR, 'ai-audit-outbox': env.AI_AUDIT_OUTBOX_DIR })) {
          const original = fileManifest(directory);
          assert.deepEqual(fileManifest(path.join(path.dirname(env.UPLOAD_DIR), 'restored-files', name)), original);
          manifests[name] = original;
        }
        save('restored-database-manifest.json', tables);
        save('restored-file-manifest.json', manifests);
        return { allPrismaModels: tables.length, totalRows: tables.reduce((sum, table) => sum + table.records, 0),
          includes: 'Main classroom, all supplementary artifact/assessment/discussion/media scopes and encrypted global configuration',
          sourceQuiesced: true, files: Object.values(manifests).reduce((sum, files) => sum + files.length, 0) };
      } finally { await restored.$disconnect(); }
    }, 'isolated-backend');
    await check('restored-application-login-history-media', async () => {
      assert.equal(verifiedRestore?.sourceQuiesced, true, 'Restored runtime requires successful database and file reconciliation');
      assert.equal(typeof bootRestored, 'function', 'Restored application boot is unavailable');
      await bootRestored();
      return verifyRestoredClassroom({ browser, origin, password, instance, students, fixture, output });
    }, 'browser-real-backend');

  } finally {
    clearInterval(continuityTimer); await continuityFlight;
    // Close the clients before draining response bodies: a live streaming or
    // media response may stay open until its owner is closed.
    report.phase = 'cleanup'; injected = true;
    await Promise.allSettled(students.map(student => student.context.close()));
    await teacherContext.close();
    for (const extra of browsers) await extra.close();
    await Promise.race([all([...pending]), delay(10000)]);
    if (pending.size) record('traffic-drain', '未验证', `${pending.size} responses did not finish after client shutdown`);
    save('browser-traffic.json', traffic); save('browser-errors.json', errors); save('resource-snapshots.json', snapshots);
    report.tutorUiRecoveries = learningEvidence?.tutorRecoveries ?? [];
    report.aiHttpTransport = Object.fromEntries(stages.map(([phase]) => [phase,
      summarizeClassroomAiTraffic(traffic, phase, { tutorUiRecoveries: report.tutorUiRecoveries, documentReviewSettlement: report.documentReviewSettlement })]));
    save('ai-http-transport.json', report.aiHttpTransport);
    for (const [phase, operations] of Object.entries(report.aiHttpTransport)) for (const [operation, metric] of Object.entries(operations)) {
      if (metric.completedResponses || metric.unrecoveredFailures) record(`ai-http-${phase}-${operation}`, metric.unrecoveredFailures ? '失败' : '通过', metric, 'browser-real-backend');
    }
    for (const phase of CLASSROOM_PERFORMANCE_PHASES) {
      report.metrics[phase] = summarizeClassroomTraffic(traffic, phase);
      for (const [operation, metrics] of Object.entries(report.metrics[phase])) {
        const budget = metrics.category === 'read' ? 1000 : 2000;
        if (!metrics.samples && !metrics.failures && !metrics.unmeasured) {
          report.transportExclusions ??= {};
          report.transportExclusions[`${phase} ${operation}`] = metrics;
          delete report.metrics[phase][operation];
          continue; // cancellations are raw evidence, never completed samples.
        }
        record(`performance-${phase}-${operation}`, metrics.samples > 0 && metrics.p95Ms <= budget && !metrics.failures && !metrics.unmeasured ? '通过' : '失败', metrics);
      }
    }
    if (errors.length) record('browser-errors', '失败', errors);
    checkpoint(report);
  }
  return report;
}
