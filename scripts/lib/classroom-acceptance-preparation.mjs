import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { validateScene, validateStage } from '@openmaic/dsl';

const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const checkNames = ['teacher-preparation-resource-persistence', 'teacher-preparation-version-isolation', 'teacher-preparation-student-permission'];

/** Publication must preserve every source file; concurrent warmup may add only
 * content-addressed, final audio files. Temporary files are never accepted.
 */
export function assertPreparationMediaManifest(original, current, classroomId) {
  assert.match(classroomId, /^[a-zA-Z0-9_-]+$/);
  const indexed = rows => {
    const files = new Map();
    for (const file of rows) {
      assert.equal(files.has(file.path), false, `Duplicate source media path: ${file.path}`);
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0, `Invalid source media size: ${file.path}`);
      assert.match(file.sha256, /^[a-f0-9]{64}$/, `Invalid source media digest: ${file.path}`);
      files.set(file.path, file);
    }
    return files;
  };
  const before = indexed(original); const after = indexed(current);
  for (const [name, file] of before) {
    assert.ok(after.has(name), `Original classroom media disappeared: ${name}`);
    assert.equal(after.get(name).bytes, file.bytes, `Original classroom media size changed: ${name}`);
    assert.equal(after.get(name).sha256, file.sha256, `Original classroom media content changed: ${name}`);
  }
  const added = current.filter(file => !before.has(file.path));
  const prefix = `${classroomId}/audio/`;
  for (const file of added) {
    const match = file.path.startsWith(prefix)
      && /^explanation-([a-f0-9]{64})\.(?:wav|mp3|aac|flac|m4a|ogg|opus|webm)$/.exec(file.path.slice(prefix.length));
    assert.ok(match, `Unrelated or unfinished classroom media appeared: ${file.path}`);
    assert.equal(file.sha256, match[1], `New explanation audio does not match its content address: ${file.path}`);
    assert.ok(file.bytes > 0, `New explanation audio is empty: ${file.path}`);
  }
  return added;
}

export function assertPreparationWarmupAudio(added, explanations, classroomId) {
  return added.map(file => {
    const filename = path.posix.basename(file.path);
    const row = explanations.find(item => item.status === 'COMPLETED' && item.input?.classroomId === classroomId
      && item.audio?.filename === filename && item.audio.bytes === file.bytes
      && Number.isFinite(item.audio.audioDurationSec) && item.audio.audioDurationSec > 0);
    assert.ok(row, `New explanation audio has no committed warmup metadata: ${file.path}`);
    return { ...file, explanationId: row.id, audioDurationSec: row.audio.audioDurationSec };
  });
}

