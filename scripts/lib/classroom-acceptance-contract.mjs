import assert from 'node:assert/strict';
import { CLASSROOM_REQUIRED_EVIDENCE, CLASSROOM_REQUIRED_CHECKS, evaluateContinuity, evaluatePerformance } from './classroom-acceptance-evidence.mjs';
import { evaluateClassroomSoak } from './classroom-acceptance-soak.mjs';
export { CLASSROOM_STAGES, CLASSROOM_PERFORMANCE_PHASES, CLASSROOM_PHASE_MINUTES,
  CLASSROOM_REQUIRED_EVIDENCE, CLASSROOM_REQUIRED_CHECKS } from './classroom-acceptance-evidence.mjs';

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { READ_API_NATIVE_PROTOCOL_CHECKS, READ_API_NATIVE_ROUTES, READ_API_NATIVE_PROTOCOL_VERSION } from './prelaunch-read-api-contract.mjs';
import { readCapacityMigrationIdentity } from '../capacity-build-guard.mjs';
import { assertBrowserIdentity } from './prelaunch-browser.mjs';

export const ACCEPTANCE_CHECKS = Object.freeze(['unit', 'ui', 'linkage', 'practice', 'classroom', 'faults']);
export const ACCEPTANCE_BRANDS = Object.freeze(['google-chrome', 'microsoft-edge']);
export { READ_API_NATIVE_PROTOCOL_CHECKS };
export const BROWSER_SUITE_SPECS = Object.freeze({
  ui: Object.freeze(['lecture-chat', 'prepared-question-explanation', 'student-usability', 'classroom-complete',
    'teacher-player-isolation', 'project-workspace', 'teacher-presentation', 'posttest-stage',
    'teacher-classroom-editor', 'branded-native-zoom'].map(name => `e2e/${name}.spec.ts`)),
  faults: Object.freeze(['classroom-reliability', 'code-reliability', 'teacher-error-recovery',
    'prelaunch-fault-recovery'].map(name => `e2e/${name}.spec.ts`)),
});
export const ISOLATION_REQUIRED_CHECKS = Object.freeze(['isolated-database-migration', 'isolated-redis-start',
  'isolated-production-build', 'isolated-generated-css-integrity', 'isolated-app-start', 'browser-identity',
  'classroom-ai-usage-and-cache-metrics']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const pass = status => status === '通过' || status === 'passed';
const fail = status => ['失败', '未通过', 'failed'].includes(status);

export function parseAcceptanceOptions(args = []) {
  const options = { smoke: false, minutes: 90, students: 30, soakClasses: 1, checks: [...ACCEPTANCE_CHECKS], help: false };
  let minutes;
  let students;
  let explicitSoak = false;
  for (const argument of args) {
    if (argument === '--smoke') options.smoke = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument.startsWith('--minutes=')) minutes = Number(argument.slice(10));
    else if (argument.startsWith('--students=')) students = Number(argument.slice(11));
    else if (argument.startsWith('--soak-classes=')) { options.soakClasses = Number(argument.slice(15)); explicitSoak = true; }
    else if (argument.startsWith('--checks=')) options.checks = argument.slice(9).split(',');
    else throw new Error(`Unknown acceptance option: ${argument}`);
  }
  assert.ok(options.checks.length && options.checks.every(check => ACCEPTANCE_CHECKS.includes(check)), 'Unknown or empty --checks selection');
  assert.equal(new Set(options.checks).size, options.checks.length, 'Duplicate check selection');
  if (options.smoke) {
    options.minutes = minutes ?? 0.2;
    options.students = students ?? 2;
  } else {
    assert.ok(minutes === undefined || minutes === 90, 'A shortened duration requires --smoke');
    assert.ok(students === undefined || students === 30, 'A smaller classroom requires --smoke');
  }
  assert.ok(Number.isFinite(options.minutes) && options.minutes > 0 && options.minutes <= 90, 'Minutes must be within (0, 90]');
  assert.ok(Number.isInteger(options.students) && options.students >= 2 && options.students <= 30, 'Students must be an integer within 2..30');
  if (!explicitSoak && !options.smoke && options.checks.includes('classroom')) options.soakClasses = 3;
  assert.ok([1, 3].includes(options.soakClasses), 'Soak classes must be 1 or 3');
  assert.ok(options.soakClasses === 1 || options.checks.includes('classroom'), 'Soak requires the classroom check');
  return options;
}

