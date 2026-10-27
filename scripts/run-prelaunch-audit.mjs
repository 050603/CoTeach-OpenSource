// Sequential browser acceptance; keeps business writes inside verify-prelaunch-functional.mjs.
// Run: node scripts/run-prelaunch-audit.mjs [--desktop-compat] [--with-providers] [--with-classroom-ai] [--browser-only] [--with-zoom]
// --desktop-compat uses real Chrome/Edge native page zoom. Legacy --with-zoom
// covers equivalent CSS viewports only; DPR runs independently test HiDPI.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { browserConfiguration, inspectBrowserIdentity } from './lib/prelaunch-browser.mjs';
import { desktopSizes, deployedLayoutBuild } from './lib/layout-browser.mjs';

const desktopCompatibility = process.argv.includes('--desktop-compat');
const nativeZoom = desktopCompatibility || process.argv.includes('--native-zoom');
const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.PRELAUNCH_OUTPUT_DIR || path.join(root, 'test-results/prelaunch'));
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ status: 'initializing', results: [] }, null, 2));
const baseURL = process.env.PRELAUNCH_BASE_URL || 'http://127.0.0.1:3000';
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseURL).hostname)) throw new Error('Browser audit requires a local instance');
const browsers = (process.env.PRELAUNCH_BROWSERS || (desktopCompatibility ? 'google-chrome,microsoft-edge' : 'chromium,firefox,webkit')).split(',').map(value => value.trim()).filter(Boolean);
if (!browsers.length) throw new Error('At least one browser is required');
if (browsers.some(value => !['chromium', 'firefox', 'webkit', 'google-chrome', 'microsoft-edge'].includes(value))) throw new Error('Unknown browser');
if (desktopCompatibility && browsers.some(browser => !['google-chrome', 'microsoft-edge'].includes(browser))) throw new Error('Desktop compatibility acceptance requires real Chrome and Edge');
const buildId = await deployedLayoutBuild(baseURL);
const profiles = browsers.map(label => {
  if (label === 'google-chrome' || label === 'microsoft-edge') {
    return { engine: 'chromium', ...browserConfiguration({
      PRELAUNCH_E2E_BROWSER_LABEL: label,
      PRELAUNCH_E2E_EXECUTABLE_PATH: label === 'google-chrome'
        ? process.env.PRELAUNCH_CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome'
        : process.env.PRELAUNCH_EDGE_EXECUTABLE_PATH || '/usr/bin/microsoft-edge',
    }) };
  }
  return { engine: label, label, executablePath: undefined };
});
const desktopProfiles = desktopSizes.map(([w, h]) => `desktop-${w}x${h}`).join(',');
const teachingProfiles = desktopProfiles;
const zoomFactors = (process.env.PRELAUNCH_ZOOM_FACTORS || (nativeZoom ? '0.8,0.9,1,1.1,1.25,1.5,1.75,2' : '1.25,1.5')).split(',').map(Number);
if (zoomFactors.some(value => !Number.isFinite(value) || value < 0.8 || value > 2)) throw new Error('Zoom factors must be between 0.8 and 2');
const platformCore = 'home,student-login,teacher-login,teacher-course-dialog,student-survey,survey-column,survey-text';
const teachingCore = 'teacher-classroom,teacher-knowledge-analytics,preparation,code,student-player,student-standalone-player,player';
const results = [];
writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ baseURL, buildId, windowsValidation: 'pending-real-Windows', results }, null, 2));

