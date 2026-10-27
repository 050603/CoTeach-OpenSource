import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acceptanceBuildCommand, acceptanceCommands, resolveAcceptanceBrowsers } from './run-classroom-acceptance.mjs';
import { parseAcceptanceOptions } from './lib/classroom-acceptance-contract.mjs';

const settings = { root: '/repository', output: '/repository/test-results/classroom-acceptance/run-id', runId: 'run-id',
  browsers: { 'google-chrome': '/chrome', 'microsoft-edge': '/edge' } };

test('build disables runtime opt-ins while the classroom retains the requested configuration', () => {
  const requested = Object.freeze({ OPENPBL_COURSE_READ_WORKERS: '2',
    OPENPBL_COURSE_READ_CONNECTION_BUDGET: '57', OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS: '16' });
  const build = acceptanceBuildCommand(settings.output);
  const classroom = acceptanceCommands(parseAcceptanceOptions(['--checks=classroom']), settings)[0];
  const buildEnvironment = { ...requested, ...build.env };
  const classroomEnvironment = { ...requested, ...classroom.env };
  assert.equal(buildEnvironment.OPENPBL_COURSE_READ_WORKERS, '0');
  assert.equal(buildEnvironment.OPENPBL_COURSE_READ_DATABASE_URL, '');
  assert.equal(buildEnvironment.OPENPBL_COURSE_READ_CONNECTION_BUDGET, '57');
  assert.equal(buildEnvironment.OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS, '16');
  assert.equal(buildEnvironment.NEXT_DIST_DIR, '.next-build');
  assert.deepEqual(build.args, ['build']);
  assert.equal(build.directory, `${settings.output}/build`);
  assert.equal(classroomEnvironment.OPENPBL_COURSE_READ_WORKERS, '2');
  assert.equal(classroomEnvironment.OPENPBL_COURSE_READ_CONNECTION_BUDGET, '57');
  assert.equal(classroomEnvironment.OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS, '16');
  assert.equal(classroomEnvironment.OPENPBL_COURSE_READ_DATABASE_URL, undefined);
  assert.equal(classroomEnvironment.PRELAUNCH_REAL_PROVIDERS, '1');
  assert.equal(classroomEnvironment.CLASSROOM_ACCEPTANCE_MINUTES, '90');
  assert.equal(classroomEnvironment.CLASSROOM_ACCEPTANCE_STUDENTS, '30');
  assert.equal(requested.OPENPBL_COURSE_READ_WORKERS, '2');
  const inherited = { ...requested, OPENPBL_COURSE_READ_DATABASE_URL: 'not-a-disposable-read-url', ...build.env };
  assert.equal(inherited.OPENPBL_COURSE_READ_DATABASE_URL, '');
});

test('formal plan runs brands sequentially and enables real providers only for the classroom', () => {
  const commands = acceptanceCommands(parseAcceptanceOptions(), settings);
  assert.equal(commands.length, 10);
  const classroom = commands.find(command => command.check === 'classroom');
  assert.equal(classroom.env.CLASSROOM_ACCEPTANCE_STUDENTS, '30');
  assert.equal(classroom.env.CLASSROOM_ACCEPTANCE_MINUTES, '90');
  assert.equal(classroom.env.CLASSROOM_ACCEPTANCE_SOAK_CLASSES, '3');
  assert.equal(classroom.env.CLASSROOM_ACCEPTANCE_RUN_ID, settings.runId);
  assert.equal(classroom.env.PRELAUNCH_CLASSROOM_ACCEPTANCE, '1');
  assert.equal(classroom.env.PRELAUNCH_REAL_PROVIDERS, '1');
  assert.equal(classroom.env.PRELAUNCH_WEBSOCKET, '1');
  assert.equal(classroom.env.PRELAUNCH_E2E_EXECUTABLE_PATH, '/chrome');
  assert.ok(classroom.args.includes('tsx'));
  assert.equal(new Set(commands.map(command => command.directory)).size, commands.length);
  for (const command of commands.filter(command => !['unit', 'classroom'].includes(command.check))) {
    assert.equal(command.env.PRELAUNCH_REAL_PROVIDERS, '0');
    assert.equal(command.env.PRELAUNCH_E2E_EXECUTABLE_PATH, settings.browsers[command.brand]);
    assert.equal(command.env.PRELAUNCH_REUSE_BUILD, '1');
    assert.ok(command.directory.startsWith(settings.output));
  }
  for (const command of commands.filter(command => ['ui', 'faults'].includes(command.check))) {
    assert.equal(command.env.PRELAUNCH_BROWSER_SUITE, command.check);
    assert.ok(command.env.PLAYWRIGHT_JSON_OUTPUT_FILE.endsWith('/playwright.json'));
    assert.ok(!command.args.includes('systemctl'));
  }
});

