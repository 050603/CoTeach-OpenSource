import type { Browser, BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import { captureLayoutScreenshot, deployedLayoutBuild, measureLayoutEnvironment, openLayoutContext } from '../../scripts/lib/layout-browser.mjs';

/** Desktop browser content areas. A small desktop window is still a desktop:
 * do not infer phone/tablet identity from its CSS width. Native browser zoom
 * is exercised separately and must not be inferred from these dimensions. */
export const desktopViewports = [
  { width: 768, height: 576 },
  { width: 1024, height: 576 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 1920, height: 1200 },
  { width: 2560, height: 1440 },
  { width: 3440, height: 1440 },
  { width: 3840, height: 2160 },
];

export const desktopOnly = process.env.OPENPBL_E2E_DESKTOP_ONLY === '1';

export function selectedDesktopViewports() {
  const selection = process.env.OPENPBL_DESKTOP_VIEWPORTS?.split(',');
  if (!selection) return desktopViewports;
  const selected = desktopViewports.filter(({ width, height }) => selection.includes(`${width}x${height}`));
  if (selected.length !== selection.length) throw new Error(`Unknown desktop viewport: ${selection.join(',')}`);
  return selected;
}

// The existing suites retain their full device coverage for ordinary CI.
// Desktop acceptance opts in explicitly and supplies desktop-sized matrices.
export function desktopAcceptanceViewports<T extends { width: number; height: number }>(ordinary: T[]) {
  return desktopOnly ? selectedDesktopViewports() : ordinary;
}

type DesktopProfile = {
  viewport: { width: number; height: number };
  zoom: number;
  dpr: number;
  nativeZoom: boolean;
  name: string;
  hasTouch?: boolean;
  isMobile?: boolean;
};

export function desktopAcceptanceProfiles(ordinary: Array<{ width: number; height: number }>): DesktopProfile[] {
  if (process.env.OPENPBL_E2E_TOUCH_ONLY === '1') {
    if (desktopOnly || process.env.OPENPBL_DESKTOP_NATIVE_ZOOM || process.env.OPENPBL_DESKTOP_DPRS) {
      throw new Error('Touchscreen profiles require an independent run from desktop zoom and DPR.');
    }
    return [
      { width: 768, height: 1024 }, { width: 1024, height: 768 },
      { width: 390, height: 844 }, { width: 844, height: 390 },
      { width: 320, height: 568 }, { width: 568, height: 320 },
    ].map(viewport => ({ viewport, zoom: 1, dpr: 1, nativeZoom: false, hasTouch: true,
      isMobile: viewport.width < 1024, name: 'touch zoom 100% DPR 1' }));
  }
  const nativeZoom = Boolean(process.env.OPENPBL_DESKTOP_NATIVE_ZOOM);
  const zooms = nativeZoom ? process.env.OPENPBL_DESKTOP_NATIVE_ZOOM!.split(',').map(Number) : [1];
  const dprs = process.env.OPENPBL_DESKTOP_DPRS ? process.env.OPENPBL_DESKTOP_DPRS.split(',').map(Number) : [1];
  if (nativeZoom && dprs.some((dpr) => dpr !== 1)) throw new Error('Native page zoom and DPR emulation require independent runs.');
  const core = selectedDesktopViewports().filter(({ width, height }) => process.env.OPENPBL_DESKTOP_VIEWPORTS
    || width === 1366 && height === 768 || width === 1920 && height === 1080);
  const viewports = nativeZoom || process.env.OPENPBL_DESKTOP_DPRS ? core : desktopAcceptanceViewports(ordinary);
  return viewports.flatMap((viewport) => zooms.flatMap((zoom) => dprs.map((dpr) => ({
    viewport, zoom, dpr, nativeZoom, name: `${nativeZoom ? 'native zoom' : 'zoom'} ${Math.round(zoom * 100)}% DPR ${dpr}`,
  }))));
}

export async function captureDesktopScreenshot(page: Page, path: string, fullPage = false) {
  if (process.env.OPENPBL_DESKTOP_NATIVE_ZOOM) return captureLayoutScreenshot(page, path, true);
  return page.screenshot({ path, fullPage, animations: 'disabled' });
}

/** Measure clipping in CSS pixels so fractional native scroll positions do not
 * turn a subpixel border into an inaccessible whole-canvas assertion. */
export async function visibleLayoutClipping(locator: Locator) {
  return locator.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const clips = [Math.max(0, -bounds.left, bounds.right - innerWidth, -bounds.top, bounds.bottom - innerHeight)];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), clip = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) clips.push(Math.max(0, clip.left - bounds.left, bounds.right - clip.right));
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) clips.push(Math.max(0, clip.top - bounds.top, bounds.bottom - clip.bottom));
    }
    return Math.max(...clips);
  });
}

