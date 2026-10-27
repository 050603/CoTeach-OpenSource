import assert from 'node:assert/strict';
import { summarizeClassroomTraffic } from './classroom-acceptance-traffic.mjs';

/** Retain negative-case HTTP status in the journal and its latency in gates.
 * Only a caller's asserted, documented stale-presentation rejection is success.
 */
export function summarizeIncrementalTraffic(traffic, phase) {
  const expected = row => row.expectedStatus === 409 && row.status === 409 && row.method === 'PATCH'
    && /^\/api\/courses\/[^/]+\/showcase\/presentation$/.test(row.path)
    && ['PROJECTION_CONTROL_CONFLICT', 'SHOWCASE_INACTIVE'].includes(row.errorCode);
  const result = summarizeClassroomTraffic(traffic.map(row => expected(row) ? { ...row, status: 200 } : row), phase);
  for (const [operation, group] of Object.entries(result)) {
    const rows = traffic.filter(row => row.phase === phase && !row.injected
      && `${row.method} ${row.path} ${row.operation}` === operation);
    group.observedHttpErrorResponses = rows.filter(row => row.status >= 400).length;
    group.firstAttemptFailures = rows.filter(row => row.status === 0 || row.status >= 400).length;
    group.expectedFunctionalRejections = rows.filter(expected).length;
  }
  return result;
}

/** This profile is supplementary evidence, never a substitute for full classroom acceptance. */
export function incrementalClassroomOptions(environment = process.env) {
  const smoke = environment.INCREMENTAL_SMOKE === '1';
  const minutes = smoke ? [.05, .15, .1, .05] : [5, 20, 5, 5];
  const students = smoke ? 4 : 40;
  return { smoke, students, aiStudents: smoke ? 2 : 30,
    phases: ['warmup', 'steady', 'recovery', 'idle'].map((name, i) => ({ name, durationMs: minutes[i] * 60000 })),
    saveIntervalMs: 5000, readBudgetMs: 1000, writeBudgetMs: 2000, projectionBudgetMs: 500,
    aiCompletionBudgetMs: 120000, aiExecutionBudgetMs: 110000 };
}

export function assertIncrementalIsolation({ origin, environment, marker }) {
  const url = new URL(origin);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.ok(url.port && !['3000', '3002', '80', '443'].includes(url.port), 'Incremental load requires an isolated application port');
  const database = new URL(environment.DATABASE_URL);
  assert.equal(database.hostname, '127.0.0.1');
  assert.ok(database.port && database.port !== '5432', 'Incremental load requires a disposable database port');
  assert.ok(marker && marker === environment.OPENPBL_VERIFICATION_MARKER, 'Missing disposable database marker');
  assert.equal(environment.PRELAUNCH_REAL_PROVIDERS, '1', 'Incremental AI evidence requires actual configured providers');
}

const count = value => Number.isSafeInteger(value) && value >= 0;
const measured = value => Number.isFinite(value) && value >= 0;
const present = value => typeof value === 'string' && value.trim().length > 0;

