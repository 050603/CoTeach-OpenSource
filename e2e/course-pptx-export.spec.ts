import { test, expect } from '@playwright/test';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import JSZip from 'jszip';
import sharp from 'sharp';
import katex from 'katex';
import { createPblTemplateCourse } from '../src/lib/platform/pbl-template';
import { renderPlaybackSlide, closePlaybackSlideBrowser } from '../src/lib/openmaic/export/render-playback-slide';
import type { Scene } from '../src/lib/openmaic/types/stage';

test.afterEach(async () => { await closePlaybackSlideBrowser(); });

test('downloads playback pixels with complete Chinese, SVG arrows, outlines, image cropping and charts', async ({ page, browser }, info) => {
  test.setTimeout(150_000);
  const courseId = 'e2e-pptx-export';
  const course = createPblTemplateCourse(courseId, { name: '中文公式课件', subject: '教育学', grade: '本科', hours: 1, drivingQuestion: '如何解释学习证据？' });
  course.aiLearningClassroomId = 'e2e-pptx-classroom';
  const theme = { fontName: 'Noto Sans SC', fontColor: '#163b3c', themeColors: ['#365fca'], backgroundColor: '#fff' };
  const base = { rotate: 0 };
  const canvas = { viewportSize: 1000, viewportRatio: 0.5625, theme, background: { type: 'solid', color: '#ffffff' } };
  const title = (content: string) => ({ ...base, id: 'title', type: 'text', left: 60, top: 35, width: 880, height: 70,
    content: `<p style="font-size:36px;font-weight:bold">${content}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#163b3c' });
  const scenes = [
    { id: 'concept', stageId: 'stage', title: '中文与公式', type: 'slide', order: 0, actions: [{ id: 'speech', type: 'speech', text: '严谨定义：学习证据包含可观察表现。' }], content: { type: 'slide', canvas: { ...canvas, id: 'concept-canvas', elements: [
      title('学习证据（中文、公式与表格）'),
      { ...base, id: 'body', type: 'text', left: 70, top: 140, width: 860, height: 70, content: '<p style="font-size:28px">保留完整事实：α ≤ β，&amp; 表示“与”。</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#163b3c' },
      { ...base, id: 'formula', type: 'latex', left: 70, top: 225, width: 540, height: 85, latex: '\\sum_{i=1}^{n} x_i \\leq \\alpha + \\beta', html: katex.renderToString('\\sum_{i=1}^{n} x_i \\leq \\alpha + \\beta'), color: '#365fca' },
      { ...base, id: 'list', type: 'text', left: 700, top: 220, width: 250, height: 100, content: '<ol start="3"><li>必要条件</li><li>真实顺序</li></ol>', defaultFontName: 'Noto Sans SC', defaultColor: '#163b3c' },
      { ...base, id: 'table', type: 'table', left: 70, top: 345, width: 570, height: 140, colWidths: [0.5, 0.5], cellMinHeight: 70,
        outline: { color: '#365fca', width: 1, style: 'solid' }, data: [['概念（条件）', '具体证据'], ['可观察表现', '分析、解释与迁移']].map((row, ri) => row.map((text, ci) => ({ id: `${ri}-${ci}`, text, colspan: 1, rowspan: 1, style: { fontsize: '24px', fontname: 'Noto Sans SC', color: '#163b3c' } }))) },
      { ...base, id: 'image', type: 'image', left: 720, top: 330, width: 200, height: 160, fixedRatio: false, src: 'https://course-images.test/diagram.png' },
    ] } } },
    { id: 'chart', stageId: 'stage', title: '完整图表', type: 'slide', order: 1, actions: [], content: { type: 'slide', canvas: { ...canvas, id: 'chart-canvas', elements: [
      title('教学证据比较'),
      { ...base, id: 'chart', type: 'chart', left: 70, top: 130, width: 850, height: 370, chartType: 'bar', themeColors: ['#365fca'],
        data: { labels: ['理解', '应用', '迁移'], legends: ['学习表现'], series: [[30, 60, 90]] }, options: { fontSize: 24 } },
    ] } } },
    { id: 'vectors', stageId: 'stage', title: '箭头边框与图像比例', type: 'slide', order: 2, actions: [], content: { type: 'slide', canvas: { ...canvas, id: 'vector-canvas', elements: [
      title('箭头、边框、裁图与形状文字'),
      { ...base, id: 'arrow', type: 'line', left: 110, top: 175, start: [0, 0], end: [700, 0], points: ['arrow', 'arrow'], color: '#e11d48', width: 9, style: 'solid' },
      { ...base, id: 'elbow', type: 'line', left: 110, top: 245, start: [0, 0], end: [130, 200], points: ['dot', 'arrow'], color: '#16766d', width: 7, style: 'dashed', broken: [130, 0] },
      { ...base, id: 'shape', type: 'shape', left: 310, top: 270, width: 285, height: 145, rotate: -8, viewBox: [100, 100], path: 'M0 0 L100 0 L100 100 L0 100 Z',
        fill: '#ecfdf5', outline: { width: 6, color: '#16766d', style: 'solid' },
        text: { content: '<p style="font-size:25px">保留播放器内边距<br>和真实文字换行</p>', align: 'middle', defaultFontName: 'Noto Sans SC', defaultColor: '#163b3c' } },
      { ...base, id: 'cropped', type: 'image', left: 690, top: 280, width: 220, height: 155, rotate: 12, src: 'https://course-images.test/diagram.png', fixedRatio: false,
        radius: 22, clip: { shape: 'rect', range: [[15, 0], [85, 100]] }, outline: { width: 7, color: '#365fca', style: 'solid' } },
    ] } } },
  ];
  const classroom = { id: course.aiLearningClassroomId, stage: { id: 'stage', name: course.name }, scenes, createdAt: '2026-10-20T00:00:00Z' };
  const errors: string[] = [], unexpected: string[] = [];
  let missingImage = false;
  page.on('pageerror', (error) => errors.push(error.message));
  const secret = process.env.OPENPBL_E2E_JWT_SECRET_FILE ? readFileSync(process.env.OPENPBL_E2E_JWT_SECRET_FILE, 'utf8').trim() : process.env.JWT_SECRET;
  if (secret) {
    const token = await new SignJWT({ role: 'teacher', sv: 1, username: 'e2e-pptx', displayName: '课件验收' }).setProtectedHeader({ alg: 'HS256' }).setSubject('e2e-teacher').setIssuer('openpbl').setAudience('openpbl-app').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
    await page.context().addCookies([{ name: 'openpbl_teacher', value: token, domain: new URL(info.project.use.baseURL as string).hostname, path: '/', httpOnly: true, sameSite: 'Lax' }]);
  }
  const picture = await sharp({ create: { width: 200, height: 160, channels: 3, background: '#00ced1' } })
    .composite([{ input: Buffer.from('<svg width="200" height="160"><circle cx="100" cy="80" r="65" fill="#ffc000"/><path d="M10 0V160M190 0V160" stroke="#e11d48" stroke-width="15"/></svg>') }]).png().toBuffer();
  process.env.OPENPBL_SLIDE_EXPORT_URL = `${info.project.use.baseURL}/internal/slide-export`;
  await page.routeWebSocket((url) => !url.pathname.includes('_next'), (socket) => socket.onMessage(() => undefined));
  await page.route('**/api/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/me') return json({ user: { id: 'e2e-teacher', role: 'teacher', name: '课件验收' } });
    if (path === '/api/courses') return json({ courses: [course], user: { role: 'teacher', name: '课件验收' }, hydrated: true, updatedAt: course.updatedAt });
    if (path.endsWith('/state')) return json({ course, eventCursor: '0' });
    if (path.endsWith('/events')) return json({ events: [], nextCursor: '0', hasMore: false, courseVersion: 1 });
    if (path.endsWith('/presence')) return json({ members: [], degraded: false });
    if (path.endsWith('/resource-repair')) return json({ issues: [] });
    if (path.endsWith('/generation')) return json({ backgroundEnabled: false, job: null });
    if (path.endsWith('/design-workspace')) return json({ publication: { latestVersion: 1, draftVersion: 1 } });
    if (path.endsWith('/resource-download')) return json({ schemaVersion: 1, course: { id: courseId, name: course.name },
      classrooms: [{ kind: 'main', label: '学生 AI 课堂', classroom }], sourceFiles: [{ fileName: '不应下载.pdf', url: '/api/uploads/unwanted-source' }] });
    if (path === '/api/openmaic/export/slide-image') {
      const png = await renderPlaybackSlide(request.postDataJSON().scene as Scene);
      return route.fulfill({ status: 200, contentType: 'image/png', body: png });
    }
    if (path === '/api/proxy-media') {
      expect(request.postDataJSON()).toEqual({ url: 'https://course-images.test/diagram.png' });
      return route.fulfill({ status: missingImage ? 404 : 200, contentType: 'image/png', body: missingImage ? '' : picture });
    }
    unexpected.push(`${request.method()} ${path}`);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`/teacher/prepare/${courseId}/preview`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: '下载 PPT', exact: true }), `${errors.join('; ')} / ${unexpected.join('; ')}`)
    .toBeEnabled({ timeout: 30_000 });
  for (const viewport of [
    { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 },
    { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 500 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('button', { name: '下载 PPT', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  const downloadEvent = page.waitForEvent('download');
  const exportError = page.getByText('PPT 下载失败', { exact: true }).waitFor({ state: 'visible', timeout: 60_000 }).then(async () => {
    throw new Error(`PPT export failed: ${await page.locator('[data-sonner-toast]').allTextContents()} / ${errors.join('; ')} / ${unexpected.join('; ')}`);
  });
  await page.getByRole('button', { name: '下载 PPT', exact: true }).click();
  const download = await Promise.race([downloadEvent, exportError]);
  expect(download.suggestedFilename()).toBe('中文公式课件.pptx');
  const pptxPath = info.outputPath('course.pptx');
  await download.saveAs(pptxPath);
  const zip = await JSZip.loadAsync(readFileSync(pptxPath));
  expect(Object.keys(zip.files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))).toHaveLength(3);
  const images = Object.keys(zip.files).filter((path) => /^ppt\/media\/.*\.png$/.test(path));
  expect(images).toHaveLength(3);
  for (const [index, image] of images.entries()) {
    const png = await zip.file(image)!.async('nodebuffer');
    expect(await sharp(png).metadata()).toMatchObject({ width: 2000, height: 1125 });
    const path = info.outputPath(`page-${index + 1}.png`);
    await writeFile(path, png);
    await info.attach(`page-${index + 1}`, { path, contentType: 'image/png' });
    const xml = await zip.file(`ppt/slides/slide${index + 1}.xml`)!.async('string');
    expect(xml.match(/<p:pic>/g)).toHaveLength(1);
    expect(xml).not.toContain('<a:t>');
    expect(xml).not.toContain('<a:tbl>');
  }
  const firstImage = await zip.file(images[0])!.async('nodebuffer');
  const pixel = await sharp(firstImage).extract({ left: 1480, top: 680, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
  expect([...pixel]).toEqual([0, 206, 209]);
  const chartImage = await zip.file(images[1])!.async('nodebuffer');
  const chartPixels = await sharp(chartImage).extract({ left: 140, top: 260, width: 1700, height: 740 }).removeAlpha().raw().toBuffer();
  let bluePixels = 0;
  for (let index = 0; index < chartPixels.length; index += 3) {
    if (chartPixels[index] === 54 && chartPixels[index + 1] === 95 && chartPixels[index + 2] === 202) bluePixels += 1;
  }
  expect(bluePixels, 'chart bars must be drawn before the page is captured').toBeGreaterThan(150_000);
  // Compare the download with an independently painted playback DOM, including
  // arrowheads and half-strokes outside each SVG's own viewport.
  const context = await browser.newContext({ viewport: { width: 1000, height: 563 }, deviceScaleFactor: 2 });
  try {
    const reference = await context.newPage();
    await reference.goto(`${info.project.use.baseURL}/internal/slide-export`);
    await reference.waitForFunction(() => typeof window.__openPblRenderExportSlide === 'function');
    for (const [index, savedScene] of scenes.entries()) {
      const scene = structuredClone(savedScene);
      for (const element of scene.content.canvas.elements) {
        if (element.type === 'image') element.src = `data:image/png;base64,${picture.toString('base64')}`;
      }
      await reference.evaluate(async (input) => window.__openPblRenderExportSlide!(input), scene as unknown as Scene);
      const snapshot = await reference.screenshot({ clip: { x: 0, y: 0, width: 1000, height: 563 }, animations: 'disabled' });
      await writeFile(info.outputPath(`playback-${index + 1}.png`), snapshot);
      const expected = await sharp(snapshot).extract({ left: 0, top: 0, width: 2000, height: 1125 }).ensureAlpha().raw().toBuffer();
      const actual = await sharp(await zip.file(images[index])!.async('nodebuffer')).ensureAlpha().raw().toBuffer();
      let changed = 0;
      for (let pixel = 0; pixel < expected.length; pixel += 4) {
        if ([0, 1, 2].some((channel) => Math.abs(expected[pixel + channel] - actual[pixel + channel]) > 16)) changed += 1;
      }
      expect(changed / (2000 * 1125), `page ${index + 1} must match the playback pixels`).toBeLessThan(0.001);
    }
  } finally { await context.close(); }
  expect(await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')).toContain('严谨定义：学习证据包含可观察表现。');
  // A failed asset should leave a retryable button, with no partial download.
  missingImage = true;
  const downloads: string[] = [];
  page.on('download', (item) => downloads.push(item.suggestedFilename()));
  await expect(page.getByRole('button', { name: '下载 PPT', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '下载 PPT', exact: true }).click();
  await expect(page.getByText('PPT 下载失败', { exact: true })).toBeVisible();
  await expect(page.getByText('第 1 页“中文与公式”导出失败：页面图片下载失败（HTTP 404）', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '下载 PPT', exact: true })).toBeEnabled();
  expect(downloads).toEqual([]);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