/** Reuse each suite's existing business fixture and assertions in a measured
 * desktop context. Native mode uses a real persistent Chrome/Edge profile;
 * no call to setViewportSize, CSS zoom or User-Agent substitution is involved. */
export async function withDesktopProfile(profile: DesktopProfile, browser: Browser, info: TestInfo,
  run: (session: { context: BrowserContext; page: Page }) => Promise<void>,
  baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000') {
  const session = await openLayoutContext({ browser, engine: browser.browserType().name(), executablePath: process.env.PRELAUNCH_E2E_EXECUTABLE_PATH,
    label: process.env.PRELAUNCH_E2E_BROWSER_LABEL || browser.browserType().name(), viewport: profile.viewport,
    zoom: profile.zoom, dpr: profile.dpr, nativeZoom: profile.nativeZoom,
    ...(profile.hasTouch ? { hasTouch: true, ...(browser.browserType().name() === 'firefox' ? {} : { isMobile: profile.isMobile }) } : {}),
    baseURL, serviceWorkers: 'allow', reducedMotion: 'reduce' });
  // Keep sandboxed source previews untouched while preventing any top-level
  // service worker from bypassing the suites' explicit business API routes.
  await session.context.addInitScript(() => {
    if (window !== window.top || !navigator.serviceWorker) return;
    Object.defineProperty(navigator.serviceWorker, 'register', {
      value: () => Promise.reject(new Error('Service worker registration is disabled in the desktop fixture.')),
    });
  });
  const page = await session.context.newPage();
  const buildId = await deployedLayoutBuild(baseURL);
  try { await run({ context: session.context, page }); }
  catch (error) {
    const path = info.outputPath('desktop-profile-failure.png');
    await captureDesktopScreenshot(page, path).then(() => info.attach('desktop-profile-failure', { path, contentType: 'image/png' })).catch(() => {});
    throw error;
  } finally {
    try {
      const runtime = await measureLayoutEnvironment(page, { ...profile, physicalWidth: profile.viewport.width, physicalHeight: profile.viewport.height });
      await info.attach('desktop-environment', { body: JSON.stringify({ buildId, browser: session.identity, profile, runtime }, null, 2), contentType: 'application/json' });
    } finally { await session.close(); }
  }
}

/** Every teacher/student page.tsx is associated with a real page scenario.
 * The server-backed entries must run against a disposable acceptance DB;
 * browser API mocks cannot replace Server Component repository reads. */
