#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCapacityBuildId } from './capacity-build-guard.mjs';
import { writeClassroomAcceptanceReview } from './lib/classroom-acceptance-report.mjs';
import {
  ACCEPTANCE_BRANDS, captureWorkspaceIdentity, assertAcceptanceIdentityUnchanged,
  acceptanceExitCode, evaluateAcceptance, evaluateChildReport, parseAcceptanceOptions,
} from './lib/classroom-acceptance-contract.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const UNIT_PATHS = [
  'src/next-config.test.ts',
  'src/lib/classroom', 'src/lib/realtime', 'src/lib/project-practice', 'src/lib/showcase',
  'src/lib/public-discussion/service.test.ts',
  'src/lib/session', 'src/lib/ai-collaboration', 'src/lib/companion/scoped-message-batch.test.ts',
  'src/lib/companion/server-store.test.ts', 'src/lib/companion/server-store-read.test.ts',
  'src/lib/browser/document-review-notifications.test.ts',
  'src/lib/browser/document-draft.test.ts', 'src/lib/browser/code-editor-runtime.test.ts',
  'src/lib/openmaic/utils/iframe.test.ts',
  'src/lib/browser/code-ai-request.test.ts', 'src/lib/browser/code-background-request.test.ts',
  'src/lib/observability/classroom-ai.test.ts', 'src/lib/observability/http.test.ts',
  'src/lib/observability/metrics.test.ts', 'src/lib/observability/main-thread-cpu.test.ts',
  'src/lib/observability/course-read-worker-metrics.test.ts',
  'src/lib/observability/action-entry-timing.test.ts', 'src/lib/observability/progress-request-timing.test.ts',
  'src/lib/observability/node-http-ingress.test.ts', 'src/instrumentation-node.test.ts',
  'src/lib/observability/static-resource-timing.test.ts',
  'src/lib/observability/edge-log-reader.test.ts', 'src/lib/observability/nginx-edge-metrics.test.ts',
  'src/app/api/ai-collaboration/code/route.test.ts',
  'src/app/api/ai-collaboration/document/route.test.ts',
  'src/app/api/courses/[courseId]/events/route.test.ts',
  'src/app/api/courses/[courseId]/showcase/presentation/route.test.ts',
  'src/app/api/courses/[courseId]/showcase/artifacts/[versionId]/route.test.ts',
  'src/app/api/courses/[courseId]/showcase/artifacts/export/route.test.ts',
  'src/app/api/courses/[courseId]/showcase/artifacts/pdf/route.test.ts',
  'src/app/api/project-practice/submissions/finalize/route.test.ts',
  'src/components/views/student/ai-member-workspace.test.tsx',
  'src/components/views/student/code-ai-member-workspace.test.tsx',
  'src/components/views/student/use-code-draft.test.tsx',
  'src/components/views/student/use-project-memory.test.tsx',
  'src/components/views/student/collaboration-memory-history.test.tsx',
  'src/lib/platform/learning-events.test.ts', 'src/lib/knowledge-lecture.test.ts',
  'src/lib/learning-analytics', 'src/lib/browser/learning-outbox.test.ts',
  'src/lib/browser/learning-event-outbox.test.ts', 'src/lib/browser/resource-learning-events.test.ts',
  'src/lib/browser/ai-event-outbox.test.ts',
  'src/lib/courses', 'src/lib/platform/experiment-service.test.ts', 'src/lib/platform/research-export.test.ts',
  'src/lib/platform/course-mind-map-publication.test.ts', 'src/lib/platform/course-audio-publication.test.ts',
  'src/components/openmaic-bridge/lecture-chat', 'src/components/openmaic-bridge/student-stage-host.test.tsx',
  'src/app/api/courses/[courseId]/lecture-chat/route.test.ts', 'src/app/api/knowledge-lecture/route.test.ts',
  'src/app/api/learning-events/route.test.ts',
  'src/app/api/openmaic/generate/tts/route.test.ts', 'src/lib/openmaic/server/tts',
  'src/app/api/openmaic/progress/route.test.ts', 'src/lib/llm/classroom-capacity.test.ts',
  'src/lib/openmaic/server/interactive-tts', 'src/lib/openmaic/audio/tts-providers',
  'src/components/views/student/knowledge-lecture-board.test.tsx',
  'src/lib/platform/access.test.ts', 'src/lib/platform/classroom-media-access.test.ts',
  'src/lib/platform/offering-cover-access.test.ts',
  'src/app/api/server-providers/route.test.ts', 'src/lib/openmaic/server/provider-config-refresh.test.ts',
  'src/app/api/platform/offerings/[offeringId]/research-export/route.test.ts',
  'src/components/classroom', 'src/components/views/teacher/knowledge-lecture-analytics.test.tsx',
  'src/components/views/teacher/class-intervention-panel.test.tsx',
  'src/components/views/student/use-workspace-toolbar-offset.test.tsx',
  'src/components/views/student/document-ai-collaboration-proactive.test.tsx',
  'src/components/views/student/document-ai-collaboration-undo.test.tsx',
  'src/components/plate-document-editor.test.tsx', 'src/components/plate-document-editor-anchor.test.tsx',
  'src/components/plate-document-editor-comment-history.test.tsx', 'src/components/ui/block-discussion.test.tsx',
  'src/lib/db/session-stage-readback.test.ts',
  'src/lib/db/transaction-admission.test.ts', 'src/lib/db/transaction-retry.test.ts',
  'src/lib/db/transaction-pipeline.test.ts', 'src/lib/db/course-mutation-queue.test.ts',
  'src/lib/db/classroom-design-cache.test.ts', 'src/lib/db/v2-course-projection-read.test.ts',
  'src/lib/db/student-read-coalescing.test.ts',
  'src/lib/db/client-course-read-budget.test.ts',
  'src/lib/db/session-read-repository.test.ts',
  'src/app/api/courses/[courseId]/state/route.test.ts',
  'src/app/api/courses/route.test.ts',
  'src/lib/browser/submission-save-outbox.test.ts',
  'src/lib/browser/submission-save-telemetry.test.ts',
  'src/lib/browser/scoped-read-lane.test.ts',
  'src/components/views/student/public-discussion-overlay.test.tsx',
  'src/hooks/use-course-presence.test.tsx', 'src/app/api/courses/[courseId]/presence/route.test.ts',
  'src/hooks/use-showcase-presentation.test.tsx',
  'src/app/api/courses/[courseId]/public-discussion/route.test.ts',
  'src/lib/observability/pending-save-reports.test.ts',
  'src/components/views/student/submission-save-conflict.test.tsx',
  'src/components/views/student/document-save-reload.test.tsx',
  'src/lib/observability/health-checks.test.ts', 'src/lib/observability/classroom-health.test.ts',
  'src/lib/observability/http-operation.test.ts', 'src/lib/uploads/file-stream.test.ts',
  'src/lib/uploads/buffer-stream.test.ts', 'src/lib/openmaic/audio/wav-container.test.ts',
  'src/lib/uploads/write-upload-file.test.ts',
  'src/lib/openmaic/server/runtime-asset-cache.test.ts',
  'src/lib/openmaic/server/encoded-monaco-runtime.test.ts',
  'src/lib/openmaic/server/encoded-monaco-bundle.test.ts',
  'src/lib/openmaic/server/pinned-monaco-handler.test.ts',
  'src/app/api/openmaic/interactive-runtime/[runtime]/[...path]/route.test.ts',
  'src/app/api/uploads/[id]/route.test.ts',
  'src/app/api/openmaic/classroom-media/[classroomId]/[...path]/route.test.ts',
  'src/app/student/ai-collaboration/[id]/page.test.tsx', 'src/app/student/classroom/[id]/page.test.tsx',
  'src/app/teacher/teach/[id]/classroom',
  'src/proxy.matcher.test.ts', 'src/proxy.read-api-matcher.test.ts',
  'src/lib/auth/read-api-boundary.test.ts', 'src/lib/auth/hmac-verification-key.test.ts',
];