function execute(name, script, extra = {}, timeout = 3_600_000, scriptArgs = ['--assert']) {
  const childEnv = { LAYOUT_WORKERS: desktopCompatibility ? '4' : '1', TEACHING_WORKERS: desktopCompatibility ? '4' : '1', ...process.env, LAYOUT_BASE_URL: baseURL, ...extra };
  const useContainer = name.includes('webkit') && process.env.PRELAUNCH_WEBKIT_CONTAINER === '1';
  const command = useContainer ? 'docker' : process.execPath;
  const args = useContainer
    ? ['run', '--rm', '--network', 'host', '--user', `${process.getuid()}:${process.getgid()}`,
      '--volume', `${root}:${root}`, '--workdir', root,
      '--env', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright',
      ...Object.entries(childEnv).filter(([key]) => /^(LAYOUT|TEACHING)_/.test(key)).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
      'mcr.microsoft.com/playwright:v1.61.1-noble', 'node', script, '--assert']
    : [script, ...scriptArgs];
  const result = spawnSync(command, args, {
    cwd: root, env: childEnv,
    stdio: 'inherit', timeout,
  });
  const summaryPath = extra.LAYOUT_OUTPUT_DIR || extra.TEACHING_OUTPUT_DIR || extra.PRELAUNCH_OUTPUT_DIR;
  const playwrightReport = extra.PLAYWRIGHT_JSON_OUTPUT_FILE;
  let summary = null;
  try { summary = playwrightReport ? JSON.parse(readFileSync(playwrightReport, 'utf8')).stats : summaryPath ? JSON.parse(readFileSync(path.join(summaryPath, extra.PRELAUNCH_OUTPUT_DIR ? 'report.json' : 'summary.json'), 'utf8')) : null; } catch { /* startup failed */ }
  const hasEvidence = summary && (playwrightReport ? summary.expected > 0 && summary.unexpected === 0 && summary.skipped === 0 : true);
  const entry = { name, status: result.status === 0 && hasEvidence ? '通过' : '失败', exitCode: result.status,
    evidence: extra.PRELAUNCH_OUTPUT_DIR ? 'isolated-backend-and-optional-real-provider' : extra.LAYOUT_NATIVE_ZOOM === '1' || extra.TEACHING_NATIVE_ZOOM === '1' || extra.OPENPBL_DESKTOP_NATIVE_ZOOM || name.startsWith('native-player-editor-classroom') ? 'native-browser-zoom-with-fixtures' : 'browser-fixtures',
    error: result.error?.message ?? (!hasEvidence && result.status === 0 ? 'Missing or incomplete acceptance evidence' : null), signal: result.signal, summary };
  results.push(entry);
  writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ baseURL, buildId, windowsValidation: 'pending-real-Windows', results }, null, 2));
  return entry;
}

