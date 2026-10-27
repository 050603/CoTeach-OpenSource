import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ACCEPTANCE_CHECKS, ACCEPTANCE_BRANDS, CLASSROOM_REQUIRED_CHECKS, CLASSROOM_REQUIRED_EVIDENCE, CLASSROOM_STAGES,
  CLASSROOM_PHASE_MINUTES, CLASSROOM_PERFORMANCE_PHASES, READ_API_NATIVE_PROTOCOL_CHECKS, BROWSER_SUITE_SPECS, ISOLATION_REQUIRED_CHECKS, acceptanceExitCode,
  parseAcceptanceOptions, captureWorkspaceIdentity, assertAcceptanceIdentityUnchanged,
  evaluateChildReport, evaluateTestReport, evaluateAcceptance, evaluateStudentManifest,
} from './classroom-acceptance-contract.mjs';

import { READ_API_NATIVE_ROUTES, READ_API_NATIVE_PROTOCOL_VERSION } from './prelaunch-read-api-contract.mjs';

import { sustainedLesson } from './classroom-acceptance-test-fixtures.mjs';
import { evaluateClassroomSoak } from './classroom-acceptance-soak.mjs';
import { evaluateSustainedClassroom } from './classroom-acceptance-evidence.mjs';
const options = parseAcceptanceOptions();
const providerHash = 'a'.repeat(64);
const context = { buildId: 'candidate-build', runId: 'current-run', options, startedAt: '2026-10-16T00:00:00Z' };
const browserIdentity = label => ({ label, executablePath: `/browsers/${label}`, version: '130.0.0.0',
  executableVersion: `${label === 'google-chrome' ? 'Google Chrome' : 'Microsoft Edge'} 130.0.0.0`,
  userAgent: `Mozilla/5.0 HeadlessChrome/130.0.0.0${label === 'microsoft-edge' ? ' Edg/130.0.0.0' : ''}` });
