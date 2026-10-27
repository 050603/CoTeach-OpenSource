import test from 'node:test';
import assert from 'node:assert/strict';
import { incrementalClassroomOptions, assertIncrementalIsolation, evaluateIncrementalClassroom, summarizeIncrementalTraffic, assertShowcaseLoadOnlyOptions, evaluateShowcaseLoadOnly, isIncrementalRestartConsoleFailure } from './incremental-classroom-contract.mjs';

const options = incrementalClassroomOptions({});
const instanceId = 'incremental-fixture';
const saveOperation = `POST /api/courses/${instanceId}/actions UPSERT_SUBMISSION`;
const readOperation = `GET /api/courses/${instanceId}/state GET`;
const measuredGroup = (category, samples, p95Ms) => ({ category, samples, p95Ms, failures: 0, unmeasured: 0 });

test('verified stale-controller rejections retain raw HTTP counts and measured latency', () => {
  const row = { phase: 'steady', category: 'write', method: 'PATCH', operation: 'PATCH',
    path: '/api/courses/isolated/showcase/presentation', status: 409, expectedStatus: 409,
    errorCode: 'PROJECTION_CONTROL_CONFLICT', elapsedMs: 2100, timingSource: 'api-request-monotonic' };
  const operation = `PATCH ${row.path} PATCH`;
  const group = summarizeIncrementalTraffic([row], 'steady')[operation];
  assert.equal(group.failures, 0); assert.equal(group.expectedFunctionalRejections, 1);
  assert.equal(group.observedHttpErrorResponses, 1); assert.equal(group.p95Ms, 2100);
  assert.equal(group.firstAttemptFailures, 1);
  assert.equal(row.status, 409);
  for (const replacement of [{ expectedStatus: 200 }, { errorCode: 'DATABASE_FAILED' }, { status: 500 }]) {
    assert.equal(summarizeIncrementalTraffic([{ ...row, ...replacement }], 'steady')[operation].failures, 1);
  }
});

function complete(profile = options) {
  const periodicLoad = profile.phases.flatMap(phase => Array.from({ length: profile.students }, (_, index) => {
    const ticks = phase.name === 'idle' ? 0 : Math.floor(phase.durationMs / profile.saveIntervalMs);
    return { phase: phase.name, client: `student-${index}`, scheduledTicks: ticks,
      saveAttempts: ticks, saveSuccesses: ticks, readSuccesses: ticks, missedDeadlines: 0, maxLatenessMs: 1,
      protocolSaveSuccesses: ticks, browserSaveSuccesses: 0, protocolReadSuccesses: ticks, browserReadSuccesses: 0 };
  }));
  const performance = Object.fromEntries(['warmup', 'steady'].map(phase => {
    const ticks = Math.floor(profile.phases.find(row => row.name === phase).durationMs / profile.saveIntervalMs);
    return [phase, ticks ? { [saveOperation]: measuredGroup('write', ticks * profile.students, 2000),
      [readOperation]: measuredGroup('read', ticks * profile.students, 1000) } : {}];
  }));
  return { students: profile.students, teachers: 2, fixture: { instanceId },
    brands: { 'google-chrome': profile.students / 2, 'microsoft-edge': profile.students / 2 },
    checks: ['roster-and-live-subscriptions', 'native-save-conflict-and-shared-outbox', 'lost-save-receipt',
      'ai-round-1', 'ai-round-2', 'online-export-and-backup', 'offline-60s-and-isolated-restart',
      'confirmed-ai-receipts-survive-restart',
      'all-save-receipts-and-replay', 'word-archive-and-content', 'recommendation-and-showcase-controls', 'final-backup-and-isolated-restore']
      .map(name => ({ name, status: 'passed', ...(name === 'recommendation-and-showcase-controls'
        ? { detail: { phase: 'steady', mainCourseId: instanceId, simultaneousSavingStudents: profile.students } } : {}) })),
    phases: profile.phases.map(phase => ({ ...phase })),
    aiRounds: [{ completed: profile.aiStudents }, { completed: profile.aiStudents }], errors: [],
    faultWindows: [
      { kind: 'offline', client: 'student-0', start: 0, end: profile.smoke ? 1000 : 60000 },
      { kind: 'offline', client: `student-${profile.students / 2}`, start: 0, end: profile.smoke ? 1000 : 60000 },
      { kind: 'isolated-restart', start: 100000, end: 105000 },
    ], periodicLoad, performance,
    saveReconciliation: Array.from({ length: profile.students }, (_, index) => ({ client: `student-${index}`,
      studentId: `student-id-${index}`, requestId: `saved-request-${index}`, version: 100, pendingSave: false })),
    projections: [{ phase: 'steady', receivers: profile.students + 2, httpMs: 500, lastReceiverMs: 500 }] };
}