/** Hash actual tracked and non-ignored new inputs, including uncommitted edits.
 * Reports contain paths/hashes only; ignored credentials and runtime data are excluded.
 */
export async function captureWorkspaceIdentity(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd();
  const names = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const files = [];
  for (let offset = 0; offset < names.length; offset += 32) {
    files.push(...await Promise.all(names.slice(offset, offset + 32).map(async name => {
      const absolute = path.resolve(root, name);
      assert.ok(absolute.startsWith(`${path.resolve(root)}${path.sep}`), 'Source path escaped the workspace');
      try {
        const before = await lstat(absolute);
        const bytes = before.isSymbolicLink() ? await readlink(absolute) : await readFile(absolute);
        const after = await lstat(absolute);
        assert.ok(before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, `Source changed while reading: ${name}`);
        return { path: name, sha256: sha256(bytes), kind: before.isSymbolicLink() ? 'symlink' : 'file', mode: before.mode & 0o777 };
      } catch (error) {
        if (error.code === 'ENOENT') return { path: name, missing: true };
        throw error;
      }
    })));
  }
  return {
    commit: git(['rev-parse', 'HEAD']), source: { sha256: sha256(JSON.stringify(files)), files },
    migrations: await readCapacityMigrationIdentity(path.join(root, 'prisma/migrations')),
  };
}

export function assertAcceptanceIdentityUnchanged(expected, actual) {
  assert.equal(actual.commit, expected.commit, 'Git commit changed during acceptance');
  assert.equal(actual.source.sha256, expected.source.sha256, 'Source inputs changed during acceptance');
  assert.equal(actual.migrations.sha256, expected.migrations.sha256, 'Migration inputs changed during acceptance');
}

export function evaluateTestReport(kind, report, { requiredSpecs = [], brand, startedAt } = {}) {
  const failures = [];
  const missing = [];
  let total = 0;
  if (kind === 'unit') {
    const tests = (report?.testResults ?? []).flatMap(file => file.assertionResults ?? []);
    total = tests.length;
    if (!total || report.numTotalTests !== total) missing.push('Unit test collection is missing or inconsistent');
    if (report?.success !== true || report.numFailedTests > 0 || tests.some(test => test.status === 'failed')) failures.push('Unit tests failed');
    if (report?.numPendingTests > 0 || report?.numTodoTests > 0 || tests.some(test => test.status !== 'passed' && test.status !== 'failed')) missing.push('Unit tests were skipped or incomplete');
    if (tests.some(test => test.status === 'passed' && test.failureMessages?.length)) failures.push('Passed unit test contains a failure');
  } else {
    const tests = [];
    const covered = new Set();
    const visit = (suites, inheritedFile) => {
      for (const suite of suites ?? []) {
        const suiteFile = suite.file ?? inheritedFile;
        for (const spec of suite.specs ?? []) {
          const file = (spec.file ?? suiteFile ?? '').replaceAll('\\', '/');
          const matched = requiredSpecs.find(expected => file === expected || file === path.posix.basename(expected)
            || (path.posix.isAbsolute(file) && file.endsWith(`/${expected}`)));
          for (const test of spec.tests ?? []) {
            tests.push(test);
            if (matched && test.expectedStatus === 'passed' && test.status === 'expected'
              && test.results?.length && test.results.every(result => result.status === 'passed')) covered.add(matched);
          }
        }
        visit(suite.suites, suiteFile);
      }
    };
    visit(report?.suites);
    total = tests.length;
    if (!total) missing.push('No browser tests were collected');
    if (report?.errors?.length || report?.stats?.unexpected > 0 || report?.stats?.flaky > 0) failures.push('Browser tests failed or were flaky');
    for (const test of tests) {
      const attempts = test.results ?? [];
      if (brand && test.projectName !== brand) failures.push('Browser test project differs from the requested brand');
      if (test.expectedStatus !== 'passed' || test.status === 'skipped' || attempts.some(result => result.status === 'skipped') || !attempts.length) missing.push('Browser test was skipped or incomplete');
      else if (test.status !== 'expected' || attempts.some(result => result.status !== 'passed')) failures.push('Browser test failed or required a retry');
    }
    for (const spec of requiredSpecs) if (!covered.has(spec)) missing.push(`Required browser spec not executed: ${spec}`);
    if (requiredSpecs.length) {
      const stats = report?.stats;
      if (!stats || !['expected', 'unexpected', 'flaky', 'skipped'].every(key => Number.isInteger(stats[key]) && stats[key] >= 0)
        || stats.expected + stats.unexpected + stats.flaky + stats.skipped !== total) missing.push('Browser test totals are missing or inconsistent');
      if (startedAt && (!Number.isFinite(Date.parse(stats?.startTime)) || Date.parse(stats.startTime) < Date.parse(startedAt))) failures.push('Browser test report timestamp is missing or stale');
    }
  }
  return { outcome: failures.length ? 'failed' : missing.length ? 'partial' : 'passed', total, failures: [...new Set(failures)], missing: [...new Set(missing)] };
}

