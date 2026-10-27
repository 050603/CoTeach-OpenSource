import { expect, test } from '@playwright/test';
import { desktopAcceptanceProfiles, withDesktopProfile } from './fixtures/desktop-coverage';
import { captureDesktopContentState, contentCourseId, contentScript, installDesktopContentFixtures } from './fixtures/desktop-content-states';

const baseURL = process.env.OPENPBL_RESOURCE_E2E_BASE_URL || 'http://127.0.0.1:3000';

for (const profile of desktopAcceptanceProfiles([{ width: 1366, height: 768 }])) {
  const label = `${profile.viewport.width}x${profile.viewport.height} ${profile.name}`;
  test(`teacher populated resources preview and scripts ${label}`, async ({ browser }, info) => {
    test.setTimeout(60_000);
    await withDesktopProfile(profile, browser, info, async ({ page }) => {
      const { audit, sceneTitles } = await installDesktopContentFixtures(page, baseURL, 'teacher');
      try {
        await page.goto(`/teacher/prepare/${contentCourseId}/resources`);
        await expect(page.getByRole('heading', { name: /教师授课资源/ })).toBeVisible();
        const frame = page.frameLocator('iframe[title="授课资源播放器"]');
        // The screen-element wrapper has absolutely positioned children and
        // intentionally no box. Check the rendered slide content itself.
        const renderedTitle = frame.locator('[data-slide-element-id="resource-title"] .element-content').first();
        await expect(renderedTitle).toBeVisible({ timeout: 20_000 });
        // A full-height preview may extend below a short desktop window.
        // Scroll the outer document as a teacher would before capturing it.
        await page.locator('iframe[title="授课资源播放器"]').evaluate((element) => element.scrollIntoView({ block: 'start' }));
        await expect(renderedTitle).toBeInViewport();
        await expect(frame.getByText(contentScript, { exact: true }).first()).toBeVisible();
        const titleBounds = await renderedTitle.boundingBox();
        expect(titleBounds!.width).toBeGreaterThan(100);
        await captureDesktopContentState(page, info, 'teacher-resource-ppt');
        await page.getByRole('button', { name: `2. ${sceneTitles[1]}`, exact: false }).click();
        await expect(frame.getByText(sceneTitles[1], { exact: true }).first()).toBeVisible();
        await page.getByRole('button', { name: '讲稿文本', exact: true }).click();
        await expect(page.getByText(`${contentScript}\n${contentScript}`, { exact: true }).first()).toBeVisible();
        await page.getByRole('button', { name: '复制讲稿', exact: true }).first().click({ trial: true });
        await captureDesktopContentState(page, info, 'teacher-resource-script');
        expect(audit.errors).toEqual([]); expect(audit.resources).toEqual([]); expect(audit.unexpected).toEqual([]); expect(audit.writes).toEqual([]);
      } finally { await info.attach('content-state-api-and-assets', { body: JSON.stringify(audit, null, 2), contentType: 'application/json' }); }
    }, baseURL);
  });

  test(`teacher populated design knowledge timing blueprint and classroom ${label}`, async ({ browser }, info) => {
    test.setTimeout(60_000);
    await withDesktopProfile(profile, browser, info, async ({ page }) => {
      const { audit } = await installDesktopContentFixtures(page, baseURL, 'teacher');
      try {
        await page.goto(`/teacher/prepare/${contentCourseId}/verify/edit?section=knowledge`);
        await expect(page.getByRole('region', { name: '课程设计环节', exact: true })).toBeVisible();
        const targets = [
          { key: 'knowledge', label: '知识结构', ready: '知识点与分组' },
          { key: 'timing', label: '时间规划', ready: '知识讲授总时长（分钟）' },
          { key: 'blueprint', label: '蓝图大纲', ready: '讲授单元' },
          { key: 'classroom', label: '课堂资源', ready: '按知识小节更新课堂' },
        ];
        for (const target of targets) {
          const picker = page.getByRole('combobox', { name: '当前设计环节', exact: true });
          if (await picker.isVisible()) await picker.selectOption(target.key);
          else await page.locator('[aria-label="课程设计环节"]').getByRole('button', { name: new RegExp(target.label) }).click();
          await expect(page.getByText(target.ready, { exact: true }).first()).toBeVisible();
          if (target.key === 'knowledge') await expect(page.getByRole('combobox', { name: '关系 1 起点', exact: true })).toHaveValue('kp-1');
          if (target.key === 'blueprint') await expect(page.getByRole('textbox', { name: '核心解释', exact: true }).first()).toHaveValue('独立验证集用于评估模型的泛化表现。');
          await captureDesktopContentState(page, info, `design-${target.key}`);
          if (target.key === 'blueprint') {
            const lastPage = page.getByRole('textbox', { name: '页面标题', exact: true }).last();
            await expect(lastPage).toHaveValue('训练数据页面 12');
            await lastPage.scrollIntoViewIfNeeded();
            await expect(lastPage).toBeInViewport();
            await captureDesktopContentState(page, info, 'design-blueprint-last-page');
          }
        }
        expect(audit.errors).toEqual([]); expect(audit.resources).toEqual([]); expect(audit.unexpected).toEqual([]); expect(audit.writes).toEqual([]);
      } finally { await info.attach('content-state-api-and-assets', { body: JSON.stringify(audit, null, 2), contentType: 'application/json' }); }
    }, baseURL);
  });

  test(`student assignment quiz resource and classroom activity content ${label}`, async ({ browser }, info) => {
    await withDesktopProfile(profile, browser, info, async ({ page }) => {
      const { audit } = await installDesktopContentFixtures(page, baseURL, 'student');
      try {
        for (const type of ['Assignment', 'Quiz', 'Resource', 'Classroom']) {
          await page.goto(`/student/activities/desktop-${type}`);
          await expect(page.getByRole('heading', { name: new RegExp(`^${type} ·`) })).toBeVisible();
          if (type === 'Assignment') {
            await expect(page.getByRole('textbox', { name: '作业内容', exact: true })).toHaveValue('已保存的调查报告与原始记录');
            await page.getByRole('button', { name: '更新提交', exact: true }).click({ trial: true });
          } else if (type === 'Quiz') {
            await expect(page.getByRole('textbox')).toHaveCount(2);
            await page.getByRole('button', { name: '更新提交', exact: true }).click({ trial: true });
          } else if (type === 'Resource') {
            await expect(page.getByText('已学习', { exact: true })).toBeVisible();
            await page.getByRole('link', { name: '打开参考资料 ↗', exact: true }).click({ trial: true });
          } else {
            await page.getByRole('button', { name: '进入课堂', exact: true }).click({ trial: true });
            await page.getByRole('button', { name: /第 1 次 · 查看课堂记录/ }).click({ trial: true });
            await page.getByRole('link', { name: '开始后测', exact: true }).click({ trial: true });
          }
          await captureDesktopContentState(page, info, `activity-${type}`);
        }
        expect(audit.errors).toEqual([]); expect(audit.resources).toEqual([]); expect(audit.unexpected).toEqual([]); expect(audit.writes).toEqual([]);
      } finally { await info.attach('content-state-api-and-assets', { body: JSON.stringify(audit, null, 2), contentType: 'application/json' }); }
    }, baseURL);
  });
}
