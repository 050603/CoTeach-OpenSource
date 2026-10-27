// Real HTTP/model acceptance on a copied production build and disposable DB.
// No production student rows are read; only global encrypted provider settings
// are snapshotted with the existing read-only acceptance helper.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { snapshotAcceptanceProviders } from './lib/classroom-acceptance-provider-snapshot.mjs';
import { documentAcceptanceReceiptPending, documentAcceptancePollTimeout, documentAcceptanceScenarioCount } from './lib/document-boundary-acceptance-receipts.mjs';
import { resolveDocumentAcceptanceRuntime } from './lib/document-boundary-acceptance-runtime.mjs';
import { verifyReleaseReady } from './lib/production-assets.mjs';
import { boundaryCourses, boundaryCases, boundaryConstraintCases, boundaryShapeChecks, classifyBoundaryResult } from './lib/document-boundary-acceptance-fixtures.mjs';

const allCases = [...boundaryCases, ...boundaryConstraintCases];
const root = path.resolve(import.meta.dirname, '..');
const label = process.env.DOCUMENT_BOUNDARY_LABEL || 'baseline';
const mode = process.env.DOCUMENT_BOUNDARY_MODE || 'matrix';
assert.ok(['matrix', 'browser', 'concurrency'].includes(mode), 'Mode must be matrix, browser or concurrency');
const matrixEnabled = mode === 'matrix';
const browserEnabled = mode === 'browser' || process.env.DOCUMENT_BOUNDARY_BROWSER === '1';
assert.match(label, /^[a-z0-9-]+$/);
const output = path.join(root, '.openpbl-runtime/document-boundary-acceptance', label);
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);
const runtimeSource = await resolveDocumentAcceptanceRuntime(root, {
  releaseId: process.env.DOCUMENT_BOUNDARY_RUNTIME_RELEASE,
  buildDir: process.env.DOCUMENT_BOUNDARY_BUILD_DIR || '.next-build',
});
const buildDir = runtimeSource.buildDir;
const runtime = path.join(output, 'runtime');
const port = Number(process.env.DOCUMENT_BOUNDARY_PORT || 3296);
assert.ok(Number.isInteger(port) && port > 1024 && port !== 3000);
const origin = `http://127.0.0.1:${port}`;
const namespace = `openpbl-boundary-${label}-${randomUUID()}`;
const containers = [];
const previousReport = path.join(output, 'report.json');
assert.ok(!existsSync(previousReport) || process.env.DOCUMENT_BOUNDARY_RESUME === '1', 'Existing results require DOCUMENT_BOUNDARY_RESUME=1 or a new label');
const previous = existsSync(previousReport) ? JSON.parse(readFileSync(previousReport, 'utf8')) : null;
const rows = previous?.rows ?? [];
const concurrency = previous?.concurrency ?? [];
let browserAcceptance = previous?.browserAcceptance ?? null;
const selected = (process.env.DOCUMENT_BOUNDARY_CASES || boundaryCases.map(row => row.id).join(',')).split(',');
const repeats = Number(process.env.DOCUMENT_BOUNDARY_REPEATS || 3);
assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 10, 'Repeats must be between 1 and 10');
assert.ok(selected.length > 0 && selected.every(id => allCases.some(row => row.id === id)) && new Set(selected).size === selected.length, 'Unknown or repeated case ID');
const plannedScenarios = documentAcceptanceScenarioCount(mode, selected.length, repeats);
const env = { ...process.env, DATABASE_URL: '', PROVIDER_CONFIG_DATABASE_URL: '', PROVIDER_CONFIG_ENCRYPTION_KEY: '',
  OPENPBL_COURSE_READ_DATABASE_URL: '', REDIS_URL: '', JWT_SECRET: randomBytes(48).toString('base64url'),
  PROVIDER_ENCRYPTION_KEY: '', INTERNAL_MONITOR_TOKEN: randomBytes(32).toString('base64url'),
  ENABLE_WEBSOCKET: 'false', ENABLE_TLDRAW_SYNC: 'false', TRUST_PROXY_HEADERS: 'true', ENABLE_LOAD_TEST_API: 'false',
  KNOWLEDGE_EXPLANATION_WARMUP_ENABLED: 'false', COURSE_GENERATION_BACKGROUND_ENABLED: 'false',
  DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED: 'true', NEXT_PUBLIC_OPENPBL_SYSTEM_MODE: 'new', NEXT_TELEMETRY_DISABLED: '1',
  UPLOAD_DIR: path.join(output, 'uploads'), CLASSROOM_DATA_DIR: path.join(output, 'classrooms'),
  WHITEBOARD_DATA_DIR: path.join(output, 'whiteboards'), TTS_CACHE_DIR: path.join(output, 'tts-cache'),
  AI_AUDIT_OUTBOX_DIR: path.join(output, 'audit-outbox'), PUBLIC_BASE_URL: origin,
  OPENPBL_OUTBOUND_PROXY: 'http://127.0.0.1:19999', HOSTNAME: '127.0.0.1', PORT: String(port) };