/** Pure representative editor payload. The source resource is never mutated. */
export function createPreparationEdit(classroom, marker) {
  const scenes = structuredClone(classroom.scenes);
  const now = Date.now();
  const stage = { ...structuredClone(classroom.stage), createdAt: Number(classroom.stage.createdAt) || Date.parse(classroom.stage.createdAt) || now, updatedAt: now };
  for (const scene of scenes) {
    scene.createdAt = Number(scene.createdAt) || Date.parse(scene.createdAt) || now;
    scene.updatedAt = now;
  }
  const slide = scenes.find(scene => scene.type === 'slide' && scene.content?.type === 'slide');
  assert.ok(slide, 'Preparation acceptance requires an actual slide');
  const text = slide.content.canvas.elements.find(element => element.type === 'text');
  assert.ok(text, 'Preparation acceptance requires an editable text element');
  const speech = slide.actions.find(action => action.type === 'speech' && action.text);
  assert.ok(speech, 'Preparation acceptance requires authored narration');
  const board = slide.actions.find(action => action.type === 'wb_draw_text');
  assert.ok(board, 'Preparation acceptance requires an authored whiteboard text action');
  text.content = `<p>备课持久化验收 ${marker}</p>`;
  board.content = `白板证据记录 ${marker}`;
  speech.text = `比较观察时长前先记录原始证据。备课讲稿保存验收 ${marker}。`;
  const shapeId = 'acceptance-preparation-shape';
  const shape = { id: shapeId, type: 'shape', left: 760, top: 450, width: 160, height: 60, rotate: 0,
    fixedRatio: false, viewBox: [100, 100], path: 'M0 0 L100 0 L100 100 L0 100 Z', fill: '#16766d',
    text: { content: `<p>${marker}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#ffffff', align: 'middle' } };
  slide.content.canvas.elements = slide.content.canvas.elements.filter(element => element.id !== shapeId);
  slide.content.canvas.elements.push(shape);
  for (const [name, validation] of [['stage', validateStage(stage)], ...scenes.map(scene => [scene.id, validateScene(scene)])]) {
    assert.equal(validation.valid, true, `${name}: ${JSON.stringify(validation.errors)}`);
  }
  return { body: { classroomId: classroom.id, revision: classroom.revision ?? 0, stage, scenes },
    expected: { sceneId: slide.id, textId: text.id, text: text.content, shape, boardId: board.id, boardText: board.content,
      speechId: speech.id, speechText: speech.text } };
}

export function assertPreparationEdits(classroom, expected) {
  const scene = classroom.scenes.find(item => item.id === expected.sceneId);
  assert.ok(scene, 'Saved slide disappeared');
  assert.equal(scene.content.canvas.elements.find(item => item.id === expected.textId)?.content, expected.text);
  assert.deepEqual(scene.content.canvas.elements.find(item => item.id === expected.shape.id), expected.shape);
  assert.equal(scene.actions.find(item => item.id === expected.boardId)?.content, expected.boardText);
  const speech = scene.actions.find(item => item.id === expected.speechId);
  assert.equal(speech?.text, expected.speechText);
  assert.equal(speech.audioUrl, undefined, 'Edited narration retained audio from the previous text');
  assert.equal(speech.audioInvalidated, true, 'Edited narration did not invalidate previous audio');
  return { text: true, shape: true, whiteboard: true, narration: true, staleNarrationAudioRemoved: true };
}

/** Real isolated API/database/file evidence, outside the sustained lesson.
 * Creates a separate template and instances; no API/browser transport is mocked.
 * Published-resource copy-on-write is exercised without writing the source fixture.
 */
export async function runPreparationAcceptance({ teacher, students, template, instance, fixture, offering, chapter,
  origin, db, request, record, output, classroomDataDir }) {
  const directory = path.join(output, 'preparation');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const evidence = { startedAt: new Date().toISOString(), evidence: 'isolated-backend', passed: false, checks: [], receipts: [],
    limitations: ['Editor pointer/keyboard interactions and visual rendering are covered separately by the UI suite.',
      'This authored fixture verifies persistence and version isolation; it does not verify AI generation or teaching quality.',
      'Edited narration invalidates its old audio. The new version is not claimed to have regenerated or playable narration audio.'] };
  const save = () => writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  const recordCheck = (name, status, detail) => { evidence.checks.push({ name, status, detail, evidence: 'isolated-backend' }); record(name, status, detail, 'isolated-backend'); };
  const deadline = Date.now() + 5 * 60_000;
  const api = async (context, method, url, data, expected = 200) => {
    assert.ok(Date.now() < deadline, 'Preparation API acceptance exceeded five minutes');
    const receipt = { method, url, startedAt: new Date().toISOString(), ...(data === undefined ? {} : { request: data }) };
    evidence.receipts.push(receipt);
    try {
      const body = await request(context, method, url, data, expected);
      Object.assign(receipt, { verifiedStatus: expected, response: body, finishedAt: new Date().toISOString() });
      return body;
    } catch (error) { receipt.error = String(error); throw error; }
  };
  const resourceFile = id => {
    assert.match(id, /^[a-zA-Z0-9_-]+$/, 'Unsafe classroom resource identifier');
    return path.join(classroomDataDir, `${id}.json`);
  };
  const sourceFiles = async id => {
    const fileEntry = async file => {
      const bytes = await readFile(file);
      return { path: path.relative(classroomDataDir, file).split(path.sep).join('/'), bytes: bytes.length, sha256: digest(bytes) };
    };
    const files = [await fileEntry(resourceFile(id))];
    const collect = async directory => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await collect(file);
        else if (entry.isFile()) files.push(await fileEntry(file));
        else assert.fail('Unexpected non-file classroom media entry');
      }
    };
    await collect(path.join(classroomDataDir, id));
    return files;
  };
  const instanceEvidence = async id => ({
    instance: await db.classroomInstance.findUniqueOrThrow({ where: { id } }),
    participations: await db.classroomParticipation.findMany({ where: { instanceId: id }, orderBy: { id: 'asc' } }),
    learningEvents: await db.learningEvent.findMany({ where: { classroomInstanceId: id }, orderBy: { id: 'asc' } }),
    domainEvents: await db.domainEvent.findMany({ where: { classroomInstanceId: id }, orderBy: { id: 'asc' } }),
  });
  let currentCheck = checkNames[0];
  try {
    const address = new URL(origin);
    assert.ok(['127.0.0.1', 'localhost'].includes(address.hostname) && ['3197', '3198', '3199'].includes(address.port), 'Only the isolated acceptance origin is allowed');
    assert.ok(classroomDataDir && path.isAbsolute(classroomDataDir), 'Pass the isolated env.CLASSROOM_DATA_DIR');
    assert.ok(students?.length && teacher?.context && template?.id && instance?.id && fixture?.classroom?.id);
    const originalVersion = await db.classroomTemplateVersion.findUniqueOrThrow({ where: { id: instance.templateVersionId } });
    assert.equal(originalVersion.templateId, template.id, 'Main template and instance do not match');
    const originalSnapshot = structuredClone(originalVersion.snapshot);
    const sourceId = originalSnapshot.design.aiLearningClassroomId || originalSnapshot.design.content._openmaicClassroomId;
    assert.equal(sourceId, fixture.classroom.id);
    const originalBytes = await readFile(resourceFile(sourceId));
    const originalResourceHash = digest(originalBytes);
    const originalFiles = await sourceFiles(sourceId);
    const originalVersionHash = digest(originalVersion);

    const separate = await api(teacher.context, 'POST', '/api/platform/templates', {
      title: '备课保存与发布版本隔离验收', snapshot: originalSnapshot,
    }, 201);
    const oldVersion = separate.versions.find(version => version.status.toUpperCase() === 'PUBLISHED');
    assert.ok(oldVersion?.id && separate.id !== template.id);
    const activity = (await api(teacher.context, 'POST', `/api/platform/offerings/${offering.id}/chapters/${chapter.id}/activities`, {
      type: 'Classroom', title: '备课版本隔离独立课堂', templateVersionId: oldVersion.id,
    }, 201)).activity;
    await api(teacher.context, 'PATCH', `/api/platform/activities/${activity.id}`, { isOpen: true });
    const oldInstance = await db.classroomInstance.findFirstOrThrow({ where: { activityId: activity.id, templateVersionId: oldVersion.id } });
    await api(teacher.context, 'POST', `/api/platform/classroom-instances/${oldInstance.id}/start`, {});
    await api(students[0].context, 'POST', `/api/platform/classroom-instances/${oldInstance.id}/enter`, {});
    const oldCourse = (await api(teacher.context, 'GET', `/api/courses/${oldInstance.id}/state`)).course;
    assert.equal(oldCourse.aiLearningClassroomId, sourceId);
    const oldHistory = await instanceEvidence(oldInstance.id);
    assert.ok(oldHistory.participations.length && oldHistory.learningEvents.length, 'The old instance must contain actual saved history');
    evidence.identifiers = { templateId: separate.id, oldVersionId: oldVersion.id, oldInstanceId: oldInstance.id, sourceClassroomId: sourceId };
    evidence.baseline = { originalResourceHash, originalFiles, originalVersionHash, oldVersionHash: digest(oldVersion), oldHistoryHash: digest(oldHistory),
      participations: oldHistory.participations.length, learningEvents: oldHistory.learningEvents.length, domainEvents: oldHistory.domainEvents.length };

    const endpoint = `/api/courses/${separate.id}/classroom-resource`;
    const initial = (await api(teacher.context, 'GET', endpoint)).classroom;
    const first = createPreparationEdit(initial, '首次保存');
    const fork = await api(teacher.context, 'PATCH', endpoint, first.body);
    assert.equal(fork.forkedDraft, true, 'Editing a published classroom must fork a draft');
    assert.notEqual(fork.classroom.id, sourceId);
    assertPreparationEdits(fork.classroom, first.expected);
    const stale = await api(teacher.context, 'PATCH', endpoint, first.body, 409);
    assert.equal(stale.code, 'REVISION_CONFLICT');
    const firstRead = (await api(teacher.context, 'GET', endpoint)).classroom;
    assertPreparationEdits(firstRead, first.expected);
    const second = createPreparationEdit(firstRead, '再次保存');
    const saved = await api(teacher.context, 'PATCH', endpoint, second.body);
    assert.equal(saved.forkedDraft, false);
    assert.equal(saved.classroom.id, fork.classroom.id);
    assert.equal(saved.classroom.revision, firstRead.revision + 1);
    const reread = (await api(teacher.context, 'GET', endpoint)).classroom;
    const features = assertPreparationEdits(reread, second.expected);
    const diskResource = JSON.parse(await readFile(resourceFile(reread.id), 'utf8'));
    assertPreparationEdits(diskResource, second.expected);
    assert.deepEqual(diskResource, reread, 'HTTP readback and persisted classroom file disagree');
    evidence.edits = { features, sceneId: second.expected.sceneId, firstRevision: firstRead.revision, finalRevision: reread.revision,
      draftClassroomId: reread.id, persistedHash: digest(diskResource), revisionConflictCode: stale.code };
    recordCheck(currentCheck, '通过', evidence.edits); await save();

    currentCheck = checkNames[1];
    const draft = await db.classroomTemplateVersion.findFirstOrThrow({ where: { templateId: separate.id }, orderBy: { version: 'desc' } });
    assert.equal(draft.status.toUpperCase(), 'DRAFT');
    assert.equal(draft.snapshot.design.aiLearningClassroomId, reread.id);
    const published = (await api(teacher.context, 'POST', `/api/platform/templates/${separate.id}/versions`, { snapshot: draft.snapshot }, 201)).version;
    assert.equal(published.status.toUpperCase(), 'PUBLISHED');
    assert.ok(published.version > oldVersion.version && published.id !== oldVersion.id);
    const newInstance = (await api(teacher.context, 'POST', `/api/platform/activities/${activity.id}/instance`, { templateVersionId: published.id }, 201)).instance;
    assert.notEqual(newInstance.id, oldInstance.id);
    assert.equal(newInstance.templateVersionId, published.id);
    const newCourse = (await api(teacher.context, 'GET', `/api/courses/${newInstance.id}/state`)).course;
    assert.equal(newCourse.aiLearningClassroomId, reread.id);
    const newResource = (await api(teacher.context, 'GET', `/api/openmaic/classroom?id=${encodeURIComponent(reread.id)}`)).classroom;
    assertPreparationEdits(newResource, second.expected);
    const historicalCourse = (await api(teacher.context, 'GET', `/api/courses/${oldInstance.id}/state`)).course;
    assert.equal(historicalCourse.aiLearningClassroomId, sourceId);
    const historicalResource = (await api(students[0].context, 'GET', `/api/openmaic/classroom?id=${encodeURIComponent(sourceId)}`)).classroom;
    assert.deepEqual(historicalResource.scenes, initial.scenes, 'A student in the old classroom received edited resources');
    assert.deepEqual(JSON.parse(JSON.stringify(await db.classroomTemplateVersion.findUniqueOrThrow({ where: { id: oldVersion.id } }))), oldVersion);
    assert.deepEqual(await instanceEvidence(oldInstance.id), oldHistory, 'Publishing changed existing classroom or saved history');
    assert.equal(digest(await readFile(resourceFile(sourceId))), originalResourceHash, 'Original classroom fixture was mutated');
    const currentFiles = await sourceFiles(sourceId);
    evidence.sourceMedia = { originalFiles, currentFiles, addedWarmupAudio: [] };
    const added = assertPreparationMediaManifest(originalFiles, currentFiles, sourceId);
    // The producer atomically renames validated audio just before committing its
    // database pointer. Wait only for that commit; never ignore altered files.
    const audioCommitDeadline = Math.min(deadline, Date.now() + 5000);
    while (added.length) {
      const explanations = await db.knowledgeExplanation.findMany({ where: { input: { path: ['classroomId'], equals: sourceId } },
        select: { id: true, status: true, input: true, audio: true } });
      try {
        evidence.sourceMedia.addedWarmupAudio = assertPreparationWarmupAudio(added, explanations, sourceId);
        break;
      } catch (error) {
        if (Date.now() >= audioCommitDeadline) throw error;
        await delay(100);
      }
    }
    assert.equal(digest(await db.classroomTemplateVersion.findUniqueOrThrow({ where: { id: originalVersion.id } })), originalVersionHash);
    assert.equal((await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id } })).templateVersionId, originalVersion.id);
    evidence.publication = { version: published.version, versionId: published.id, newInstanceId: newInstance.id,
      oldHistoryUnchanged: true, oldVersionUnchanged: true, mainFixtureUnchanged: true, newClassroomUsesEditedResource: true,
      preservedSourceFiles: originalFiles.length, addedWarmupAudio: evidence.sourceMedia.addedWarmupAudio };
    recordCheck(currentCheck, '通过', evidence.publication); await save();

    currentCheck = checkNames[2];
    const permission = [];
    const beforeDenied = digest(await readFile(resourceFile(reread.id)));
    for (const method of ['GET', 'PATCH']) {
      const response = await students[0].context.request.fetch(`${origin}${endpoint}`, {
        method, headers: { Origin: origin }, ...(method === 'PATCH' ? { data: { ...second.body, classroomId: reread.id, revision: reread.revision } } : {}), timeout: 30_000,
      });
      const body = await response.json().catch(() => ({}));
      const receipt = { method, url: endpoint, status: response.status(), response: body, finishedAt: new Date().toISOString(), actor: 'authenticated-student' };
      evidence.receipts.push(receipt); permission.push({ method, status: receipt.status });
      assert.ok([401, 403].includes(response.status()), `Student ${method} editor resource was not denied: ${response.status()}`);
      assert.equal(body.classroom, undefined, 'Denied editor response leaked classroom contents');
    }
    assert.equal(digest(await readFile(resourceFile(reread.id))), beforeDenied, 'Denied student write changed teacher resources');
    recordCheck(currentCheck, '通过', { permission, authenticatedBySuccessfulClassroomEntry: true, deniedWritePreservedFile: true });
    evidence.passed = true;
  } catch (error) {
    recordCheck(currentCheck, '失败', String(error.stack ?? error));
    for (const name of checkNames) if (!evidence.checks.some(check => check.name === name)) recordCheck(name, '未验证', 'Preparation prerequisite failed; this feature was not executed.');
  } finally {
    evidence.finishedAt = new Date().toISOString();
    await save();
  }
  return evidence;
}
