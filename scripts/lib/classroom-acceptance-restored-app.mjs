import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import { courseReadWorkerSettings, retargetCourseReadDatabaseURL } from './course-read-role.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Large SQL never enters a driver Buffer or execFileSync maxBuffer. A partial
 * dump is not published as the completed backup, and failed children are reaped.
 */
export async function runFileCommand(command, args, { inputFile, outputFile, env, cwd, timeoutMs = 30 * 60_000 } = {}) {
  const temporaryOutput = outputFile ? `${outputFile}.partial-${randomUUID()}` : undefined;
  const child = spawn(command, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; let timedOut = false;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16_384); });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(new Error(`Snapshot command failed (${timedOut ? 'timeout' : signal ?? code}): ${stderr}`)));
  });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs); timer.unref();
  const jobs = [exited];
  if (inputFile) jobs.push(pipeline(createReadStream(inputFile), child.stdin)); else child.stdin.end();
  if (outputFile) jobs.push(pipeline(child.stdout, createWriteStream(temporaryOutput, { flags: 'wx', mode: 0o600 })));
  else child.stdout.resume();
  try {
    await Promise.all(jobs);
    if (outputFile) await rename(temporaryOutput, outputFile);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    child.stdin.destroy();
    const settled = await Promise.allSettled(jobs);
    if (temporaryOutput) await rm(temporaryOutput, { force: true });
    // psql can close stdin first on a SQL error. Prefer its bounded diagnostic
    // over an incidental EPIPE, while retaining file-system errors unchanged.
    if (error.code === 'EPIPE' && settled[0].status === 'rejected') throw settled[0].reason;
    throw error;
  } finally { clearTimeout(timer); }
}