function fails(mutate, expected) {
  const report = complete(); mutate(report);
  const result = evaluateIncrementalClassroom(report, options);
  assert.equal(result.status, 'failed');
  if (expected) assert.ok(result.failures.some(failure => expected.test(failure)), result.failures.join('\n'));
  return result;
}

test('a complete profile keeps the existing latency budgets and full classroom limitation', () => {
  const result = evaluateIncrementalClassroom(complete(), options);
  assert.equal(result.status, 'passed');
  assert.equal(result.periodicLoadCoverage.status, 'complete');
  assert.equal(result.fullClassroomAcceptance, false);
  assert.deepEqual(result.periodicLoadCoverage.phases.map(phase => [phase.phase, phase.successfulTarget]),
    [['warmup', 59], ['steady', 239], ['recovery', 59], ['idle', 0]]);
});

test('requires every timed window, both full AI rounds and every projection receiver', () => {
  for (const mutate of [r => r.phases.pop(), r => r.aiRounds[1].completed--,
    r => r.projections[0].receivers--, r => r.performance.steady[saveOperation].p95Ms++,
    r => r.performance.steady[readOperation].p95Ms++, r => r.errors.push({ message: 'timeout' }),
    r => r.performance.steady[saveOperation].unmeasured++, r => r.checks.push({ name: 'save', status: 'failed' })]) fails(mutate);
});

test('check labels and an unrelated fast read cannot replace observed load evidence', () => {
  fails(r => { delete r.periodicLoad; }, /periodic-load:coverage/);
  fails(r => { r.periodicLoad = {}; }, /periodic-load:coverage/);
  fails(r => { delete r.saveReconciliation; }, /save-reconciliation:unconfirmed/);
  fails(r => { r.performance.steady = { unrelated: measuredGroup('read', 1, 1) }; }, /missing-performance:steady/);
  fails(r => { delete r.performance.warmup[saveOperation]; }, /missing-performance:warmup:write/);
  fails(r => { delete r.fixture; }, /missing-fixture-identity/);
  fails(r => { delete r.checks.find(check => check.name === 'recommendation-and-showcase-controls').detail; }, /missing-simultaneous-showcase-load/);
  fails(r => { r.checks.find(check => check.name === 'recommendation-and-showcase-controls').detail.phase = 'reconciliation'; }, /missing-simultaneous-showcase-load/);
});

test('a slow save during online backup cannot be hidden by a fast full steady window', () => {
  fails(r => { r.operationPerformance = { backup: { during: { [saveOperation]: measuredGroup('write', 40, 2001) } } }; },
    /performance-window:backup/);
});

test('requires exact coverage of every student in every phase, without duplicate evidence', () => {
  fails(r => { r.periodicLoad = r.periodicLoad.filter(row => row.client !== 'student-39'); }, /periodic-load:coverage:steady:student-39/);
  fails(r => { r.periodicLoad.push({ ...r.periodicLoad[0] }); }, /periodic-load:coverage:warmup:student-0/);
  fails(r => { r.periodicLoad[0].client = 'student-40'; }, /periodic-load:unexpected-scope/);
  fails(r => { r.periodicLoad[0].phase = 'not-a-phase'; }, /periodic-load:unexpected-scope/);
});