export const desktopRouteCoverage = [
  { route: '/teacher', scenarios: ['teacher-root'], suite: 'check-desktop-layout' },
  { route: '/teacher/login', scenarios: ['teacher-login'], suite: 'check-desktop-layout' },
  { route: '/teacher/register', scenarios: ['teacher-register'], suite: 'check-desktop-layout' },
  { route: '/teacher/classes', scenarios: ['teacher-courses'], suite: 'check-desktop-layout' },
  { route: '/teacher/classes/[offeringId]', scenarios: ['teacher-course', 'teacher-course-dialog'], suite: 'check-desktop-layout' },
  { route: '/teacher/classes/[offeringId]/access', scenarios: ['teacher-access-redirect'], suite: 'check-desktop-layout' },
  { route: '/teacher/classes/[offeringId]/students', scenarios: ['teacher-students', 'teacher-student-detail'], suite: 'check-desktop-layout' },
  { route: '/teacher/classes/[offeringId]/activities/[activityId]/experiment', scenarios: ['teacher-experiment'], suite: 'check-desktop-layout' },
  { route: '/teacher/classrooms/[instanceId]', scenarios: ['teacher-records', 'teacher-record-states'], suite: 'desktop-page-coverage' },
  { route: '/teacher/participations/[participationId]', scenarios: ['teacher-participation'], suite: 'desktop-page-coverage' },
  { route: '/teacher/templates', scenarios: ['teacher-library'], suite: 'check-desktop-layout' },
  { route: '/teacher/templates/new', scenarios: ['teacher-template-new'], suite: 'check-desktop-layout' },
  { route: '/teacher/templates/pbl/new', scenarios: ['teacher-template-pbl-new'], suite: 'check-desktop-layout' },
  { route: '/teacher/textbooks', scenarios: ['textbook library → reading → evidence → real graph → fullscreen → keyboard search and history'], suite: 'textbook-library' },
  { route: '/teacher/textbooks/[id]', scenarios: ['reader visual acceptance', 'real Canvas performance and bounded graph'], suite: 'textbook-library' },
  { route: '/teacher/prepare/[id]/verify', scenarios: ['quick-preparation', 'saved outlines and blueprints remain readable during classroom generation'], suite: 'check-teaching-layout / course-design-details' },
  { route: '/teacher/prepare/[id]/generate', scenarios: ['generate-redirect'], suite: 'check-teaching-layout' },
  { route: '/teacher/prepare/[id]/verify/edit', scenarios: ['preparation', 'teacher populated design knowledge timing blueprint and classroom'], suite: 'check-teaching-layout / desktop-content-states' },
  { route: '/teacher/prepare/[id]/resources', scenarios: ['resources-empty', 'teacher populated resources preview and scripts'], suite: 'check-teaching-layout / desktop-content-states' },
  { route: '/teacher/prepare/[id]/preview', scenarios: ['player'], suite: 'check-teaching-layout' },
  { route: '/teacher/prepare/[id]/classroom-editor', scenarios: ['classroom editor and whiteboard controls fit'], suite: 'teacher-classroom-editor' },
  { route: '/teacher/prepare/[id]/versions', scenarios: ['teacher-versions'], suite: 'desktop-page-coverage' },
  { route: '/teacher/teach/[id]/setup', scenarios: ['teacher/legacy-template-setup', 'teacher/compatible-classroom-setup', 'teacher/pbl-classroom-setup'], suite: 'verify-prelaunch-functional', backend: 'isolated' },
  { route: '/teacher/teach/[id]/classroom', scenarios: ['teacher-classroom', 'teacher-knowledge-analytics'], suite: 'check-teaching-layout' },
  { route: '/teacher/teach/[id]/history', scenarios: ['teacher/legacy-classroom-history'], suite: 'verify-prelaunch-functional', backend: 'isolated' },
  { route: '/teacher/surveys/[activityId]', scenarios: ['survey-donut', 'survey-bar', 'survey-column', 'survey-text', 'survey-presentation'], suite: 'check-desktop-layout' },
  { route: '/teacher/settings', scenarios: ['teacher-settings', 'teacher-settings-ai', 'teacher-settings-ai-detail'], suite: 'check-desktop-layout' },
  { route: '/student', scenarios: ['student-root', 'student-courses'], suite: 'check-desktop-layout' },
  { route: '/student/login', scenarios: ['student-login'], suite: 'check-desktop-layout' },
  { route: '/student/register', scenarios: ['student-register', 'student-register-account'], suite: 'check-desktop-layout' },
  { route: '/student/reset-password', scenarios: ['student-reset-password'], suite: 'check-desktop-layout' },
  { route: '/student/profile', scenarios: ['student-profile'], suite: 'check-desktop-layout' },
  { route: '/student/courses/[offeringId]', scenarios: ['student-course', 'student-course-long-copy'], suite: 'check-desktop-layout' },
  { route: '/student/activities/[activityId]', scenarios: ['student-survey', 'student assignment quiz resource and classroom activity content'], suite: 'check-desktop-layout / desktop-content-states' },
  { route: '/student/activities/[activityId]/assessments/[instanceId]/[phase]', scenarios: ['student-pretest', 'student-posttest'], suite: 'desktop-page-coverage' },
  { route: '/student/participations/[participationId]', scenarios: ['student-participation'], suite: 'desktop-page-coverage' },
  { route: '/student/classroom/[id]', scenarios: ['student-player'], suite: 'check-teaching-layout' },
  { route: '/student/ai-learning/[id]', scenarios: ['student-standalone-player'], suite: 'check-teaching-layout' },
  { route: '/student/ai-collaboration/[id]', scenarios: ['code', 'student document retains draft recovery and save actions in a narrow desktop window'], suite: 'check-teaching-layout / student-usability' },
];

export const desktopCoverageEntries = desktopRouteCoverage.map((entry) => ({
  ...entry,
  evidence: entry.backend === 'isolated' ? 'isolated-backend' : 'browser-fixtures',
}));