let db; let server; let providerSnapshot; let buildId; let complete = false;
const stopFile = path.join(output, 'STOP');
let stopRequested = false;
process.on('SIGUSR2', () => { stopRequested = true; });
const shouldStop = () => stopRequested || existsSync(stopFile);
const write = (filename, data) => writeFileSync(path.join(output, filename), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const command = (bin, args, options = {}) => execFileSync(bin, args, { cwd: root, env, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, ...options }).trim();
function report() {
  const usage = existsSync(path.join(output, 'server.log')) ? readFileSync(path.join(output, 'server.log'), 'utf8').split('\n').flatMap(line => {
    try { const item = JSON.parse(line); return item.event === 'classroom-ai-usage' ? [Object.fromEntries(['feature', 'requestId', 'provider', 'model', 'callId', 'attempt', 'outcome', 'durationMs', 'inputTokens', 'outputTokens', 'totalTokens'].filter(key => item[key] !== undefined).map(key => [key, item[key]]))] : []; } catch { return []; }
  }) : [];
  write('model-usage.json', usage);
  const counts = Object.fromEntries([...new Set(rows.map(row => row.classification))].map(name => [name, rows.filter(row => row.classification === name).length]));
  write('report.json', { label, mode, intermediate: shouldStop(), buildId, runtimeSource, providerSnapshot, models: [...new Set(usage.map(item => item.model))], modelCalls: usage.length, origin, complete, at: new Date().toISOString(),
    isolation: 'Disposable PostgreSQL/Redis; copied standalone; synthetic students/coursework; real authenticated document route and providers',
    limitations: ['HTTP/model acceptance does not prove browser controls', 'Shape checks are preliminary; actual content must be reviewed', 'No capacity claim beyond measured concurrency', 'Scenario 18 uses explicit core requests that can be blocked individually; it does not isolate the causal effect of the cumulative summary. Summary ownership/adoption are covered by separate deterministic regressions.'],
    plannedScenarios, completedScenarios: rows.length, counts, shapeFailures: rows.filter(row => row.shapeIssues.length).length,
    courses: boundaryCourses, cases: allCases.filter(row => selected.includes(row.id)), rows, concurrency, browserAcceptance });
  const text = ['# 第三阶段 AI 组员真实模型边界验收', '', `版本：${label} / ${buildId}；完成 ${rows.length}/${plannedScenarios} 个场景。`,
    '', '使用隔离数据库、合成身份及真实文档接口；结构检查不代替逐条语义复核。', '',
    '|题号|轮次|题目|预期|实际判定|异步接单(ms)|完整结果(ms)|建议入文|初步检查|', '|---|---|---|---|---|---:|---:|---|---|'];
  for (const row of rows) text.push(`|${row.caseId}|${row.repeat}|${row.request.replaceAll('|', '\\|')}|${row.expected}|${row.classification}|${row.acceptedMs ?? '未使用异步接单'}|${row.scenarioElapsedMs ?? row.elapsedMs}|${row.proposesDocumentChange ? '是' : '否'}|${row.shapeIssues.join('；') || '结构符合预期，待内容复核'}|`);
  text.push('', '## 固定课程上下文', '', '```json', JSON.stringify(boundaryCourses, null, 2), '```', '', '## 实际回复与交付');
  for (const row of rows) text.push('', `### ${row.caseId} / 第 ${row.repeat} 次`, '', `请求：${row.request}`, '', `预期：${row.expected}`, '', '当前文稿：', '', allCases.find(item => item.id === row.caseId)?.documentHtml || '（空文稿）', '',
    `实际判定：${row.classification}；场景耗时 ${row.scenarioElapsedMs ?? row.elapsedMs} ms（末次请求 ${row.elapsedMs} ms）；HTTP ${row.httpStatus}`, '', row.response?.result?.message || row.response?.message || row.error || '无回复', '',
    row.response?.result?.deliverable?.content || '', '', '```json', JSON.stringify({ delegation: row.response?.result?.delegation, documentActions: row.response?.result?.deliverable?.documentActions, shapeIssues: row.shapeIssues }, null, 2), '```');
  writeFileSync(path.join(output, 'report.md'), `${text.join('\n')}\n`, { mode: 0o600 });
}
async function container(name, image, portNumber) {
  command('docker', ['run', '--detach', '--rm', '--name', name, '--publish', `127.0.0.1::${portNumber}`,
    ...(portNumber === 5432 ? ['--tmpfs', '/var/lib/postgresql/data:rw', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust'] : []), image]);
  containers.push(name);
  for (let attempt = 0; attempt < 60; attempt++) {
    try { command('docker', ['exec', name, ...(portNumber === 5432 ? ['pg_isready', '-U', 'postgres'] : ['redis-cli', 'ping'])], { timeout: 3000 }); break; }
    catch { if (attempt === 59) throw new Error('Disposable database not ready'); await delay(500); }
  }
  const address = command('docker', ['port', name, `${portNumber}/tcp`]); assert.match(address, /^127\.0\.0\.1:\d+$/); return address;
}
async function request(student, method, url, body, timeout = 120000, headers = {}) {
  const response = await fetch(`${origin}${url}`, { method, headers: { 'Content-Type': 'application/json', Origin: origin,
    Cookie: `openpbl_student=${student.token}`, 'X-OpenPBL-Role': 'student', 'X-Forwarded-For': student.ip, ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
  const data = await response.json(); return { status: response.status, body: data, serverTiming: response.headers.get('server-timing') };
}
async function createStudent(course, tag) {
  const user = await db.user.create({ data: { username: tag, usernameKey: tag, displayName: `模拟学生 ${tag}`, passwordHash: 'NOT-A-LOGIN-HASH' } });
  const enrollment = await db.enrollment.create({ data: { userId: user.id, offeringId: course.offeringId } });
  const participation = await db.classroomParticipation.create({ data: { instanceId: course.instanceId, enrollmentId: enrollment.id, firstEnteredAt: new Date() } });
  const token = await new SignJWT({ role: 'student', userId: user.id, studentName: user.displayName, sv: 1 })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id).setIssuedAt().setIssuer('openpbl').setAudience('openpbl-app').setExpirationTime('1d').sign(new TextEncoder().encode(env.JWT_SECRET));
  return { userId: user.id, participationId: participation.id, courseId: course.instanceId, token,
    ip: `10.88.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}` };
}
async function createCourse(key, ownerId) {
  const design = boundaryCourses[key];
  const offering = await db.courseOffering.create({ data: { name: `模拟边界验收 ${key}`, status: 'OPEN' } });
  const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: design.name, position: 0, isOpen: true } });
  const template = await db.classroomTemplate.create({ data: { ownerId, title: design.name, status: 'PUBLISHED' } });
  const version = await db.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: 'PUBLISHED', snapshot: { schemaVersion: 2, kind: 'pbl-course', design } } });
  const activity = await db.activity.create({ data: { chapterId: chapter.id, type: 'Classroom', title: design.name, position: 0, isOpen: true } });
  const instance = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: 'TEACHING', startedAt: new Date(), runtimeConfig: { currentStageIndex: 2, version: 1, makeArtifactMode: 'document' } } });
  return { offeringId: offering.id, instanceId: instance.id };
}
async function ask(student, testCase, message, intent = testCase.intent, replayRequestId) {
  const clientSentAt = new Date().toISOString();
  const started = performance.now(); const requestId = replayRequestId ?? randomUUID();
  const body = { courseId: student.courseId, studentId: student.userId, stageKey: 'make', workspaceKind: 'document', conversationId: 'legacy',
    requestId, intent, message, documentHtml: testCase.documentHtml };
  let reply; const receiptTrail = []; let error; let initialResponseMs; let recovering = false;
  const observe = (receipt, extra = {}) => receiptTrail.push({ atMs: Math.round(performance.now() - started),
    status: receipt.status, body: receipt.body, serverTiming: receipt.serverTiming, ...extra });
  const observeFailure = (failure, method) => {
    const message = String(failure.message); error ??= message; recovering = true;
    receiptTrail.push({ atMs: Math.round(performance.now() - started), method, error: message });
  };
  try {
    reply = await request(student, 'POST', '/api/ai-collaboration/document', body, 120000, { Prefer: 'respond-async' });
    initialResponseMs = Math.round(performance.now() - started);
    observe(reply, { method: 'POST' });
  } catch (failure) { observeFailure(failure, 'POST'); }
  while ((!reply || documentAcceptanceReceiptPending(reply)) && documentAcceptancePollTimeout(started, performance.now()) > 0) {
    await delay(Math.min(1000, documentAcceptancePollTimeout(started, performance.now())));
    const pollTimeout = documentAcceptancePollTimeout(started, performance.now());
    if (!pollTimeout) break;
    try {
      reply = await request(student, 'GET', `/api/ai-collaboration/document?${new URLSearchParams({ courseId: student.courseId, studentId: student.userId,
        stageKey: 'make', workspaceKind: 'document', requestId })}`, null, pollTimeout);
      observe(reply, { method: 'GET', ...(recovering ? { recovery: true } : {}) }); recovering = false;
    } catch (failure) { observeFailure(failure, 'GET'); }
  }
  const tasks = await db.aiTask.findMany({ where: { createdById: student.userId, taskType: 'DOCUMENT_COLLABORATION', input: { path: ['requestId'], equals: requestId } },
    select: { id: true, status: true, taskType: true, startedAt: true, completedAt: true, error: true } });
  const events = await db.aiInteractionEvent.findMany({ where: { participationId: student.participationId, requestId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, eventType: true, actor: true, content: true, payload: true, createdAt: true } });
  const result = { requestId, request: message, intent, clientSentAt, clientCompletedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started), httpStatus: reply?.status ?? 0,
    initialResponseMs, acceptedMs: receiptTrail.find(receipt => receipt.method === 'POST' && receipt.status === 202)?.atMs ?? null,
    deadlineReachedWhileProcessing: Boolean(reply && documentAcceptanceReceiptPending(reply)),
    response: reply?.body ?? null, serverTiming: reply?.serverTiming ?? null, ...(error ? { error } : {}), receiptTrail, tasks, events };
  // Transport errors remain visible even when a durable completed receipt recovers successfully.
  return result;
}
async function checkpointEvidence(student, requestId) {
  const rows = await db.$queryRaw`SELECT task.status AS "taskStatus",
    task.output -> 'preparedResponse' IS NOT NULL AS "hasPreparedResponse",
    task.output #> '{preparedResponse,delegationAssessment}' IS NOT NULL AS assessment,
    task.output #> '{preparedResponse,delegationDraft}' IS NOT NULL AS draft,
    task.output #>> '{preparedResponse,delegationContextFingerprint}' AS fingerprint,
    task.output #> '{preparedResponse,delegationAssessmentRepairUsed}' AS "assessmentRepairUsed",
    task.output #> '{preparedResponse,delegationAssessmentGeneration,version}' AS "assessmentGenerationVersion",
    task.output #> '{preparedResponse,delegationAssessmentGeneration,drafts}' AS "assessmentGenerationDrafts",
    task.output #> '{preparedResponse,delegationAssessmentGeneration,repairUsed}' AS "assessmentGenerationRepairUsed",
    task.output #> '{preparedResponse,delegationAssessmentGeneration,pendingRepair}' AS "assessmentGenerationPendingRepair",
    task.output #> '{preparedResponse,delegationPlacementRepair,version}' AS "placementRepairVersion",
    task.output #> '{preparedResponse,delegationPlacementRepair,pending}' AS "placementRepairPending",
    task.output #>> '{preparedResponse,delegationPlacementRepair,raw}' AS "placementRepairRaw",
    task.output #> '{preparedResponse,delegationDelivery,version}' AS "deliveryCheckpointVersion",
    task.output #> '{preparedResponse,delegationDelivery,drafts}' AS "deliveryDrafts",
    task.output #> '{preparedResponse,delegationDelivery,repairUsed}' AS "deliveryRepairUsed",
    task.output #>> '{preparedResponse,delegationDelivery,pendingRepair,kind}' AS "deliveryPendingRepair",
    task.output #> '{preparedResponse,delegationReviewOutputs}' AS "deliveryReviewOutputs",
    task.output #> '{preparedResponse,discussionReview,drafts}' AS "discussionDrafts",
    task.output #> '{preparedResponse,discussionReview,reviewOutputs}' AS "discussionReviewOutputs",
    task.output #>> '{preparedResponse,discussionReview,fingerprint}' AS "discussionFingerprint",
    task.output #>> '{preparedResponse,discussionReview,pendingRepair,kind}' AS "discussionPendingRepair",
    task.output #> '{preparedResponse,discussionReview,repairUsed}' AS "discussionRepairUsed"
    FROM "AiTask" task WHERE task."createdById" = ${student.userId}
      AND task.input ->> 'requestId' = ${requestId} AND task."taskType" = 'DOCUMENT_COLLABORATION'`;
  if (!rows[0]) return null;
  const { assessmentGenerationDrafts, deliveryDrafts, discussionDrafts, placementRepairRaw,
    deliveryReviewOutputs, discussionReviewOutputs, ...row } = rows[0];
  const hashes = values => Array.isArray(values) ? values.filter(value => typeof value === 'string')
    .map(value => createHash('sha256').update(value).digest('hex')) : [];
  const reviewEvidence = values => Array.isArray(values) ? values.filter(value => value && typeof value.raw === 'string')
    .map(value => ({ fingerprint: value.fingerprint, repairStructure: value.repairStructure,
      rawSha256: createHash('sha256').update(value.raw).digest('hex') })) : [];
  return { ...row, placementRepairRawSha256: typeof placementRepairRaw === 'string'
    ? createHash('sha256').update(placementRepairRaw).digest('hex') : null,
    assessmentGenerationDraftCount: Array.isArray(assessmentGenerationDrafts) ? assessmentGenerationDrafts.length : 0,
    assessmentGenerationDraftSha256: hashes(assessmentGenerationDrafts),
    deliveryDraftCount: Array.isArray(deliveryDrafts) ? deliveryDrafts.length : 0,
    deliveryDraftSha256: hashes(deliveryDrafts), discussionDraftCount: Array.isArray(discussionDrafts) ? discussionDrafts.length : 0,
    discussionDraftSha256: hashes(discussionDrafts), deliveryReviewOutputs: reviewEvidence(deliveryReviewOutputs),
    discussionReviewOutputs: reviewEvidence(discussionReviewOutputs) };
}
async function retryConfirmedFailure(student, testCase, result, artifactTag) {
  if (!shouldStop() && process.env.DOCUMENT_BOUNDARY_RETRY_FAILED === '1' && result.response?.status === 'failed' && result.response?.retryable !== false) {
    try {
      const failureReceipt = await request(student, 'GET', `/api/ai-collaboration/document?${new URLSearchParams({ courseId: student.courseId,
        studentId: student.userId, stageKey: 'make', workspaceKind: 'document', requestId: result.requestId })}`, null, 8000);
      if (failureReceipt.body?.status === 'failed' && failureReceipt.body?.retryable !== false) {
        const checkpointBefore = await checkpointEvidence(student, result.requestId);
        const retry = await ask(student, testCase, result.request, result.intent, result.requestId);
        const checkpointAfter = await checkpointEvidence(student, result.requestId);
        const originalIds = new Set(result.events.map(event => event.id));
        const newlyRecordedSteps = retry.events.filter(event => !originalIds.has(event.id))
          .map(event => event.payload?.detail).filter(detail => detail?.kind === 'model-output').map(detail => detail.modelStep ?? 'discussion');
        result.retry = { failureReceipt, checkpointBefore, checkpointAfter, ...retry, newlyRecordedSteps,
          unchangedOriginalResult: true,
          assessmentReused: checkpointBefore?.assessment ? !newlyRecordedSteps.includes('delegation-assessment') : null,
          deliveryReused: checkpointBefore?.draft ? !newlyRecordedSteps.some(step => step.startsWith('delegation-delivery')) : null,
          draftReusedBeforeAnyRegeneration: checkpointBefore?.draft ? newlyRecordedSteps[0]?.startsWith('delegation-review') ?? false : null,
          deliveryRegeneratedForRepair: Boolean(checkpointBefore?.draft && newlyRecordedSteps[0]?.startsWith('delegation-review') && newlyRecordedSteps.includes('delegation-delivery')),
          discussionDraftReusedBeforeAnyRegeneration: checkpointBefore?.discussionDraftCount > 0
            ? newlyRecordedSteps[0] === 'discussion-review' : null,
          scope: 'One explicit HTTP retry after a confirmed failed durable GET; same identity, body and request ID; original attempt retained' };
        write(`${artifactTag}-retry.json`, result.retry);

        console.log(`${label} ${artifactTag} explicit retry: HTTP ${retry.httpStatus}, ${retry.response?.result?.kind ?? retry.response?.error}, new steps ${newlyRecordedSteps.join(',')}`);
      } else {
        result.retrySkipped = { reason: 'Durable state was not confirmed retryable failure', receipt: failureReceipt };
      }
    } catch (error) {
      result.retrySkipped = { reason: 'Retry observation failed; original attempt is unchanged', error: error.message };

    }
  }
  write(`${artifactTag}.json`, result);
}
async function scenario(courses, testCase, repeat) {
  const student = await createStudent(courses[testCase.course], `${label}-${testCase.id}-${repeat}-${randomUUID().slice(0, 8)}`);
  const turns = [];
  for (const [index, message] of (testCase.turns ?? []).entries()) {
    const turn = await ask(student, testCase, message, /只|是什么|为什么/.test(message) ? 'discuss' : 'delegate');
    const artifactTag = `case-${testCase.id}-${repeat}-prefix-${index + 1}`;
    // Preserve the original failed prefix before observing any explicit recovery.
    write(`${artifactTag}.json`, turn);
    await retryConfirmedFailure(student, testCase, turn, artifactTag);
    turns.push(turn);
  }
  const result = await ask(student, testCase, testCase.request);
  const row = { ...result, caseId: testCase.id, repeat, course: testCase.course, expected: testCase.expected,
    studentId: student.userId, participationId: student.participationId, turns,
    scenarioElapsedMs: turns.reduce((total, turn) => total + turn.elapsedMs, result.elapsedMs),
    proposesDocumentChange: Boolean(result.response?.result?.suggestion || result.response?.result?.deliverable?.documentActions?.some(action => action.operation !== 'none')),
    shapeIssues: boundaryShapeChecks(testCase, result.response) };
  row.classification = classifyBoundaryResult(row); rows.push(row); rows.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.repeat - b.repeat); report();
  console.log(`${label} ${testCase.id}/${repeat}: ${row.classification}; ${row.elapsedMs}ms; ${row.shapeIssues.length ? row.shapeIssues.join('; ') : 'shape-ok'}`);
  write(`case-${testCase.id}-${repeat}.json`, row);
  await retryConfirmedFailure(student, testCase, row, `case-${testCase.id}-${repeat}`);
  row.scenarioWithExplicitRecoveryElapsedMs = row.scenarioElapsedMs + (row.retry?.elapsedMs ?? 0)
    + turns.reduce((total, turn) => total + (turn.retry?.elapsedMs ?? 0), 0);
  write(`case-${testCase.id}-${repeat}.json`, row); report();
}
async function concurrentRound(courses, count) {
  const started = Date.now(); const students = await Promise.all(Array.from({ length: count }, (_, index) => createStudent(courses.A, `${label}-load-${count}-${index}-${randomUUID().slice(0, 8)}`)));
  const batches = []; const reviews = [];
  const review = async (student, index, round) => {
    const text = `我只在A点观察十分钟就证明全校所有洗手点都在浪费水（模拟记录 ${count}-${round}-${index}）。`;
    const body = { courseId: student.courseId, studentId: student.userId, stageKey: 'make', workspaceKind: 'document', requestId: randomUUID(),
      action: 'proactive-document-comments', documentHtml: `<p>${text}</p>`, paragraphs: [{ candidateId: `load-${count}-${round}-${index}`, blockId: `load-${count}-${index}`, blockIndex: 0, targetText: text }] };
    const since = Date.now();
    try {
      let response = await request(student, 'POST', '/api/ai-collaboration/document', body);
      const observations = [{ status: response.status, atMs: Date.now() - since }];
      while (documentAcceptanceReceiptPending(response) && documentAcceptancePollTimeout(since) > 0) {
        await delay(Math.min(1000, documentAcceptancePollTimeout(since)));
        const pollTimeout = documentAcceptancePollTimeout(since);
        if (!pollTimeout) break;
        response = await request(student, 'GET', `/api/ai-collaboration/document?${new URLSearchParams({ courseId: student.courseId, studentId: student.userId, stageKey: 'make', workspaceKind: 'document', requestId: body.requestId })}`, null, pollTimeout);
        observations.push({ status: response.status, atMs: Date.now() - since });
      }
      return { requestId: body.requestId, status: response.status, body: response.body, observations, elapsedMs: Date.now() - since, deadlineReachedWhileProcessing: documentAcceptanceReceiptPending(response) };
    }
    catch (error) { return { requestId: body.requestId, status: 0, error: error.message, elapsedMs: Date.now() - since }; }
  };
  for (let round = 0; round < 2; round++) {
    const pendingReviews = Promise.all(students.map((student, index) => review(student, index, round)));
    batches.push(await Promise.all(students.map(student => ask(student, boundaryCases[5], round === 0 ? '五人支持但总共有八人，为什么不能说所有人支持？只解释方法。' : '怎样区分尚未验证和已经证明？只解释方法。', 'discuss'))));
    reviews.push(await pendingReviews);
  }
  const replies = batches.flat(); const elapsed = replies.map(reply => reply.elapsedMs).sort((a, b) => a - b);
  const value = { students: count, rounds: 2, elapsedMs: Date.now() - started, replies, backgroundReviews: reviews,
    completedReplies: replies.filter(reply => reply.httpStatus === 200 && reply.response?.result?.message).length,
    errors: replies.filter(reply => reply.httpStatus !== 200 || !reply.response?.result?.message).length,
    duplicateTaskCount: replies.reduce((total, reply) => total + Math.max(0, reply.tasks.length - 1), 0),
    duplicateMessageIds: replies.reduce((total, reply) => {
      const ids = (reply.response?.messages ?? []).map(message => message.id);
      return total + ids.length - new Set(ids).size;
    }, 0),
    extraPersistedReplies: replies.reduce((total, reply) => total
      + Math.max(0, reply.events.filter(event => event.actor === 'assistant' && event.eventType === 'response').length - 1), 0),
    completedBackgroundReviews: reviews.flat().filter(review => review.status === 200 && review.body?.complete === true).length,
    p50Ms: (elapsed[Math.floor((elapsed.length - 1) / 2)] + elapsed[Math.floor(elapsed.length / 2)]) / 2,
    p95Ms: elapsed[Math.ceil(elapsed.length * .95) - 1],
    limitation: 'Authenticated concurrent HTTP users and real proactive review API; not a browser load measurement' };
  concurrency.push(value); report(); write(`concurrency-${count}.json`, value);
  console.log(`${label} concurrency ${count}: ${value.completedReplies}/${count * 2}, ${value.elapsedMs}ms`);
}
async function verifyBrowserScenario(courses, scenario) {
  const browserOutput = path.join(output, `browser-${scenario}`);
  mkdirSync(browserOutput, { recursive: true, mode: 0o700 });
  const { chromium } = await import('playwright');
  const { browserConfiguration } = await import('./lib/prelaunch-browser.mjs');
  const configuration = browserConfiguration();
  const browser = await chromium.launch(configuration.executablePath ? { executablePath: configuration.executablePath } : {});
  const student = await createStudent(courses.A, `${label}-browser-${randomUUID().slice(0, 8)}`);
  const group = await db.projectGroup.create({ data: { id: `${courses.A.offeringId}:grp-${student.userId}`,
    offeringId: courses.A.offeringId, name: '模拟浏览器组' } });
  await db.groupMember.create({ data: { groupId: group.id, userId: student.userId, participationId: student.participationId, role: 'LEADER' } });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const evidence = { scenario, errors, noBusinessApiMocks: true, syntheticStudentId: student.userId };
  try {
    await context.addCookies([{ name: 'openpbl_student', value: student.token, url: origin, httpOnly: true, sameSite: 'Lax' }]);
    await context.addInitScript(() => { if (location.protocol !== 'about:') localStorage.setItem('locale', 'zh-CN'); });
    const response = await page.goto(`${origin}/student/ai-collaboration/${student.courseId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    assert.equal(response.status(), 200);
    const editor = page.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first();
    await editor.waitFor({ state: 'visible', timeout: 60000 });
    const member = page.getByLabel('AI 组员工作区', { exact: true });
    if (!await member.isVisible()) await page.getByRole('button', { name: /^(?:唤醒 )?AI 组员$/ }).click();
    await member.waitFor();
    await page.locator('[data-document-workspace][data-member-state="open"]').waitFor();
    const legacyNames = ['讨论思路', '安排辅助工作', '整理当前进展', '检查文稿'];
    evidence.legacyButtons = Object.fromEntries(await Promise.all(legacyNames.map(async name => [name, await member.getByRole('button', { name, exact: true }).count()])));
    assert.ok(Object.values(evidence.legacyButtons).every(count => count === 0), 'Permanent preset buttons remain visible');
    const { observeSubmissionSaveReceipts, confirmSubmissionSave, removeAcknowledgedDocumentDrafts } = await import('./lib/classroom-acceptance-save-confirmation.mjs');
    const saves = observeSubmissionSaveReceipts(page, { origin, courseId: student.courseId, studentId: student.userId });
    evidence.saveObservations = saves.entries;
    const until = async (read, message, timeout = 45000) => {
      const end = Date.now() + timeout;
      do { const value = await read(); if (value) return value; await delay(200); } while (Date.now() < end);
      throw new Error(message);
    };
    const value = row => row.payload?.view ?? row.payload;
    const saved = async () => (await db.classroomSubmission.findMany({ where: { participationId: student.participationId } }))
      .find(row => value(row)?.type === 'document');
    const original = '我们尚未验证，这可能改善浪废水的情况。';
    const corrected = original.replace('浪废', '浪费');
    await member.getByRole('button', { name: '收起 AI 组员', exact: true }).click();
    await member.waitFor({ state: 'hidden' });
    await editor.click(); await page.keyboard.insertText(original);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const baseline = await until(async () => { const row = await saved(); return row && value(row).content.includes(original) && row; }, 'Synthetic browser draft did not save');
    evidence.initialSave = await confirmSubmissionSave({ page, db, courseId: student.courseId, studentId: student.userId,
      participationId: student.participationId, submission: baseline, observations: saves.entries, marker: original });
    const beforeHtml = value(baseline).content;
    if (!await member.isVisible()) await page.getByRole('button', { name: /^(?:唤醒 )?AI 组员$/ }).click();
    const draft = member.locator('textarea');
    evidence.deliveries = [];
    const send = async message => {
      const started = Date.now(); const receipts = []; const reads = new Set();
      const entry = { message, receipts, clientSentAt: new Date(started).toISOString() };
      evidence.requestReplies ??= []; evidence.requestReplies.push(entry);
      const onResponse = response => {
        const url = new URL(response.url()); const request = response.request();
        if (url.pathname !== '/api/ai-collaboration/document' || !['GET', 'POST'].includes(request.method())) return;
        const sent = request.method() === 'POST' ? request.postDataJSON() : null;
        const receipt = { method: request.method(), requestId: sent?.requestId ?? url.searchParams.get('requestId'),
          atMs: Date.now() - started, status: response.status(), request: sent };
        receipts.push(receipt);
        const reading = response.json().then(body => { receipt.body = body; })
          .catch(error => { receipt.error = error.message; }).finally(() => reads.delete(reading));
        reads.add(reading);
      };
      page.on('response', onResponse);
      try {
        await draft.fill(message);
        await member.getByRole('button', { name: '发送给 AI 组员', exact: true }).click();
        const progress = member.getByText(/已等待.*你可以继续编辑/);
        await progress.waitFor({ state: 'visible', timeout: 5000 });
        entry.processingFeedbackMs = Date.now() - started;
        await page.setViewportSize({ width: 390, height: 844 });
        await member.waitFor({ state: 'visible' });
        const { progressBox } = await until(async () => {
          const box = await progress.boundingBox();
          if (!box) return receipts.some(receipt => ['completed', 'failed'].includes(receipt.body?.status)) && { progressBox: null };
          return box.x >= -2 && box.x + box.width <= 392 && box.y >= -2 && box.y + box.height <= 846 && { progressBox: box };
        }, 'Mobile processing status is outside the visible viewport', 5000);
        entry.mobileProcessing = { viewport: { width: 390, height: 844 }, progressBox,
          completedBeforeCapture: !progressBox, pageHorizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) };
        assert.ok(entry.mobileProcessing.pageHorizontalOverflow <= 2, 'Mobile processing page horizontally overflows');
        await page.screenshot({ path: path.join(browserOutput, 'browser-mobile-processing.png'), fullPage: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
        const initial = await until(() => receipts.find(receipt => receipt.method === 'POST' && receipt.body), 'Browser sent no document request', 120000);
        const terminal = await until(() => receipts.find(receipt => receipt.requestId === initial.requestId
          && receipt.body && !documentAcceptanceReceiptPending(receipt)), 'Browser did not observe a terminal durable receipt',
        Math.max(1, 120000 - (Date.now() - started)));
        Object.assign(entry, { request: initial.request, requestId: initial.requestId, status: terminal.status, response: terminal.body,
          initialResponseMs: initial.atMs, acceptedMs: initial.status === 202 ? initial.atMs : null, elapsedMs: terminal.atMs });
        assert.equal(terminal.status, 200);
        assert.equal(terminal.body.result?.kind, 'work-delivery', terminal.body.error ?? terminal.body.failureMessage ?? 'Expected executable document delivery');
        assert.ok(initial.request.contributionId, 'Browser delegation request has no contribution identity');
        return entry;
      } catch (error) { entry.error = error.message; entry.failureObservedMs = Date.now() - started; throw error;
      } finally { page.off('response', onResponse); await Promise.allSettled([...reads]); }
    };
    const undoDelivery = async (entry, applied, expectedHtml = beforeHtml, expectedText = original) => {
      const title = entry.response.result.deliverable.title;
      const undo = page.getByRole('button', { name: `撤销 AI 修改“${title}”`, exact: true }).filter({ visible: true });
      if (!await undo.count()) {
        const toastUndo = page.getByRole('button', { name: '撤销', exact: true }).filter({ visible: true });
        if (await toastUndo.count()) await toastUndo.click();
        else {
          await page.locator('.pbl-document-editor [role="toolbar"]').first().locator('[data-toolbar-overflow-more] button').first().click();
          await undo.click();
        }
      } else await undo.click();
      const undone = await until(async () => { const current = await saved(); return current && value(current).content === expectedHtml
        && value(current).version > value(applied).version && current; }, 'Undo did not persist the exact original rich document');
      assert.equal((await editor.innerText()).trim(), expectedText);
      entry.undoSave = await confirmSubmissionSave({ page, db, courseId: student.courseId, studentId: student.userId,
        participationId: student.participationId, submission: undone, observations: saves.entries, marker: expectedText });
      entry.undoRestoredExactHtml = true;
    };
    const confirmDecision = async (entry, decision, undone) => {
      const contributionId = entry.contributionId;
      entry.decisions = await until(async () => {
        const records = await db.aiSupportRecord.findMany({ where: { participationId: student.participationId,
          structuredPayload: { path: ['collection'], equals: 'studentAiDecisions' } } });
        const decisions = records.map(record => record.structuredPayload.view).filter(item => item?.contributionId === contributionId);
        return decisions.some(item => item.decision === decision)
          && (!undone || decisions.some(item => item.decision === 'rejected')) && decisions;
      }, 'Student review/undo decision was not durably recorded for this contribution');
      entry.approval = await until(async () => {
        const approvals = await db.aiActionConfirmation.findMany({ where: { requestedById: student.userId,
          payload: { path: ['detail', 'contributionId'], equals: contributionId } } });
        return approvals.length === 1 && approvals[0].status === (decision === 'adopted' ? 'APPROVED' : 'REJECTED') && { id: approvals[0].id, status: approvals[0].status };
      }, 'The exact student approval/rejection receipt is absent or was rewritten by undo');
    };
    for (const decision of ['rejected', 'adopted'].filter(value => scenario === `review-${value}`)) {
      const message = '请替我修正当前文稿中的错别字“浪废水”为“浪费水”，其他文字、观点和不确定程度逐字保持原样。先给我审阅，不要直接应用到文档。';
      const reply = await send(message);
      const pending = member.getByRole('region', { name: '待审阅的 AI 组员交付物', exact: true }); await pending.waitFor();
      const row = { decision, application: 'review-first', ...reply, contributionId: reply.request.contributionId };
      evidence.deliveries.push(row);
      assert.equal(await editor.locator('[data-block-suggestion="true"]').count() > 0, true, 'Unconfirmed delivery has no visible change markers');
      assert.equal(value(await saved()).content, beforeHtml, 'Unconfirmed delivery changed durable document');
      await page.screenshot({ path: path.join(browserOutput, `browser-delivery-${decision}-before.png`), fullPage: true });
      if (decision === 'rejected') {
        await pending.getByRole('button', { name: '暂不采用', exact: true }).click();
        await pending.waitFor({ state: 'hidden' });
        assert.equal((await editor.innerText()).trim(), original);
        assert.equal(value(await saved()).content, beforeHtml);
        row.documentUnchanged = true;
      } else {
        await pending.getByRole('button', { name: '确认并应用到文档', exact: true }).click();
        const applied = await until(async () => { const current = await saved(); return current && value(current).content.includes(corrected)
          && !value(current).content.includes('浪废') && current; }, 'Adopted delivery did not save the corrected text');
        assert.equal((await editor.innerText()).trim(), corrected);
        row.appliedSave = await confirmSubmissionSave({ page, db, courseId: student.courseId, studentId: student.userId,
          participationId: student.participationId, submission: applied, observations: saves.entries, marker: corrected });
        await page.screenshot({ path: path.join(browserOutput, 'browser-delivery-adopted.png'), fullPage: true });
        await undoDelivery(row, applied);
        await page.screenshot({ path: path.join(browserOutput, 'browser-delivery-undone.png'), fullPage: true });
      }
      await confirmDecision(row, decision, decision === 'adopted');
    }
    for (const kind of ['correction', 'polish'].filter(value => value === scenario)) {
      const message = kind === 'correction'
        ? '请帮我把当前文稿里的“浪废水”改成“浪费水”，其他文字不变。'
        : '帮我把当前这句话润色得通顺一点，顺便修正错别字。保留“可能”和“尚未验证”，不要增加观点或数据。';
      const reply = await send(message);
      const row = { decision: 'adopted', application: 'review-first', kind, ...reply, contributionId: reply.request.contributionId };
      evidence.deliveries.push(row);
      const pending = member.getByRole('region', { name: '待审阅的 AI 组员交付物', exact: true });
      await pending.waitFor();
      assert.equal(value(await saved()).content, beforeHtml, 'Unconfirmed edit changed durable document');
      assert.equal(await editor.locator('[data-block-suggestion="true"]').count() > 0, true, 'Editing instruction has no visible preview');
      await pending.getByRole('button', { name: '确认并应用到文档', exact: true }).click();
      const applied = await until(async () => {
        const current = await saved(); const html = current && value(current).content;
        return html && html !== beforeHtml && !html.includes('浪废') && html.includes('可能') && html.includes('尚未验证') && current;
      }, 'Confirmed editing instruction did not update and save the real document');
      assert.equal(await member.getByRole('region', { name: '待审阅的 AI 组员交付物', exact: true }).count(), 0,
        'Confirmed editing instruction still has an unresolved review');
      row.appliedText = (await editor.innerText()).trim(); row.appliedHtml = value(applied).content;
      row.appliedAndSavedMs = Date.now() - Date.parse(reply.clientSentAt);
      if (kind === 'correction') assert.equal(row.appliedText, corrected);
      row.appliedSave = await confirmSubmissionSave({ page, db, courseId: student.courseId, studentId: student.userId,
        participationId: student.participationId, submission: applied, observations: saves.entries, marker: '尚未验证' });
      await page.screenshot({ path: path.join(browserOutput, `browser-direct-${kind}-applied.png`), fullPage: true });
      if (kind === 'correction') {
        await undoDelivery(row, applied);
        await confirmDecision(row, 'adopted', true);
      } else {
        await confirmDecision(row, 'adopted', false);
        row.removedAcknowledgedDrafts = await removeAcknowledgedDocumentDrafts(page, {
          courseId: student.courseId, studentId: student.userId, submission: applied });
        // Read back in a separate page so the editor's session-scoped undo
        // remains available. Persistence does not promise undo after reload.
        const readback = await context.newPage();
        try {
          await readback.goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 60000 });
          await readback.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          const readbackEditor = readback.locator('.pbl-document-editor [data-slate-editor="true"][contenteditable="true"]').first();
          await readbackEditor.waitFor({ state: 'visible', timeout: 60000 });
          await until(async () => (await readbackEditor.innerText()).trim() === row.appliedText, 'Reload did not restore the acknowledged document from the server');
          await readback.screenshot({ path: path.join(browserOutput, 'browser-direct-polish-reloaded.png'), fullPage: true });
        } finally { await readback.close(); }
        assert.equal(value(await saved()).content, row.appliedHtml);
        row.serverReloadRestoredExactHtml = true;
        await undoDelivery(row, applied);
        await confirmDecision(row, 'adopted', true);
        await page.screenshot({ path: path.join(browserOutput, 'browser-direct-polish-undone.png'), fullPage: true });
      }
    }
    await saves.close();
    evidence.coreSuccess = true;
    evidence.responsive = [];
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const pane = page.locator('[data-ai-member-pane]');
      const paneBox = await until(async () => {
        const box = await pane.boundingBox();
        return box && box.x >= -2 && box.x + box.width <= viewport.width + 2
          && box.y >= -2 && box.y + box.height <= viewport.height + 2 && box;
      }, 'AI member scroll container is outside the visible viewport', 5000);
      const beforeInteraction = { panelBox: await member.boundingBox(), draftBox: await draft.boundingBox(),
        scroll: await pane.evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight })) };
      await draft.fill('只解释观察方法，暂不发送。');
      const send = member.getByRole('button', { name: '发送给 AI 组员', exact: true });
      await send.scrollIntoViewIfNeeded();
      const panelBox = await member.boundingBox(); const draftBox = await draft.boundingBox();
      const sendBox = await send.boundingBox();
      // Short landscape layouts intentionally scroll the member pane. Check
      // that its controls become visible and usable, rather than demanding the
      // entire minimum-height section fit without scrolling.
      for (const [name, box] of [['composer', draftBox], ['send', sendBox]]) {
        assert.ok(box && box.x >= -2 && box.x + box.width <= viewport.width + 2, `${name} horizontally overflows ${viewport.width}`);
        assert.ok(box.y >= -2 && box.y + box.height <= viewport.height + 2, `${name} is outside ${viewport.height}`);
      }
      await send.click({ trial: true, timeout: 10000 });
      const pageHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert.ok(pageHorizontalOverflow <= 2, `Page horizontally overflows ${viewport.width}`);
      evidence.responsive.push({ viewport, paneBox, beforeInteraction, panelBox, draftBox, sendBox,
        scrollAfterInteraction: await pane.evaluate(element => ({ scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight })),
        sendClickableWithoutSending: true, pageHorizontalOverflow });
      await page.screenshot({ path: path.join(browserOutput, `browser-${viewport.width}x${viewport.height}.png`), fullPage: true });
    }
    await draft.fill('');
    assert.deepEqual(errors, [], 'Unexpected browser runtime errors');
    evidence.success = true;
    await page.screenshot({ path: path.join(browserOutput, 'browser-workspace.png'), fullPage: true });
  } catch (error) { evidence.success = false; evidence.error = error.message; await page.screenshot({ path: path.join(browserOutput, 'browser-failure.png'), fullPage: true }).catch(() => undefined); }
  finally { await context.close(); await browser.close(); writeFileSync(path.join(browserOutput, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }); }
  console.log(`${label} browser ${scenario}: ${evidence.success ? 'passed' : evidence.error}`);
  return evidence;
}
async function verifyBrowser(courses) {
  const allowed = ['review-rejected', 'review-adopted', 'correction', 'polish'];
  const selected = (process.env.DOCUMENT_BOUNDARY_BROWSER_SCENARIOS || allowed.join(',')).split(',');
  assert.ok(selected.length && selected.every(value => allowed.includes(value)) && new Set(selected).size === selected.length,
    'Unknown or repeated browser scenario');
  browserAcceptance = { success: false, noBusinessApiMocks: true, scenarios: [],
    isolation: 'Each browser scenario uses a new synthetic student, document, group and browser context' };
  for (const scenario of selected) {
    if (shouldStop()) break;
    try { browserAcceptance.scenarios.push(await verifyBrowserScenario(courses, scenario)); }
    catch (error) { browserAcceptance.scenarios.push({ scenario, success: false, error: error.message }); }
    write('browser-acceptance.json', browserAcceptance); report();
  }
  browserAcceptance.success = browserAcceptance.scenarios.length === selected.length
    && browserAcceptance.scenarios.every(result => result.success);
  write('browser-acceptance.json', browserAcceptance); report();
  if (!browserAcceptance.success) process.exitCode = 1;
}

try {
  if (!existsSync(path.join(runtime, 'server.js'))) {
    const source = runtimeSource.source;
    const excluded = ['.openpbl-data', '.openpbl-runtime', '.env', '.env.local', '.env.production', '.env.production.local'].map(name => path.join(source, name));
    cpSync(source, runtime, { recursive: true, verbatimSymlinks: true, filter: file => !excluded.some(item => file === item || file.startsWith(`${item}${path.sep}`)) });
  }
  if (browserEnabled && runtimeSource.sourceKind === 'build-standalone') {
    cpSync(path.join(root, 'public'), path.join(runtime, 'public'), { recursive: true });
    cpSync(path.join(root, buildDir, 'static'), path.join(runtime, buildDir, 'static'), { recursive: true });
  }
  for (const name of ['.env', '.env.local', '.env.production', '.env.production.local']) assert.ok(!existsSync(path.join(runtime, name)), `Copied runtime must not load ${name}`);
  const embeddedBuild = path.join(runtime, buildDir, 'BUILD_ID');
  buildId = existsSync(embeddedBuild) ? readFileSync(embeddedBuild, 'utf8').trim() : readFileSync(path.join(root, buildDir, 'BUILD_ID'), 'utf8').trim();
  if (runtimeSource.buildId) {
    assert.equal(buildId, runtimeSource.buildId, 'Copied acceptance runtime does not match the selected immutable release');
    await verifyReleaseReady(runtime, buildDir, buildId);
  }
  const pgAddress = await container(namespace, 'pgvector/pgvector:0.8.6-pg16', 5432);
  env.DATABASE_URL = `postgresql://postgres@${pgAddress}/postgres?schema=public&connection_limit=24`;
  command('node', ['scripts/run-prisma.mjs', 'migrate', 'deploy']);
  db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  const redis = await container(`${namespace}-redis`, 'redis:7.4.5-alpine', 6379); env.REDIS_URL = `redis://${redis}/0`;
  const source = new PrismaClient({ datasourceUrl: readFileSync(path.join(root, 'deploy/secrets/database_url.txt'), 'utf8').trim() });
  try { providerSnapshot = await snapshotAcceptanceProviders(source, db); } finally { await source.$disconnect(); }
  env.PROVIDER_CONFIG_DATABASE_URL = env.DATABASE_URL;
  env.PROVIDER_CONFIG_ENCRYPTION_KEY = readFileSync(path.join(root, 'deploy/secrets/provider_encryption_key.txt'), 'utf8').trim();
  env.PROVIDER_ENCRYPTION_KEY = env.PROVIDER_CONFIG_ENCRYPTION_KEY;
  for (const directory of [env.UPLOAD_DIR, env.CLASSROOM_DATA_DIR, env.WHITEBOARD_DATA_DIR, env.AI_AUDIT_OUTBOX_DIR]) mkdirSync(directory, { recursive: true });
  server = spawn(process.execPath, [path.join(runtime, 'server.js')], { cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => writeFileSync(path.join(output, 'server.log'), chunk, { flag: 'a', mode: 0o600 }));
  for (let attempt = 0; attempt < 90; attempt++) {
    if (server.exitCode !== null) throw new Error(`Isolated server exited ${server.exitCode}; inspect private server.log`);
    try { if ((await fetch(`${origin}/api/health/live`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* booting */ }
    if (attempt === 89) throw new Error('Isolated runtime did not start'); await delay(1000);
  }
  const owner = await db.user.create({ data: { username: 'synthetic-owner', usernameKey: 'synthetic-owner', displayName: '模拟课程教师', passwordHash: 'NOT-A-LOGIN-HASH', role: 'TEACHER' } });
  const courses = Object.fromEntries(await Promise.all(Object.keys(boundaryCourses).map(async key => [key, await createCourse(key, owner.id)])));
  const queue = !matrixEnabled ? [] : allCases.filter(row => selected.includes(row.id)).flatMap(testCase => Array.from({ length: repeats }, (_, index) => ({ testCase, repeat: index + 1 })))
    .filter(item => !rows.some(row => row.caseId === item.testCase.id && row.repeat === item.repeat));
  const workers = Number(process.env.DOCUMENT_BOUNDARY_WORKERS || 3);
  assert.ok(Number.isInteger(workers) && workers > 0 && workers <= 10, 'Workers must be between 1 and 10');
  let next = 0;
  await Promise.all(Array.from({ length: workers }, async () => { while (next < queue.length && !shouldStop()) { const { testCase, repeat } = queue[next++]; await scenario(courses, testCase, repeat); } }));
  if (!shouldStop() && (mode === 'concurrency' || matrixEnabled && process.env.DOCUMENT_BOUNDARY_CONCURRENCY === '1')) for (const count of [5, 10]) {
    if (shouldStop()) break;
    if (!concurrency.some(row => row.students === count)) await concurrentRound(courses, count);
  }
  if (!shouldStop() && browserEnabled) await verifyBrowser(courses);
  complete = !shouldStop() && rows.length === plannedScenarios;
  if (!shouldStop()) assert.ok(complete, 'Scenario matrix is incomplete'); report();
} catch (error) {
  write('fatal-error.json', { message: error.message, stack: error.stack }); console.error(`Acceptance failed: ${error.message}`); process.exitCode = 1;
} finally {
  report();
  if (db) { try { writeFileSync(path.join(output, `synthetic-database-${namespace.slice(-8)}.sql`), command('docker', ['exec', namespace, 'pg_dump', '-U', 'postgres', '-d', 'postgres', '--no-owner', '--no-acl']), { mode: 0o600 }); } catch { /* preserve reports independently */ } }
  if (server) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(10000)]); if (server.exitCode === null) server.kill('SIGKILL'); }
  await db?.$disconnect();
  for (const name of containers.reverse()) { try { command('docker', ['rm', '--force', name]); } catch { /* owned container already stopped */ } }
}