const fixture = () => {
  let elapsed = Date.parse(sustainedLesson({ sequence: 3 }).startedAt);
  const continuitySnapshots = [];
  const checks = CLASSROOM_REQUIRED_CHECKS.map(name => ({ name, status: '通过', evidence: CLASSROOM_REQUIRED_EVIDENCE[name] }));
  const metrics = Object.fromEntries(CLASSROOM_PERFORMANCE_PHASES.map(stage => [stage, Object.fromEntries(['GET /api/course/state read', 'POST /api/course/actions save'].map(operation => {
    const detail = { samples: 30, p95Ms: 25, failures: 0 };
    checks.push({ name: `performance-${stage}-${operation}`, status: '通过', evidence: 'browser-real-backend', detail: { ...detail } });
    return [operation, detail];
  }))]));
  const phaseTiming = CLASSROOM_STAGES.map((stageKey, index) => {
    const duration = CLASSROOM_PHASE_MINUTES[index] * 60;
    const startedAt = new Date(elapsed).toISOString();
    for (let second = 0; second <= duration; second += 30) continuitySnapshots.push({
      at: new Date(elapsed + second * 1000).toISOString(), stageKey, students: 30, authenticatedStudents: 30, teacherAlive: true,
      providerConfigurationSha256: providerHash,
    });
    elapsed += duration * 1000;
    return { stageKey, startedAt, finishedAt: new Date(elapsed).toISOString(), actualDurationSeconds: duration };
  });
  const result = {
    buildId: context.buildId, date: '2026-10-16T05:00:00Z', mode: 'isolated-production-build-and-disposable-database',
    browser: browserIdentity('google-chrome'), realClassroomAi: true, environment: { classroomTransport: 'websocket-with-http-recovery' },
    results: [...ISOLATION_REQUIRED_CHECKS.map(name => ({ name, status: '通过' })),
      { name: 'isolated-real-provider-snapshot', status: '通过', detail: { rows: 2, sha256: providerHash, targetSha256: providerHash, target: 'disposable-database' } },
      { name: 'read-api-native-protocol', status: '通过', detail: { buildId: context.buildId,
        evidence: 'production-next-http', restoration: 'passed', requestCount: READ_API_NATIVE_ROUTES.length * 14 + 4,
        checks: [...READ_API_NATIVE_PROTOCOL_CHECKS], contractVersion: READ_API_NATIVE_PROTOCOL_VERSION, protocolMode: 'candidate',
        coveredRoutes: READ_API_NATIVE_ROUTES.map(row => ({ route: row.route, requestCount: 14,
          testedMethods: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'], optionsAllow: row.optionsAllow, clockState: 'unknown' })),
        httpIdentity: { stateAnchor: 'measured', repeatedBusinessRequests: 4, uniqueNativeIds: 4, sameAppPid: true, businessIdPreserved: true } } },
      ...structuredClone(checks)],
    classroomAcceptance: { schemaVersion: 1, runId: context.runId, teachers: 1, students: 30, actualDurationSeconds: 5400,
      startedAt: phaseTiming[0].startedAt, finishedAt: phaseTiming.at(-1).finishedAt,
      browserCounts: { 'google-chrome': 15, 'microsoft-edge': 15 },
      ...Object.fromEntries(ACCEPTANCE_BRANDS.map(brand => [brand, browserIdentity(brand)])),
      checks, phaseTiming, continuitySnapshots, metrics, runtimeConfiguration: { publicProviderConfigurationSha256: providerHash },
    },
  };
  result.classroomAcceptance = { ...sustainedLesson({ sequence: 3 }), ...result.classroomAcceptance };
  const lessons = [sustainedLesson({ sequence: 1 }), sustainedLesson({ sequence: 2 }), result.classroomAcceptance];
  result.classroomSoak = { ...evaluateClassroomSoak(lessons, options), classEvidence: lessons };
  return result;
};
const browserSuite = check => ({
  suites: BROWSER_SUITE_SPECS[check].map(file => ({ file, specs: [{ file, tests: [{
    expectedStatus: 'passed', status: 'expected', projectName: 'google-chrome', results: [{ status: 'passed' }],
  }] }] })),
  stats: { expected: BROWSER_SUITE_SPECS[check].length, unexpected: 0, skipped: 0, flaky: 0, startTime: '2026-10-16T00:01:00Z' }, errors: [],
});
const completeRun = () => ({
  options, build: { status: 'passed', buildId: context.buildId }, identityVerified: true,
  runs: ACCEPTANCE_CHECKS.flatMap(check => (['unit', 'classroom'].includes(check) ? [undefined] : ACCEPTANCE_BRANDS)
    .map(brand => ({ check, brand, exitCode: 0, verdict: { outcome: 'passed' } }))),
});

test('formal defaults are fixed; reduced duration/roster requires an explicit smoke run', () => {
  assert.equal(options.minutes, 90); assert.equal(options.students, 30); assert.equal(options.soakClasses, 3);
  assert.equal(parseAcceptanceOptions(['--smoke']).soakClasses, 1);
  assert.equal(parseAcceptanceOptions(['--checks=unit']).soakClasses, 1);
  assert.deepEqual(options.checks, ACCEPTANCE_CHECKS);
  assert.throws(() => parseAcceptanceOptions(['--minutes=1']), /smoke/);
  assert.throws(() => parseAcceptanceOptions(['--students=2']), /smoke/);
  assert.throws(() => parseAcceptanceOptions(['--smoke', '--minutes=0']));
  assert.throws(() => parseAcceptanceOptions(['--checks=classroom,classroom']));
  assert.throws(() => parseAcceptanceOptions(['--checks=unknown']));
  assert.equal(parseAcceptanceOptions(['--smoke', '--minutes=1']).minutes, 1);
});

test('success requires every selected and mandatory scope; smoke is always partial', () => {
  assert.equal(evaluateAcceptance(completeRun()).outcome, 'passed');
  const small = completeRun(); small.options = parseAcceptanceOptions(['--smoke']);
  assert.equal(evaluateAcceptance(small).outcome, 'partial');
  const missing = completeRun(); missing.runs = missing.runs.filter(run => run.check !== 'faults');
  assert.equal(evaluateAcceptance(missing).outcome, 'partial');
  const wrongBuild = completeRun(); wrongBuild.identityVerified = false;
  assert.equal(evaluateAcceptance(wrongBuild).outcome, 'partial');
  const failed = completeRun(); failed.runs[0].exitCode = 1;
  assert.equal(evaluateAcceptance(failed).outcome, 'failed');
});

test('student delivery requires every distinct roster member and preserves failed or incomplete rows', () => {
  const manifest = () => Array.from({ length: 30 }, (_, index) => ({
    index, userId: `student-${index}`, participationId: `participation-${index}`, status: '通过', errors: '',
  }));
  const settings = { students: 30 };
  assert.equal(evaluateStudentManifest(manifest(), settings).outcome, 'passed');
  assert.equal(evaluateStudentManifest(undefined, settings).outcome, 'partial');
  assert.equal(evaluateStudentManifest(manifest().slice(0, 29), settings).outcome, 'partial');
  for (const field of ['index', 'userId', 'participationId']) {
    const duplicate = manifest(); duplicate[29][field] = duplicate[0][field];
    assert.equal(evaluateStudentManifest(duplicate, settings).outcome, 'failed', field);
  }
  const failed = manifest(); failed[3].status = '失败';
  assert.equal(evaluateStudentManifest(failed, settings).outcome, 'failed');
  const incomplete = manifest(); incomplete[4].status = '未验证';
  assert.equal(evaluateStudentManifest(incomplete, settings).outcome, 'partial');
  const contradictory = manifest(); contradictory[5].errors = 'Saved answer was not retained';
  assert.equal(evaluateStudentManifest(contradictory, settings).outcome, 'failed');
});

test('valid real classroom evidence passes its scope', () => {
  assert.deepEqual(evaluateChildReport('classroom', fixture(), context), { outcome: 'passed', failures: [], missing: [] });
});

test('classroom requires its post-class native protocol proof while other child scopes do not', () => {
  const report = fixture(); report.results = report.results.filter(row => row.name !== 'read-api-native-protocol');
  const verdict = evaluateChildReport('classroom', report, context);
  assert.equal(verdict.outcome, 'partial');
  assert.ok(verdict.missing.includes('Required child result missing: read-api-native-protocol'));
  assert.equal(CLASSROOM_REQUIRED_CHECKS.includes('read-api-native-protocol'), false);
  report.results.push({ name: 'browser-ui-regressions', status: '通过' });
  assert.equal(evaluateChildReport('ui', report, { ...context, brand: 'google-chrome', testReport: browserSuite('ui') }).outcome, 'passed');
  const run = completeRun(); run.runs.find(row => row.check === 'classroom').verdict = verdict;
  Object.assign(run, evaluateAcceptance(run)); assert.equal(run.outcome, 'partial'); assert.equal(acceptanceExitCode(run), 2);
});

test('native protocol proof rejects another build, fixture evidence and failed restoration', () => {
  for (const [field, value] of [['buildId', 'different-build'], ['evidence', 'test-orchestration-fixture'], ['restoration', 'failed']]) {
    const report = fixture(); report.results.find(row => row.name === 'read-api-native-protocol').detail[field] = value;
    const verdict = evaluateChildReport('classroom', report, context);
    assert.equal(verdict.outcome, 'failed', field);
    const run = completeRun(); run.runs.find(row => row.check === 'classroom').verdict = verdict;
    Object.assign(run, evaluateAcceptance(run)); assert.equal(run.outcome, 'failed'); assert.equal(acceptanceExitCode(run), 1);
  }
});

test('native protocol success labels cannot replace missing proof metadata or real requests', () => {
  for (const change of [row => { delete row.detail; }, row => { row.detail.requestCount = 0; },
    row => { row.detail.requestCount = 1.5; }, row => { row.detail.requestCount = undefined; },
    row => { row.detail.checks = null; }, row => { delete row.detail.restoration; }]) {
    const report = fixture(); change(report.results.find(row => row.name === 'read-api-native-protocol'));
    assert.notEqual(evaluateChildReport('classroom', report, context).outcome, 'passed');
  }
});

test('every required native protocol check must be present once, not repeated to fill the count', () => {
  for (const name of READ_API_NATIVE_PROTOCOL_CHECKS) {
    const report = fixture(); const proof = report.results.find(row => row.name === 'read-api-native-protocol');
    proof.detail.checks = proof.detail.checks.filter(check => check !== name);
    const verdict = evaluateChildReport('classroom', report, context);
    assert.equal(verdict.outcome, 'partial', name);
    assert.ok(verdict.missing.includes(`Required native protocol check missing: ${name}`));
  }
  const report = fixture(); report.results.find(row => row.name === 'read-api-native-protocol').detail.checks.fill(READ_API_NATIVE_PROTOCOL_CHECKS[0]);
  assert.equal(evaluateChildReport('classroom', report, context).outcome, 'failed');
});

test('duplicate or failed native protocol result cannot be rescued by a success result', () => {
  const duplicated = fixture(); duplicated.results.push(structuredClone(duplicated.results.find(row => row.name === 'read-api-native-protocol')));
  assert.equal(evaluateChildReport('classroom', duplicated, context).outcome, 'failed');
  const failed = fixture(); failed.results.find(row => row.name === 'read-api-native-protocol').status = '失败';
  assert.equal(evaluateChildReport('classroom', failed, context).outcome, 'failed');
});

test('model/voice settings must be isolated, fingerprinted and monitored without a configuration change', () => {
  const missing = fixture(); missing.results = missing.results.filter(row => row.name !== 'isolated-real-provider-snapshot');
  assert.equal(evaluateChildReport('classroom', missing, context).outcome, 'partial');
  const incomplete = fixture(); delete incomplete.classroomAcceptance.continuitySnapshots[3].providerConfigurationSha256;
  assert.equal(evaluateChildReport('classroom', incomplete, context).outcome, 'partial');
  const changed = fixture(); changed.classroomAcceptance.continuitySnapshots[3].providerConfigurationSha256 = 'b'.repeat(64);
  assert.equal(evaluateChildReport('classroom', changed, context).outcome, 'failed');
  const corrupt = fixture(); corrupt.results.find(row => row.name === 'isolated-real-provider-snapshot').detail.targetSha256 = 'b'.repeat(64);
  assert.equal(evaluateChildReport('classroom', corrupt, context).outcome, 'partial');
});

test('a successful child exit cannot replace raw checks or complete duration', () => {
  const report = fixture(); report.classroomAcceptance.actualDurationSeconds = 5399;
  report.classroomAcceptance.checks = report.classroomAcceptance.checks.filter(check => check.name !== 'teacher-metrics');
  const result = evaluateChildReport('classroom', report, context);
  assert.equal(result.outcome, 'partial');
  assert.ok(result.missing.some(message => message.includes('teacher-metrics')));
  assert.ok(result.missing.some(message => message.includes('duration')));
});

test('every concrete mandatory function is required in both raw scopes, including all artifact modes', () => {
  for (const name of ['projection-render-latency', 'finish-and-export', 'adopted-textbook-publication', 'real-lecture-audio-preparation',
    'concurrent-ai-save-projection', 'classroom-write-close-race', 'phase-launch', 'teacher-display-reflection',
    'learning-grounded-textbook-citations', 'learning-private-chat-access-boundaries', 'grading-finished-classroom-keeps-accepted-grades',
    'learning-all-student-personal-tutor-native-audio',
    'artifact-mode-python', 'artifact-mode-c', 'artifact-mode-other', 'research-export-nonempty-source-actions', 'document-proactive-review-real-model',
    'document-proactive-comment-read-reply-reopen', 'document-ai-edit-adopt-reject-undo']) assert.ok(CLASSROOM_REQUIRED_CHECKS.includes(name), name);
  for (const name of CLASSROOM_REQUIRED_CHECKS) {
    const report = fixture(); report.classroomAcceptance.checks = report.classroomAcceptance.checks.filter(check => check.name !== name);
    assert.equal(evaluateChildReport('classroom', report, context).outcome, 'partial', name);
    const summaryOnly = fixture(); summaryOnly.results = summaryOnly.results.filter(check => check.name !== name);
    assert.equal(evaluateChildReport('classroom', summaryOnly, context).outcome, 'partial', `raw child ${name}`);
  }
  const duplicates = fixture(); duplicates.classroomAcceptance.checks.push({ ...duplicates.classroomAcceptance.checks[0] });
  assert.equal(evaluateChildReport('classroom', duplicates, context).outcome, 'failed');
});

test('provider and media work require their actual evidence category; aggregate success cannot substitute', () => {
  for (const name of ['learning-all-student-private-chat-and-durable-replay', 'learning-all-student-complete-lecture-playback',
    'learning-all-student-personal-tutor-native-audio',
    'real-lecture-audio-preparation', 'grading-concurrent-matching-fill-and-deep-real-model',
    'document-proactive-review-real-model', 'document-proactive-comment-read-reply-reopen', 'document-ai-edit-adopt-reject-undo']) {
    const report = fixture(); report.classroomAcceptance.checks.find(check => check.name === name).evidence = 'browser-real-backend';
    assert.equal(evaluateChildReport('classroom', report, context).outcome, 'partial', name);
  }
});

test('ninety minutes alone cannot substitute for continuous attendance and each stage duration', () => {
  for (const mutate of [
    report => { report.classroomAcceptance.continuitySnapshots = []; },
    report => { report.classroomAcceptance.continuitySnapshots = report.classroomAcceptance.continuitySnapshots.filter((_, i) => i % 3 === 0); },
    report => { delete report.classroomAcceptance.phaseTiming[2].startedAt; },
    report => { report.classroomAcceptance.phaseTiming[2].actualDurationSeconds = 1; },
    report => { report.classroomAcceptance.phaseTiming.reverse(); },
  ]) {
    const report = fixture(); mutate(report);
    assert.notEqual(evaluateChildReport('classroom', report, context).outcome, 'passed');
  }
  for (const mutate of [
    report => { report.classroomAcceptance.continuitySnapshots[20].authenticatedStudents = 29; },
    report => { report.classroomAcceptance.continuitySnapshots[20].teacherAlive = false; },
    report => { report.classroomAcceptance.continuitySnapshots[20].students = 29; },
    report => { report.classroomAcceptance.finishedAt = '2026-10-16T03:00:00Z'; },
    report => { report.classroomAcceptance['microsoft-edge'].userAgent = 'HeadlessChrome/130.0.0.0'; },
  ]) {
    const report = fixture(); mutate(report);
    assert.equal(evaluateChildReport('classroom', report, context).outcome, 'failed');
  }
});

test('performance success labels require actual per-stage read/write measurements within their budgets', () => {
  const noTraffic = fixture(); delete noTraffic.classroomAcceptance.metrics.make;
  assert.equal(evaluateChildReport('classroom', noTraffic, context).outcome, 'partial');
  const readOnly = fixture(); delete readOnly.classroomAcceptance.metrics.launch['POST /api/course/actions save'];
  assert.equal(evaluateChildReport('classroom', readOnly, context).outcome, 'partial');
  const tooSlow = fixture(); tooSlow.classroomAcceptance.metrics.make['POST /api/course/actions save'].p95Ms = 2001;
  assert.equal(evaluateChildReport('classroom', tooSlow, context).outcome, 'failed');
  const errors = fixture(); errors.classroomAcceptance.metrics.launch['GET /api/course/state read'].failures = 1;
  assert.equal(evaluateChildReport('classroom', errors, context).outcome, 'failed');
  const unknownTiming = fixture(); unknownTiming.classroomAcceptance.metrics.launch['GET /api/course/state read'].unmeasured = 1;
  assert.equal(evaluateChildReport('classroom', unknownTiming, context).outcome, 'partial');
  const postRead = fixture(); const operation = 'POST /api/knowledge-lecture tutor-explain';
  const metric = { category: 'read', samples: 30, p95Ms: 1001, failures: 0 };
  postRead.classroomAcceptance.metrics.launch[operation] = metric;
  for (const rows of [postRead.classroomAcceptance.checks, postRead.results]) rows.push({
    name: `performance-launch-${operation}`, status: '通过', evidence: 'browser-real-backend', detail: metric,
  });
  assert.equal(evaluateChildReport('classroom', postRead, context).outcome, 'failed');
  const omitted = fixture(); omitted.results = omitted.results.filter(row => !row.name.startsWith('performance-make-'));
  assert.equal(evaluateChildReport('classroom', omitted, context).outcome, 'partial');
});

test('measured performance failures remain failures without becoming unverified evidence', () => {
  for (const failure of ['latency', 'http-error']) {
    const report = fixture();
    const operation = 'POST /api/course/actions save';
    const name = `performance-make-${operation}`;
    const metric = report.classroomAcceptance.metrics.make[operation];
    if (failure === 'latency') metric.p95Ms = 2001;
    else metric.failures = 1;
    for (const rows of [report.classroomAcceptance.checks, report.results]) {
      Object.assign(rows.find(row => row.name === name), { status: '失败', detail: { ...metric } });
    }
    const verdict = evaluateChildReport('classroom', report, context);
    assert.equal(verdict.outcome, 'failed', failure);
    assert.deepEqual(verdict.missing, [], failure);
    assert.ok(verdict.failures.some(message => message === `Performance budget or error gate failed: ${name}`));

    const contradictory = structuredClone(report);
    contradictory.results.find(row => row.name === name).detail.samples++;
    assert.ok(evaluateChildReport('classroom', contradictory, context).failures
      .includes(`Performance result differs from measurements: ${name}`));

    const missing = structuredClone(report);
    missing.results = missing.results.filter(row => row.name !== name);
    assert.ok(evaluateChildReport('classroom', missing, context).missing.includes(`Missing performance result: ${name}`));
  }
});

test('artifact functionality cannot substitute for supplementary read/write performance evidence', () => {
  const report = fixture();
  assert.equal(evaluateChildReport('classroom', report, context).outcome, 'passed');
  delete report.classroomAcceptance.metrics['artifact-modes'];
  // Keep successful artifact function and performance labels: actual samples
  // must still be present for the separately measured supplementary phase.
  const verdict = evaluateChildReport('classroom', report, context);
  assert.equal(verdict.outcome, 'partial');
  assert.deepEqual(verdict.missing, [
    'Missing measured read traffic: artifact-modes',
    'Missing measured write traffic: artifact-modes',
  ]);
});

test('stale build/run reports, wrong brands, wrong roster and polling cannot pass', () => {
  for (const mutate of [
    report => { report.buildId = 'old-build'; },
    report => { report.classroomAcceptance.runId = 'other-run'; },
    report => { report.date = '2026-10-15T00:00:00Z'; },
    report => { report.classroomAcceptance.teachers = 2; },
    report => { report.classroomAcceptance.browserCounts['microsoft-edge'] = 0; },
    report => { report.environment.classroomTransport = 'http-polling'; },
  ]) {
    const report = fixture(); mutate(report);
    assert.equal(evaluateChildReport('classroom', report, context).outcome, 'failed');
  }
  assert.equal(evaluateChildReport('practice', { ...fixture(), browser: { label: 'chromium' } }, { ...context, brand: 'google-chrome' }).outcome, 'failed');
});

test('model mocks, unmeasured phases and unverified checks are partial, failures remain failures', () => {
  const mocked = fixture(); mocked.classroomAcceptance.checks.at(-1).evidence = 'browser-mocked-business-api';
  assert.equal(evaluateChildReport('classroom', mocked, context).outcome, 'partial');
  const phases = fixture(); phases.classroomAcceptance.phaseTiming.pop();
  assert.equal(evaluateChildReport('classroom', phases, context).outcome, 'partial');
  const pending = fixture(); pending.classroomAcceptance.checks[0].status = '未验证';
  assert.equal(evaluateChildReport('classroom', pending, context).outcome, 'partial');
  const failed = fixture(); failed.results.push({ name: 'real-save', status: '失败' });
  assert.equal(evaluateChildReport('classroom', failed, context).outcome, 'failed');
});

test('unit JSON must contain actual passing assertions; skips and empty suites cannot pass', () => {
  const unit = { success: true, numTotalTests: 1, numFailedTests: 0, numPendingTests: 0, testResults: [{ assertionResults: [{ status: 'passed' }] }] };
  assert.equal(evaluateTestReport('unit', unit).outcome, 'passed');
  unit.testResults[0].assertionResults[0].status = 'pending';
  assert.equal(evaluateTestReport('unit', unit).outcome, 'partial');
  assert.notEqual(evaluateTestReport('unit', {}).outcome, 'passed');
});

test('Playwright retries, expected failures and skips cannot be represented as normal passes', () => {
  const browser = () => ({ suites: [{ suites: [{ specs: [{ tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed' }] }] }] }] }], stats: { unexpected: 0, flaky: 0 }, errors: [] });
  assert.equal(evaluateTestReport('browser', browser()).outcome, 'passed');
  const retried = browser(); retried.suites[0].suites[0].specs[0].tests[0].results.unshift({ status: 'failed' });
  assert.equal(evaluateTestReport('browser', retried).outcome, 'failed');
  const skipped = browser(); skipped.suites[0].suites[0].specs[0].tests[0].results[0].status = 'skipped';
  assert.equal(evaluateTestReport('browser', skipped).outcome, 'partial');
  assert.equal(evaluateTestReport('browser', undefined).outcome, 'partial');
});

test('UI and fault suites need every selected spec with executed passing tests, not a summary or one mock test', () => {
  for (const check of ['ui', 'faults']) {
    const report = fixture(); report.results.push({ name: `browser-${check}-regressions`, status: '通过', evidence: 'browser-fixtures' });
    const settings = { ...context, brand: 'google-chrome', testReport: browserSuite(check) };
    assert.equal(evaluateChildReport(check, report, settings).outcome, 'passed');
    const summaryMissing = structuredClone(report); summaryMissing.results.pop();
    assert.equal(evaluateChildReport(check, summaryMissing, settings).outcome, 'partial');
    for (const mutate of [
      evidence => { evidence.suites = evidence.suites.slice(0, 1); evidence.stats.expected = 1; },
      evidence => { evidence.suites[0].specs[0].tests = []; evidence.stats.expected--; },
      evidence => { evidence.suites[0].specs[0].file = 'unrelated.spec.ts'; },
    ]) {
      const evidence = browserSuite(check); mutate(evidence);
      assert.equal(evaluateChildReport(check, report, { ...settings, testReport: evidence }).outcome, 'partial');
    }
    const stale = browserSuite(check); stale.stats.startTime = '2026-10-15T00:00:00Z';
    assert.equal(evaluateChildReport(check, report, { ...settings, testReport: stale }).outcome, 'failed');
    const mislabeled = browserSuite(check); mislabeled.suites[0].specs[0].tests[0].projectName = 'chromium';
    assert.equal(evaluateChildReport(check, report, { ...settings, testReport: mislabeled }).outcome, 'failed');
  }
});

test('incomplete formal and incomplete smoke runs exit nonzero; a complete smoke remains partial with exit zero', () => {
  const formal = completeRun(); Object.assign(formal, evaluateAcceptance(formal));
  assert.equal(acceptanceExitCode(formal), 0);
  formal.runs.pop(); Object.assign(formal, evaluateAcceptance(formal));
  assert.equal(formal.outcome, 'partial'); assert.equal(acceptanceExitCode(formal), 2);
  const smoke = completeRun(); smoke.options = parseAcceptanceOptions(['--smoke', '--checks=classroom']);
  smoke.runs = smoke.runs.filter(run => run.check === 'classroom'); Object.assign(smoke, evaluateAcceptance(smoke));
  assert.equal(smoke.outcome, 'partial'); assert.equal(acceptanceExitCode(smoke), 0);
  smoke.runs[0].verdict.outcome = 'partial'; assert.equal(acceptanceExitCode(smoke), 2);
  smoke.outcome = 'failed'; assert.equal(acceptanceExitCode(smoke), 1);
});

test('source identity captures uncommitted and new source; ignored reports do not invalidate it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'classroom-identity-test-'));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
    await mkdir(path.join(root, 'prisma/migrations/initial'), { recursive: true });
    await writeFile(path.join(root, '.gitignore'), 'reports/\n');
    await writeFile(path.join(root, 'source.mjs'), 'export const value = 1;');
    await writeFile(path.join(root, 'prisma/migrations/migration_lock.toml'), 'provider = "postgresql"');
    await writeFile(path.join(root, 'prisma/migrations/initial/migration.sql'), 'SELECT 1;');
    git(['add', '.']); git(['commit', '-qm', 'fixture']);
    const first = await captureWorkspaceIdentity(root);
    await mkdir(path.join(root, 'reports')); await writeFile(path.join(root, 'reports/report.json'), '{}');
    assertAcceptanceIdentityUnchanged(first, await captureWorkspaceIdentity(root));
    await writeFile(path.join(root, 'new.mjs'), 'export const added = true;');
    assert.throws(() => assertAcceptanceIdentityUnchanged(first, { ...first, source: { sha256: 'changed' } }), /Source/);
    assert.notEqual((await captureWorkspaceIdentity(root)).source.sha256, first.source.sha256);
    await writeFile(path.join(root, 'source.mjs'), 'export const value = 2;');
    assert.notEqual((await captureWorkspaceIdentity(root)).source.sha256, first.source.sha256);
    await writeFile(path.join(root, 'prisma/migrations/initial/migration.sql'), 'SELECT 2;');
    assert.notEqual((await captureWorkspaceIdentity(root)).migrations.sha256, first.migrations.sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('whole-class background review settlement cannot be replaced by the two representative AI checks', () => {
  const name = 'document-all-student-review-settlement';
  assert.equal(CLASSROOM_REQUIRED_EVIDENCE[name], 'browser-real-backend');
  const missing = fixture();
  missing.classroomAcceptance.checks = missing.classroomAcceptance.checks.filter(row => row.name !== name);
  missing.results = missing.results.filter(row => row.name !== name);
  assert.equal(evaluateChildReport('classroom', missing, context).outcome, 'partial');
  const failed = fixture();
  failed.classroomAcceptance.checks.find(row => row.name === name).status = '失败';
  assert.equal(evaluateChildReport('classroom', failed, context).outcome, 'failed');
});


test('expanded native API contract rejects absent/duplicate routes, missing methods and baseline-only evidence', () => {
  const mutations = [
    detail => { detail.protocolMode = 'baseline-observe'; },
    detail => { delete detail.contractVersion; },
    detail => { detail.coveredRoutes.pop(); },
    detail => { detail.coveredRoutes.push(structuredClone(detail.coveredRoutes[0])); },
    detail => { detail.coveredRoutes[0].testedMethods = ['GET']; },
    detail => { detail.coveredRoutes[0].requestCount = 0; },
    detail => { detail.coveredRoutes[0].optionsAllow = 'GET, POST'; },
    detail => { delete detail.httpIdentity; },
    detail => { detail.httpIdentity.uniqueNativeIds = 1; },
    detail => { detail.httpIdentity.sameAppPid = false; },
    detail => { detail.httpIdentity.businessIdPreserved = false; },
  ];
  for (const mutate of mutations) {
    const report = fixture(); mutate(report.results.find(row => row.name === 'read-api-native-protocol').detail);
    assert.notEqual(evaluateChildReport('classroom', report, context).outcome, 'passed');
  }
});

test('an explicitly unknown per-method clock remains unknown and does not invent a measured duration', () => {
  const report = fixture(); const detail = report.results.find(row => row.name === 'read-api-native-protocol').detail;
  detail.coveredRoutes.forEach(row => { row.clockState = 'unknown'; });
  assert.equal(evaluateChildReport('classroom', report, context).outcome, 'passed');
  detail.httpIdentity.stateAnchor = 'unknown';
  assert.equal(evaluateChildReport('classroom', report, context).outcome, 'partial');
});

test('single-class work and missing earlier class evidence cannot become full stability acceptance', () => {
  const single = completeRun(); single.options = parseAcceptanceOptions(['--soak-classes=1']);
  assert.equal(evaluateAcceptance(single).outcome, 'partial');
  for (const damage of [
    value => { delete value.metrics; },
    value => { delete value.documentReviewSettlement; },
    value => { value.continuitySnapshots = []; },
    value => { value.buildId = 'other-build'; },
    value => { value.runId = 'other-run'; },
  ]) {
    const current = fixture(); damage(current.classroomSoak.classEvidence[0]);
    assert.notEqual(evaluateChildReport('classroom', current, context).outcome, 'passed');
  }
});

test('review deadline uses the common completion clock and keeps final audit time separate', () => {
  const lesson = sustainedLesson();
  lesson.documentReviewSettlement.totalElapsedMs = 600000; // A slow final audit is not another model run.
  assert.deepEqual(evaluateSustainedClassroom(lesson, options), { failures: [], missing: [] });
  lesson.documentReviewSettlement.settlementElapsedMs = 300001;
  assert.ok(evaluateSustainedClassroom(lesson, options).failures.some(value => value.includes('five minutes')));
  for (const mutate of [
    value => { delete value.settlementElapsedMs; },
    value => { delete value.students[0].settledElapsedMs; },
    value => { value.students[0].settledElapsedMs = value.settlementElapsedMs + 1; },
    value => { value.students[0].settledElapsedMs = value.students[0].elapsedMs - 1; },
    value => { value.students[0].tasks[0].requestId = ''; },
    value => { value.students[0].tasks.push({ ...value.students[0].tasks[0] }); value.students[0].proof.completed = 2; },
    value => { value.students[0].proof.observedRequests = 999; },
  ]) {
    const damaged = sustainedLesson(); mutate(damaged.documentReviewSettlement);
    const result = evaluateSustainedClassroom(damaged, options);
    assert.ok(result.missing.length || result.failures.length);
  }
});


test('concurrent saving requires both cross-session conflict and shared-context original-ID replay evidence', () => {
  for (const name of ['draft-save-cross-session-conflict', 'draft-save-same-context-replay']) {
    assert.equal(CLASSROOM_REQUIRED_EVIDENCE[name], 'browser-real-backend');
    const missing = fixture();
    missing.classroomAcceptance.checks = missing.classroomAcceptance.checks.filter(row => row.name !== name);
    assert.notEqual(evaluateChildReport('classroom', missing, context).outcome, 'passed');
    const failed = fixture();
    failed.results.find(row => row.name === name).status = '失败';
    assert.equal(evaluateChildReport('classroom', failed, context).outcome, 'failed');
    const mocked = fixture();
    mocked.classroomAcceptance.checks.find(row => row.name === name).evidence = 'mock';
    assert.notEqual(evaluateChildReport('classroom', mocked, context).outcome, 'passed');
  }
});

test('production code background recovery cannot be replaced by admission or a mocked/native-drain proof', () => {
  const name = 'code-background-next-worker-after-caller-close';
  assert.equal(CLASSROOM_REQUIRED_EVIDENCE[name], 'browser-real-provider');
  for (const evidence of [undefined, 'mock', 'isolated-backend']) {
    const value = fixture();
    if (evidence === undefined) value.classroomAcceptance.checks = value.classroomAcceptance.checks.filter(row => row.name !== name);
    else value.classroomAcceptance.checks.find(row => row.name === name).evidence = evidence;
    assert.notEqual(evaluateChildReport('classroom', value, context).outcome, 'passed');
  }
  const failed = fixture(); failed.results.find(row => row.name === name).status = '失败';
  assert.equal(evaluateChildReport('classroom', failed, context).outcome, 'failed');
});