test('permits one successful-cycle boundary difference while retaining all scheduled deadlines', () => {
  const report = complete();
  for (const row of report.periodicLoad.filter(row => ['warmup', 'steady'].includes(row.phase))) {
    row.saveSuccesses--; row.protocolSaveSuccesses--; row.readSuccesses--; row.protocolReadSuccesses--;
  }
  assert.equal(evaluateIncrementalClassroom(report, options).status, 'passed');
  fails(r => { r.periodicLoad.find(row => row.phase === 'steady').scheduledTicks--; }, /periodic-load:cadence:steady/);
  fails(r => {
    const row = r.periodicLoad.find(row => row.phase === 'steady');
    row.saveSuccesses -= 2; row.protocolSaveSuccesses -= 2;
  }, /periodic-load:successes:steady/);
  fails(r => {
    const row = r.periodicLoad.find(row => row.phase === 'warmup');
    row.readSuccesses -= 2; row.protocolReadSuccesses -= 2;
  }, /periodic-load:successes:warmup/);
});

test('elapsed duration cannot hide missed deadlines or catch-up bursts', () => {
  const result = fails(r => {
    const row = r.periodicLoad.find(row => row.phase === 'steady');
    row.missedDeadlines = 1;
    row.saveAttempts += 10; row.saveSuccesses += 10; row.protocolSaveSuccesses += 10;
    r.performance.steady[saveOperation].samples += 10;
  }, /periodic-load:cadence:steady/);
  assert.equal(result.periodicLoadCoverage.status, 'incomplete');
  fails(r => { r.periodicLoad.find(row => row.phase === 'steady').maxLatenessMs = 5000; }, /periodic-load:cadence:steady/);
});

test('real UI saves may replace protocol saves only with matching source counters and timing evidence', () => {
  const report = complete();
  const row = report.periodicLoad.find(row => row.phase === 'steady');
  row.protocolSaveSuccesses -= 2; row.browserSaveSuccesses += 2;
  row.protocolReadSuccesses--; row.browserReadSuccesses++;
  assert.equal(evaluateIncrementalClassroom(report, options).status, 'passed');
  fails(r => { r.periodicLoad[0].browserSaveSuccesses++; }, /periodic-load:source-counts/);
  fails(r => { r.periodicLoad[0].browserReadSuccesses++; }, /periodic-load:source-counts/);
  fails(r => { r.periodicLoad[0].saveAttempts = 1; }, /periodic-load:source-counts/);
  fails(r => { r.performance.steady[saveOperation].samples = 1; }, /missing-performance:steady:write/);
  fails(r => { delete r.periodicLoad[0].protocolSaveSuccesses; }, /periodic-load:unmeasured/);
});

test('recovery subtracts only each affected client closed fault window and still requires actual saves', () => {
  const report = complete();
  const selected = report.periodicLoad.find(row => row.phase === 'recovery' && row.client === 'student-0');
  Object.assign(selected, { saveAttempts: 46, saveSuccesses: 46, readSuccesses: 46,
    protocolSaveSuccesses: 46, protocolReadSuccesses: 46, missedDeadlines: 13 });
  assert.equal(evaluateIncrementalClassroom(report, options).status, 'passed');
  fails(r => {
    const row = r.periodicLoad.find(row => row.phase === 'recovery' && row.client === 'student-1');
    Object.assign(row, { saveAttempts: 46, saveSuccesses: 46, readSuccesses: 46,
      protocolSaveSuccesses: 46, protocolReadSuccesses: 46, missedDeadlines: 13 });
  }, /periodic-load:(?:successes|cadence):recovery:student-1/);
  fails(r => {
    const row = r.periodicLoad.find(row => row.phase === 'recovery' && row.client === 'student-0');
    Object.assign(row, { saveAttempts: 0, saveSuccesses: 0, readSuccesses: 0, protocolSaveSuccesses: 0, protocolReadSuccesses: 0 });
  }, /periodic-load:successes:recovery:student-0/);
  fails(r => { delete r.faultWindows[0].end; }, /fault-windows:invalid/);
  fails(r => { r.faultWindows[0].end = 59000; }, /fault-windows:offline:student-0/);
  fails(r => { r.faultWindows.pop(); }, /fault-windows:isolated-restart/);
});

test('overlapping injections do not count the same missed time twice', () => {
  fails(r => {
    r.faultWindows[2] = { kind: 'isolated-restart', start: 50000, end: 60000 };
    const row = r.periodicLoad.find(row => row.phase === 'recovery' && row.client === 'student-0');
    Object.assign(row, { saveAttempts: 45, saveSuccesses: 45, readSuccesses: 45,
      protocolSaveSuccesses: 45, protocolReadSuccesses: 45, missedDeadlines: 12 });
  }, /periodic-load:successes:recovery:student-0/);
});

