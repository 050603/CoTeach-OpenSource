import { test, expect } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { textbookFixture } from './fixtures/textbook-library';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://localhost:3000';
test.use({ baseURL });

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 576 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`teacher libraries retain the original platform layout and BNU blue at ${viewport.width}x${viewport.height}`, async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.setViewportSize(viewport);
    const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE
      ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim() : process.env.JWT_SECRET;
    if (!secret) throw new Error('Provide the acceptance server JWT secret.');
    const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'library-test', displayName: '界面验收教师' })
      .setProtectedHeader({ alg: 'HS256' }).setSubject('library-test-teacher').setIssuer('openpbl').setAudience('openpbl-app')
      .setExpirationTime('1h').sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: 'openpbl_teacher', value: token, url: baseURL }]);
    const errors: string[] = [], unexpected: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const textbook = textbookFixture(10).textbook;
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const json = (data: unknown) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      if (request.method() === 'GET') {
        if (path === '/api/auth/me') return json({ user: { role: 'teacher', displayName: '界面验收教师', username: 'library-test' } });
        if (path === '/api/platform/offerings') return json({ offerings: [{ id: 'library-class', name: '社区生态调查教学班', term: '2026 秋季', status: 'OPEN', description: '观察并记录社区中的真实问题。', chapters: [] }] });
        if (path === '/api/platform/templates') return json({ templates: [{ id: 'library-course', title: '社区生态调查课程', status: 'ACTIVE', description: '从资料准备开始设计学习任务。', versions: [] }] });
        if (path === '/api/textbooks') return json({ items: [textbook] });
      }
      unexpected.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/teacher/classes');
    let reference: { x: number; width: number; font: string; padding: string; background: string; grid: string; gap: string } | undefined;
    for (const [label, routeName, search, cardTitle] of [
      ['教学班', 'classes', '搜索教学班', '社区生态调查教学班'],
      ['课程库', 'templates', '搜索课程', '社区生态调查课程'],
      ['教材库', 'textbooks', '搜索教材', textbook.title],
    ] as const) {
      if (routeName !== 'classes') await page.getByRole('navigation', { name: '教师导航' }).getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/teacher/${routeName}$`));
      await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: cardTitle, exact: true })).toBeVisible();
      const nav = page.getByRole('navigation', { name: '教师导航' });
      await expect(nav.locator('[aria-current="page"]')).toHaveText(label);
      await expect(nav.locator('[aria-current="page"]')).toHaveCSS('color', 'rgb(0, 61, 165)');
      await expect(nav.getByRole('link')).toHaveCount(3);
      await expect(page.locator('[data-teacher-library-heading] .pbl-teacher-create-button')).toHaveCSS('background-color', 'rgb(0, 61, 165)');
      await expect(page.locator('.pbl-platform-topbar').getByRole('link', { name: '返回平台首页' })).toHaveAttribute('href', '/');
      await expect(page.locator('[data-teacher-library-heading]')).toHaveCSS('border-bottom-width', '1px');
      if (viewport.width > 1180) await expect(page.locator('[data-teacher-library-heading] > .pbl-learning-art')).toBeVisible();
      const measurements = await page.locator('[data-teacher-library-heading]').evaluate(heading => {
        const box = heading.getBoundingClientRect();
        const surface = heading.closest('.pbl-platform-page')!;
        const grid = document.querySelector('.pbl-teacher-card-grid')!;
        return { x: box.x, width: box.width, font: getComputedStyle(heading.querySelector('h1')!).fontSize,
          padding: getComputedStyle(heading).padding, background: getComputedStyle(surface).backgroundColor,
          grid: getComputedStyle(grid).gridTemplateColumns, gap: getComputedStyle(grid).gap };
      });
      reference ??= measurements;
      expect(measurements).toEqual(reference);
      expect(measurements.background).toBe('rgb(243, 246, 250)');
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('textbox', { name: search }).fill('没有匹配的条目');
      await expect(page.getByRole('heading', { name: cardTitle, exact: true })).toHaveCount(0);
      await page.getByRole('textbox', { name: search }).clear();
      await expect(page.getByRole('heading', { name: cardTitle, exact: true })).toBeVisible();
      await page.getByRole('heading', { name: label, exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('.pbl-workspace-brand img').evaluate(image => (image as HTMLImageElement).decode());
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: info.outputPath(`${routeName}.png`), fullPage: true, animations: 'disabled' });
    }
    await page.getByRole('button', { name: '紧凑列表' }).click();
    await expect(page.getByRole('button', { name: '紧凑列表' })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('navigation', { name: '教师导航' }).getByRole('link', { name: '教学班', exact: true }).click();
    await page.getByRole('button', { name: '新建教学班', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '新建教学班' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: '创建并继续' })).toHaveCSS('background-color', 'rgb(0, 61, 165)');
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: '教师账号：界面验收教师' }).click();
    await expect(page.getByRole('menu').locator('.pbl-teacher-account-avatar')).toHaveCSS('background-color', 'rgb(0, 61, 165)');
    await page.keyboard.press('Escape');
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });
}
