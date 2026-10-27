import { expect, test } from '@playwright/test';
import { readdirSync } from 'node:fs';
import { desktopCoverageEntries, selectedDesktopViewports } from './fixtures/desktop-coverage';
import { assertDesktopPageRendering, attachDesktopState, desktopInstanceId, desktopPageScenarios, installDesktopPageFixtures } from './fixtures/desktop-pages';
import { deployedLayoutBuild, selectLayoutCases, measureLayoutEnvironment, openLayoutContext } from '../scripts/lib/layout-browser.mjs';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';
test.use({ baseURL, serviceWorkers: 'block', contextOptions: { reducedMotion: 'reduce' } });

test('teacher and student route inventory is complete', async ({}, info) => {
  const pages = ['teacher', 'student'].flatMap((role) => readdirSync(`src/app/${role}`, { recursive: true })
    .map((file) => String(file).replaceAll('\\', '/')).filter((file) => file === 'page.tsx' || file.endsWith('/page.tsx'))
    .map((file) => `/${role}${file === 'page.tsx' ? '' : `/${file.replace(/\/page\.tsx$/, '')}`}`));
  expect(desktopCoverageEntries.map(({ route }) => route).sort()).toEqual(pages.sort());
  await info.attach('desktop-route-coverage', { body: JSON.stringify(desktopCoverageEntries, null, 2), contentType: 'application/json' });
});

selectLayoutCases([...desktopPageScenarios, { id: 'teacher-record-states' }], process.env.OPENPBL_DESKTOP_SCENARIOS);

const nativeZoom = Boolean(process.env.OPENPBL_DESKTOP_NATIVE_ZOOM);
const zooms = nativeZoom ? process.env.OPENPBL_DESKTOP_NATIVE_ZOOM!.split(',').map(Number) : [1];
const dprs = process.env.OPENPBL_DESKTOP_DPRS ? process.env.OPENPBL_DESKTOP_DPRS.split(',').map(Number) : [1];
const viewports = selectedDesktopViewports().filter(({ width, height }) => !nativeZoom || process.env.OPENPBL_DESKTOP_VIEWPORTS || width === 1366 && height === 768 || width === 1920 && height === 1080);
const profiles = viewports.flatMap((viewport) => zooms.flatMap((zoom) => dprs.map((dpr) => ({ viewport, zoom, dpr }))));
const selection = process.env.OPENPBL_DESKTOP_SCENARIOS?.split(',');
if (selection?.some((id) => !desktopPageScenarios.some((scenario) => scenario.id === id) && id !== 'teacher-record-states')) {
  throw new Error(`Unknown desktop scenarios: ${selection.join(',')}`);
}
let buildId: string | null;
test.beforeAll(async () => { buildId = await deployedLayoutBuild(baseURL); });

for (const { viewport, zoom, dpr } of profiles) {
  test.describe(`desktop ${viewport.width}x${viewport.height} ${nativeZoom ? 'native-zoom' : 'zoom'} ${zoom} DPR ${dpr}`, () => {
    for (const scenario of desktopPageScenarios.filter(({ id }) => !selection || selection.includes(id))) {
      test(scenario.id, async ({ browser }, info) => {
        test.setTimeout(60_000);
        const session = await openLayoutContext({ browser, engine: browser.browserType().name(), executablePath: process.env.PRELAUNCH_E2E_EXECUTABLE_PATH,
          label: process.env.PRELAUNCH_E2E_BROWSER_LABEL || browser.browserType().name(), viewport, zoom, dpr, nativeZoom,
          baseURL, serviceWorkers: 'allow', reducedMotion: 'reduce' });
        const page = await session.context.newPage();
        const fixture = await installDesktopPageFixtures(page, baseURL, scenario.role);
        try {
          const response = await page.goto(scenario.path);
          expect(response?.status(), 'Application document is available').toBe(200);
          await scenario.exercise(page, info);
          await assertDesktopPageRendering(page);
          expect(fixture.audit.unexpected, 'All business reads and writes use explicit fixtures').toEqual([]);
          expect(fixture.audit.errors, 'No uncaught component failures').toEqual([]);
          expect(fixture.audit.failedResources, 'Real application resources load').toEqual([]);
        } catch (error) {
          if (!page.isClosed()) await attachDesktopState(page, info, 'failure-state').catch(() => {});
          throw error;
        } finally {
          try {
            if (!page.isClosed()) {
              const runtime = await measureLayoutEnvironment(page, { zoom, dpr, nativeZoom, physicalWidth: viewport.width, physicalHeight: viewport.height });
              await info.attach('desktop-evidence', { body: JSON.stringify({ buildId, browser: session.identity, viewport, runtime, ...fixture.audit }, null, 2), contentType: 'application/json' });
            }
          } finally { await session.close(); }
        }
      });
    }

    if (!process.env.OPENPBL_DESKTOP_SCENARIOS || selection?.includes('teacher-record-states')) {
      test('teacher-record-states', async ({ browser }, info) => {
        const session = await openLayoutContext({ browser, engine: browser.browserType().name(), executablePath: process.env.PRELAUNCH_E2E_EXECUTABLE_PATH,
          label: process.env.PRELAUNCH_E2E_BROWSER_LABEL || browser.browserType().name(), viewport, zoom, dpr, nativeZoom,
          baseURL, serviceWorkers: 'allow', reducedMotion: 'reduce' });
        const page = await session.context.newPage();
        const fixture = await installDesktopPageFixtures(page, baseURL, 'teacher');
        try {
          fixture.setRecordMode('loading');
          await page.goto(`/teacher/classrooms/${desktopInstanceId}`);
          await expect(page.getByRole('status')).toContainText('正在加载学习记录');
          await attachDesktopState(page, info, 'classroom-records-loading');
          fixture.setRecordMode('error');
          await expect(page.getByRole('alert').filter({ hasText: fixture.transientError })).toBeVisible();
          await attachDesktopState(page, info, 'classroom-records-error');
          fixture.setRecordMode('empty');
          await page.getByRole('button', { name: '重新加载', exact: true }).click();
          await expect(page.getByRole('heading', { name: '等待第一份学习记录', exact: true })).toBeVisible();
          await attachDesktopState(page, info, 'classroom-records-empty');
          fixture.setRecordMode('ready');
          await page.getByRole('button', { name: '刷新记录', exact: true }).click();
          await expect(page.getByRole('table').getByRole('row')).toHaveCount(15);
          expect(fixture.audit.unexpected).toEqual([]);
          expect(fixture.audit.errors).toEqual([]);
          expect(fixture.audit.failedResources).toEqual([]);
          const runtime = await measureLayoutEnvironment(page, { zoom, dpr, nativeZoom, physicalWidth: viewport.width, physicalHeight: viewport.height });
          await info.attach('desktop-evidence', { body: JSON.stringify({ buildId, browser: session.identity, viewport, runtime, ...fixture.audit }, null, 2), contentType: 'application/json' });
        } finally { await session.close(); }
      });
    }
  });
}
