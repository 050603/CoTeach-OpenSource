import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';

const hash = text => createHash('sha256').update(text).digest('hex');
const normalize = text => text.replace(/[\s\u200B-\u200D\uFEFF]/gu, '');

/** Read every student's actual persisted artifact through both teacher display modes. */
export async function runTeacherArtifactPreviews({ teacher, students, instance, origin, db, request, record, output, mode }) {
  const name = `teacher-artifact-preview-${mode}`;
  const evidence = { instanceId: instance.id, mode, students: [], checks: [], errors: [], browserErrors: [] };
  const page = teacher.page;
  const listener = error => evidence.browserErrors.push(error.message);
  page.on('pageerror', listener);
  await mkdir(output, { recursive: true });
  try {
    assert.ok(['document', 'python', 'c', 'other'].includes(mode)); assert.ok(students.length);
    const course = (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
    assert.equal(course.stages[course.currentStageIndex].key, 'make', 'Teacher previews must run while the project-practice stage is selected');
    assert.equal(course.pblConfig.makeArtifactMode, mode);
    const userIds = students.map(student => student.user.id);
    const expectedType = mode === 'document' ? 'document' : mode === 'other' ? 'artifact-brief' : 'code';
    const [submissions, versions, users] = await Promise.all([
      db.classroomSubmission.findMany({ where: { participation: { instanceId: instance.id, enrollment: { userId: { in: userIds } } },
        // Storage keys distinguish artifact types; the projected payload keeps stageKey="make".
        stageKey: { in: [`make:${expectedType}`, 'make'] }, status: { not: 'ARCHIVED' } },
      include: { participation: { include: { enrollment: true } } } }),
      db.artifactVersion.findMany({ where: { artifact: { participation: { instanceId: instance.id, enrollment: { userId: { in: userIds } } } } },
        include: { artifact: { include: { participation: { include: { enrollment: true } } } }, fileAsset: true } }),
      db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }),
    ]);
    for (const student of students) {
      const userId = student.user.id;
      const user = users.find(item => item.id === userId);
      assert.ok(user?.displayName); assert.equal(course.students.find(item => item.id === userId)?.name, user.displayName);
      const ownSubmissions = submissions.filter(row => row.participation.enrollment.userId === userId)
        .map(row => ({ row, view: row.payload?.view ?? row.payload }))
        .filter(({ view }) => view.stageKey === 'make' && view.type === expectedType && view.status !== 'failed')
        .sort((a, b) => Date.parse(b.view.updatedAt ?? b.row.updatedAt) - Date.parse(a.view.updatedAt ?? a.row.updatedAt));
      const latest = ownSubmissions[0];
      if (mode !== 'other') assert.ok(latest, `${user.displayName} has no persisted ${expectedType}`);
      if (latest) {
        const projected = course.submissions.find(item => item.id === latest.view.id || item.id === latest.row.id);
        assert.ok(projected, 'Teacher state omitted the stored submission');
        assert.equal(projected.content, latest.view.content);
      }
      const ownVersions = versions.filter(row => row.artifact.participation.enrollment.userId === userId
        && (mode === 'document' ? row.artifact.type === 'DOCUMENT_ARCHIVE' : ['FILE_ARCHIVE', 'PDF_ARCHIVE'].includes(row.artifact.type)));
      if (mode === 'document' || mode === 'other') assert.ok(ownVersions.length, `${user.displayName} needs submitted versions before preview validation`);
      const item = { userId, displayName: user.displayName, submissionId: latest?.row.id,
        contentSha256: latest ? hash(latest.view.content) : null, versions: ownVersions.map(version => ({
          id: version.id, sequence: version.sequence, title: version.artifact.title,
          originalName: version.fileAsset?.originalName, uploadId: version.fileAssetId, status: version.status,
        })) };
      evidence.students.push(item);
    }
    await page.goto(`${origin}/teacher/teach/${instance.id}/classroom`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    const visible = locator => locator.filter({ visible: true }).first();
    const exitFullscreen = async () => {
      const button = visible(page.getByRole('button', { name: '退出全屏', exact: true }));
      if (await button.isVisible()) await button.click();
    };
    await exitFullscreen();
    await expect(visible(page.getByText('项目实践进度', { exact: true }))).toBeVisible({ timeout: 30_000 });
    const inspect = async (student, display) => {
      const preview = visible(page.locator(`[id="practice-artifact-${student.userId}"]`));
      await expect(preview).toBeVisible({ timeout: 15_000 });
      const card = preview.locator('..');
      const latest = submissions.filter(row => row.participation.enrollment.userId === student.userId)
        .map(row => ({ row, view: row.payload?.view ?? row.payload }))
        .filter(({ view }) => view.stageKey === 'make' && view.type === expectedType && view.status !== 'failed')
        .sort((a, b) => Date.parse(b.view.updatedAt ?? b.row.updatedAt) - Date.parse(a.view.updatedAt ?? a.row.updatedAt))[0]?.view;
      if (latest && (mode === 'document' || mode === 'other')) {
        const expected = await page.evaluate(html => {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          doc.querySelectorAll('script,style').forEach(node => node.remove());
          return doc.body.textContent ?? '';
        }, latest.content);
        assert.ok(normalize(expected), 'An empty authored document cannot establish preview content correctness');
        const rendered = preview.locator('[data-document-preview="true"]');
        await expect(rendered).toBeVisible();
        await expect.poll(async () => normalize(await rendered.innerText()), { timeout: 15_000 })
          .toBe(normalize(expected));
      }
      if (mode === 'python' || mode === 'c') {
        const code = JSON.parse(latest.content);
        assert.equal(code.language, mode); assert.ok(code.files.length);
        await expect(preview.locator('pre code')).toHaveCount(code.files.length);
        for (const file of code.files) {
          const section = preview.getByText(file.path, { exact: true }).locator('..');
          await expect(section.locator('pre code')).toHaveText(file.content, { useInnerText: false });
          assert.equal(await section.locator('pre code').textContent(), file.content, 'Teacher preview changed saved source bytes');
        }
      }
      if (mode === 'document') {
        const block = card.getByText('Word 提交版本', { exact: true }).locator('..').locator('..');
        await expect(block).toBeVisible();
        await expect(block.getByRole('link', { name: '下载 Word', exact: true })).toHaveCount(student.versions.length);
        for (const version of student.versions) {
          assert.equal(version.status, 'SUBMITTED'); assert.ok(version.uploadId);
          const link = block.locator(`a[href="/api/uploads/${version.uploadId}?download=1"]`);
          await expect(link).toBeVisible();
          await expect(link.locator('..')).toContainText(`第 ${version.sequence} 版`);
        }
      }
      if (mode === 'other') {
        const block = preview.locator(`[id="practice-upload-${student.userId}"]`);
        await expect(block.getByRole('listitem')).toHaveCount(student.versions.length);
        for (const version of student.versions) {
          assert.equal(version.status, 'SUBMITTED'); assert.ok(version.uploadId);
          const row = block.getByRole('listitem').filter({ hasText: `第 ${version.sequence} 版 · ${version.title}` });
          await expect(row).toBeVisible();
          await expect(row.getByRole('link', { name: '下载', exact: true }))
            .toHaveAttribute('href', `/api/uploads/${encodeURIComponent(version.uploadId)}?download=1`);
          const openable = /\.(pdf|doc|docx)$/i.test(version.title);
          await expect(row.getByRole('link', { name: '打开', exact: true })).toHaveCount(openable ? 1 : 0);
          if (!openable) await expect(row).toContainText('暂不支持在线预览');
        }
      }
      if (display === 'fullscreen') {
        await expect(card.locator(`[id="practice-conversation-${student.userId}"]`)).toHaveCount(0);
        await expect(card.getByText('学生与 AI 协作对话', { exact: true })).toHaveCount(0);
      }
      evidence.checks.push({ studentId: student.userId, display, status: '通过',
        contentSha256: student.contentSha256, versions: student.versions.map(item => item.id) });
    };
    const inspectAll = async display => {
      for (const student of evidence.students) {
        try {
          if (display === 'normal') {
            const button = visible(page.getByRole('button').filter({ has: page.getByText(student.displayName, { exact: true }) }));
            await button.click({ timeout: 15_000 });
          } else await visible(page.getByLabel('选择展示学生成果', { exact: true })).selectOption(student.userId);
          await inspect(student, display);
        } catch (error) {
          const detail = { studentId: student.userId, display, error: String(error?.stack || error).slice(0, 1800) };
          evidence.errors.push(detail); evidence.checks.push({ ...detail, status: '失败' });
          await page.screenshot({ path: path.join(output, `${name}-${display}-${student.userId}.png`), fullPage: true }).catch(() => undefined);
        }
      }
    };
    await inspectAll('normal');
    await visible(page.getByRole('button', { name: '全屏授课', exact: true })).click();
    try {
      await visible(page.getByRole('button', { name: '选择学生成果', exact: true })).click();
      await expect(visible(page.getByLabel('选择展示学生成果', { exact: true }))).toBeVisible();
      await inspectAll('fullscreen');
    } finally { await exitFullscreen(); }
    assert.deepEqual(evidence.browserErrors, []);
    assert.equal(evidence.errors.length, 0, `${evidence.errors.length} teacher previews failed`);
    assert.equal(evidence.checks.filter(item => item.status === '通过').length, students.length * 2);
    evidence.status = '通过';
    record(name, '通过', { mode, students: students.length, normalPreviews: students.length, fullscreenPreviews: students.length,
      savedContentMatched: true, submittedVersionLinksMatched: true, fullscreenPrivateConversationHidden: true }, 'browser-real-backend');
  } catch (error) {
    evidence.status = '失败'; evidence.error = String(error?.stack || error).slice(0, 3000);
    await page.screenshot({ path: path.join(output, `${name}-failure.png`), fullPage: true }).catch(() => undefined);
    record(name, '失败', evidence.error, 'browser-real-backend');
  } finally {
    const exit = page.getByRole('button', { name: '退出全屏', exact: true }).filter({ visible: true }).first();
    if (await exit.isVisible().catch(() => false)) await exit.click().catch(() => undefined);
    page.off('pageerror', listener);
    await writeFile(path.join(output, `${name}.json`), JSON.stringify(evidence, null, 2));
  }
  return evidence;
}
