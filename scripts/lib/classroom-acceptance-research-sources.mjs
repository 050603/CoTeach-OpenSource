import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const json = value => JSON.parse(JSON.stringify(value));
export const RESEARCH_SOURCE_CHECK = 'research-export-nonempty-source-actions';

/** An empty matching set does not demonstrate content or cursor coverage. */
export function assertNonemptyResearchExport({ type, rows, expected, pageCount, researchKeys }) {
  assert.ok(Number.isInteger(pageCount) && pageCount >= 2, `${type} export never followed a cursor`);
  assert.ok(researchKeys.length >= 2 && researchKeys.every(key => typeof key === 'string' && key.length > 0),
    'Export coverage needs the actual enrolled research identities');
  assert.equal(new Set(researchKeys).size, researchKeys.length, 'Export roster duplicated a research identity');
  assert.ok(rows.length >= researchKeys.length, `${type} export is empty or omits students`);
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length, `${type} export duplicated rows`);
  assert.deepEqual(rows.map(row => row.id).sort(), expected.map(row => row.id).sort(),
    `${type} export omitted or included foreign records`);
  const exportedKeys = new Set(rows.map(row => row.researchKey));
  assert.ok(researchKeys.every(key => exportedKeys.has(key)), `${type} export omitted an enrolled student`);
  return { type, rows: rows.length, pages: pageCount, students: researchKeys.length };
}

/** Supplemental real API exercise after the sustained classroom, before its
 * export. No main classroom submissions, questionnaires or pages are changed.
 * ActivitySubmission and CLASSROOM_REFLECT are separate platform contracts;
 * the main document/quiz/posttest UI does not generate either record type.
 */