export function evaluateChildReport(check, report, { buildId, runId, options, brand, startedAt, testReport } = {}) {
  if (check === 'unit') return evaluateTestReport('unit', report);
  const failures = [];
  const missing = [];
  if (!report || !Array.isArray(report.results) || report.results.length === 0) return { outcome: 'failed', failures: ['Missing raw functional report'], missing };
  if (report.buildId !== buildId) failures.push('Child report build does not match the candidate build');
  if (report.mode !== 'isolated-production-build-and-disposable-database') failures.push('Child report did not use the isolated production backend');
  if (!Number.isFinite(Date.parse(report.date)) || Date.parse(report.date) < Date.parse(startedAt)) failures.push('Child report timestamp is missing or predates its invocation');
  const validateBrowser = (identity, expectedBrand) => {
    try {
      assert.equal(identity?.label, expectedBrand);
      assert.ok(path.isAbsolute(identity.executablePath ?? ''), 'Missing executable identity');
      assertBrowserIdentity(identity, identity, identity.executableVersion);
    } catch { failures.push(`Unverified actual browser identity: ${expectedBrand}`); }
  };
  if (brand || check === 'classroom') validateBrowser(report.browser, brand ?? 'google-chrome');
  for (const result of report.results) {
    if (fail(result.status)) failures.push(`${result.name}: ${result.status}`);
    else if (!pass(result.status)) missing.push(`${result.name}: ${result.status ?? 'missing status'}`);
  }
  const required = [...ISOLATION_REQUIRED_CHECKS];
  if (check === 'classroom') required.push('isolated-real-provider-snapshot', 'read-api-native-protocol');
  if (check === 'linkage') required.push('three-browser-projection-pages-stop-offline-and-refresh-recovery', 'three-browser-stage-switch-independent-answers-teacher-progress', 'three-browser-real-websocket-subscribe-events-and-reconnect', 'three-browser-websocket-outage-http-polling-delivery');
  if (check === 'practice') {
    for (const language of ['python', 'c']) required.push(`browser-practice-${language}-new-file-edit-save-server-reload`, `browser-practice-${language}-real-sandbox-run-and-teacher-submission`, `browser-practice-${language}-teacher-preview`);
    required.push('browser-practice-document-edit-save-server-reload', 'browser-practice-document-submit-download-word-and-reload', 'browser-practice-document-teacher-preview');
    for (const mode of ['python', 'c', 'document']) required.push(`browser-practice-${mode}-resources-and-layout`);
  }
  if (BROWSER_SUITE_SPECS[check]) required.push(`browser-${check}-regressions`);
  for (const name of required) {
    const rows = report.results.filter(result => result.name === name);
    if (!rows.some(result => pass(result.status))) missing.push(`Required child result missing: ${name}`);
    if (rows.length > 1) failures.push(`Duplicate required child result: ${name}`);
  }
  if (check === 'classroom') {
    const proof = report.results.find(result => result.name === 'read-api-native-protocol');
    if (proof && pass(proof.status)) {
      const detail = proof.detail;
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
        missing.push('Native protocol proof metadata missing');
      } else {
        if (detail.buildId !== buildId) failures.push('Native protocol proof build differs from the candidate build');
        if (detail.evidence !== 'production-next-http') failures.push('Native protocol proof did not use real production HTTP');
        if (detail.restoration !== 'passed') failures.push('Native protocol proof restoration/identity was not verified');
        if (!Number.isSafeInteger(detail.requestCount) || detail.requestCount <= 0) missing.push('Native protocol proof has no valid actual request count');
        if (detail.contractVersion !== READ_API_NATIVE_PROTOCOL_VERSION) missing.push('Native protocol proof has no current expanded API contract');
        if (detail.protocolMode !== 'candidate') failures.push('Baseline wire observations cannot satisfy native candidate acceptance');
        const covered = Array.isArray(detail.coveredRoutes) ? detail.coveredRoutes : [];
        for (const definition of READ_API_NATIVE_ROUTES) {
          const rows = covered.filter(row => row?.route === definition.route);
          if (!rows.length) { missing.push(`Native API route not covered: ${definition.route}`); continue; }
          if (rows.length !== 1) { failures.push(`Duplicate native API route: ${definition.route}`); continue; }
          const row = rows[0];
          if (!Number.isSafeInteger(row.requestCount) || row.requestCount < 14) missing.push(`Native API actual requests incomplete: ${definition.route}`);
          if (row.optionsAllow !== definition.optionsAllow) failures.push(`Native API OPTIONS contract differs: ${definition.route}`);
          const actual = Array.isArray(row.testedMethods) ? row.testedMethods : [];
          const expected = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];
          if (actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some(method => !actual.includes(method))) {
            missing.push(`Native API method evidence incomplete: ${definition.route}`);
          }
          if (!['measured', 'unknown'].includes(row.clockState)) missing.push(`Native API timing availability unspecified: ${definition.route}`);
        }
        if (covered.reduce((sum, row) => sum + (Number.isSafeInteger(row?.requestCount) ? row.requestCount : 0), 0) > detail.requestCount) failures.push('Native route counts exceed actual HTTP requests');
        if (!detail.httpIdentity || detail.httpIdentity.stateAnchor !== 'measured'
          || detail.httpIdentity.repeatedBusinessRequests !== 4 || detail.httpIdentity.uniqueNativeIds !== 4
          || detail.httpIdentity.sameAppPid !== true || detail.httpIdentity.businessIdPreserved !== true) {
          missing.push('Native HTTP identity reuse/spoof proof incomplete');
        }
        const checks = Array.isArray(detail.checks) ? detail.checks : [];
        for (const name of READ_API_NATIVE_PROTOCOL_CHECKS) {
          const count = checks.filter(check => check === name).length;
          if (!count) missing.push(`Required native protocol check missing: ${name}`);
          else if (count > 1) failures.push(`Duplicate native protocol check: ${name}`);
        }
      }
    }
  }
  if (['linkage', 'classroom'].includes(check) && report.environment?.classroomTransport !== 'websocket-with-http-recovery') failures.push('Real WebSocket transport was not enabled');
  if (['ui', 'faults'].includes(check)) {
    const browserResult = evaluateTestReport('browser', testReport, { requiredSpecs: BROWSER_SUITE_SPECS[check], brand, startedAt });
    failures.push(...browserResult.failures); missing.push(...browserResult.missing);
  }
  if (check === 'classroom') {
    const classroom = report.classroomAcceptance;
    if (!classroom || classroom.schemaVersion !== 1 || classroom.runId !== runId) failures.push('Missing or mismatched classroom acceptance identity');
    else {
      if (classroom.teachers !== 1 || classroom.students !== options.students) failures.push('Actual classroom roster differs from the requested one');
      if (!Number.isFinite(classroom.actualDurationSeconds) || classroom.actualDurationSeconds < options.minutes * 60) missing.push('Requested continuous classroom duration was not completed');
      const expectedChrome = Math.ceil(options.students / 2);
      if (classroom.browserCounts?.['google-chrome'] !== expectedChrome || classroom.browserCounts?.['microsoft-edge'] !== options.students - expectedChrome) failures.push('Actual student Chrome/Edge counts differ from the requested split');
      for (const expectedBrand of ACCEPTANCE_BRANDS) validateBrowser(classroom[expectedBrand], expectedBrand);
      const checks = Array.isArray(classroom.checks) ? classroom.checks : [];
      for (const name of CLASSROOM_REQUIRED_CHECKS) {
        for (const [scope, rows] of [['classroom', checks], ['child', report.results]]) {
          const matches = rows.filter(item => item.name === name);
          const result = matches[0];
          if (matches.length > 1) failures.push(`Duplicate required ${scope} check: ${name}`);
          if (!result || !pass(result.status)) {
            (result && fail(result.status) ? failures : missing).push(`Required ${scope} check: ${name}`);
          } else if (result.evidence !== CLASSROOM_REQUIRED_EVIDENCE[name]) missing.push(`Insufficient ${scope} evidence: ${name}`);
        }
      }
      for (const result of checks) if (fail(result.status)) failures.push(`Classroom check failed: ${result.name}`);
      evaluateContinuity(classroom, options, failures, missing);
      evaluatePerformance(classroom, report.results, failures, missing);
      if (report.realClassroomAi !== true) missing.push('Real classroom model calls were not enabled');
      const providerHash = classroom.runtimeConfiguration?.publicProviderConfigurationSha256;
      if (!/^[a-f0-9]{64}$/.test(providerHash ?? '')) missing.push('Missing configured model/voice fingerprint');
      else for (const sample of classroom.continuitySnapshots ?? []) {
        if (!sample.providerConfigurationSha256) missing.push('Provider configuration was not monitored throughout the classroom');
        else if (sample.providerConfigurationSha256 !== providerHash) failures.push('Provider configuration changed during the classroom');
      }
      const providerSnapshot = report.results.find(row => row.name === 'isolated-real-provider-snapshot')?.detail;
      if (!(providerSnapshot?.rows > 0) || !/^[a-f0-9]{64}$/.test(providerSnapshot.sha256 ?? '')
        || providerSnapshot.sha256 !== providerSnapshot.targetSha256 || providerSnapshot.target !== 'disposable-database') missing.push('Real providers/settings were not copied and verified in the disposable database');
      if (options.soakClasses === 3) {
        const soak = report.classroomSoak;
        if (!soak || soak.classes !== 3 || soak.classEvidence?.length !== 3) missing.push('Three-class soak evidence is missing');
        else if (soak.status === 'failed' || soak.failures?.length) failures.push('Three-class soak failed');
        else if (soak.status !== 'passed' && !(options.smoke && soak.status === 'partial')) missing.push('Three-class soak is incomplete');
        if (Array.isArray(soak?.classEvidence)) {
          const seen = new Set();
          for (const [index, lesson] of soak.classEvidence.entries()) {
            if (lesson.sequence !== index + 1 || !lesson.instanceId || seen.has(lesson.instanceId)
              || lesson.buildId !== buildId || lesson.runId !== runId) failures.push(`Soak class ${index + 1} identity differs or is duplicated`);
            seen.add(lesson.instanceId);
          }
          const measured = evaluateClassroomSoak(soak.classEvidence, { ...options, count: 3 });
          failures.push(...measured.failures.map(message => `Soak verification: ${message}`));
          missing.push(...measured.missing.map(message => `Soak verification: ${message}`));
          for (const field of ['processIdentities', 'rssAfterQuietWindows', 'growthBytes', 'permittedGrowthBytes']) {
            if (JSON.stringify(measured[field]) !== JSON.stringify(soak[field])) failures.push(`Soak summary differs from raw class evidence: ${field}`);
          }
        }
      }
    }
  }
  return { outcome: failures.length ? 'failed' : missing.length ? 'partial' : 'passed', failures: [...new Set(failures)], missing: [...new Set(missing)] };
}