export function resolveAcceptanceBrowsers(root, environment = process.env) {
  const candidates = {
    'google-chrome': [environment.PRELAUNCH_CHROME_EXECUTABLE_PATH, path.join(root, '.cache/browsers/chrome/opt/google/chrome/chrome'), '/usr/bin/google-chrome'],
    'microsoft-edge': [environment.PRELAUNCH_EDGE_EXECUTABLE_PATH, path.join(root, '.cache/browsers/edge/opt/microsoft/msedge/msedge'), '/usr/bin/microsoft-edge'],
  };
  return Object.fromEntries(Object.entries(candidates).map(([brand, values]) => {
    // An explicit path must not silently fall back to a different installation.
    const configured = values[0];
    const executable = configured || values.find(value => value && existsSync(value));
    assertExecutable(executable, brand);
    return [brand, executable];
  }));
}

function assertExecutable(executable, brand) {
  if (!executable || !path.isAbsolute(executable) || !existsSync(executable)) throw new Error(`Missing actual ${brand} executable; configure its PRELAUNCH_*_EXECUTABLE_PATH`);
}

export function acceptanceCommands(options, { root, output, runId, browsers = {} }) {
  const commands = [];
  for (const check of options.checks) {
    const brands = ['unit', 'classroom'].includes(check) ? [undefined] : ACCEPTANCE_BRANDS;
    for (const brand of brands) {
      const directory = path.join(output, check, brand ?? 'all');
      if (check === 'unit') {
        commands.push({ check, directory, reportPath: path.join(directory, 'vitest.json'),
          evidence: 'unit-controlled-inputs', command: 'pnpm', args: ['exec', 'vitest', 'run', ...UNIT_PATHS,
            '--maxWorkers=4', '--reporter=json', `--outputFile=${path.join(directory, 'vitest.json')}`],
          // Units supply their own controlled pools/ports. Runtime opt-ins are
          // exercised by their explicit cases and the isolated browser gates.
          env: { OPENPBL_COURSE_READ_WORKERS: '0', OPENPBL_COURSE_READ_DATABASE_URL: '' }, timeoutMs: 30 * 60_000 });
        continue;
      }
      const environment = {
        PRELAUNCH_OUTPUT_DIR: directory, PRELAUNCH_REUSE_BUILD: '1', PRELAUNCH_DIST_DIR: '.next-build',
        PRELAUNCH_WEBSOCKET: '1', PRELAUNCH_REAL_PROVIDERS: check === 'classroom' ? '1' : '0',
        PRELAUNCH_CLASSROOM_AI: check === 'classroom' ? '1' : '0',
        PRELAUNCH_CLASSROOM_ACCEPTANCE: check === 'classroom' ? '1' : '0',
        PRELAUNCH_LINKAGE_ONLY: check === 'linkage' ? '1' : '0',
        PRELAUNCH_PRACTICE_ONLY: check === 'practice' ? '1' : '0',
        PRELAUNCH_PRACTICE_MODES: 'python,c,document',
        PRELAUNCH_BROWSER_SUITE: ['ui', 'faults'].includes(check) ? check : '',
        PRELAUNCH_E2E_BROWSER: 'chromium', PRELAUNCH_E2E_BROWSER_LABEL: brand ?? 'google-chrome',
        PRELAUNCH_E2E_EXECUTABLE_PATH: browsers[brand ?? 'google-chrome'],
        PRELAUNCH_CHROME_EXECUTABLE_PATH: browsers['google-chrome'], PRELAUNCH_EDGE_EXECUTABLE_PATH: browsers['microsoft-edge'],
        CLASSROOM_ACCEPTANCE_RUN_ID: runId, CLASSROOM_ACCEPTANCE_SMOKE: options.smoke ? '1' : '0',
        CLASSROOM_ACCEPTANCE_MINUTES: String(options.minutes), CLASSROOM_ACCEPTANCE_STUDENTS: String(options.students),
        CLASSROOM_ACCEPTANCE_SOAK_CLASSES: String(options.soakClasses ?? 1),
        PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(directory, 'playwright.json'),
      };
      commands.push({ check, brand, directory, reportPath: path.join(directory, 'report.json'),
        evidence: check === 'classroom' ? 'real-backend-and-real-provider' : ['ui', 'faults'].includes(check) ? 'browser-mocked-business-api' : 'browser-real-backend',
        command: 'pnpm', args: ['exec', 'tsx', path.join(root, 'scripts/verify-prelaunch-functional.mjs')], env: environment,
        timeoutMs: (check === 'classroom' ? (options.minutes + 60) * (options.soakClasses ?? 1) : 60) * 60_000 });
    }
  }
  return commands;
}