function periodicLoadCoverage(report, options) {
  const failures = [];
  const clients = Array.from({ length: options.students }, (_, index) => `student-${index}`);
  const rows = Array.isArray(report.periodicLoad) ? report.periodicLoad : [];
  const windows = Array.isArray(report.faultWindows) ? report.faultWindows : [];
  const validWindows = windows.filter(window => window && ['offline', 'isolated-restart'].includes(window.kind)
    && measured(window.start) && measured(window.end) && window.end >= window.start
    && (window.kind === 'offline' ? clients.includes(window.client) : window.client === undefined));
  if (validWindows.length !== windows.length) failures.push('fault-windows:invalid');
  for (const client of [clients[0], clients[options.students / 2]]) {
    if (!validWindows.some(window => window.kind === 'offline' && window.client === client
      && window.end - window.start >= (options.smoke ? 1000 : 60000))) failures.push(`fault-windows:offline:${client}`);
  }
  if (!validWindows.some(window => window.kind === 'isolated-restart')) failures.push('fault-windows:isolated-restart');
  const injectedTicks = client => {
    const ranges = validWindows.filter(window => !window.client || window.client === client)
      .map(window => [window.start, window.end]).sort((left, right) => left[0] - right[0]);
    let durationMs = 0, previous;
    for (const [start, end] of ranges) {
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else { if (previous) durationMs += previous[1] - previous[0]; previous = [start, end]; }
    }
    if (previous) durationMs += previous[1] - previous[0];
    return Math.ceil(durationMs / options.saveIntervalMs);
  };
  for (const row of rows) {
    if (!row || !clients.includes(row.client) || !options.phases.some(phase => phase.name === row.phase)) failures.push('periodic-load:unexpected-scope');
  }
  const phases = [];
  for (const phase of options.phases) {
    const scheduledTarget = Math.floor(phase.durationMs / options.saveIntervalMs);
    const successfulTarget = Math.max(scheduledTarget > 0 ? 1 : 0, scheduledTarget - 1);
    let completeClients = 0;
    for (const client of clients) {
      const key = `${phase.name}:${client}`;
      const selected = rows.filter(row => row?.phase === phase.name && row.client === client);
      if (selected.length !== 1) { failures.push(`periodic-load:coverage:${key}`); continue; }
      const row = selected[0];
      const counters = ['saveAttempts', 'saveSuccesses', 'readSuccesses', 'scheduledTicks', 'missedDeadlines',
        'protocolSaveSuccesses', 'browserSaveSuccesses', 'protocolReadSuccesses', 'browserReadSuccesses'];
      if (counters.some(name => !count(row[name])) || !measured(row.maxLatenessMs)) {
        failures.push(`periodic-load:unmeasured:${key}`); continue;
      }
      if (row.saveSuccesses > row.saveAttempts
        || row.protocolSaveSuccesses + row.browserSaveSuccesses !== row.saveSuccesses
        || row.protocolReadSuccesses + row.browserReadSuccesses !== row.readSuccesses) {
        failures.push(`periodic-load:source-counts:${key}`); continue;
      }
      if (phase.name === 'idle') {
        if (row.saveAttempts || row.saveSuccesses) failures.push(`periodic-load:idle-write:${client}`);
        else completeClients++;
        continue;
      }
      const allowance = phase.name === 'recovery' ? injectedTicks(client) : 0;
      const requiredSuccesses = phase.name === 'recovery' ? Math.max(1, successfulTarget - allowance) : successfulTarget;
      const before = failures.length;
      const lateTicks = Array.isArray(row.lateTicks) ? row.lateTicks : [];
      const explainedLateness = phase.name === 'recovery' && lateTicks.length > 0
        && lateTicks.every(tick => measured(tick.scheduledAt) && measured(tick.observedAt)
          && tick.observedAt - tick.scheduledAt === tick.latenessMs && tick.latenessMs >= options.saveIntervalMs
          && validWindows.some(window => (!window.client || window.client === client)
            && tick.scheduledAt <= window.end && tick.observedAt >= window.start))
        && Math.max(...lateTicks.map(tick => tick.latenessMs)) === row.maxLatenessMs
        && lateTicks.reduce((sum, tick) => sum + Math.floor(tick.latenessMs / options.saveIntervalMs), 0) === row.missedDeadlines;
      if (row.scheduledTicks + row.missedDeadlines < scheduledTarget || row.missedDeadlines > allowance
        || (row.maxLatenessMs >= options.saveIntervalMs && !explainedLateness)) {
        failures.push(`periodic-load:cadence:${key}`);
      }
      if (row.saveSuccesses < requiredSuccesses || row.readSuccesses < requiredSuccesses) failures.push(`periodic-load:successes:${key}`);
      if (failures.length === before) completeClients++;
    }
    phases.push({ phase: phase.name, expectedClients: clients.length, completeClients,
      scheduledTarget: phase.name === 'idle' ? 0 : scheduledTarget,
      successfulTarget: phase.name === 'idle' ? 0 : successfulTarget,
      injectionAllowance: phase.name === 'recovery' ? 'closed per-client offline and global restart windows only' : 'none' });
  }
  const receipts = Array.isArray(report.saveReconciliation) ? report.saveReconciliation : [];
  const studentIds = new Set(), requestIds = new Set();
  for (const client of clients) {
    const selected = receipts.filter(row => row?.client === client);
    const receipt = selected[0];
    if (selected.length !== 1 || !present(receipt?.studentId) || !present(receipt?.requestId)
      || !Number.isSafeInteger(receipt?.version) || receipt.version <= 0 || receipt.pendingSave !== false
      || studentIds.has(receipt.studentId) || requestIds.has(receipt.requestId)) {
      failures.push(`save-reconciliation:unconfirmed:${client}`); continue;
    }
    studentIds.add(receipt.studentId); requestIds.add(receipt.requestId);
  }
  if (receipts.length !== clients.length || receipts.some(row => !clients.includes(row?.client))) failures.push('save-reconciliation:coverage');
  return { status: failures.length ? 'incomplete' : 'complete', saveIntervalMs: options.saveIntervalMs, phases,
    failures: [...new Set(failures)] };
}