test('a late recovery tick requires exact timing evidence overlapping its actual injected window', () => {
  const report = complete();
  const row = report.periodicLoad.find(row => row.phase === 'recovery' && row.client === 'student-1');
  Object.assign(row, { scheduledTicks: 59, missedDeadlines: 1, maxLatenessMs: 5000,
    lateTicks: [{ scheduledAt: 100000, observedAt: 105000, latenessMs: 5000 }] });
  assert.equal(evaluateIncrementalClassroom(report, options).status, 'passed');
  delete row.lateTicks;
  assert.ok(evaluateIncrementalClassroom(report, options).failures.includes('periodic-load:cadence:recovery:student-1'));
  row.lateTicks = [{ scheduledAt: 200000, observedAt: 205000, latenessMs: 5000 }];
  assert.ok(evaluateIncrementalClassroom(report, options).failures.includes('periodic-load:cadence:recovery:student-1'));
});

test('idle may contain only background reads and must retain zero periodic writes', () => {
  const report = complete();
  for (const row of report.periodicLoad.filter(row => row.phase === 'idle')) {
    row.readSuccesses = 3; row.browserReadSuccesses = 3;
  }
  report.performance.idle = { [readOperation]: measuredGroup('read', 120, 1000) };
  assert.equal(evaluateIncrementalClassroom(report, options).status, 'passed');
  fails(r => { r.periodicLoad.find(row => row.phase === 'idle').saveAttempts++; }, /periodic-load:idle-write/);
  fails(r => { r.periodicLoad = r.periodicLoad.filter(row => row.phase !== 'idle'); }, /periodic-load:coverage:idle/);
  fails(r => { r.phases.find(row => row.name === 'idle').durationMs--; }, /duration:idle/);
});

test('requires a distinct confirmed receipt and an empty pending save for every actor', () => {
  fails(r => { r.saveReconciliation[0].pendingSave = true; }, /save-reconciliation:unconfirmed:student-0/);
  fails(r => { delete r.saveReconciliation[0].pendingSave; }, /save-reconciliation:unconfirmed:student-0/);
  fails(r => { r.saveReconciliation.pop(); }, /save-reconciliation:coverage/);
  fails(r => { r.saveReconciliation[1].studentId = r.saveReconciliation[0].studentId; }, /save-reconciliation:unconfirmed/);
  fails(r => { r.saveReconciliation[1].requestId = r.saveReconciliation[0].requestId; }, /save-reconciliation:unconfirmed/);
});

test('missing, nonfinite and negative measurements cannot become successful evidence', () => {
  fails(r => { r.periodicLoad[0].maxLatenessMs = NaN; }, /periodic-load:unmeasured/);
  fails(r => { r.periodicLoad[0].scheduledTicks = -1; }, /periodic-load:unmeasured/);
  fails(r => { r.periodicLoad[0].readSuccesses = Infinity; }, /periodic-load:unmeasured/);
  fails(r => { delete r.performance.steady[saveOperation].p95Ms; }, /performance:steady/);
  fails(r => { r.performance.steady[readOperation].p95Ms = NaN; }, /performance:steady/);
  fails(r => { delete r.projections[0].httpMs; }, /projection-delivery/);
  fails(r => { r.phases[0].durationMs = NaN; }, /duration:warmup/);
});

test('smoke keeps its short actual windows and can only produce partial evidence', () => {
  const smoke = incrementalClassroomOptions({ INCREMENTAL_SMOKE: '1' });
  assert.equal(evaluateIncrementalClassroom(complete(smoke), smoke).status, 'partial');
  const report = complete(smoke); report.periodicLoad.find(row => row.phase === 'steady').scheduledTicks = 0;
  assert.equal(evaluateIncrementalClassroom(report, smoke).status, 'failed');
});