test('smoke parameters are explicit; selecting only unit requires no browsers or providers', () => {
  const [smoke] = acceptanceCommands(parseAcceptanceOptions(['--smoke', '--checks=classroom']), settings);
  assert.equal(smoke.env.CLASSROOM_ACCEPTANCE_SMOKE, '1');
  assert.equal(smoke.env.CLASSROOM_ACCEPTANCE_MINUTES, '0.2');
  assert.equal(smoke.env.CLASSROOM_ACCEPTANCE_STUDENTS, '2');
  assert.equal(smoke.env.CLASSROOM_ACCEPTANCE_SOAK_CLASSES, '1');
  const [unit] = acceptanceCommands(parseAcceptanceOptions(['--checks=unit']), { ...settings, browsers: {} });
  assert.equal(unit.check, 'unit'); assert.deepEqual(unit.env, {
    OPENPBL_COURSE_READ_WORKERS: '0', OPENPBL_COURSE_READ_DATABASE_URL: '',
  });
  assert.ok(unit.args.includes('--reporter=json'));
  assert.ok(unit.args.includes('--maxWorkers=4'));
  for (const entry of ['src/next-config.test.ts', 'src/lib/browser/document-review-notifications.test.ts', 'src/lib/openmaic/utils/iframe.test.ts', 'src/lib/observability/edge-log-reader.test.ts', 'src/lib/observability/nginx-edge-metrics.test.ts',
    'src/lib/observability/metrics.test.ts', 'src/lib/observability/main-thread-cpu.test.ts',
    'src/lib/openmaic/server/encoded-monaco-runtime.test.ts',
    'src/lib/openmaic/server/encoded-monaco-bundle.test.ts',
    'src/lib/openmaic/server/pinned-monaco-handler.test.ts',
    'src/lib/browser/code-ai-request.test.ts', 'src/lib/browser/code-background-request.test.ts',
    'src/components/views/student/use-project-memory.test.tsx',
    'src/components/views/student/collaboration-memory-history.test.tsx',
    'src/lib/public-discussion/service.test.ts',
    'src/lib/auth/hmac-verification-key.test.ts', 'src/lib/courses', 'src/lib/platform/experiment-service.test.ts',
    'src/lib/platform/research-export.test.ts', 'src/lib/platform/course-mind-map-publication.test.ts',
    'src/lib/platform/course-audio-publication.test.ts', 'src/components/openmaic-bridge/lecture-chat',
    'src/components/openmaic-bridge/student-stage-host.test.tsx', 'src/app/api/courses/[courseId]/lecture-chat/route.test.ts',
    'src/app/api/knowledge-lecture/route.test.ts']) assert.ok(unit.args.includes(entry), entry);
});

test('an explicitly missing branded executable is never silently substituted', () => {
  assert.throws(() => resolveAcceptanceBrowsers('/repository', { PRELAUNCH_CHROME_EXECUTABLE_PATH: '/definitely-missing-acceptance-chrome' }), /Missing actual google-chrome/);
});
test('three-class workload preserves one classroom child process and budgets all classes', () => {
  const commands = acceptanceCommands(parseAcceptanceOptions(['--soak-classes=3']), settings);
  const classroom = commands.find(command => command.check === 'classroom');
  assert.equal(commands.filter(command => command.check === 'classroom').length, 1);
  assert.equal(classroom.env.CLASSROOM_ACCEPTANCE_SOAK_CLASSES, '3');
  assert.equal(classroom.timeoutMs, 450 * 60000);
  assert.throws(() => parseAcceptanceOptions(['--soak-classes=2']), /Soak classes/);
  assert.throws(() => parseAcceptanceOptions(['--soak-classes=3', '--checks=unit']), /Soak requires/);
});

test('the actual tsx CLI loads classroom helpers and confirms the real cursor receipt contract', { timeout: 15000 }, () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Test the CLI loader as well as native node --test: tsx exposes a .ts
  // CommonJS namespace differently when an ESM .mjs helper imports it.
  const source = `(async () => {
    const assert = await import('node:assert/strict');
    const { createBrowserActionReceipts } = await import('./scripts/lib/classroom-acceptance-action-receipts.mjs');
    const { confirmSubmissionSave } = await import('./scripts/lib/classroom-acceptance-save-confirmation.mjs');
    const classroom = await import('./scripts/lib/classroom-acceptance.mjs');
    assert.equal(typeof classroom.runClassroomAcceptance, 'function');
    const at = '2026-10-16T00:00:00.000Z';
    const saved = { id: 'draft', courseId: 'course', studentId: 'student', stageKey: 'make', type: 'document', content: '<p>Real codec</p>', version: 2 };
    const request = { requestId: 'original', action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', expectedSubmissionVersion: 1, submission: { ...saved, version: 1 } } } };
    const store = createBrowserActionReceipts('course', at);
    const ack = store.remember(request, { courseVersion: 3, submissionVersion: 2 });
    const receipt = { id: ack.eventCursor.split('~')[1], createdAt: new Date(at), actorId: 'student', idempotencyKey: 'course-action:student:original', payload: { ack } };
    const proof = await confirmSubmissionSave({ page: { waitForFunction: async () => {} },
      db: { domainEvent: { findUnique: async query => { assert.deepEqual(query, { where: { idempotencyKey: receipt.idempotencyKey } }); return receipt; } } },
      courseId: 'course', studentId: 'student', participationId: 'participation',
      submission: { participationId: 'participation', payload: { view: saved } }, observations: [{ request, ack, status: 200 }], timeoutMs: 0 });
    assert.equal(proof.receiptId, receipt.id);
    assert.deepEqual(store.lookup(request), { status: 200, body: ack });
    console.log('tsx-acceptance-import-and-receipt-ok');
  })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const output = execFileSync('pnpm', ['exec', 'tsx', '--eval', source], { cwd: root,
    encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' }, timeout: 12000 });
  assert.match(output, /tsx-acceptance-import-and-receipt-ok/);
});
