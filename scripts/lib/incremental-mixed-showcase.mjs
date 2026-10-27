import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { assertIncrementalArchiveText, runIncrementalShowcaseAcceptance } from './incremental-showcase-acceptance.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const view = row => row.payload?.view ?? row.payload;

/** The main classroom keeps saving while an independent two-student offering
 * exercises real recommendation workers, Word/PDF viewers and projection.
 * Authentication contexts are shared; pages, participations and drafts are not.
 */
export async function runIncrementalMixedShowcase({ students, teachers, instance, db, origin, output, send, record, options }) {
  const target = new URL(origin);
  assert.equal(target.protocol, 'http:');
  assert.equal(target.hostname, '127.0.0.1');
  assert.ok(target.port && !['80', '443', '3000', '3002'].includes(target.port), 'Mixed showcase requires the isolated application');
  assert.equal(teachers.length, 2);
  const representatives = ['google-chrome', 'microsoft-edge'].map(brand => {
    const student = students.find(actor => actor.label === brand);
    assert.ok(student?.user?.id && student.participation?.id && student.page && student.context, `Missing ${brand} main-classroom actor`);
    return student;
  });
  const directory = path.join(output, 'mixed-showcase');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { status: 'running', phase: 'steady', startedAt: new Date().toISOString(),
    startedAtMonotonicMs: performance.now(), mainInstanceId: instance.id,
    mainStudents: [], fixture: null, archives: [], stages: [], isolation: [], cleanupErrors: [],
    trafficScope: 'Separate offering and instance on the same isolated application; main periodic traffic must filter its own course ID' };
  const clones = [], originals = [];
  let mixed, failure, showcase;
  const save = () => writeFile(path.join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const stage = async (name, work) => {
    const step = { name, phase: 'steady', startedAt: new Date().toISOString(), startedAtMonotonicMs: performance.now(), status: 'running' };
    evidence.stages.push(step);
    try { const result = await work(); step.status = 'passed'; return result; }
    catch (error) { step.status = 'failed'; step.error = String(error.message ?? error).slice(0, 2000); throw error; }
    finally { step.finishedAt = new Date().toISOString(); step.durationMs = performance.now() - step.startedAtMonotonicMs; await save(); }
  };
  const scopedSend = (actor, method, endpoint, body, expected = 200, operation) => {
    assert.ok(mixed, 'Mixed classroom has not been created');
    const url = new URL(endpoint, origin);
    assert.equal(url.origin, target.origin, 'Mixed requests must stay on the isolated application');
    assert.ok(url.pathname.startsWith(`/api/courses/${mixed.id}/`) || url.pathname === '/api/project-practice/submissions/finalize',
      'Mixed showcase cannot write to another classroom');
    const courseId = body?.courseId ?? body?.action?.payload?.courseId ?? body?.action?.payload?.id;
    if (courseId !== undefined) assert.equal(courseId, mixed.id, 'Mixed request payload belongs to another classroom');
    return send(actor, method, `${url.pathname}${url.search}`, body, expected, operation);
  };
  const action = (actor, value, requestId = randomUUID(), expected = 200) => scopedSend(actor, 'POST',
    `/api/courses/${mixed.id}/actions`, { requestId, action: value }, expected);
  const state = () => scopedSend(teachers[0], 'GET', `/api/courses/${mixed.id}/state`);
  try {
    await stage('independent-fixture', async () => {
      const source = await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
      assert.equal(source.status, 'TEACHING');
      for (const student of representatives) {
        const row = await db.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: {
          participationId: student.participation.id, stageKey: 'make:document' } } });
        const current = view(row);
        assert.equal(current.courseId, instance.id); assert.equal(current.studentId, student.user.id);
        originals.push({ student, page: student.page, url: student.page.url(), participationId: student.participation.id,
          submissionId: current.id, version: current.version, content: current.content });
        evidence.mainStudents.push({ client: student.client, studentId: student.user.id, participationId: student.participation.id,
          submissionId: current.id, version: current.version, contentSha256: hash(current.content) });
      }
      const offering = await db.courseOffering.create({ data: { name: '增量混合负载：独立成果展示',
        description: `incremental-mixed-${randomUUID()}`, status: 'OPEN', teachers: { create: teachers.map(actor => ({ userId: actor.user.id })) } } });
      evidence.fixture = { offeringId: offering.id, participants: [] };
      const chapter = await db.chapter.create({ data: { offeringId: offering.id, title: '混合负载成果展示', position: 0, isOpen: true } });
      evidence.fixture.chapterId = chapter.id;
      const activity = await db.activity.create({ data: { chapterId: chapter.id, title: '独立成果展示与推荐', position: 0, type: 'CLASSROOM', isOpen: true } });
      evidence.fixture.activityId = activity.id;
      mixed = await db.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: source.templateVersionId,
        status: 'TEACHING', startedAt: new Date(), runtimeConfig: { version: 1, currentStageIndex: 2,
          classConfig: { groupMode: 'solo', totalStudents: 2, perGroup: 1, crossClass: false } } } });
      assert.notEqual(mixed.id, instance.id);
      Object.assign(evidence.fixture, { instanceId: mixed.id, templateVersionId: source.templateVersionId });
      for (const original of originals) {
        const student = original.student;
        const enrollment = await db.enrollment.create({ data: { offeringId: offering.id, userId: student.user.id } });
        const participation = await db.classroomParticipation.create({ data: { instanceId: mixed.id,
          enrollmentId: enrollment.id, firstEnteredAt: new Date() } });
        const groupId = `grp-${student.user.id}`;
        const group = await db.projectGroup.create({ data: { id: `${offering.id}:${groupId}`, offeringId: offering.id,
          name: `混合负载个人组${student.index}`, members: { create: { userId: student.user.id, participationId: participation.id } } } });
        const now = new Date().toISOString();
        const clone = { role: 'student', context: student.context, page: await student.context.newPage(),
          index: student.index, user: student.user, label: student.label, client: `mixed-${student.client}`,
          enrollment, participation, version: 0, submission: { id: randomUUID(), courseId: mixed.id,
            studentId: student.user.id, studentName: student.user.displayName, groupId, stageKey: 'make', type: 'document',
            title: `混合负载观察报告${student.index}`, content: original.content, status: 'draft', version: 0,
            createdAt: now, updatedAt: now } };
        clones.push(clone);
        evidence.fixture.participants.push({ client: clone.client, sourceClient: student.client, studentId: student.user.id,
          enrollmentId: enrollment.id, participationId: participation.id, groupId, storedGroupId: group.id,
          submissionId: clone.submission.id, contentSha256: hash(original.content) });
      }
    });
    await stage('real-save-and-word-archive', async () => {
      for (const student of clones) {
        const submission = { ...student.submission, version: 1 };
        const requestId = randomUUID();
        const ack = await action(student, { type: 'UPSERT_SUBMISSION', payload: { courseId: mixed.id,
          expectedSubmissionVersion: 0, submission } }, requestId);
        assert.equal(ack.requestId, requestId); assert.equal(ack.submissionVersion, 1);
        const row = await db.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: {
          participationId: student.participation.id, stageKey: 'make:document' } } });
        const confirmed = view(row);
        assert.equal(confirmed.content, submission.content); assert.equal(confirmed.version, ack.submissionVersion);
        assert.equal(confirmed.courseId, mixed.id); assert.equal(confirmed.studentId, student.user.id);
        student.version = ack.submissionVersion; student.submission = confirmed;
        const body = { requestId: randomUUID(), courseId: mixed.id, studentId: student.user.id,
          submissionId: confirmed.id, stageKey: 'make', expectedVersion: student.version };
        const archived = await scopedSend(student, 'POST', '/api/project-practice/submissions/finalize', body);
        student.archived = archived;
        assert.equal(archived.submissionVersion, student.version + 1);
        const download = new URL(archived.downloadUrl, origin);
        assert.equal(download.origin, target.origin, 'Archive download left the isolated application');
        const response = await student.context.request.get(download.href, { timeout: 30000 });
        assert.equal(response.status(), 200);
        const bytes = await response.body(); assert.equal(hash(bytes), archived.sha256);
        const zip = await JSZip.loadAsync(bytes), document = zip.file('word/document.xml');
        assert.ok(document, 'Word archive lacks its document XML');
        const text = assertIncrementalArchiveText(confirmed.content, await document.async('string'));
        assert.deepEqual(await scopedSend(student, 'POST', '/api/project-practice/submissions/finalize', body), archived);
        student.version = archived.submissionVersion;
        student.submission = { ...confirmed, version: student.version, status: 'submitted', submittedAt: archived.submittedAt };
        evidence.archives.push({ studentId: student.user.id, client: student.client, saveRequestId: requestId,
          ack, archived, ...text, byteSha256: hash(bytes), contentSha256: hash(confirmed.content), replayMatched: true });
        await save();
      }
    });
    showcase = await stage('recommendation-word-pdf-and-projection', () => runIncrementalShowcaseAcceptance({
      teachers, students: clones, instance: mixed, db, origin, output: directory, send: scopedSend, state, action, record, options,
    }));
    evidence.showcase = showcase;
    evidence.status = 'passed';
  } catch (error) {
    failure = error; evidence.status = 'failed'; evidence.error = String(error.stack ?? error).slice(0, 6000);
  } finally {
    try {
      await stage('main-classroom-scope-preserved', async () => {
        const mixedMarkers = clones.flatMap(student => [student.incrementalShowcaseMarker,
          ...(student.submission.content.match(/INC_REVISED_[A-Za-z0-9_-]+/g) ?? [])]).filter(Boolean);
        for (const original of originals) {
          const student = original.student;
          assert.equal(student.page, original.page); assert.equal(student.page.url(), original.url);
          assert.equal(student.participation.id, original.participationId);
          assert.equal(student.submission.courseId, instance.id);
          const row = await db.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: {
            participationId: original.participationId, stageKey: 'make:document' } } });
          const current = view(row);
          assert.equal(current.courseId, instance.id); assert.equal(current.studentId, student.user.id);
          assert.equal(current.id, original.submissionId);
          assert.ok(current.version >= original.version, 'Main draft revision went backwards during mixed traffic');
          if (current.version === original.version) assert.equal(current.content, original.content, 'Main draft changed without a new saved revision');
          for (const marker of mixedMarkers) assert.equal(current.content.includes(marker), false, 'Mixed-course revision leaked into the main draft');
          evidence.isolation.push({ client: student.client, studentId: student.user.id, courseId: current.courseId,
            participationId: row.participationId, beforeVersion: original.version, afterVersion: current.version,
            afterContentSha256: hash(current.content), mixedRevisionMarkersAbsent: true, originalPagePreserved: true });
        }
      });
    } catch (error) {
      failure ??= error; evidence.status = 'failed'; evidence.isolationError = String(error.stack ?? error).slice(0, 4000);
    }
    const cleanup = await Promise.allSettled(clones.map(student => student.page.close()));
    evidence.cleanupErrors = cleanup.filter(result => result.status === 'rejected').map(result => String(result.reason));
    if (evidence.cleanupErrors.length) {
      failure ??= new Error('Mixed showcase pages did not close'); evidence.status = 'failed';
    }
    evidence.finishedAt = new Date().toISOString(); evidence.durationMs = performance.now() - evidence.startedAtMonotonicMs;
    await save();
  }
  if (failure) throw failure;
  const result = { status: 'passed', phase: 'steady', mainInstanceId: instance.id, mixedInstanceId: mixed.id,
    representatives: clones.length, sourceCourseIsolated: true, originalPagesPreserved: true,
    durationMs: evidence.durationMs, startedAt: evidence.startedAt, finishedAt: evidence.finishedAt,
    ...showcase, evidence: path.join(directory, 'evidence.json') };
  record('incremental-mixed-showcase-during-periodic-load', '通过', result, 'browser-real-backend');
  return result;
}