export function acceptanceBuildCommand(output) {
  return { check: 'build', directory: path.join(output, 'build'), command: 'pnpm', args: ['build'],
    // The disposable read-only role is provisioned after this build. Runtime
    // commands inherit the requested worker count and receive their own URL.
    env: { NEXT_DIST_DIR: '.next-build', OPENPBL_COURSE_READ_WORKERS: '0', OPENPBL_COURSE_READ_DATABASE_URL: '' },
    timeoutMs: 30 * 60_000 };
}

async function atomicJson(file, value) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

/** Child groups and logs belong only to this run. Never restarts an installed service. */
export async function runClassroomAcceptance(args = process.argv.slice(2), environment = process.env) {
  const options = parseAcceptanceOptions(args);
  if (options.help) {
    console.log('Usage: pnpm test:classroom-acceptance [--smoke] [--minutes=0.2] [--students=2] [--soak-classes=3] [--checks=unit,ui,linkage,practice,classroom,faults]\nFormal target: 1 teacher + 30 students (15 Chrome / 15 Edge), three consecutive 90-minute classes in one application process.\nSoak runs three five-stage classes in one app process before the last class fault/restart scenarios.\nBuilds once, runs sequentially against isolated backends, never restarts production.\nSmoke, missing checks, skipped tests and missing evidence cannot pass formal acceptance.');
    return null;
  }
  const root = projectRoot;
  const runId = randomUUID();
  const output = path.join(root, 'test-results/classroom-acceptance', runId);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const reportFile = path.join(output, 'report.json');
  const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), options,
    toolchain: { node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch,
      packageManagerUserAgent: environment.npm_config_user_agent ?? null },
    target: { teachers: 1, students: options.students, minutes: options.minutes,
      browserCounts: { 'google-chrome': Math.ceil(options.students / 2), 'microsoft-edge': Math.floor(options.students / 2) } },
    outcome: 'running', identityVerified: false, build: { status: 'pending' }, runs: [], failures: [],
    limitations: [
      'Local isolated browser acceptance does not verify classroom Wi-Fi, physical audio/projection hardware or all possible future failures.',
    ],
  };
  let child;
  let forcedStopTimer;
  let timer;
  let checking;
  let stopped = false;
  const stopChild = () => {
    const pid = child?.pid;
    if (!pid) return;
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already exited */ }
    // Allow bounded app shutdown and two 30s diagnostic dumps on manual
    // interruption as well as a timeout. No business/model deadline changes.
    forcedStopTimer ??= setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
    }, 90_000);
  };
  const interrupted = () => { stopped = true; report.failures.push('Acceptance interrupted'); stopChild(); };
  const checkIdentity = async () => {
    assertAcceptanceIdentityUnchanged(report.identity, await captureWorkspaceIdentity(root));
    if (report.build.buildId && await readCapacityBuildId(path.join(root, '.next-build/BUILD_ID')) !== report.build.buildId) throw new Error('Candidate build changed during acceptance');
    report.identityCheckedAt = new Date().toISOString();
  };
  const execute = async descriptor => {
    await mkdir(descriptor.directory, { recursive: true, mode: 0o700 });
    const logPath = path.join(descriptor.directory, 'run.log');
    const log = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
    const childEnvironment = { ...environment, ...descriptor.env };
    for (const key of ['PRELAUNCH_RESUME_AI_DIR', 'PRELAUNCH_RESUME_PUBLIC_DISCUSSION', 'PRELAUNCH_COURSE_GENERATION']) delete childEnvironment[key];
    const startedAt = new Date().toISOString();
    console.log(`Starting ${descriptor.check}${descriptor.brand ? `/${descriptor.brand}` : ''}; log: ${logPath}`);
    let timeout;
    const result = await new Promise(resolve => {
      child = spawn(descriptor.command, descriptor.args, { cwd: root, env: childEnvironment, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      child.once('error', error => resolve({ exitCode: null, error: error.message }));
      child.once('close', (exitCode, signal) => resolve({ exitCode, ...(signal ? { signal } : {}) }));
      timeout = setTimeout(() => {
        report.failures.push(`Timed out: ${descriptor.check}`);
        stopChild();
      }, descriptor.timeoutMs);
    });
    clearTimeout(timeout); clearTimeout(forcedStopTimer); forcedStopTimer = undefined;
    child = undefined;
    await new Promise((resolve, reject) => { log.once('error', reject); log.end(resolve); });
    return { ...result, startedAt, finishedAt: new Date().toISOString(), logPath };
  };
  process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  try {
    report.identity = await captureWorkspaceIdentity(root);
    await atomicJson(reportFile, report);
    if (stopped) throw new Error('Acceptance interrupted before the candidate build');
    const browsers = options.checks.some(check => check !== 'unit') ? resolveAcceptanceBrowsers(root, environment) : {};
    report.browserExecutables = browsers;
    timer = setInterval(() => {
      if (checking || stopped) return;
      checking = checkIdentity().catch(error => { stopped = true; report.failures.push(error.message); stopChild(); }).finally(() => { checking = undefined; });
    }, 30_000);
    const build = await execute(acceptanceBuildCommand(output));
    report.build = { ...build, status: build.exitCode === 0 ? 'passed' : 'failed' };
    if (build.exitCode !== 0) throw new Error('Candidate production build failed');
    await checkIdentity();
    report.build.buildId = await readCapacityBuildId(path.join(root, '.next-build/BUILD_ID'));
    report.build.sourceSha256 = report.identity.source.sha256;
    report.build.migrationsSha256 = report.identity.migrations.sha256;
    await atomicJson(reportFile, report);
    for (const descriptor of acceptanceCommands(options, { root, output, runId, browsers })) {
      if (stopped) break;
      await checkIdentity();
      const result = await execute(descriptor);
      let verdict;
      try {
        const raw = JSON.parse(await readFile(descriptor.reportPath, 'utf8'));
        const testReport = ['ui', 'faults'].includes(descriptor.check) ? JSON.parse(await readFile(path.join(descriptor.directory, 'playwright.json'), 'utf8')) : undefined;
        verdict = evaluateChildReport(descriptor.check, raw, { buildId: report.build.buildId, runId, options,
          brand: descriptor.brand, startedAt: result.startedAt, testReport });
      } catch (error) { verdict = { outcome: 'failed', failures: [`Cannot verify raw child evidence: ${error.message}`], missing: [] }; }
      report.runs.push({ check: descriptor.check, ...(descriptor.brand ? { brand: descriptor.brand } : {}), evidence: descriptor.evidence,
        reportPath: descriptor.reportPath, ...result, verdict });
      await checkIdentity();
      await atomicJson(reportFile, report);
      console.log(`${descriptor.check}${descriptor.brand ? `/${descriptor.brand}` : ''}: ${verdict.outcome}`);
    }
    clearInterval(timer);
    await checking;
    if (!stopped) { await checkIdentity(); report.identityVerified = true; }
  } catch (error) { report.failures.push(error.message); }
  finally {
    clearInterval(timer);
    await checking;
    process.off('SIGINT', interrupted); process.off('SIGTERM', interrupted);
    report.finishedAt = new Date().toISOString();
    Object.assign(report, evaluateAcceptance(report));
    report.review = await writeClassroomAcceptanceReview(report, output);
    await atomicJson(reportFile, report);
    console.log(`Classroom acceptance: ${report.outcome}\nReport: ${reportFile}`);
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runClassroomAcceptance().then(report => { process.exitCode = acceptanceExitCode(report); })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
