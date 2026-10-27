import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';

async function until(read, message, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do { const value = await read(); if (value) return value; await delay(150); } while (Date.now() < deadline);
  throw new Error(message);
}
async function all(items) {
  const results = await Promise.allSettled(items);
  const failures = results.filter(item => item.status === 'rejected');
  assert.equal(failures.length, 0, failures.map(item => item.reason?.message ?? String(item.reason)).join('\n'));
  return results.map(item => item.value);
}
const mediaState = locator => locator.evaluate(video => ({ currentTime: video.currentTime, duration: video.duration,
  paused: video.paused, seeking: video.seeking, readyState: video.readyState, frames: video.getVideoPlaybackQuality().totalVideoFrames,
  seekable: Array.from({ length: video.seekable.length }, (_, index) => [video.seekable.start(index), video.seekable.end(index)]),
  error: video.error?.message ?? null, controls: video.controls, playbackRate: video.playbackRate }));
const projectedFrame = page => page.locator('iframe[title="授课资源播放器"]');
const projectedBody = page => page.frameLocator('iframe[title="授课资源播放器"]').locator('body');

/** Native Chrome seek increments depend on duration (1% in Chrome 155).
 * Keep the actual media clock authoritative and retain every keyboard sample.
 */
export async function seekNativeVideo(controller, evidence) {
  const before = await mediaState(controller);
  assert.ok(Number.isFinite(before.duration) && before.duration > 0, 'Native video has no finite seekable duration');
  const distance = Math.min(4, before.duration / 4);
  assert.ok(before.paused && before.duration - before.currentTime > distance + 0.5, 'Paused video must have room for seek and resume');
  Object.assign(evidence, { duration: before.duration, seekable: before.seekable, seekFrom: before.currentTime,
    seekTargetDistance: distance, seekKeyPresses: 0, seekSamples: [] });
  let sample = before;
  for (let count = 0; count < 60 && sample.currentTime - before.currentTime < distance; count++) {
    await controller.press('ArrowRight');
    evidence.seekKeyPresses++;
    await delay(150);
    sample = await mediaState(controller);
    evidence.seekSamples.push({ keyPress: evidence.seekKeyPresses, at: new Date().toISOString(), ...sample });
  }
  assert.ok(sample.currentTime - before.currentTime >= distance, `Native seek did not advance ${distance}s after ${evidence.seekKeyPresses} ArrowRight presses`);
  let stableAt = Date.now();
  let previous = sample.currentTime;
  const seekTo = await until(async () => {
    const current = await mediaState(controller);
    if (!current.paused || current.seeking || current.readyState < 2 || Math.abs(current.currentTime - previous) > 0.05) stableAt = Date.now();
    previous = current.currentTime;
    return current.paused && !current.seeking && current.readyState >= 2
      && current.currentTime - before.currentTime >= distance && Date.now() - stableAt >= 600 ? current.currentTime : null;
  }, 'Native video seek did not settle at the requested position');
  evidence.seekTo = seekTo;
  evidence.stableSeekState = await mediaState(controller);
  return seekTo;
}

/** Runs outside the sustained classroom, on a new disposable instance. Video is
 * a real WebM recording; native controls drive the actual media clock and events.
 */