export function evaluateAcceptance(report) {
  const failures = [...(report.failures ?? []), ...(report.evidenceValidation?.failures ?? [])];
  const missing = [...(report.evidenceValidation?.missing ?? [])];
  if (report.build?.status !== 'passed' || !report.build?.buildId) missing.push('Candidate build was not completed');
  if (report.identityVerified !== true) missing.push('Source/build/migration identity was not verified through completion');
  for (const check of ACCEPTANCE_CHECKS) {
    const brands = ['unit', 'classroom'].includes(check) ? [undefined] : ACCEPTANCE_BRANDS;
    for (const brand of brands) {
      const child = report.runs?.find(entry => entry.check === check && entry.brand === brand);
      const label = `${check}${brand ? `/${brand}` : ''}`;
      if (!child) missing.push(`Not executed: ${label}`);
      else if (child.exitCode !== 0 || child.verdict?.outcome === 'failed') failures.push(`Failed: ${label}`);
      else if (child.verdict?.outcome !== 'passed') missing.push(`Incomplete: ${label}`);
    }
  }
  if (report.options?.smoke) missing.push('Smoke mode cannot satisfy formal acceptance');
  if (report.options?.soakClasses !== 3) missing.push('Formal stability acceptance requires three consecutive classes in the same application process');
  if (report.options?.students !== 30 || report.options?.minutes !== 90) missing.push('Formal target requires one teacher, 30 students and 90 minutes');
  return { outcome: failures.length ? 'failed' : missing.length ? 'partial' : 'passed', failures: [...new Set(failures)], missing };
}

