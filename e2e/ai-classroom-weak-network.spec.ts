import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer, request as proxyRequest, type ServerResponse } from 'node:http';
import { SignJWT } from 'jose';
import { browserLearningEventReceipt } from '../scripts/lib/classroom-acceptance-action-receipts.mjs';

const timestamp = '2026-10-25T00:00:00.000Z';
const courseId = 'weak-network-fixture';
const classroomId = 'weak-network-classroom';
const studentId = 'weak-network-student';
const mediaPrefix = `/api/openmaic/classroom-media/${classroomId}/audio/`;

type AudioObservation = {
  id: number; event: string; at: number; src: string; currentTime: number;
  duration: number; bufferedEnd: number; paused: boolean; volume: number;
};
declare global {
  interface Window {
    __weakAudio: { elements: HTMLAudioElement[]; observations: AudioObservation[] };
  }
}

function narrationWav() {
  const sampleRate = 24_000;
  const samples = sampleRate * 8;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) {
    bytes.writeInt16LE(Math.round(Math.sin(index / sampleRate * Math.PI * 440) * 300), 44 + index * 2);
  }
  return bytes;
}

async function startFixture(upstreamUrl: string, initialMode: 'slow' | 'stalled' | 'fast') {
  const upstream = new URL(upstreamUrl);
  if (upstream.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(upstream.hostname)) {
    throw new Error('Weak-network acceptance requires a local HTTP application server');
  }
  const wav = narrationWav();
  const etag = `"${createHash('sha256').update(wav).digest('base64url')}"`;
  const state = {
    mode: initialMode,
    errors: [] as string[],
    media: [] as { file: string; range: string; ifNoneMatch?: string; ifRange?: string; status: number; startedAt: number; completedAt?: number; abortedAt?: number; bytes: number }[],
  };
  const scenes = [{
    id: 'lecture', stageId: classroomId, outlineId: 'lecture', title: '观察与记录', type: 'slide', order: 0,
    audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching', ttsPolicy: 'target-duration',
    actions: [
      { id: 'first', type: 'speech', text: '先观察并完整记录证据，这是第一段讲解。', audioUrl: `${mediaPrefix}first.wav`, audioDurationSec: 8 },
      { id: 'second', type: 'speech', text: '接着比较记录，这是第二段讲解。', audioUrl: `${mediaPrefix}second.wav`, audioDurationSec: 8 },
    ],
    content: { type: 'slide', canvas: { id: 'weak-network-canvas', viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: ['#16766d'], fontColor: '#29394f', fontName: 'Noto Sans SC' },
      background: { type: 'solid', color: '#ffffff' }, elements: [] } },
  }];
  const course = {
    id: courseId, version: 1, name: '校园共享网络音频验收', status: 'teaching', subject: '科学', grade: '初中', hours: 1,
    createdAt: timestamp, updatedAt: timestamp, currentStageIndex: 1, aiLearningClassroomId: classroomId,
    stages: [{ key: 'launch', label: '项目启动', view: 'simple-resource' }, { key: 'ai-learning', label: '知识讲授', view: 'ai-learning' }],
    students: [{ id: studentId, name: '弱网验收', joinedAt: timestamp, stageProgress: {} }],
    aiLearningProgress: { [studentId]: { classroomId, currentSceneIndex: 0, totalScenes: 1,
      completedScenes: [], completionModelVersion: 2, knowledgeLectureAttempts: [], lastActiveAt: timestamp } },
    content: { knowledgePoints: [], lessonOutline: [], pblOutline: '', evaluationPlan: { dimensions: [], overallRubric: '' } },
    resources: [], groups: [], submissions: [], activityLog: [], uiState: {},
  };
  const json = (response: ServerResponse, body: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  // A real same-origin HTTP stream preserves browser Range requests and cache.
  // Every business API is intercepted here, before any proxy forwarding.
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (pathname.startsWith(mediaPrefix)) {
      const file = pathname.slice(mediaPrefix.length);
      const range = request.headers.range ?? '';
      const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-cache, must-revalidate', Vary: 'Cookie, Authorization', ETag: etag };
      const record = { file, range, ifNoneMatch: request.headers['if-none-match'], ifRange: request.headers['if-range'],
        status: 200, startedAt: Date.now(), bytes: 0 } as typeof state.media[number];
      state.media.push(record);
      if (request.headers['if-none-match']?.split(',').some(value => value.trim().replace(/^W\//, '') === etag)) {
        record.status = 304;
        record.completedAt = Date.now();
        response.writeHead(304, headers);
        response.end();
        return;
      }
      const match = request.headers['if-range'] && request.headers['if-range'] !== etag
        ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), wav.length - 1) : wav.length - 1;
      if (start > end || start >= wav.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${wav.length}` });
        response.end();
        return;
      }
      record.status = match ? 206 : 200;
      response.writeHead(match ? 206 : 200, {
        ...headers, 'Content-Length': end - start + 1,
        ...(match ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}),
      });
      response.flushHeaders();
      const mode = state.mode;
      let offset = start;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const send = () => {
        if (response.destroyed) return;
        const next = Math.min(end + 1, offset + (mode === 'fast' ? wav.length : 16_384));
        response.write(wav.subarray(offset, next));
        record.bytes += next - offset;
        offset = next;
        if (offset > end) {
          record.completedAt = Date.now();
          response.end();
        } else timer = setTimeout(send, 250);
      };
      response.on('close', () => {
        if (timer) clearTimeout(timer);
        if (!record.completedAt) record.abortedAt = Date.now();
      });
      if (mode !== 'stalled') send();
      return;
    }
    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/auth/me') return json(response, { user: { id: studentId, role: 'student', displayName: '弱网验收' } });
      if (pathname === '/api/courses') return json(response, { courses: [course], hydrated: true, user: { role: 'student', name: '弱网验收' }, studentId, joinedCourseId: courseId });
      if (pathname === `/api/courses/${courseId}/state`) return json(response, { course, eventCursor: '0' });
      if (pathname.endsWith('/events')) return json(response, { events: [], nextCursor: '0', hasMore: false });
      if (pathname.endsWith('/presence')) return json(response, { members: [] });
      if (pathname.endsWith('/projection')) return json(response, { courseId, courseVersion: 1, projectionVersion: 0, resourceProjection: null, teacherResourceProjection: null });
      if (pathname.endsWith('/public-discussion')) return json(response, { enabled: false, session: null });
      if (pathname === '/api/openmaic/classroom') return json(response, { success: true, classroom: { stage: { id: classroomId, name: course.name, createdAt: 1, updatedAt: 1 }, scenes } });
      if (pathname === '/api/openmaic/progress') return json(response, { data: { progress: {} } });
      if (pathname === '/api/knowledge-lecture/settings') return json(response, { settings: {} });
      if (pathname.endsWith('/lecture-chat')) return json(response, { thread: { id: 'weak-network-thread', messages: [] }, requests: [], writable: true });
      if (pathname === '/api/learning-events' && request.method === 'POST') {
        const body: Buffer[] = [];
        for await (const chunk of request) body.push(Buffer.from(chunk));
        const receipt = browserLearningEventReceipt(Buffer.concat(body).toString('utf8'), Date.now());
        return json(response, receipt.body, receipt.status);
      }
      if (pathname.includes('learning-events') || pathname.includes('learning-analytics')) return json(response, { success: true });
      if (/provider|server-providers/.test(pathname)) return json(response, { providers: [], models: [], success: true });
      if (pathname.endsWith('/actions')) return json(response, { success: true, courseVersion: 1 });
      state.errors.push(`Missing fixture: ${request.method} ${pathname}`);
      return json(response, {}, 404);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      state.errors.push(`Blocked non-API write: ${request.method} ${pathname}`);
      return json(response, {}, 405);
    }
    const proxied = proxyRequest(new URL(request.url ?? '/', upstream), {
      method: request.method, headers: { ...request.headers, host: upstream.host },
    }, incoming => {
      // Preserve the production CSP and encoded asset response unchanged.
      response.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(response);
    });
    proxied.on('error', error => {
      state.errors.push(`Application proxy: ${error.message}`);
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on('close', () => { if (!response.writableFinished) proxied.destroy(); });
    proxied.end();
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return {
    baseURL: `http://127.0.0.1:${address.port}`, state, mediaBytes: wav.length,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

async function openClassroom(page: Page, baseURL: string, saveData = false) {
  const secret = (await readFile(process.env.OPENPBL_E2E_JWT_SECRET_FILE || process.env.LAYOUT_JWT_SECRET_FILE || 'deploy/secrets/jwt_secret.txt', 'utf8')).trim();
  const token = await new SignJWT({ role: 'student', sv: 1, userId: studentId, studentName: '弱网验收', displayName: '弱网验收', username: studentId })
    .setProtectedHeader({ alg: 'HS256' }).setSubject(studentId).setIssuer('openpbl').setAudience('openpbl-app')
    .setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode(secret));
  await page.context().addCookies([{ name: 'openpbl_student', value: token, url: baseURL }]);
  await page.routeWebSocket('**/*', socket => socket.close());
  await page.addInitScript(({ saveData }) => {
    localStorage.setItem('locale', 'zh-CN');
    if (saveData) Object.defineProperty(navigator, 'connection', { value: { saveData: true, effectiveType: '4g' } });
    const probe = { elements: [] as HTMLAudioElement[], observations: [] as AudioObservation[] };
    window.__weakAudio = probe;
    window.Audio = new Proxy(window.Audio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args) as HTMLAudioElement;
        const id = probe.elements.push(audio) - 1;
        const observe = (event: string) => probe.observations.push({
          id, event, at: Date.now(), src: audio.currentSrc || audio.src, currentTime: audio.currentTime,
          duration: audio.duration, paused: audio.paused, volume: audio.volume,
          bufferedEnd: audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0,
        });
        for (const event of ['loadstart', 'progress', 'playing', 'timeupdate', 'waiting', 'pause', 'ended', 'error', 'emptied']) {
          audio.addEventListener(event, () => observe(event));
        }
        observe('created');
        return audio;
      },
    });
  }, { saveData });
  await page.goto(`${baseURL}/student/classroom/${courseId}`);
  await expect(page.getByPlaceholder('这里没听懂？问一下')).toBeVisible();
  await page.getByRole('button', { name: '继续讲解', exact: true }).click();
}