export async function runResourceMediaAcceptance({ teacher, students, instance, offering, chapter, origin, db, request, record, output, browser }) {
  const directory = path.join(output, 'resource-media');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { students: students.length, startedAt: new Date().toISOString(), checks: [], passed: false,
    limitations: ['Browser media validation does not verify physical speakers or projection hardware.'] };
  const save = () => writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const check = async (name, operation, category = 'browser-real-backend') => {
    try { const detail = await operation(); evidence.checks.push({ name, status: '通过', detail, evidence: category }); record(name, '通过', detail, category); return true; }
    catch (error) {
      const detail = String(error.stack ?? error); evidence.checks.push({ name, status: '失败', detail, evidence: category }); record(name, '失败', detail, category);
      if (name === 'resource-video-native-play-pause-seek-sync') {
        evidence.nativeMedia ??= {};
        const snapshot = async locator => {
          try { return await locator.count() ? await mediaState(locator) : { absent: true }; }
          catch (error) { return { error: String(error) }; }
        };
        evidence.nativeMedia.failureSnapshot = {
          at: new Date().toISOString(),
          teacher: await snapshot(teacher.page.locator('.teacher-resource-video video').filter({ visible: true }).first()),
          students: await Promise.all(students.map(async student => ({ studentId: student.user.id,
            ...await snapshot(student.page.locator('[data-teacher-resource-projection] video')) }))),
        };
      }
      await teacher.page.screenshot({ path: path.join(directory, `${name}-teacher.png`), fullPage: true }).catch(() => undefined);
      await students[0].page.screenshot({ path: path.join(directory, `${name}-student.png`), fullPage: true }).catch(() => undefined);
      return false;
    }
    finally { await save(); }
  };
  let mediaInstance;
  try {
    assert.ok(students.length >= 2 && students.length <= 30);
    assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname) && ['3197', '3198'].includes(new URL(origin).port));
    const original = (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
    assert.ok(original.aiLearningClassroomId, 'A real published classroom is required for resource projection');
    const source = (await request(teacher.context, 'GET', `/api/openmaic/classroom?id=${encodeURIComponent(original.aiLearningClassroomId)}`)).classroom;
    const slides = source.scenes.filter(scene => scene.type === 'slide');
    assert.ok(slides.length >= 2, 'Teacher projection needs two actual published scenes');
    const template = await request(teacher.context, 'POST', '/api/platform/templates', { title: '资源与真实视频投屏专项',
      snapshot: { schemaVersion: 2, kind: 'pbl-course', design: { name: '资源与真实视频投屏专项', subject: '科学', grade: '七年级', hours: 1,
        stages: original.stages, aiLearningClassroomId: original.aiLearningClassroomId,
        drivingQuestion: '教师演示是否准确同步且不替代学生学习？', expectedOutcome: '真实投屏与独立学习记录',
        pblConfig: { makeArtifactMode: 'document' }, content: { ...original.content,
          _openmaicSceneOutlines: slides.map((scene, index) => ({ id: scene.outlineId ?? scene.id, title: scene.title,
            type: scene.type, order: index, stageKey: 'ai-learning', audience: 'student', knowledgePointIds: scene.knowledgePointIds ?? [] })),
        } } } }, 201);
    const activity = (await request(teacher.context, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
      type: 'Classroom', title: '资源与视频同步独立场次', templateVersionId: template.versions[0].id,
    }, 201)).activity;
    await request(teacher.context, 'PATCH', `/api/platform/activities/${activity.id}`, { isOpen: true });
    mediaInstance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: activity.id } });
    evidence.instanceId = mediaInstance.id;
    await request(teacher.context, 'POST', `/api/platform/classroom-instances/${mediaInstance.id}/start`, {});
    await all(students.map(async student => {
      await request(student.context, 'GET', `/api/platform/activities/${activity.id}`);
      await request(student.context, 'POST', `/api/platform/classroom-instances/${mediaInstance.id}/enter`, {});
    }));
    const state = async () => (await request(teacher.context, 'GET', `/api/courses/${mediaInstance.id}/state`)).course;
    const studentUrl = `${origin}/student/classroom/${mediaInstance.id}`;
    const teacherUrl = `${origin}/teacher/teach/${mediaInstance.id}/classroom`;
    const endpoint = `/api/courses/${mediaInstance.id}/actions`;
    const completion = async () => {
      const course = await state();
      return { completed: Object.fromEntries(students.map(student => [student.user.id, {
        scenes: [...(course.aiLearningProgress?.[student.user.id]?.completedScenes ?? [])].sort(),
        outlines: [...(course.aiLearningProgress?.[student.user.id]?.completedOutlineIds ?? [])].sort(),
        attempts: course.aiLearningProgress?.[student.user.id]?.knowledgeLectureAttempts ?? [],
      }])), resourceCompletions: await db.learningEvent.count({ where: { classroomInstanceId: mediaInstance.id, eventType: 'resource-complete' } }) };
    };
    const before = await completion();

    await check('resource-video-native-play-pause-seek-sync', async () => {
      const recorder = await browser.newContext({ recordVideo: { dir: path.join(directory, 'recorded-webm'), size: { width: 480, height: 270 } } });
      let videoFile;
      try {
        const page = await recorder.newPage();
        await page.setContent('<body style="margin:0;background:#173b3c;color:white;font:32px sans-serif"><p>真实视频同步验收</p><output id="frame"></output><script>let count=0;function draw(){document.querySelector("output").textContent=++count;document.body.style.background=`hsl(${count%360} 45% 25%)`;requestAnimationFrame(draw)}draw()</script></body>');
        await delay(16_000);
        await page.close(); videoFile = await page.video().path();
      } finally { await recorder.close(); }
      const bytes = await readFile(videoFile); assert.ok(bytes.length > 1000);
      const uploadedResponse = await teacher.context.request.post(`${origin}/api/uploads`, { headers: { Origin: origin }, timeout: 60_000,
        multipart: { file: { name: 'classroom-real-video.webm', mimeType: 'video/webm', buffer: bytes }, title: '真实视频同步验收',
          courseId: mediaInstance.id, stageKey: 'launch', bindAsCourseResource: 'true' } });
      assert.equal(uploadedResponse.status(), 201, await uploadedResponse.text());
      const uploaded = await uploadedResponse.json(); evidence.videoAsset = { url: uploaded.url, bytes: bytes.length };
      await teacher.page.goto(teacherUrl, { waitUntil: 'domcontentloaded' });
      await all(students.map(student => student.page.goto(studentUrl, { waitUntil: 'domcontentloaded' })));
      await teacher.page.getByRole('button').filter({ has: teacher.page.getByText('真实视频同步验收', { exact: true }) }).filter({ visible: true }).first().click({ timeout: 30000 });
      const controller = teacher.page.locator('.teacher-resource-video video').filter({ visible: true }).first();
      await controller.waitFor({ timeout: 45_000 });
      await until(async () => (await mediaState(controller)).readyState >= 2, 'Teacher video did not decode');
      evidence.nativeMedia = { initialTeacher: await mediaState(controller) };
      await teacher.page.getByRole('button', { name: /^(同步到学生|投屏)$/ }).filter({ visible: true }).first().click();
      const followers = students.map(student => ({ student, video: student.page.locator('[data-teacher-resource-projection] video') }));
      await all(followers.map(async ({ video }) => {
        await video.waitFor({ timeout: 45_000 });
        await until(async () => (await mediaState(video)).readyState >= 2, 'Projected video did not decode');
        assert.equal((await mediaState(video)).controls, false, 'Student projection unexpectedly exposes independent controls');
      }));
      await controller.focus(); await controller.press('Space');
      await until(async () => !(await mediaState(controller)).paused, 'Native teacher play control did not start the video');
      await all(followers.map(({ video }) => until(async () => { const value = await mediaState(video); return !value.paused && value.currentTime > 0.5 && value.frames > 0; }, 'Student real video clock did not advance')));
      const playing = await all(followers.map(async ({ student, video }) => ({ studentId: student.user.id, ...await mediaState(video) })));
      evidence.nativeMedia.playing = playing;
      await controller.press('Space');
      await all(followers.map(({ video }) => until(async () => (await mediaState(video)).paused, 'Student did not follow the teacher pause')));
      const paused = await all(followers.map(async ({ student, video }) => ({ studentId: student.user.id, ...await mediaState(video) })));
      evidence.nativeMedia.paused = paused;
      await delay(1000);
      for (const [{ video }, sample] of followers.map((item, index) => [item, paused[index]])) assert.ok(Math.abs((await mediaState(video)).currentTime - sample.currentTime) < 0.2, 'Paused native clock kept advancing');
      const seekTo = await seekNativeVideo(controller, evidence.nativeMedia);
      await all(followers.map(({ video }) => until(async () => { const value = await mediaState(video); return value.paused && Math.abs(value.currentTime - seekTo) <= 0.8; }, 'Student video seek did not converge to the teacher position')));
      const sought = await all(followers.map(async ({ student, video }) => ({ studentId: student.user.id, ...await mediaState(video) })));
      evidence.nativeMedia.sought = sought;
      await controller.press('Space');
      await all(followers.map(({ video }, index) => until(async () => { const value = await mediaState(video); return !value.paused && value.currentTime > seekTo + 0.5
        && value.frames > sought[index].frames; }, 'Student did not resume decoding after seek')));
      evidence.nativeMedia.resumed = await all(followers.map(async ({ student, video }) => ({ studentId: student.user.id, ...await mediaState(video) })));
      await controller.press('Space');
      assert.ok((await mediaState(controller)).error === null);
      await teacher.page.getByRole('button', { name: /^(停止同步|停止投屏|结束投屏)$/ }).filter({ visible: true }).first().click();
      await all(students.map(student => student.page.locator('[data-teacher-resource-projection]').waitFor({ state: 'detached' })));
      return { students: students.length, nativeWebm: true, decodedFrames: true, playPauseSeekResume: true };
    }, 'browser-media');

    await request(teacher.context, 'POST', endpoint, { requestId: randomUUID(), action: { type: 'SET_STAGE', payload: { id: mediaInstance.id, index: 1 } } });
    await teacher.page.goto(teacherUrl, { waitUntil: 'domcontentloaded' });
    await all(students.map(student => student.page.goto(studentUrl, { waitUntil: 'domcontentloaded' })));
    const forced = await check('teacher-resource-forced-projection', async () => {
      const selector = teacher.page.getByLabel('自主选择知识讲授PPT页面');
      await selector.waitFor({ state: 'visible', timeout: 45000 });
      await selector.selectOption(slides[0].outlineId ?? slides[0].id);
      const start = teacher.page.getByRole('button', { name: '投屏给全班', exact: true });
      await expect(start).toBeEnabled({ timeout: 30_000 }); await start.click();
      await until(async () => (await state()).uiState?.teacherResourceProjection?.mode === 'forced', 'Teacher UI did not publish a forced resource');
      await all(students.map(async student => {
        await projectedFrame(student.page).waitFor({ state: 'visible', timeout: 45_000 });
        await expect(projectedBody(student.page)).toContainText(slides[0].title, { timeout: 45_000 });
        await expect(student.page.locator('[data-stage-host-mode="student"]')).toHaveCount(0);
      }));
      await selector.selectOption(slides[1].outlineId ?? slides[1].id);
      await teacher.page.getByRole('button', { name: '投屏给全班', exact: true }).click();
      await all(students.map(student => expect(projectedBody(student.page)).toContainText(slides[1].title, { timeout: 45_000 })));
      await teacher.page.getByRole('button', { name: '停止投屏', exact: true }).click();
      await all(students.map(student => projectedFrame(student.page).waitFor({ state: 'detached' })));
      return { students: students.length, teacherUi: true, twoPublishedScenes: true, personalPlayerSuspended: true };
    });
    await check('teacher-resource-optional-viewing', async () => {
      assert.ok(forced, 'Forced UI projection must work before verifying the optional student branch');
      await teacher.page.getByLabel('投屏方式', { exact: true }).selectOption('optional');
      await teacher.page.getByLabel('自主选择知识讲授PPT页面').selectOption(slides[0].outlineId ?? slides[0].id);
      await teacher.page.getByRole('button', { name: '投屏给全班', exact: true }).click();
      await until(async () => (await state()).uiState?.teacherResourceProjection?.mode === 'optional', 'Teacher UI did not publish optional projection');
      await all(students.map(async student => {
        await student.page.getByRole('button', { name: '查看投屏', exact: true }).waitFor();
        await expect(projectedFrame(student.page)).toHaveCount(0);
        await expect(student.page.locator('[data-stage-host-mode="student"]')).toBeVisible();
        await student.page.getByRole('button', { name: '查看投屏', exact: true }).click();
        await expect(projectedBody(student.page)).toContainText(slides[0].title, { timeout: 45_000 });
        await expect(student.page.locator('[data-stage-host-mode="student"]')).toHaveCount(0);
        await student.page.getByRole('button', { name: '收起投屏', exact: true }).click();
        await expect(projectedFrame(student.page)).toHaveCount(0);
        await expect(student.page.locator('[data-stage-host-mode="student"]')).toBeVisible();
      }));
      await teacher.page.getByRole('button', { name: '停止投屏', exact: true }).click();
      await until(async () => !(await state()).uiState?.teacherResourceProjection, 'Teacher optional projection did not stop');
      return { students: students.length, teacherUi: true, studentUiOpenClose: true, optionalTeacherUiVerified: true };
    });
    await check('projection-does-not-complete-learning', async () => {
      const after = await completion(); evidence.completion = { before, after };
      assert.deepEqual(after, before, 'Teacher projection incorrectly completed an independent resource/learning task');
      return { students: students.length, studentCompletionsUnchanged: true, resourceCompletionEventsUnchanged: true };
    });
    evidence.passed = evidence.checks.length === 4 && evidence.checks.every(item => item.status === '通过');
  } catch (error) {
    evidence.error = String(error.stack ?? error); record('resource-media-setup', '失败', String(error.message), 'browser-real-backend');
  } finally {
    evidence.finishedAt = new Date().toISOString();
    if (mediaInstance) await request(teacher.context, 'POST', `/api/platform/classroom-instances/${mediaInstance.id}/finish`, {}).catch(error => { evidence.cleanupError = error.message; record('resource-media-close', '失败', error.message, 'isolated-backend'); });
    await save();
  }
  return evidence;
}