export async function stopIsolatedApplication(child, { graceMs = 15000, killMs = 5000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return { forced: false, alreadyExited: true };
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, 'Isolated application has no process identity');
  const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
  const wait = async milliseconds => {
    let timer;
    try { return await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  const signal = name => { try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  signal('SIGTERM');
  if (await wait(graceMs)) return { forced: false, alreadyExited: false };
  signal('SIGKILL');
  assert.ok(await wait(killMs), 'Isolated application did not stop; source snapshot is unsafe');
  return { forced: true, alreadyExited: false };
}

export function restoredClassroomEnvironment(source, temporary) {
  const database = new URL(source.DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname),
    'Restore requires the disposable loopback PostgreSQL source');
  assert.notEqual(database.pathname, '/acceptance_restore', 'Restore source already points at the recovery database');
  database.pathname = '/acceptance_restore';
  const target = database.toString();
  assert.notEqual(target, source.DATABASE_URL, 'Restore must use another database');
  let redis = source.REDIS_URL;
  if (redis) { const url = new URL(redis); assert.notEqual(url.pathname, '/1', 'Restore Redis namespace is already in use by the source'); url.pathname = '/1'; redis = url.toString(); }
  const reader = courseReadWorkerSettings(source).enabled
    ? { OPENPBL_COURSE_READ_DATABASE_URL: retargetCourseReadDatabaseURL(source.DATABASE_URL, source.OPENPBL_COURSE_READ_DATABASE_URL, target) } : {};
  return { ...source, DATABASE_URL: target, PROVIDER_CONFIG_DATABASE_URL: target, ...reader, REDIS_URL: redis,
    UPLOAD_DIR: path.join(temporary, 'restored-files/uploads'),
    CLASSROOM_DATA_DIR: path.join(temporary, 'restored-files/classrooms'),
    WHITEBOARD_DATA_DIR: path.join(temporary, 'restored-files/whiteboards'),
    AI_AUDIT_OUTBOX_DIR: path.join(temporary, 'restored-files/ai-audit-outbox'),
    TTS_CACHE_DIR: path.join(temporary, 'restored-tts-cache'),
    KNOWLEDGE_EXPLANATION_WARMUP_ENABLED: 'false', DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED: 'false',
  };
}

/** Check the connections themselves, not only the strings used to create them. */
export async function assertIsolatedRestoreDatabase(source, restored) {
  const identity = db => db.$queryRaw`SELECT current_database() AS database, inet_server_addr()::text AS server, inet_server_port() AS port`;
  const [[original], [target]] = await Promise.all([identity(source), identity(restored)]);
  assert.ok(original && target, 'Restore database identities are unavailable');
  assert.notEqual(target.database, original.database, 'Restored connection points at the source database');
  assert.equal(target.database, 'acceptance_restore', 'Restored connection points at an unexpected database');
  assert.equal(target.server, original.server, 'Restore must remain in the disposable PostgreSQL instance');
  assert.equal(target.port, original.port, 'Restore must remain in the disposable PostgreSQL instance');
  return { sourceDatabase: original.database, restoredDatabase: target.database, separateDatabase: true };
}

export function restoredMediaUrl(origin, classroomId, source) {
  const url = new URL(source, origin);
  assert.equal(url.origin, new URL(origin).origin, 'Restored playback must use the isolated restored application');
  assert.ok(url.pathname.startsWith(`/api/openmaic/classroom-media/${encodeURIComponent(classroomId)}/`), 'Restored playback must read a restored classroom file');
  return url.toString();
}

export function assertRestoredStudentHistory(course, actor, instanceId) {
  assert.equal(course?.id, instanceId, 'Restored history returned another classroom');
  assert.equal(course.status, 'finished', 'Restored classroom did not retain its finished state');
  const sourceView = actor.saved?.payload?.view ?? actor.saved?.payload ?? actor.saved;
  const sourceId = sourceView?.id ?? actor.saved?.id;
  assert.ok(sourceId, 'Source student has no acknowledged document identity');
  const saved = course.submissions?.find(value => value.id === sourceId && value.studentId === actor.user.id);
  assert.ok(saved?.content?.includes(`自动验收学生${actor.index}`), 'Restored history lost the student document');
  const events = (course.aiInteractionEvents ?? []).filter(event => event.studentId === actor.user.id);
  assert.ok(events.some(event => event.actorRole === 'student'), 'Restored history lost student AI interactions');
  assert.ok(events.some(event => event.actorRole === 'ai'), 'Restored history lost AI replies');
  const archive = course.projectDocumentVersions?.find(value => value.studentId === actor.user.id && value.submissionId === sourceId && value.docxUploadId && value.status === 'submitted');
  assert.ok(archive, 'Restored history lacks an archived Word version');
  assert.match(archive.docxSha256 ?? '', /^[a-f0-9]{64}$/, 'Restored archive lacks its durable SHA-256');
  return { saved, archive, eventActors: Object.fromEntries([...new Set(events.map(event => event.actorRole))]
    .sort().map(role => [role, events.filter(event => event.actorRole === role).length])) };
}

/** Run only after byte-for-byte restore reconciliation: real login changes
 * lastLoginAt, and the restored runtime must not write to the source database.
 */
export async function verifyRestoredClassroom({ browser, origin, password, instance, students, fixture, output,
  teacherUsername = 'acceptance-teacher' }) {
  const contexts = [];
  const evidence = { startedAt: new Date().toISOString(), classroomId: instance.id, checks: [], status: 'running' };
  try {
    const teacher = await browser.newContext(); contexts.push(teacher);
    const teacherPage = await teacher.newPage();
    await teacherPage.goto(`${origin}/teacher/login?redirect=${encodeURIComponent('/teacher/classes')}`, { waitUntil: 'domcontentloaded' });
    await teacherPage.getByLabel('账号', { exact: true }).fill(teacherUsername);
    await teacherPage.getByLabel('密码', { exact: true }).fill(password);
    const teacherLogin = teacherPage.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/platform/auth/teacher-login');
    await teacherPage.locator('button[type="submit"]').click();
    assert.equal((await teacherLogin).status(), 200);
    await teacherPage.waitForURL('**/teacher/classes');
    const teacherState = await teacher.request.get(`${origin}/api/courses/${instance.id}/state`);
    assert.equal(teacherState.status(), 200);
    const restoredCourse = (await teacherState.json()).course;
    const histories = students.map(actor => ({ studentId: actor.user.id, ...assertRestoredStudentHistory(restoredCourse, actor, instance.id) }));
    await teacherPage.goto(`${origin}/teacher/teach/${instance.id}/classroom`, { waitUntil: 'domcontentloaded' });
    await expect(teacherPage.getByText(restoredCourse.name, { exact: true }).first()).toBeVisible({ timeout: 30000 });
    evidence.checks.push({ name: 'restored-teacher-real-login-and-history-ui', passed: true,
      histories: histories.map(({ studentId, saved, archive, eventActors }) => ({ studentId, submissionId: saved.id, archiveId: archive.id, eventActors })) });
    await teacherPage.screenshot({ path: path.join(output, 'restored-teacher-history.png') });

    const actor = students[0];
    const student = await browser.newContext(); contexts.push(student);
    const page = await student.newPage();
    await page.goto(`${origin}/student/login`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('学号', { exact: true }).fill(actor.user.username);
    await page.getByLabel('密码', { exact: true }).fill(password);
    const studentLogin = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/platform/auth/login');
    await page.locator('button[type="submit"]').click();
    assert.equal((await studentLogin).status(), 200);
    await page.waitForURL(url => url.pathname.startsWith('/student') && !url.pathname.includes('/login'));
    await page.goto(`${origin}/student/classroom/${instance.id}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '课堂已结束', exact: true })).toBeVisible({ timeout: 30000 });
    const stateResponse = await student.request.get(`${origin}/api/courses/${instance.id}/state`);
    assert.equal(stateResponse.status(), 200);
    const course = (await stateResponse.json()).course;
    const { saved, archive } = assertRestoredStudentHistory(course, actor, instance.id);
    assert.ok((course.aiInteractionEvents ?? []).every(event => event.studentId === actor.user.id), 'Student history exposed another student');
    const downloaded = await student.request.get(`${origin}/api/uploads/${archive.docxUploadId}?download=1`);
    assert.equal(downloaded.status(), 200);
    assert.equal(digest(await downloaded.body()), archive.docxSha256);
    evidence.checks.push({ name: 'restored-student-real-login-history-and-download', passed: true,
      submissionId: saved.id, archiveVersionId: archive.id, downloadedSha256: archive.docxSha256 });

    const speech = fixture.classroom.scenes.flatMap(scene => scene.actions).find(action => action.type === 'speech' && action.audioUrl);
    assert.ok(speech, 'Original classroom contains no playable speech');
    const audioUrl = restoredMediaUrl(origin, fixture.classroom.id, speech.audioUrl);
    // The native audio starts in an actual user click. Observe advancing time
    // and ended, without overriding play(), decoding or media clocks.
    await page.evaluate(url => {
      const audio = document.createElement('audio'); audio.id = 'restored-classroom-audio'; audio.src = url;
      const button = document.createElement('button'); button.textContent = '播放恢复音频';
      button.addEventListener('click', () => { void audio.play().catch(error => { button.dataset.error = error.message; }); });
      document.body.append(audio, button);
    }, audioUrl);
    await page.getByRole('button', { name: '播放恢复音频', exact: true }).click();
    await page.waitForFunction(() => {
      const audio = document.getElementById('restored-classroom-audio');
      return audio instanceof HTMLAudioElement && audio.currentTime > 0.2;
    }, null, { timeout: 30000 });
    await page.waitForFunction(() => document.getElementById('restored-classroom-audio')?.ended, null,
      { timeout: Math.max(180000, (Number(speech.audioDurationSec) || 0) * 1500) });
    evidence.checks.push({ name: 'restored-native-media-playback-ended', passed: true,
      media: await page.evaluate(() => { const audio = document.getElementById('restored-classroom-audio');
        return { currentTime: audio.currentTime, duration: audio.duration, ended: audio.ended, source: new URL(audio.currentSrc).pathname }; }) });
    await page.screenshot({ path: path.join(output, 'restored-student-history.png') });
    evidence.status = 'passed';
    return evidence;
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error.stack ?? error); throw error;
  } finally {
    evidence.finishedAt = new Date().toISOString();
    try { await writeFile(path.join(output, 'restored-app-ui.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }); }
    finally { await Promise.allSettled(contexts.map(context => context.close())); }
  }
}