async function saveEvidence(page: Page, fixture: Awaited<ReturnType<typeof startFixture>>, testInfo: TestInfo) {
  const observations = await page.evaluate(() => window.__weakAudio?.observations ?? []).catch(() => []);
  const evidencePath = testInfo.outputPath('real-http-audio-observations.json');
  await writeFile(evidencePath, JSON.stringify({ media: fixture.state.media, errors: fixture.state.errors, observations }, null, 2));
  await testInfo.attach('real-http-audio-observations', {
    path: evidencePath, contentType: 'application/json',
  });
}

test.describe('AI classroom on a shared slow connection', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(65_000);

  test('streams before download completion and hands over the one buffered next element', async ({ page, baseURL }, testInfo) => {
    const fixture = await startFixture(baseURL!, 'slow');
    try {
      await openClassroom(page, fixture.baseURL);
      await expect.poll(() => page.evaluate(() => window.__weakAudio.observations.some(item =>
        item.src.endsWith('/first.wav') && item.event === 'timeupdate' && item.volume > 0.01 && item.currentTime > 0)),
      { timeout: 10_000 }).toBe(true);
      const firstAudible = await page.evaluate(() => window.__weakAudio.observations.find(item =>
        item.src.endsWith('/first.wav') && item.event === 'timeupdate' && item.volume > 0.01 && item.currentTime > 0)!);

      await expect.poll(() => fixture.state.media.filter(item => item.file === 'second.wav').length, { timeout: 10_000 }).toBe(1);
      const firstDownload = fixture.state.media.find(item => item.file === 'first.wav' && item.bytes === fixture.mediaBytes)!;
      expect(firstAudible.at).toBeLessThan(firstDownload.completedAt!);
      expect(firstAudible.bufferedEnd).toBeLessThan(firstAudible.duration);
      const nextRequest = fixture.state.media.find(item => item.file === 'second.wav')!;
      const beforeNext = await page.evaluate(at => window.__weakAudio.observations.filter(item =>
        item.src.endsWith('/first.wav') && item.at <= at && item.bufferedEnd >= item.duration - 0.05), nextRequest.startedAt);
      expect(beforeNext.length).toBeGreaterThan(0);
      const preloadId = await page.evaluate(() => window.__weakAudio.observations.find(item => item.src.endsWith('/second.wav'))!.id);
      await expect.poll(() => page.evaluate(() => window.__weakAudio.observations.some(item =>
        item.src.endsWith('/second.wav') && item.event === 'playing' && item.volume > 0.01)), { timeout: 15_000 }).toBe(true);
      const nextIds = await page.evaluate(() => [...new Set(window.__weakAudio.observations.filter(item => item.src.endsWith('/second.wav')).map(item => item.id))]);
      expect(nextIds).toEqual([preloadId]);
      expect(fixture.state.media.filter(item => item.file === 'second.wav')).toHaveLength(1);
      expect(fixture.state.errors).toEqual([]);
      await page.getByRole('button', { name: '暂停讲解', exact: true }).click();
    } finally {
      await saveEvidence(page, fixture, testInfo);
      await page.goto('about:blank');
      await fixture.close();
    }
  });

  test('keeps a stalled speech retryable after bounded media and fallback waits', async ({ page, baseURL }, testInfo) => {
    const fixture = await startFixture(baseURL!, 'stalled');
    try {
      await openClassroom(page, fixture.baseURL);
      await expect(page.getByText(/语音加载超时/).first()).toBeVisible({ timeout: 35_000 });
      expect(fixture.state.media.filter(item => item.file === 'second.wav')).toHaveLength(0);
      expect(fixture.state.media.some(item => item.abortedAt)).toBe(true);
      await expect(page.getByRole('region', { name: '本课学习完成' })).toHaveCount(0);
      fixture.state.mode = 'fast';
      await page.getByRole('button', { name: '继续讲解', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.__weakAudio.observations.some(item =>
        item.src.endsWith('/first.wav') && item.event === 'timeupdate' && item.volume > 0.01 && item.currentTime > 0.1)),
      { timeout: 8_000 }).toBe(true);
      await expect(page.getByText('先观察并完整记录证据，这是第一段讲解。', { exact: true }).first()).toBeVisible();
      expect(fixture.state.errors).toEqual([]);
      await page.getByRole('button', { name: '暂停讲解', exact: true }).click();
    } finally {
      await saveEvidence(page, fixture, testInfo);
      await page.goto('about:blank');
      await fixture.close();
    }
  });

  test('does not download the next clip with Save-Data enabled', async ({ page, baseURL }, testInfo) => {
    const fixture = await startFixture(baseURL!, 'fast');
    try {
      await openClassroom(page, fixture.baseURL, true);
      await expect.poll(() => page.evaluate(() => window.__weakAudio.observations.some(item =>
        item.src.endsWith('/first.wav') && item.event === 'timeupdate' && item.volume > 0.01 && item.currentTime > 1)),
      { timeout: 8_000 }).toBe(true);
      expect(fixture.state.media.filter(item => item.file === 'second.wav')).toHaveLength(0);
      expect(fixture.state.errors).toEqual([]);
      await page.getByRole('button', { name: '暂停讲解', exact: true }).click();
    } finally {
      await saveEvidence(page, fixture, testInfo);
      await page.goto('about:blank');
      await fixture.close();
    }
  });

  test('cancels a real speculative transfer when the student pauses', async ({ page, baseURL }, testInfo) => {
    const fixture = await startFixture(baseURL!, 'slow');
    try {
      await openClassroom(page, fixture.baseURL);
      await expect.poll(() => fixture.state.media.filter(item => item.file === 'second.wav').length,
        { timeout: 12_000 }).toBe(1);
      await page.getByRole('button', { name: '暂停讲解', exact: true }).click();
      await expect.poll(() => fixture.state.media.find(item => item.file === 'second.wav')?.abortedAt).toBeTruthy();
      expect(fixture.state.media.find(item => item.file === 'second.wav')?.completedAt).toBeUndefined();
      const playing = await page.evaluate(() => window.__weakAudio.elements.filter(audio => !audio.paused).length);
      expect(playing).toBe(0);
      await expect(page.getByRole('button', { name: '继续讲解', exact: true })).toBeVisible();
      expect(fixture.state.errors).toEqual([]);
    } finally {
      await saveEvidence(page, fixture, testInfo);
      await page.goto('about:blank');
      await fixture.close();
    }
  });
});