export async function runResearchSourceAcceptance({ teacher, students, instance, offering, chapter, db, request, record, output }) {
  const directory = path.join(output, 'research-export-sources');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { startedAt: new Date().toISOString(), mainInstanceId: instance.id,
    scope: 'Supplemental real Assignment submission and independent classroom reflection APIs, outside the sustained classroom duration; not a main-course UI claim',
    students: [], errors: [] };
  let supplemental; let started = false;
  try {
    assert.ok(students.length >= 2 && students.length <= 30);
    assert.equal(new Set(students.map(student => student.user.id)).size, students.length);
    const main = await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } });
    assert.equal(main.status, 'TEACHING', 'Run the supplemental sources after the normal stages but before main finish');
    const mainRecords = async () => json(await Promise.all([
      db.classroomSubmission.findMany({ where: { participation: { instanceId: instance.id } }, orderBy: { id: 'asc' } }),
      db.experimentAssessmentSubmission.findMany({ where: { instanceId: instance.id }, orderBy: { id: 'asc' } }),
    ]));
    const before = await mainRecords();
    const endpoint = `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`;
    const assignment = (await request(teacher.context, 'POST', endpoint, {
      type: 'Assignment', title: '导出专项：观察方法作业',
      description: '独立 API 验证：说明比较两个地点时如何保持观察时长一致。',
    }, 201)).activity;
    await request(teacher.context, 'PATCH', `/api/platform/activities/${assignment.id}`, { isOpen: true });
    const assignmentSource = await db.activity.findUniqueOrThrow({ where: { id: assignment.id } });
    const activity = (await request(teacher.context, 'POST', endpoint, {
      type: 'Classroom', title: '导出专项：独立反思记录', templateVersionId: main.templateVersionId,
    }, 201)).activity;
    await request(teacher.context, 'PATCH', `/api/platform/activities/${activity.id}`, { isOpen: true });
    supplemental = await db.classroomInstance.findFirstOrThrow({ where: { activityId: activity.id } });
    assert.notEqual(supplemental.id, instance.id);
    evidence.assignmentId = assignment.id; evidence.reflectionActivityId = activity.id; evidence.supplementalInstanceId = supplemental.id;
    await request(teacher.context, 'POST', `/api/platform/classroom-instances/${supplemental.id}/start`, {});
    started = true;
    // Sequential API observations do not claim a second 30-browser load test.
    for (const student of students) {
      const item = { index: student.index, userId: student.user.id, status: 'failed' };
      evidence.students.push(item);
      try {
        const enrollment = await db.enrollment.findUniqueOrThrow({
          where: { userId_offeringId: { userId: student.user.id, offeringId: offering.id } },
        });
        assert.equal(enrollment.id, student.participation.enrollmentId);
        const answer = `学生 ${student.index + 1}：两个地点都观察十分钟，分别记录地点、时间和数量，再比较结果。`;
        const submitted = await request(student.context, 'POST', `/api/platform/activities/${assignment.id}/submit`, { answer });
        assert.equal(submitted.progress.status, 'COMPLETED');
        const rows = await db.activitySubmission.findMany({ where: { activityId: assignment.id, enrollmentId: enrollment.id } });
        assert.equal(rows.length, 1, 'A single assignment request must persist one immutable submission');
        const row = rows[0];
        assert.equal(row.researchKey, enrollment.researchKey); assert.equal(row.activityVersion, assignmentSource.version);
        assert.deepEqual(row.activitySnapshot, { type: assignmentSource.type, title: assignmentSource.title,
          config: assignmentSource.config, version: assignmentSource.version });
        assert.deepEqual(row.payload, { answer, answers: {}, submittedAt: row.submittedAt.toISOString() });
        assert.deepEqual(submitted.progress.progressData, row.payload);
        const entered = await request(student.context, 'POST', `/api/platform/classroom-instances/${supplemental.id}/enter`, {});
        assert.equal(entered.participation.enrollmentId, enrollment.id); assert.equal(entered.participation.instanceId, supplemental.id);
        const participationId = entered.participation.id;
        const outcomeEndpoint = `/api/platform/participations/${participationId}/outcomes`;
        const body = { action: 'reflect', content: `学生 ${student.index + 1}：我需要保留原始观察记录；观察时长不同的结果不能直接比较。`, idempotencyKey: randomUUID() };
        const first = await request(student.context, 'POST', outcomeEndpoint, body);
        const replay = await request(student.context, 'POST', outcomeEndpoint, body);
        assert.deepEqual(replay, first, 'An identical reflection retry changed the durable receipt');
        const reflections = await db.reflection.findMany({ where: { participationId } });
        assert.equal(reflections.length, 1); assert.equal(first.outcome.id, reflections[0].id);
        assert.equal(reflections[0].content, body.content); assert.equal(reflections[0].authorId, student.user.id);
        assert.equal(reflections[0].activityId, activity.id);
        const receipts = await db.domainEvent.findMany({ where: { participationId, eventType: 'CLASSROOM_REFLECT' } });
        assert.equal(receipts.length, 1, 'Reflection retry created a second research event');
        const receipt = receipts[0];
        assert.equal(receipt.offeringId, offering.id); assert.equal(receipt.classroomInstanceId, supplemental.id);
        assert.equal(receipt.researchKey, enrollment.researchKey); assert.equal(receipt.actorId, student.user.id);
        assert.equal(receipt.idempotencyKey, `classroom-outcome:${student.user.id}:${body.idempotencyKey}`);
        assert.deepEqual(receipt.payload.result, first.outcome);
        const ownerView = await request(student.context, 'GET', outcomeEndpoint);
        const teacherView = await request(teacher.context, 'GET', outcomeEndpoint);
        assert.deepEqual(ownerView.reflections, json(reflections)); assert.deepEqual(teacherView.reflections, json(reflections));
        Object.assign(item, { status: 'passed', researchKey: enrollment.researchKey, participationId,
          submissionId: row.id, reflectionId: first.outcome.id, outcomeEventId: receipt.id,
          requestId: body.idempotencyKey, replayMatches: true });
      } catch (error) { item.error = String(error.stack ?? error).slice(0, 2500); evidence.errors.push(item.error); }
    }
    assert.deepEqual(await mainRecords(), before, 'Supplemental APIs changed the main classroom submissions or formal assessments');
    evidence.mainSubmissionsAndAssessmentsUnchanged = true;
    assert.equal(await db.experimentAssessmentSubmission.count({ where: { instanceId: supplemental.id } }), 0,
      'The supplementary reflection scenario must not invent pretests or posttests');
    assert.equal(await db.classroomSubmission.count({ where: { participation: { instanceId: supplemental.id } } }), 0,
      'The supplementary reflection scenario must not invent stage submissions');
  } catch (error) { evidence.errors.push(String(error.stack ?? error).slice(0, 2500)); }
  finally {
    if (started) {
      try {
        const finished = await request(teacher.context, 'POST', `/api/platform/classroom-instances/${supplemental.id}/finish`, {});
        assert.equal(finished.instance.status, 'FINISHED'); evidence.supplementalFinished = true;
      } catch (error) { evidence.errors.push(String(error.stack ?? error).slice(0, 2500)); }
    }
    evidence.finishedAt = new Date().toISOString();
    evidence.status = evidence.errors.length || evidence.students.length !== students.length ? '失败' : '通过';
    await writeFile(path.join(directory, 'receipts.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    record(RESEARCH_SOURCE_CHECK, evidence.status, evidence, 'isolated-backend');
  }
  return evidence;
}