/** The delivery artifact must contain one acknowledged reconciliation per student. */
export function evaluateStudentManifest(manifest, { students }) {
  const failures = []; const missing = [];
  if (!Array.isArray(manifest)) missing.push('Student reconciliation manifest is not an array');
  else {
    if (manifest.length !== students) missing.push(`Student reconciliation manifest has ${manifest.length}/${students} records`);
    for (const key of ['index', 'userId', 'participationId']) {
      const values = manifest.map(row => row?.[key]);
      if (values.some(value => key === 'index' ? !Number.isInteger(value) || value < 0 || value >= students : typeof value !== 'string' || !value)) {
        failures.push(`Student reconciliation manifest has an invalid ${key}`);
      }
      if (new Set(values).size !== values.length) failures.push(`Student reconciliation manifest has duplicate ${key}`);
    }
    for (const row of manifest) {
      if (fail(row?.status) || row?.errors) failures.push(`Student reconciliation failed: ${row?.index ?? 'unknown'}`);
      else if (!pass(row?.status)) missing.push(`Student reconciliation is incomplete: ${row?.index ?? 'unknown'}`);
    }
  }
  return { outcome: failures.length ? 'failed' : missing.length ? 'partial' : 'passed', failures, missing };
}

/** A successful smoke is useful in CI, but an incomplete formal run is not green. */
export function acceptanceExitCode(report) {
  if (!report || report.outcome === 'passed') return 0;
  if (report.outcome === 'failed') return 1;
  if (report.outcome === 'partial' && report.options?.smoke && report.build?.status === 'passed' && report.identityVerified === true
    && !report.failures?.length && report.runs?.length
    && report.options.checks.every(check => {
      const brands = ['unit', 'classroom'].includes(check) ? [undefined] : ACCEPTANCE_BRANDS;
      return brands.every(brand => report.runs.some(run => run.check === check && run.brand === brand
        && run.exitCode === 0 && run.verdict?.outcome === 'passed'));
    })) return 0;
  return 2;
}
