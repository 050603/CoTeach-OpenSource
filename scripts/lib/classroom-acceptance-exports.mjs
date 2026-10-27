import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const sections = ['summary', 'activity_progress', 'activity_submissions', 'classrooms', 'artifacts', 'reflections', 'evaluations', 'summary_csv'];
const finalStatuses = ['SUBMITTED', 'submitted', 'COMPLETED', 'completed', 'PUBLISHED', 'published', 'READY', 'ready'];
const practiceThreads = new Set(['ai-collaboration:make', 'ai-collaboration-comments:make',
  'ai-collaboration:external-artifact:make', 'ai-collaboration-comments:external-artifact:make',
  'ai-code-collaboration:make:python', 'ai-code-comments:make:python', 'ai-code-collaboration:make:c', 'ai-code-comments:make:c']);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const normalized = value => JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
const hash = value => createHash('sha256').update(value).digest('hex');
const pick = (row, keys) => Object.fromEntries(keys.map(key => {
  assert.ok(Object.hasOwn(row, key), `Export omitted required field ${key}`);
  return [key, row[key]];
}));
const researchExportFields = Object.freeze({
  events: ['eventType', 'durationMs', 'metadata'],
  ai: ['eventType', 'content', 'payload'],
  outcomes: ['eventType', 'payload'],
  domain: ['eventType', 'payload'],
  experiments: ['phase', 'objectiveScore', 'objectiveTotal', 'questionnaire', 'answers'],
  submissions: ['activitySnapshot', 'payload'],
});

/** includeContent=true requires the actual fields, even when their value is null. */
export function assertResearchExportRowContent(type, actual, source) {
  assert.ok(Object.hasOwn(researchExportFields, type), `Unknown research export type ${type}`);
  const keys = ['id', 'researchKey', ...researchExportFields[type]];
  assert.deepEqual(pick(actual, keys), pick(source, keys), `${type} export content differs from its persisted source`);
}