for (const { engine, label: browser, executablePath } of profiles) {
  if (executablePath) {
    const instance = await chromium.launch({ executablePath });
    try {
      const identity = await inspectBrowserIdentity({ label: browser, executablePath }, await instance.newContext());
      results.push({ name: `browser-identity-${browser}`, status: '通过', evidence: 'installed-browser-and-runtime', identity });
      writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ baseURL, buildId, windowsValidation: 'pending-real-Windows', results }, null, 2));
    } finally { await instance.close(); }
  }
  const layoutBrowser = { LAYOUT_BROWSER: engine, LAYOUT_BROWSER_LABEL: browser, ...(executablePath ? { LAYOUT_EXECUTABLE_PATH: executablePath } : {}) };
  const teachingBrowser = { TEACHING_BROWSER: engine, TEACHING_BROWSER_LABEL: browser, ...(executablePath ? { TEACHING_EXECUTABLE_PATH: executablePath } : {}) };
  execute(`platform-${browser}-dpr1`, 'scripts/check-desktop-layout.mjs', {
    ...layoutBrowser,
    LAYOUT_NATIVE_ZOOM: '0', LAYOUT_ZOOM: '1',
    LAYOUT_DPR: '1',
    LAYOUT_OUTPUT_DIR: path.join(output, 'layout', browser, 'dpr1'),
    LAYOUT_DEVICES: process.env.PRELAUNCH_LAYOUT_DEVICES || desktopProfiles,
    ...(process.env.PRELAUNCH_LAYOUT_SCENARIOS ? { LAYOUT_SCENARIOS: process.env.PRELAUNCH_LAYOUT_SCENARIOS } : {}),
  });
  execute(`teaching-${browser}-dpr1`, 'scripts/check-teaching-layout.mjs', {
    ...teachingBrowser,
    TEACHING_NATIVE_ZOOM: '0', TEACHING_ZOOM: '1',
    TEACHING_DPR: '1',
    TEACHING_OUTPUT_DIR: path.join(output, 'teaching', browser, 'dpr1'),
    TEACHING_DEVICES: process.env.PRELAUNCH_TEACHING_DEVICES || teachingProfiles,
    ...(process.env.PRELAUNCH_TEACHING_SCENARIOS ? { TEACHING_SCENARIOS: process.env.PRELAUNCH_TEACHING_SCENARIOS } : {}),
  });
  for (const dpr of desktopCompatibility ? [1.25, 1.5, 2] : [2]) {
    execute(`platform-${browser}-dpr${dpr}`, 'scripts/check-desktop-layout.mjs', {
      ...layoutBrowser, LAYOUT_NATIVE_ZOOM: '0', LAYOUT_ZOOM: '1', LAYOUT_DPR: String(dpr),
      LAYOUT_OUTPUT_DIR: path.join(output, 'layout', browser, `dpr${dpr}`),
      LAYOUT_DEVICES: 'desktop-1366x768,desktop-1920x1080',
      LAYOUT_SCENARIOS: process.env.PRELAUNCH_LAYOUT_SCENARIOS || platformCore,
    });
    execute(`teaching-${browser}-dpr${dpr}`, 'scripts/check-teaching-layout.mjs', {
      ...teachingBrowser, TEACHING_NATIVE_ZOOM: '0', TEACHING_ZOOM: '1', TEACHING_DPR: String(dpr),
      TEACHING_OUTPUT_DIR: path.join(output, 'teaching', browser, `dpr${dpr}`),
      TEACHING_DEVICES: 'desktop-1366x768,desktop-1920x1080',
      TEACHING_SCENARIOS: process.env.PRELAUNCH_TEACHING_SCENARIOS || teachingCore,
    });
  }
  if (nativeZoom || process.argv.includes('--with-zoom')) {
    for (const zoom of zoomFactors) {
      execute(`platform-${browser}-zoom${zoom}`, 'scripts/check-desktop-layout.mjs', {
        ...layoutBrowser, LAYOUT_ZOOM: String(zoom), LAYOUT_DPR: String(nativeZoom ? 1 : zoom), LAYOUT_NATIVE_ZOOM: nativeZoom ? '1' : '0',
        LAYOUT_OUTPUT_DIR: path.join(output, 'layout', browser, `zoom${zoom}`),
        LAYOUT_DEVICES: process.env.PRELAUNCH_ZOOM_DEVICES || 'desktop-1366x768,desktop-1920x1080',
        ...((process.env.PRELAUNCH_LAYOUT_SCENARIOS || zoom > 1.5) ? { LAYOUT_SCENARIOS: process.env.PRELAUNCH_LAYOUT_SCENARIOS || platformCore } : {}),
      });
      execute(`teaching-${browser}-zoom${zoom}`, 'scripts/check-teaching-layout.mjs', {
        ...teachingBrowser, TEACHING_ZOOM: String(zoom), TEACHING_DPR: String(nativeZoom ? 1 : zoom), TEACHING_NATIVE_ZOOM: nativeZoom ? '1' : '0',
        TEACHING_OUTPUT_DIR: path.join(output, 'teaching', browser, `zoom${zoom}`),
        TEACHING_DEVICES: process.env.PRELAUNCH_ZOOM_DEVICES || 'desktop-1366x768,desktop-1920x1080',
        ...((process.env.PRELAUNCH_TEACHING_SCENARIOS || zoom > 1.5) ? { TEACHING_SCENARIOS: process.env.PRELAUNCH_TEACHING_SCENARIOS || teachingCore } : {}),
      });
    }
  }
  if (desktopCompatibility) {
    execute(`image-stability-${browser}`, 'scripts/check-image-stability.mjs', {
      ...layoutBrowser, LAYOUT_DEVICES: 'desktop',
      LAYOUT_OUTPUT_DIR: path.join(output, 'images', browser),
    });
    const jobs = [
      { id: 'desktop-pages', suites: ['desktop-page-coverage'] },
      { id: 'desktop-pages-native', suites: ['desktop-page-coverage'], environment: { OPENPBL_DESKTOP_NATIVE_ZOOM: '0.8,0.9,1,1.1,1.25,1.5' } },
      { id: 'populated-content', suites: ['desktop-content-states', 'course-design-details'] },
      { id: 'populated-content-native', suites: ['desktop-content-states', 'course-design-details'], environment: { OPENPBL_DESKTOP_NATIVE_ZOOM: '0.8,0.9,1,1.1,1.25,1.5' } },
      { id: 'desktop-flows', suites: ['desktop-user-flows'] },
      { id: 'assessment-details', suites: ['posttest-stage'], grepInvert: 'standalone pretest' },
      { id: 'native-player-editor-classroom', suites: ['branded-native-zoom'] },
      { id: 'graphs-reader-editor', suites: ['textbook-library', 'teacher-classroom-editor', 'student-usability'],
        grep: 'reader visual acceptance|classroom editor and whiteboard controls fit|student classroom knowledge graph supports|student tutor keeps|retains draft recovery and save actions' },
      { id: 'graphs-reader-editor-native', suites: ['textbook-library', 'teacher-classroom-editor', 'student-usability'],
        environment: { OPENPBL_DESKTOP_NATIVE_ZOOM: '0.8,0.9,1,1.1,1.25,1.5' },
        grep: 'reader visual acceptance|classroom editor and whiteboard controls fit|student classroom knowledge graph supports|student tutor keeps|retains draft recovery and save actions' },
      { id: 'graphs-reader-editor-dpr', suites: ['textbook-library', 'teacher-classroom-editor', 'student-usability'],
        environment: { OPENPBL_DESKTOP_DPRS: '1.25,1.5,2' },
        grep: 'reader visual acceptance|classroom editor and whiteboard controls fit|student classroom knowledge graph supports|student tutor keeps|retains draft recovery and save actions' },
      { id: 'graphs-reader-editor-extended', suites: ['textbook-library', 'teacher-classroom-editor', 'student-usability'],
        environment: { OPENPBL_DESKTOP_NATIVE_ZOOM: '1.75,2' },
        grep: 'reader visual acceptance|classroom editor and whiteboard controls fit|student classroom knowledge graph supports|student tutor keeps|retains draft recovery and save actions' },
      { id: 'editor-visuals', suites: ['teacher-classroom-editor'],
        grep: 'chart values and all chart forms|diagram labels and attached arrows|video playback shows a retry' },
      { id: 'textbook-graph-details', suites: ['textbook-library'],
        grep: 'real Canvas performance and bounded graph|textbook library → reading' },
      { id: 'components-and-runtime', suites: ['teacher-presentation', 'project-workspace', 'pdf-browser-runtime', 'interactive-python-runtime', 'interactive-three-runtime'],
        grepInvert: '390x844|844x390|320x568|768x1024' },
      { id: 'five-stages-native', suites: ['teacher-presentation'], environment: { OPENPBL_DESKTOP_NATIVE_ZOOM: '0.8,0.9,1,1.1,1.25,1.5' },
        grep: 'all five classroom workspaces' },
      { id: 'five-stages-dpr', suites: ['teacher-presentation'], environment: { OPENPBL_DESKTOP_DPRS: '1.25,1.5,2' },
        grep: 'all five classroom workspaces' },
    ];
    for (const job of jobs) {
      const destination = path.join(output, 'e2e', browser, job.id);
      mkdirSync(destination, { recursive: true });
      execute(`${job.id}-${browser}`, 'node_modules/@playwright/test/cli.js', {
        OPENPBL_RESOURCE_E2E_BASE_URL: baseURL, OPENPBL_E2E_JWT_SECRET_FILE: process.env.LAYOUT_JWT_SECRET_FILE || path.join(root, 'deploy/secrets/jwt_secret.txt'),
        PRELAUNCH_E2E_BROWSER_LABEL: browser, PRELAUNCH_E2E_EXECUTABLE_PATH: executablePath,
        OPENPBL_E2E_DESKTOP_ONLY: '1', OPENPBL_DESKTOP_NATIVE_ZOOM: '', OPENPBL_DESKTOP_DPRS: '', PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(destination, 'report.json'),
        ...job.environment,
      }, 3_600_000, ['test', ...job.suites.map(suite => `e2e/${suite}.spec.ts`), '--workers=2', '--reporter=json',
        '--output', path.join(destination, 'artifacts'), ...(job.grep ? ['--grep', job.grep] : []), ...(job.grepInvert ? ['--grep-invert', job.grepInvert] : [])]);
    }

  }

}
if (!desktopCompatibility && !process.argv.includes('--browser-only')) {
  const branded = profiles.filter(profile => profile.executablePath);
  for (const profile of branded.length ? branded : [browserConfiguration()]) {
    execute(`isolated-functional-${profile.label}`, 'scripts/verify-prelaunch-functional.mjs', {
      PRELAUNCH_OUTPUT_DIR: path.join(output, 'functional', profile.label),
      PRELAUNCH_E2E_BROWSER_LABEL: profile.label,
      PRELAUNCH_E2E_EXECUTABLE_PATH: profile.executablePath || '',
      PRELAUNCH_REAL_PROVIDERS: process.argv.includes('--with-providers') || process.argv.includes('--with-classroom-ai') ? '1' : '0',
      PRELAUNCH_CLASSROOM_AI: process.argv.includes('--with-classroom-ai') ? '1' : process.env.PRELAUNCH_CLASSROOM_AI || '0',
    }, 1_800_000);
  }
}
try {
  const completedBuild = await deployedLayoutBuild(baseURL);
  results.push({ name: 'deployed-build-stable', status: completedBuild === buildId ? '通过' : '失败', buildId, completedBuild });
} catch (error) { results.push({ name: 'deployed-build-stable', status: '失败', error: error.message }); }
writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ baseURL, buildId, status: 'complete', windowsValidation: 'pending-real-Windows', results }, null, 2));
if (!results.length || results.some(result => result.status !== '通过')) process.exitCode = 1;