test('rejects deployed targets, missing markers and model substitutes before any mutation', () => {
  const isolated = { origin: 'http://127.0.0.1:3198', marker: 'owned', environment: {
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:49152/postgres', OPENPBL_VERIFICATION_MARKER: 'owned', PRELAUNCH_REAL_PROVIDERS: '1' } };
  assert.doesNotThrow(() => assertIncrementalIsolation(isolated));
  for (const origin of ['https://coteach.cn', 'http://127.0.0.1:3000', 'http://127.0.0.1:3002']) assert.throws(() => assertIncrementalIsolation({ ...isolated, origin }));
  assert.throws(() => assertIncrementalIsolation({ ...isolated, marker: 'other' }));
  assert.throws(() => assertIncrementalIsolation({ ...isolated, environment: { ...isolated.environment, PRELAUNCH_REAL_PROVIDERS: '0' } }));
});

function focusedShowcase() {
  const report = complete(); report.phases = [{ name: 'steady', durationMs: 10000 }]; report.aiRounds = [];
  report.periodicLoad = report.periodicLoad.filter(row => row.phase === 'steady').map(row => ({ ...row, scheduledTicks: 2,
    saveAttempts: 2, saveSuccesses: 2, readSuccesses: 2, protocolSaveSuccesses: 2, protocolReadSuccesses: 2 }));
  report.performance = { steady: { [saveOperation]: measuredGroup('write', 80, 2000), [readOperation]: measuredGroup('read', 80, 1000) } };
  report.performanceByClient = Object.fromEntries([...report.periodicLoad.map(row => [row.client,
    { steady: { [saveOperation]: measuredGroup('write', 2, 2000), [readOperation]: measuredGroup('read', 2, 1000) } }]),
    ...['teacher-0', 'teacher-1'].map(client => [client, { steady: { [readOperation]: measuredGroup('read', 1, 100) } }])]);
  report.saveReconciliation = report.saveReconciliation.map((row, index) => ({ ...row, courseId: instanceId,
    participationId: `participation-${index}`, submissionId: `submission-${index}`, beforeVersion: 1, duringVersion: row.version, replayedVersion: row.version, sha256: 'digest' }));
  report.checks = ['roster-and-live-subscriptions', 'recommendation-and-showcase-controls', 'all-save-receipts-and-replay', 'source-identity-unchanged', 'focused-context-cleanup']
    .map(name => ({ name, status: 'passed' }));
  report.checks[1].detail = { phase: 'steady', mainInstanceId: instanceId, mixedInstanceId: 'independent-mixed-course', sourceCourseIsolated: true,
    originalPagesPreserved: true, representatives: 2, recommendationVersions: 4, documentPreviews: 2, pdfPages: 2, oldControllerRejected: true,
    stageChangeEndedPresentation: true, actualProviderRecommendations: true };
  return report;
}
test('showcase load-only opt-in rejects smoke, changed budgets, model substitutes and competing modes', () => {
  assert.doesNotThrow(() => assertShowcaseLoadOnlyOptions(options, { PRELAUNCH_REAL_PROVIDERS: '1' }));
  for (const difference of [{ smoke: true }, { students: 4 }, { saveIntervalMs: 10000 }, { readBudgetMs: 2000 }, { writeBudgetMs: 3000 }])
    assert.throws(() => assertShowcaseLoadOnlyOptions({ ...options, ...difference }, { PRELAUNCH_REAL_PROVIDERS: '1' }));
  for (const difference of [{ PRELAUNCH_REAL_PROVIDERS: '0' }, { INCREMENTAL_CALLERS_ONLY: '1' }, { INCREMENTAL_SHOWCASE_ONLY: '1' }, { INCREMENTAL_VIEWERS_ONLY: '1' }])
    assert.throws(() => assertShowcaseLoadOnlyOptions(options, { PRELAUNCH_REAL_PROVIDERS: '1', ...difference }));
});
test('forty saving students and full independent showcase proof can pass only this focused scope without full AI/export/fault reruns', () => {
  const result = evaluateShowcaseLoadOnly(focusedShowcase(), options);
  assert.equal(result.status, 'passed'); assert.equal(result.scope, 'showcase-save-load-only'); assert.equal(result.fullClassroomAcceptance, false);
  assert.equal(evaluateIncrementalClassroom(focusedShowcase(), options).status, 'failed');
});
test('focused load refuses partial viewers, missing saves, missed cadence, wrong scope, duplicate receipts and slow or failed operations', () => {
  const mutations = [r => r.students--, r => r.teachers--, r => r.brands['google-chrome']--, r => r.periodicLoad.pop(),
    r => r.periodicLoad.push(r.periodicLoad[0]), r => r.periodicLoad[0].saveSuccesses = 0, r => r.periodicLoad[0].readSuccesses = 0,
    r => r.periodicLoad[0].scheduledTicks = 1, r => Object.assign(r.periodicLoad[0], { scheduledTicks: 4, saveAttempts: 4, saveSuccesses: 4,
      readSuccesses: 4, protocolSaveSuccesses: 4, protocolReadSuccesses: 4 }), r => r.periodicLoad[0].missedDeadlines++, r => r.periodicLoad[0].maxLatenessMs = 5000,
    r => r.periodicLoad[0].protocolSaveSuccesses--, r => r.saveReconciliation[0].pendingSave = true,
    r => r.saveReconciliation[0].version = r.saveReconciliation[0].beforeVersion, r => r.saveReconciliation[0].duringVersion = r.saveReconciliation[0].beforeVersion,
    r => r.saveReconciliation[0].replayedVersion++,
    r => r.saveReconciliation[0].courseId = 'other-course', r => r.saveReconciliation[0].studentId = r.saveReconciliation[1].studentId,
    r => r.checks[1].detail.recommendationVersions = 2, r => r.checks[1].detail.pdfPages = 0, r => r.checks[1].detail.actualProviderRecommendations = false,
    r => r.checks.pop(), r => r.checks[0].status = 'failed', r => r.errors.push({ error: 'real failure' }), r => r.phases[0].durationMs = NaN,
    r => r.performance.steady[saveOperation].p95Ms++, r => r.performance.steady[readOperation].p95Ms++,
    r => r.performance.steady[saveOperation].failures++, r => r.performance.steady[readOperation].unmeasured++,
    r => delete r.performance.steady[readOperation], r => r.performance.steady[readOperation].samples = 0];
  for (const mutate of mutations) { const report = focusedShowcase(); mutate(report); assert.equal(evaluateShowcaseLoadOnly(report, options).status, 'failed'); }
});

test('fast student reads cannot dilute a slow teacher or one slow student below the unchanged focused latency gate', () => {
  const report = focusedShowcase();
  const raw = Array.from({ length: 100 }, () => ({ client: 'student-0', phase: 'steady', method: 'GET', path: `/api/courses/${instanceId}/state`,
    operation: 'GET', category: 'read', status: 200, elapsedMs: 100, timingSource: 'api-request-monotonic' }));
  raw.push({ ...raw[0], client: 'teacher-0', elapsedMs: 6300 });
  report.performance.steady[readOperation] = summarizeIncrementalTraffic(raw, 'steady')[readOperation];
  assert.equal(report.performance.steady[readOperation].p95Ms, 100);
  report.performanceByClient['teacher-0'].steady = summarizeIncrementalTraffic(raw.filter(row => row.client === 'teacher-0'), 'steady');
  const result = evaluateShowcaseLoadOnly(report, options);
  assert.equal(result.status, 'failed'); assert.ok(result.failures.some(row => row.startsWith('client-performance:teacher-0:')));
  for (const mutate of [r => delete r.performanceByClient, r => delete r.performanceByClient['teacher-1'],
    r => r.performanceByClient['student-2'].steady[readOperation].p95Ms = 1001,
    r => r.performanceByClient['student-2'].steady[saveOperation].p95Ms = 2001,
    r => r.performanceByClient['student-2'].steady[readOperation].samples = 0]) {
    const current = focusedShowcase(); mutate(current); assert.equal(evaluateShowcaseLoadOnly(current, options).status, 'failed');
  }
});

test('503 console responses are injected only during the explicit restart; unrelated presence cancellation stays unresolved', () => {
  const error = 'Failed to load resource: the server responded with a status of 503 (Service Unavailable)';
  assert.equal(isIncrementalRestartConsoleFailure(error, true), true);
  assert.equal(isIncrementalRestartConsoleFailure(error, false), false);
  assert.equal(isIncrementalRestartConsoleFailure('[presence] synchronization failed TypeError: Failed to fetch net::ERR_ABORTED', true), false);
  assert.equal(isIncrementalRestartConsoleFailure('A real unrelated database error', true), false);
});