function sameRecords(actual, expected, label, key = row => row.id) {
  assert.ok(Array.isArray(actual), `${label} has no records array`);
  const indexed = rows => {
    const entries = rows.map(row => [String(key(row)), normalized(row)]);
    assert.equal(new Set(entries.map(([id]) => id)).size, entries.length, `${label} contains duplicate identities`);
    return entries.sort(([left], [right]) => left.localeCompare(right));
  };
  assert.deepEqual(indexed(actual), indexed(expected), `${label} differs from persisted source records`);
}
function parseCsv(value) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let index = value.charCodeAt(0) === 0xfeff ? 1 : 0; index < value.length; index++) {
    const char = value[index];
    if (char === '"') {
      if (quoted && value[index + 1] === '"') { cell += '"'; index++; } else quoted = !quoted;
    } else if (!quoted && char === ',') { row.push(cell); cell = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && value[index + 1] === '\n') index++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  assert.equal(quoted, false, 'Summary CSV has an unterminated quoted cell');
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const csvValue = value => /^[=+\-@]/.test(String(value)) ? `'${value}` : String(value);

/** Only an absent success file permits the attempts fallback. An incomplete or
 * malformed success file is evidence corruption, not permission to weaken it.
 */
export async function readBrowserExportReceipts(output, students, read = readFile) {
  let filename = 'concurrent-ai-save-projection.json'; let contents;
  try { contents = await read(path.join(output, filename), 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    filename = 'concurrent-ai-save-projection-attempts.json';
    contents = await read(path.join(output, filename), 'utf8');
  }
  const receipts = JSON.parse(contents);
  assert.ok(Array.isArray(receipts), 'Browser request receipts must be an array');
  assert.equal(receipts.length, students.length, 'Complete AI export requires every actual browser request receipt');
  assert.deepEqual(receipts.map(row => row.student).sort((a, b) => a - b), students.map(row => row.index).sort((a, b) => a - b),
    'Browser receipts omit or duplicate a student');
  for (const row of receipts) {
    assert.ok(typeof row.requestId === 'string' && row.requestId.trim(), 'A student has no actual browser request ID');
    if (filename.endsWith('-attempts.json')) {
      assert.ok((row.requestBody && row.requestBody.requestId === row.requestId)
        || (typeof row.requestSentAt === 'number' && Number.isFinite(row.requestSentAt))
        || (typeof row.requestSentAt === 'string' && Number.isFinite(Date.parse(row.requestSentAt))),
      'A failed attempt needs an observed browser request, not an ID parsed from an error');
    } else assert.ok(row.status === undefined || row.status === 'fulfilled', 'Success report contains a failed browser request');
  }
  assert.equal(new Set(receipts.map(row => row.requestId)).size, students.length, 'Browser requests share a request ID');
  return { filename, receipts };
}

/** Proves exported history for a known browser request. It never changes the
 * independent browser/model completion verdict, including a preserved failure.
 */
export function assertDocumentRequestExport({ archive, task, receipt, student, instanceId, offeringId }) {
  const input = object(task.input); const conversation = task.conversation;
  assert.equal(task.id, `document-ai-${hash(JSON.stringify([student.participation.id, receipt.requestId]))}`, 'Task identity differs from the browser request');
  assert.equal(task.taskType, 'DOCUMENT_COLLABORATION');
  assert.equal(task.createdById, student.user.id); assert.equal(task.offeringId, offeringId);
  assert.equal(input.requestId, receipt.requestId); assert.equal(input.participationId, student.participation.id);
  assert.equal(input.stageKey, 'make'); assert.equal(input.workspaceKind, 'document');
  assert.ok(typeof input.conversationId === 'string' && input.conversationId.trim(), 'Task lost its logical conversation');
  assert.equal(task.conversationId, conversation?.id);
  assert.equal(conversation?.userId, student.user.id); assert.equal(conversation?.offeringId, offeringId);
  assert.equal(conversation?.participationId, student.participation.id);
  assert.equal(conversation?.participation?.instanceId, instanceId);
  assert.equal(conversation?.participation?.enrollmentId, student.participation.enrollmentId);
  assert.equal(archive.course.id, instanceId); assert.equal(archive.student.id, student.user.id);
  assert.ok(typeof input.message === 'string' && input.message.trim(), 'The actual task has no original student question');
  if (receipt.requestBody) {
    const body = receipt.requestBody;
    assert.equal(body.requestId, receipt.requestId); assert.equal(body.courseId, instanceId);
    assert.equal(body.studentId, student.user.id); assert.equal(body.stageKey, 'make');
    assert.equal(body.message, input.message, 'The task question differs from the actual browser request');
    if (body.conversationId) assert.equal(body.conversationId, input.conversationId);
  }
  if (receipt.conversationId) assert.equal(receipt.conversationId, input.conversationId);
  const audit = archive.auditEvents.filter(event => event.requestId === receipt.requestId);
  for (const event of audit) {
    assert.equal(event.courseId, instanceId); assert.equal(event.studentId, student.user.id);
    assert.equal(event.stageKey, 'make'); assert.equal(event.conversationId, input.conversationId);
  }
  assert.ok(audit.some(event => event.eventType === 'request' && event.actorRole === 'student' && event.content === input.message),
    'Complete export omitted the actual student question, including a failed or running request');
  const raw = audit.filter(event => ['model-output', 'invalid-model-response'].includes(event.payload?.kind));
  for (const event of raw) {
    assert.ok(event.content?.trim(), 'Export contains an empty retained model output');
    assert.equal(event.payload.rawSha256, hash(event.content), 'Export changed retained raw model output');
  }
  if (task.status === 'COMPLETED') {
    const response = task.output?.response;
    assert.equal(response?.requestId, receipt.requestId);
    assert.ok(Array.isArray(response.messages) && response.messages.some(message => message.role === 'agent' && message.content?.trim()),
      'Completed task has no committed answer');
    const messages = archive.interactions.flatMap(turn => turn.messages);
    for (const message of response.messages) {
      assert.ok(messages.some(item => item.role === (message.role === 'student' ? 'student' : 'ai') && item.content === message.content),
        'Complete export omitted a committed answer or question');
    }
    assert.ok(audit.some(event => event.eventType === 'response' && event.actorRole === 'ai'));
    assert.ok(raw.some(event => event.payload.kind === 'model-output'), 'Complete export omitted retained raw provider evidence');
  } else if (task.status === 'FAILED' || task.status === 'CANCELLED') {
    if (task.status === 'FAILED') assert.ok(typeof task.error === 'string' && task.error.trim(), 'Failed task lost its diagnostic');
    assert.ok(audit.some(event => event.eventType === 'error' && event.content?.trim()), 'Complete export omitted the actual failure diagnostic');
    // No raw output is required for a timeout before the provider answered.
    // Any raw output that exists is independently reconciled against all DB facts.
  } else assert.ok(['RUNNING', 'PENDING'].includes(task.status), `Unsupported durable request status: ${task.status}`);
  return { student: student.index, requestId: receipt.requestId, taskId: task.id, status: task.status,
    taskError: task.error ?? null, browserStatus: receipt.status ?? 'fulfilled', browserError: receipt.error ?? null,
    auditEvents: audit.length, rawModelOutputs: raw.length };
}

/** Exercise both public export contracts against this run's actual records.
 * Research exports, student profiles and complete practice transcripts have
 * different scopes; none of these downloads is treated as a database backup.
 */
export async function runCompleteExportsAcceptance({ teacher, students, instance, offering, origin, db, record, output }) {
  const directory = path.join(output, 'complete-exports');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const save = (name, value) => writeFile(path.join(directory, name), typeof value === 'string' || Buffer.isBuffer(value)
    ? value : `${JSON.stringify(normalized(value), null, 2)}\n`, { mode: 0o600 });
  const evidence = { instanceId: instance.id, offeringId: offering.id, students: students.length, checks: [] };
  const check = async (name, operation) => {
    try {
      const detail = await operation(); evidence.checks.push({ name, status: '通过', detail });
      record(name, '通过', detail, 'isolated-backend');
    } catch (error) {
      const detail = String(error.stack ?? error).slice(0, 2500);
      evidence.checks.push({ name, status: '失败', detail }); record(name, '失败', detail, 'isolated-backend');
    } finally { await save('reconciliation.json', evidence); }
  };
  const roster = async () => {
    assert.ok(students.length >= 2 && students.length <= 30, 'Export needs the actual smoke or formal roster');
    const userIds = students.map(student => student.user.id);
    assert.equal(new Set(userIds).size, students.length);
    const enrollments = await db.enrollment.findMany({ where: { offeringId: offering.id, userId: { in: userIds } }, include: { user: true } });
    assert.equal(enrollments.length, students.length, 'Export roster includes a missing or foreign enrollment');
    for (const student of students) {
      const enrollment = enrollments.find(row => row.userId === student.user.id);
      assert.equal(enrollment.id, student.participation.enrollmentId);
    }
    return enrollments;
  };

  await check('profile-zip-reconciliation', async () => {
    const enrollments = await roster();
    const enrollmentIds = enrollments.map(row => row.id);
    const response = await teacher.context.request.post(`${origin}/api/platform/offerings/${offering.id}/students/export`, {
      headers: { Origin: origin }, data: { enrollmentIds, sections }, timeout: 120000,
    });
    assert.equal(response.status(), 200, (await response.text()).slice(0, 200));
    assert.match(response.headers()['content-type'], /application\/zip/);
    const bytes = await response.body(); await save('student-profiles.zip', bytes);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const read = async filename => {
      const file = zip.file(filename); assert.ok(file, `Profile ZIP omitted ${filename}`);
      return JSON.parse(await file.async('string'));
    };
    const manifest = await read('manifest.json');
    assert.equal(manifest.archiveVersion, 1); assert.equal(manifest.offering.id, offering.id);
    assert.equal(manifest.studentCount, students.length);
    assert.deepEqual([...manifest.enrollmentIds].sort(), [...enrollmentIds].sort());
    assert.deepEqual([...manifest.selectedSections].sort(), [...sections].sort());
    const records = {};
    for (const file of manifest.files) {
      assert.ok(zip.file(file.path), `Manifest references missing file ${file.path}`);
      if (!file.path.endsWith('.json')) continue;
      const data = await read(file.path);
      assert.equal(data.schemaVersion, 1); assert.equal(data.offeringId, offering.id);
      assert.equal(data.exportedAt, manifest.exportedAt); assert.ok(Array.isArray(data.records));
      assert.equal(file.recordCount, data.records.length); records[file.path] = data.records;
    }
    const requiredJson = ['data/students.json', 'reference/activity-catalog.json', 'data/activity-progress.json',
      'data/activity-submissions.json', 'data/classroom-participations.json', 'data/classroom-experiment-assessments.json',
      'data/classroom-submissions.json', 'data/artifacts.json', 'data/reflections.json', 'data/evaluations.json'];
    assert.deepEqual(Object.keys(records).sort(), requiredJson.sort(), 'Profile ZIP omitted or invented a selected data section');
    assert.ok(zip.file('README.txt')); assert.ok(zip.file('data/students-summary.csv'));
    const summaries = records['data/students.json'];
    sameRecords(summaries.map(row => pick(row, ['id', 'enrollmentId', 'username', 'displayName', 'status', 'joinedAt'])),
      enrollments.map(row => ({ id: row.userId, enrollmentId: row.id, username: row.user.username,
        displayName: row.user.displayName, status: row.status.toLowerCase(), joinedAt: row.joinedAt })), 'Profile student identities');
    const participations = await db.classroomParticipation.findMany({ where: { enrollmentId: { in: enrollmentIds } }, select: {
      id: true, enrollmentId: true, firstEnteredAt: true, lastEnteredAt: true, completedAt: true, stageProgress: true,
      instance: { select: { id: true, activityId: true, runNo: true, status: true, startedAt: true, endedAt: true } },
    } });
    sameRecords(records['data/classroom-participations.json'], participations, 'Profile classroom participation');
    assert.equal(participations.filter(row => row.instance.id === instance.id).length, students.length);
    const participationIds = participations.map(row => row.id);
    const contracts = [
      ['data/activity-submissions.json', 'activitySubmission', { enrollmentId: { in: enrollmentIds } }, ['id', 'enrollmentId', 'activityId', 'activityVersion', 'activitySnapshot', 'payload', 'submittedAt']],
      ['data/classroom-submissions.json', 'classroomSubmission', { participationId: { in: participationIds }, status: { in: finalStatuses } }, ['id', 'participationId', 'stageKey', 'status', 'payload', 'submittedAt', 'createdAt', 'updatedAt']],
      ['data/reflections.json', 'reflection', { participationId: { in: participationIds } }, ['id', 'participationId', 'activityId', 'authorId', 'content', 'metadata', 'createdAt', 'updatedAt']],
      ['data/evaluations.json', 'evaluation', { participationId: { in: participationIds } }, ['id', 'participationId', 'studentId', 'groupId', 'activityId', 'type', 'evaluatorType', 'evaluatorId', 'score', 'rubric', 'result', 'content', 'metadata', 'createdAt']],
    ];
    for (const [filename, model, where, keys] of contracts) {
      const source = await db[model].findMany({ where, select: Object.fromEntries(keys.map(key => [key, true])) });
      sameRecords(records[filename], source, filename);
    }
    const experiments = await db.experimentAssessmentSubmission.findMany({ where: { enrollmentId: { in: enrollmentIds }, instance: { activity: { chapter: { offeringId: offering.id } } } }, select: {
      id: true, enrollmentId: true, instanceId: true, phase: true, questionnaire: true, answers: true, objectiveScore: true, objectiveTotal: true, submittedAt: true, assignment: { select: { variant: true } },
    } });
    sameRecords(records['data/classroom-experiment-assessments.json'], experiments.map(({ assignment, ...row }) => ({ ...row, variant: assignment.variant })), 'Profile pretest/posttest');
    const artifacts = await db.artifact.findMany({ where: { participationId: { in: participationIds } }, select: {
      id: true, participationId: true, groupId: true, title: true, type: true, status: true, createdAt: true, updatedAt: true,
      versions: { where: { status: { in: finalStatuses } }, orderBy: { sequence: 'asc' }, select: { id: true, sequence: true, sourceHtml: true, fileAssetId: true, mimeType: true, sha256: true, size: true, status: true, submittedAt: true, createdAt: true } },
    } });
    sameRecords(records['data/artifacts.json'], artifacts.filter(row => row.versions.length), 'Profile immutable artifact versions');
    for (const student of students) {
      const tests = experiments.filter(row => row.instanceId === instance.id && row.enrollmentId === student.participation.enrollmentId);
      assert.deepEqual(tests.map(row => row.phase).sort(), ['posttest', 'pretest']);
      assert.ok(records['data/classroom-submissions.json'].some(row => row.id === student.saved.id), 'Profile omitted an acknowledged final document');
      assert.ok(artifacts.some(row => row.participationId === student.participation.id
        && row.versions.some(version => version.sha256 === student.artifactSha256)), 'Profile lost the downloaded final Word fingerprint');
    }
    const catalog = records['reference/activity-catalog.json'];
    const activities = await db.activity.findMany({ where: { chapter: { offeringId: offering.id } }, select: { id: true, chapterId: true, title: true, type: true, position: true, archivedAt: true, chapter: { select: { title: true, position: true, archivedAt: true } } } });
    sameRecords(catalog.map(row => pick(row, ['id', 'chapterId', 'chapterTitle', 'chapterPosition', 'position', 'title', 'type', 'archived'])),
      activities.map(row => ({ id: row.id, chapterId: row.chapterId, chapterTitle: row.chapter.title, chapterPosition: row.chapter.position,
        position: row.position, title: row.title, type: row.type, archived: Boolean(row.archivedAt || row.chapter.archivedAt) })), 'Profile activity catalog');
    const progress = await db.activityProgress.findMany({ where: { enrollmentId: { in: enrollmentIds } }, select: { id: true, enrollmentId: true, activityId: true, status: true, startedAt: true, completedAt: true, lastAccessedAt: true, progressData: true, updatedAt: true } });
    const expectedProgress = enrollments.flatMap(enrollment => catalog.map(activity => progress.find(row => row.enrollmentId === enrollment.id && row.activityId === activity.id)
      ?? { id: null, enrollmentId: enrollment.id, activityId: activity.id, status: summaries.find(row => row.enrollmentId === enrollment.id).activityStatuses[activity.id] ?? 'not_started',
        startedAt: null, completedAt: null, lastAccessedAt: null, progressData: null, updatedAt: null }));
    sameRecords(records['data/activity-progress.json'], expectedProgress, 'Profile activity progress', row => `${row.enrollmentId}:${row.activityId}`);
    const csv = parseCsv(await zip.file('data/students-summary.csv').async('string'));
    assert.equal(csv.length, students.length + 1); assert.equal(csv[0].length, 7);
    sameRecords(csv.slice(1).map(row => ({ id: row[1], values: row })), summaries.map(row => ({ id: csvValue(row.username),
      values: [row.displayName, row.username, row.completedOpenActivities, row.openActivityCount, row.classroomParticipationCount, row.lastLearningAt ?? '', row.attentionReasons.join(';')].map(csvValue) })), 'Profile summary CSV');
    return { students: students.length, archiveSha256: hash(bytes), sections: sections.length, pretestAndPosttest: experiments.length,
      finalDocuments: students.length, sourceRecords: Object.fromEntries(Object.entries(records).map(([name, rows]) => [name, rows.length])) };
  });

  await check('complete-ai-history-export', async () => {
    const enrollments = await roster();
    const sources = await readPracticeSources(db, instance.id);
    const response = await teacher.context.request.get(`${origin}/api/project-practice/export?${new URLSearchParams({ courseId: instance.id })}`, { timeout: 120000 });
    assert.equal(response.status(), 200, (await response.text()).slice(0, 200));
    assert.match(response.headers()['content-type'], /application\/zip/);
    const bytes = await response.body(); await save('complete-practice-history.zip', bytes);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const entries = Object.values(zip.files).filter(file => !file.dir);
    assert.equal(entries.length, students.length, 'Class AI ZIP must contain exactly one JSON per actual student');
    const archives = await Promise.all(entries.map(async file => { assert.ok(file.name.endsWith('.json')); return JSON.parse(await file.async('string')); }));
    assert.deepEqual(archives.map(row => row.student.id).sort(), students.map(student => student.user.id).sort(), 'Class AI ZIP contains a missing, duplicated or foreign student');
    // Obtain every real export even when the upstream browser exercise failed.
    const singleArchives = new Map();
    for (const student of students) {
      const singleResponse = await teacher.context.request.get(`${origin}/api/project-practice/export?${new URLSearchParams({ courseId: instance.id, studentId: student.user.id })}`, { timeout: 120000 });
      assert.equal(singleResponse.status(), 200); const single = await singleResponse.json();
      await save(`student-${student.index}-complete-practice.json`, single);
      singleArchives.set(student.user.id, single);
    }
    const { filename, receipts: known } = await readBrowserExportReceipts(output, students);
    const requests = []; const requestCounts = { completed: 0, failed: 0, running: 0, pending: 0, cancelled: 0, missing: 0 };
    evidence.aiHistory = { scope: 'Actual history generated in the main classroom; export completeness does not imply browser or model success.',
      receiptSource: filename, requestCounts, requests };
    const failures = []; const checkedTasks = [];
    const taskInclude = { conversation: { include: { participation: { select: { instanceId: true, enrollmentId: true } } } } };
    for (const student of students) {
      try {
        const receipt = known.find(row => row.student === student.index); assert.ok(receipt?.requestId, 'No browser receipt for this student');
        const observed = { student: student.index, requestId: receipt.requestId,
          browserStatus: receipt.status ?? 'fulfilled', browserError: receipt.error ?? null };
        requests.push(observed);
        const tasks = await db.aiTask.findMany({ where: { taskType: 'DOCUMENT_COLLABORATION', input: { path: ['requestId'], equals: receipt.requestId } }, include: taskInclude });
        if (tasks.length === 1 && Object.hasOwn(requestCounts, tasks[0].status.toLowerCase())) requestCounts[tasks[0].status.toLowerCase()]++;
        else requestCounts.missing++;
        assert.equal(tasks.length, 1, 'Actual browser request has no unique durable task');
        const task = tasks[0]; checkedTasks.push(task);
        Object.assign(observed, { taskId: task.id, status: task.status, taskError: task.error ?? null });
        const archive = archives.find(row => row.student.id === student.user.id);
        const enrollment = enrollments.find(row => row.userId === student.user.id);
        assert.equal(archive.schemaVersion, 2); assert.equal(archive.course.id, instance.id); assert.equal(archive.course.stageKey, 'make');
        assert.deepEqual(archive.student, { id: student.user.id, name: enrollment.user.displayName, researchKey: enrollment.researchKey });
        assert.ok(Number.isFinite(Date.parse(archive.exportedAt)));
        verifyPracticeHistory(archive, sources, student, instance.id);
        const single = singleArchives.get(student.user.id);
        const classContent = { ...archive }; delete classContent.exportedAt;
        const singleContent = { ...single }; delete singleContent.exportedAt;
        assert.deepEqual(singleContent, classContent, 'Single-student and class exports disagree on retained history');
        Object.assign(observed, assertDocumentRequestExport({ archive, task, receipt, student, instanceId: instance.id, offeringId: offering.id }));
      } catch (error) {
        const failure = new Error(`Student ${student.index} export reconciliation: ${error.message}`, { cause: error });
        failures.push(failure);
        const observed = requests.find(row => row.student === student.index);
        if (observed) observed.exportError = String(error.stack ?? error);
      }
    }
    await save('request-reconciliation.json', evidence.aiHistory);
    try {
      assert.deepEqual(normalized(await readPracticeSources(db, instance.id)), normalized(sources), 'Practice export sources changed while taking the export snapshot; drain pending writes before retrying');
      sameRecords(await db.aiTask.findMany({ where: { id: { in: checkedTasks.map(task => task.id) } }, include: taskInclude }), checkedTasks,
        'Durable request state changed during export reconciliation');
    } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'));
    return { students: students.length, archiveSha256: hash(bytes), knownBrowserRequests: known.length,
      receiptSource: filename, requestCounts, browserCompletionVerifiedByThisCheck: false,
      auditEvents: archives.reduce((sum, row) => sum + row.auditEvents.length, 0), interactionMessages: archives.reduce((sum, row) => sum + row.summary.interactionMessageCount, 0),
      writingVersions: archives.reduce((sum, row) => sum + row.writingVersions.length, 0), singleAndClassExportsMatch: true };
  });
  return evidence;
}

async function readPracticeSources(db, instanceId) {
  const [audit, conversations, versions, receipts] = await Promise.all([
    db.aiInteractionEvent.findMany({ where: { participation: { instanceId }, payload: { path: ['legacy', 'stageKey'], equals: 'make' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    db.aiConversation.findMany({ where: { participation: { instanceId }, metadata: { path: ['legacyStageKey'], string_starts_with: '' } },
      include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } }, orderBy: { id: 'asc' } }),
    db.artifactVersion.findMany({ where: { artifact: { type: 'DOCUMENT_ARCHIVE', participation: { instanceId } } },
      include: { artifact: { include: { participation: { include: { enrollment: true } } } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    db.domainEvent.findMany({ where: { classroomInstanceId: instanceId, eventType: 'document_version_submitted' }, orderBy: { id: 'asc' } }),
  ]);
  return { audit, conversations, versions, receipts };
}

function verifyPracticeHistory(archive, sources, student, instanceId) {
  const sourceAudit = sources.audit.filter(row => row.userId === student.user.id);
  const events = sourceAudit.map(row => {
    const envelope = object(row.payload); const legacy = object(envelope.legacy);
    return normalized({ id: row.id, courseId: instanceId, studentId: row.userId, stageKey: String(legacy.stageKey ?? 'make'),
      conversationId: typeof legacy.conversationId === 'string' ? legacy.conversationId : row.conversationId ?? undefined,
      source: legacy.source ?? 'system', eventType: row.eventType, actorRole: row.actor === 'assistant' ? 'ai' : row.actor,
      actorId: typeof legacy.actorId === 'string' ? legacy.actorId : undefined, content: row.content ?? undefined,
      payload: { ...object(envelope.detail), ...(typeof legacy.occurredAt === 'string' ? { occurredAt: legacy.occurredAt } : {}) },
      requestId: row.requestId ?? undefined, createdAt: row.createdAt });
  });
  const exported = new Map(archive.auditEvents.map(event => [event.id, event]));
  assert.equal(exported.size, archive.auditEvents.length, 'Complete AI history duplicated an event');
  for (const event of events) assert.deepEqual(exported.get(event.id), event, 'AI export changed or omitted persisted audit evidence');
  const fallback = new Map();
  for (const conversation of sources.conversations.filter(row => row.userId === student.user.id && practiceThreads.has(row.metadata?.legacyStageKey))) {
    for (const message of conversation.messages) {
      const metadata = object(message.metadata);
      const role = metadata.legacyRole ?? (message.role === 'assistant' ? 'agent' : message.role === 'user' ? 'student' : 'system-trigger');
      if (!['student', 'agent'].includes(role)) continue;
      fallback.set(`thread:${message.id}`, normalized({ id: `thread:${message.id}`, courseId: instanceId, studentId: student.user.id, stageKey: 'make',
        conversationId: metadata.conversationId || conversation.id,
        source: conversation.metadata.legacyStageKey.includes('-comments:') ? 'proactive-comment' : 'sidebar',
        eventType: role === 'student' ? 'request' : 'response', actorRole: role === 'student' ? 'student' : 'ai', actorId: metadata.authorId,
        content: message.content, payload: { workspaceKind: conversation.metadata.legacyStageKey.includes(':external-artifact:') ? 'external-artifact' : 'document', provenance: 'companion-message' }, createdAt: message.createdAt }));
    }
  }
  for (const event of archive.auditEvents) {
    assert.equal(event.courseId, instanceId); assert.equal(event.studentId, student.user.id); assert.equal(event.stageKey, 'make');
    if (!sourceAudit.some(row => row.id === event.id)) assert.deepEqual(event, fallback.get(event.id), 'AI history contains an event absent from persisted audit and messages');
  }
  const signature = event => JSON.stringify([event.studentId, event.conversationId, event.actorRole, event.content]);
  const count = rows => { const counts = new Map(); for (const row of rows) if (['student', 'ai'].includes(row.actorRole) && row.content) counts.set(signature(row), (counts.get(signature(row)) ?? 0) + 1); return counts; };
  const auditedCounts = count(events); const companionCounts = count([...fallback.values()]); const actualCounts = count(archive.auditEvents);
  for (const key of new Set([...auditedCounts.keys(), ...companionCounts.keys(), ...actualCounts.keys()])) {
    assert.equal(actualCounts.get(key) ?? 0, Math.max(auditedCounts.get(key) ?? 0, companionCounts.get(key) ?? 0), 'Full practice history omitted or duplicated a persisted conversation message');
  }
  const expectedMessages = archive.auditEvents.flatMap(event => {
    if (event.source !== 'proactive-comment' || event.actorRole !== 'ai' || event.eventType !== 'comment' || !event.payload?.comments?.length) return [event];
    return event.payload.comments.flatMap((comment, index) => {
      const initial = comment.comments?.find(item => item.role === 'assistant' && item.content?.trim());
      return comment.id?.trim() && initial ? [{ ...event, id: `${event.id}:comment:${index}`, conversationId: comment.id.trim(),
        content: initial.content.trim(), payload: { initialComment: true } }] : [];
    });
  }).filter(event => event.content && !['decision', 'undo', 'policy'].includes(event.eventType) && event.source !== 'system'
    && event.payload?.kind !== 'model-output' && !['read', 'suggest-delegated-work'].includes(event.payload?.action) && event.content !== '学生阅读了段落批注。');
  const actualMessages = archive.interactions.flatMap(turn => turn.messages);
  sameRecords(actualMessages.map(row => pick(row, ['id', 'role', 'content'])), expectedMessages.map(event => ({ id: event.id,
    role: event.actorRole === 'ai' ? 'ai' : event.actorRole === 'student' ? 'student' : 'system', content: event.content })), 'Complete AI transcript messages');
  const eventTime = event => event.payload?.occurredAt && Number.isFinite(Date.parse(event.payload.occurredAt)) ? event.payload.occurredAt : event.createdAt;
  const chronological = [...archive.auditEvents].sort((left, right) => eventTime(left).localeCompare(eventTime(right)) || left.id.localeCompare(right.id));
  const trimmed = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  archive.interactions.forEach((turn, index) => {
    assert.equal(turn.sequence, index + 1); assert.equal(turn.turn, index + 1); assert.ok(turn.messages.length);
    for (const message of turn.messages) {
      const event = expectedMessages.find(item => item.id === message.id);
      assert.equal(turn.conversationId, event.conversationId || '未标记对话', 'Transcript moved a message into another conversation');
      assert.equal(message.occurredAt, eventTime(event)); assert.equal(message.requestId, event.requestId);
      assert.equal(message.error, event.eventType === 'error' ? true : undefined);
      assert.equal(message.responseKind, trimmed(event.payload?.kind));
      const detail = object(event.payload); const suggestion = object(detail.suggestion); const delivery = object(detail.deliverable);
      let modification;
      if (Object.keys(suggestion).length) modification = { contributionId: trimmed(detail.contributionId), type: 'edit-suggestion',
        title: trimmed(suggestion.title), targetText: trimmed(suggestion.targetText), replacement: trimmed(suggestion.replacement) };
      else if (Object.keys(delivery).length) modification = { contributionId: trimmed(detail.contributionId), type: 'work-delivery',
        title: trimmed(delivery.title), replacement: trimmed(delivery.content), documentActions: Array.isArray(delivery.documentActions) ? delivery.documentActions : undefined };
      if (modification?.contributionId) {
        const decisions = chronological.filter(item => item.eventType === 'decision' && item.payload?.contributionId === modification.contributionId);
        const decision = decisions.at(-1);
        if (decision) Object.assign(modification, { decision: ['adopted', 'revision'].includes(decision.payload.decision) ? decision.payload.decision : 'rejected',
          decisionAt: eventTime(decision), decisionSummary: decision.content });
        const undone = chronological.filter(item => item.eventType === 'undo' && item.payload?.contributionId === modification.contributionId).at(-1);
        if (undone) modification.undoneAt = eventTime(undone);
      }
      if (modification) assert.deepEqual(message.modification, normalized(modification), 'AI export lost a proposed change or the student decision');
      else assert.equal(message.modification, undefined);
    }
  });
  const metadata = new Map(sources.receipts.map(row => [row.payload?.versionId, object(row.payload)]));
  const versions = sources.versions.filter(row => row.artifact.participation.enrollment.userId === student.user.id
    && String(metadata.get(row.id)?.stageKey ?? 'make') === 'make').map(row => ({ version: row.sequence, title: String(metadata.get(row.id)?.title ?? row.artifact.title),
    status: row.status.toUpperCase() === 'SUBMITTED' ? 'submitted' : row.status.toUpperCase() === 'FAILED' ? 'failed' : 'processing',
    submittedAt: (row.submittedAt ?? row.createdAt).toISOString() }));
  assert.deepEqual(archive.writingVersions, versions, 'Complete AI history lost immutable writing versions');
  if (student.artifactSha256) assert.ok(sources.versions.some(row => row.artifact.participation.enrollment.userId === student.user.id
    && row.sha256 === student.artifactSha256), 'Known submitted Word fingerprint has no exported version');
  const modifications = actualMessages.flatMap(message => message.modification ? [message.modification] : []);
  assert.deepEqual(archive.summary, { conversationCount: archive.interactions.length, interactionTurnCount: archive.interactions.length,
    interactionMessageCount: actualMessages.length, auditEventCount: archive.auditEvents.length, aiModificationCount: modifications.length,
    adoptedModificationCount: modifications.filter(item => item.decision === 'adopted' && !item.undoneAt).length, writingVersionCount: versions.length });
}