export function evaluateIncrementalClassroom(report, options) {
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const actualPhases = Array.isArray(report.phases) ? report.phases : [];
  const rows = Array.isArray(report.periodicLoad) ? report.periodicLoad : [];
  const rounds = Array.isArray(report.aiRounds) ? report.aiRounds : [];
  const failures = checks.filter(check => check.status !== 'passed').map(check => check.name);
  for (const name of ['roster-and-live-subscriptions', 'native-save-conflict-and-shared-outbox', 'lost-save-receipt',
    'ai-round-1', 'ai-round-2', 'online-export-and-backup', 'offline-60s-and-isolated-restart',
    'confirmed-ai-receipts-survive-restart',
    'all-save-receipts-and-replay', 'word-archive-and-content', 'recommendation-and-showcase-controls', 'final-backup-and-isolated-restore']) {
    if (!checks.some(check => check.name === name && check.status === 'passed')) failures.push(`missing:${name}`);
  }
  for (const phase of options.phases) {
    const actual = actualPhases.find(row => row?.name === phase.name);
    if (!actual || !measured(actual.durationMs) || actual.durationMs < phase.durationMs) failures.push(`duration:${phase.name}`);
  }
  if (report.students !== options.students || report.teachers !== 2
    || report.brands?.['google-chrome'] !== options.students / 2 || report.brands?.['microsoft-edge'] !== options.students / 2) failures.push('roster');
  if (rounds.length !== 2 || rounds.some(round => round?.completed !== options.aiStudents)) failures.push('two-complete-ai-rounds');
  const loadCoverage = periodicLoadCoverage(report, options);
  failures.push(...loadCoverage.failures);
  const instanceId = report.fixture?.instanceId;
  if (!present(instanceId)) failures.push('missing-fixture-identity');
  const mixed = checks.find(check => check.name === 'recommendation-and-showcase-controls' && check.status === 'passed')?.detail;
  if (mixed?.phase !== 'steady' || mixed.mainCourseId !== instanceId
    || mixed.simultaneousSavingStudents !== options.students) failures.push('missing-simultaneous-showcase-load');
  for (const phase of ['warmup', 'steady']) {
    const phaseRows = rows.filter(row => row?.phase === phase);
    const duration = options.phases.find(row => row.name === phase).durationMs;
    if (Math.floor(duration / options.saveIntervalMs) === 0) continue;
    for (const [operation, category, counter] of [
      [`POST /api/courses/${instanceId}/actions UPSERT_SUBMISSION`, 'write', 'saveSuccesses'],
      [`GET /api/courses/${instanceId}/state GET`, 'read', 'readSuccesses'],
    ]) {
      const group = report.performance?.[phase]?.[operation];
      const successes = phaseRows.reduce((sum, row) => sum + (count(row[counter]) ? row[counter] : 0), 0);
      if (!group || group.category !== category || !count(group.samples) || group.samples < Math.max(1, successes)) failures.push(`missing-performance:${phase}:${category}`);
    }
  }
  for (const [phase, operations] of Object.entries(report.performance ?? {})) for (const [operation, group] of Object.entries(operations)) {
    if (!group || !count(group.failures) || group.failures || !count(group.unmeasured) || group.unmeasured
      || !measured(group.p95Ms) || group.p95Ms > (group.category === 'read' ? options.readBudgetMs : options.writeBudgetMs)) failures.push(`performance:${phase}:${operation}`);
  }
  for (const [window, observation] of Object.entries(report.operationPerformance ?? {})) {
    for (const [operation, group] of Object.entries(observation.during ?? {})) {
      if (!group || !count(group.failures) || group.failures || !count(group.unmeasured) || group.unmeasured
        || !measured(group.p95Ms) || group.p95Ms > (group.category === 'read' ? options.readBudgetMs : options.writeBudgetMs)) {
        failures.push(`performance-window:${window}:${operation}`);
      }
    }
  }
  const projections = Array.isArray(report.projections) ? report.projections : [];
  const p95 = values => values.toSorted((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
  if (!projections.length || projections.some(row => !row || row.receivers !== options.students + 2
    || !measured(row.httpMs) || !measured(row.lastReceiverMs))) failures.push('projection-delivery');
  for (const phase of new Set(projections.filter(Boolean).map(row => row.phase))) {
    const selected = projections.filter(row => row?.phase === phase);
    if (p95(selected.map(row => row.httpMs)) > options.projectionBudgetMs || p95(selected.map(row => row.lastReceiverMs)) > options.projectionBudgetMs) failures.push(`projection-p95:${phase}`);
  }
  if (report.errors?.length) failures.push('unexpected-errors');
  return { status: failures.length ? 'failed' : options.smoke ? 'partial' : 'passed', failures: [...new Set(failures)],
    periodicLoadCoverage: loadCoverage, scope: 'incremental-changes-only', fullClassroomAcceptance: false };
}

/** Separate, opt-in supplement; never feeds or passes the 35-minute contract. */
export function assertShowcaseLoadOnlyOptions(options, environment) {
  assert.equal(options.smoke, false); assert.equal(options.students, 40); assert.equal(options.saveIntervalMs, 5000);
  assert.equal(options.readBudgetMs, 1000); assert.equal(options.writeBudgetMs, 2000);
  assert.equal(environment.PRELAUNCH_REAL_PROVIDERS, '1');
  for (const flag of ['INCREMENTAL_CALLERS_ONLY', 'INCREMENTAL_SHOWCASE_ONLY', 'INCREMENTAL_VIEWERS_ONLY']) assert.notEqual(environment[flag], '1', `Choose one focused mode: ${flag}`);
}

export function isIncrementalRestartConsoleFailure(message, restartInProgress) {
  return restartInProgress && /ERR_CONNECTION|ERR_EMPTY_RESPONSE|502|503|504|Course synchronization failed|WebSocket connection.*failed: Connection closed before receiving a handshake response/.test(message);
}

export function evaluateShowcaseLoadOnly(report, options) {
  const failures = [], require = (condition, reason) => { if (!condition) failures.push(reason); };
  const clients = Array.from({ length: 40 }, (_, index) => `student-${index}`), rows = report.periodicLoad ?? [];
  const receipts = report.saveReconciliation ?? [], courseId = report.fixture?.instanceId;
  require(!options.smoke && options.students === 40 && report.students === 40 && report.teachers === 2
    && report.brands?.['google-chrome'] === 20 && report.brands?.['microsoft-edge'] === 20 && present(courseId), 'roster');
  const duration = report.phases?.find(row => row.name === 'steady')?.durationMs;
  require(measured(duration) && duration > 0, 'duration');
  const target = Math.max(1, Math.floor(duration / options.saveIntervalMs)), maximumTicks = Math.floor(duration / options.saveIntervalMs) + 1;
  require(rows.length === 40 && receipts.length === 40, 'coverage');
  for (const client of clients) {
    const selected = rows.filter(row => row.client === client && row.phase === 'steady'), saved = receipts.filter(row => row.client === client);
    const row = selected[0], receipt = saved[0];
    require(selected.length === 1 && row && ['scheduledTicks', 'saveAttempts', 'saveSuccesses', 'readSuccesses', 'missedDeadlines',
      'protocolSaveSuccesses', 'browserSaveSuccesses', 'protocolReadSuccesses', 'browserReadSuccesses'].every(key => count(row[key]))
      && row.scheduledTicks >= target && row.scheduledTicks <= maximumTicks && row.saveSuccesses >= row.scheduledTicks && row.readSuccesses >= row.scheduledTicks
      && row.saveAttempts >= row.saveSuccesses && row.missedDeadlines === 0 && measured(row.maxLatenessMs) && row.maxLatenessMs < 5000
      && row.protocolSaveSuccesses + row.browserSaveSuccesses === row.saveSuccesses
      && row.protocolReadSuccesses + row.browserReadSuccesses === row.readSuccesses, `periodic-load:${client}`);
    require(saved.length === 1 && receipt && receipt.courseId === courseId && ['studentId', 'participationId', 'submissionId', 'requestId', 'sha256'].every(key => present(receipt[key]))
      && count(receipt.beforeVersion) && count(receipt.version) && count(receipt.duringVersion) && receipt.duringVersion > receipt.beforeVersion && receipt.version >= receipt.duringVersion
      && receipt.replayedVersion === receipt.version && receipt.pendingSave === false, `save-reconciliation:${client}`);
  }
  for (const key of ['studentId', 'participationId', 'submissionId', 'requestId']) require(new Set(receipts.map(row => row[key])).size === 40, `save-scope:${key}`);
  const checks = report.checks ?? [];
  for (const name of ['roster-and-live-subscriptions', 'recommendation-and-showcase-controls', 'all-save-receipts-and-replay', 'source-identity-unchanged', 'focused-context-cleanup'])
    require(checks.some(check => check.name === name && check.status === 'passed'), `missing:${name}`);
  const proof = checks.find(check => check.name === 'recommendation-and-showcase-controls')?.detail;
  require(proof?.phase === 'steady' && proof.mainInstanceId === courseId && present(proof.mixedInstanceId) && proof.mixedInstanceId !== courseId
    && proof.sourceCourseIsolated === true && proof.originalPagesPreserved === true && proof.representatives === 2 && proof.recommendationVersions === 4
    && proof.documentPreviews === 2 && proof.pdfPages === 2 && proof.oldControllerRejected === true && proof.stageChangeEndedPresentation === true
    && proof.actualProviderRecommendations === true, 'showcase-evidence');
  for (const [operation, counter] of [[`POST /api/courses/${courseId}/actions UPSERT_SUBMISSION`, 'saveSuccesses'], [`GET /api/courses/${courseId}/state GET`, 'readSuccesses']]) {
    const group = report.performance?.steady?.[operation];
    require(group && count(group.samples) && group.samples >= rows.reduce((sum, row) => sum + (count(row[counter]) ? row[counter] : 0), 0), `missing-performance:${operation}`);
  }
  for (const [phase, operations] of Object.entries(report.performance ?? {})) for (const [operation, group] of Object.entries(operations))
    require(group && count(group.failures) && group.failures === 0 && count(group.unmeasured) && group.unmeasured === 0
      && measured(group.p95Ms) && group.p95Ms <= (group.category === 'read' ? 1000 : 2000), `performance:${phase}:${operation}`);
  for (const client of [...clients, 'teacher-0', 'teacher-1']) {
    const phases = report.performanceByClient?.[client];
    require(phases && Object.keys(phases.steady ?? {}).length > 0, `missing-client-performance:${client}`);
    for (const [phase, operations] of Object.entries(phases ?? {})) for (const [operation, group] of Object.entries(operations))
      require(group && count(group.failures) && group.failures === 0 && count(group.unmeasured) && group.unmeasured === 0
        && measured(group.p95Ms) && group.p95Ms <= (group.category === 'read' ? 1000 : 2000), `client-performance:${client}:${phase}:${operation}`);
    if (!clients.includes(client)) continue;
    const row = rows.find(row => row.client === client);
    for (const [operation, counter] of [[`POST /api/courses/${courseId}/actions UPSERT_SUBMISSION`, 'saveSuccesses'], [`GET /api/courses/${courseId}/state GET`, 'readSuccesses']]) {
      const group = phases?.steady?.[operation];
      require(row && group && count(group.samples) && group.samples >= row[counter], `missing-client-performance:${client}:${operation}`);
    }
  }
  require(checks.every(check => check.status === 'passed') && !report.errors?.length && !report.injectedFailures?.length, 'unexpected-errors');
  return { status: failures.length ? 'failed' : 'passed', failures, scope: 'showcase-save-load-only', fullClassroomAcceptance: false };
}
