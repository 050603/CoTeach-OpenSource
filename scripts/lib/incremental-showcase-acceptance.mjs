import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { PDFDocument, rgb } from 'pdf-lib';
import { JSDOM } from 'jsdom';

const hash = value => createHash('sha256').update(value).digest('hex');
const plain = html => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, '');

/** DOCX splits text across runs; native offline edits can append a new final paragraph. */
export function assertIncrementalArchiveText(sourceHtml, documentXml) {
  const source = new JSDOM(sourceHtml);
  const target = new JSDOM(documentXml, { contentType: 'text/xml' });
  try {
    source.window.document.querySelectorAll('script,style').forEach(node => node.remove());
    const normalize = text => text.replace(/[\s\u200B-\u200D\uFEFF]+/gu, '');
    const expected = normalize(source.window.document.body.textContent ?? '');
    const actual = normalize([...target.window.document.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't')]
      .map(node => node.textContent).join(''));
    assert.ok(expected.length, 'A blank source cannot establish archive fidelity');
    assert.ok(actual.includes(expected), 'Word lost or reordered saved visible content');
    return { sourceTextSha256: hash(expected), archivedTextSha256: hash(actual), sourceCharacters: expected.length };
  } finally { source.window.close(); target.window.close(); }
}

/** A current candidate needs evidence from that exact submitted version. */
export function assertIncrementalRecommendation({ candidate, versionId, sourceHtml, prepared, analysis }) {
  assert.ok(candidate, 'Representative missing from recommendations');
  assert.equal(candidate.artifactVersionId, versionId, 'Recommendation targets an obsolete submitted version');
  assert.equal(candidate.artifactKind, 'document');
  assert.equal(candidate.analysisStatus, 'complete', `Quality analysis is ${candidate.analysisStatus}`);
  assert.equal(candidate.analyzedArtifactVersionId, versionId, 'Old analysis replaced the significant revision');
  assert.equal(candidate.analysisFreshness, 'exact');
  assert.ok(Number.isFinite(candidate.qualityScore) && candidate.qualityScore >= 0 && candidate.qualityScore <= 100);
  assert.equal(prepared.artifactVersionId, versionId);
  assert.equal(analysis.status, 'COMPLETED');
  assert.ok(Number.isInteger(analysis.attemptCount) && analysis.attemptCount > 0, 'No reserved provider request');
  assert.ok(Array.isArray(analysis.input.requests) && analysis.input.requests.length > 0, 'Missing provider request evidence');
  assert.equal(analysis.input.artifactVersionId, versionId);
  assert.equal(analysis.input.snapshot.fingerprint, prepared.snapshot.fingerprint);
  assert.ok(candidate.coverage && ['full', 'sampled'].includes(candidate.coverage.mode));
  const quality = candidate.reasons.filter(reason => reason.kind === 'quality');
  assert.ok(quality.length, 'Completed analysis has no valid quality reasons');
  for (const reason of candidate.reasons) {
    assert.ok(['quality', 'earliest', 'latest', 'ai-interactions'].includes(reason.kind));
    assert.ok(typeof reason.text === 'string' && reason.text.trim());
  }
  for (const reason of quality) {
    assert.ok(typeof reason.quote === 'string' && reason.quote.trim().length >= 4);
    const block = prepared.snapshot.blocks.find(row => row.location === reason.location);
    assert.ok(block && block.text.includes(reason.quote), 'Quality citation does not match its located block');
    assert.ok(plain(sourceHtml).includes(reason.quote.replace(/\s+/g, '')), 'Quality quote is absent from the submitted source');
  }
  return { artifactVersionId: versionId, analysisTaskId: analysis.id, qualityScore: candidate.qualityScore,
    snapshotFingerprint: prepared.snapshot.fingerprint, reasons: candidate.reasons, coverage: candidate.coverage };
}

/** An absent facts cache represents zero; scoped audit evidence is checked separately. */
export function assertIncrementalRecommendationFactsCount(candidate, studentId, facts) {
  assert.equal(candidate.aiRequestCount, facts?.output?.counts?.[studentId] ?? 0,
    'Recommendation AI count differs from the scoped facts cache');
}

async function renderedPdf(page, pageNumber, projection = false) {
  const container = projection ? page.getByTestId('student-showcase-projection') : page.getByTestId('large-artifact-preview');
  const canvas = container.locator(`canvas[aria-label="PDF 第 ${pageNumber} 页"]`);
  await expect(canvas).toBeVisible({ timeout: 45000 });
  await expect.poll(() => canvas.evaluate(element => {
    if (element.width < 10 || element.height < 10) return false;
    const context = element.getContext('2d');
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 64) if (pixels[i + 3] && (pixels[i] < 230 || pixels[i + 1] < 230 || pixels[i + 2] < 230)) colored++;
    return colored > 20;
  }), { timeout: 45000 }).toBe(true);
}

/** Uses the real API, configured recommendation workers and native browser viewers. */
export async function runIncrementalShowcaseAcceptance({ teachers, students, instance, db, origin, output, send, state, action, record, options }) {
  assert.equal(teachers.length, 2);
  assert.ok(options, 'The caller must supply its incremental profile');
  const viewersOnly = process.env.INCREMENTAL_VIEWERS_ONLY === '1';
  assert.ok(!viewersOnly || options.smoke, 'A viewer-only diagnostic cannot satisfy the formal mixed profile');
  const representatives = ['google-chrome', 'microsoft-edge'].map(brand => {
    const student = students.find(row => row.label === brand);
    assert.ok(student?.archived?.versionId && student.page && student.submission, `Missing archived ${brand} representative`);
    return student;
  });
  const route = `/api/courses/${instance.id}/showcase/presentation`;
  const recommendationRoute = `/api/courses/${instance.id}/showcase/recommendations`;
  const directory = path.join(output, 'incremental-showcase');
  await mkdir(directory, { recursive: true });
  const evidence = { startedAt: new Date().toISOString(), courseId: instance.id, status: 'running',
    representativeIds: representatives.map(student => ({ studentId: student.user.id, brand: student.label })),
    recommendations: [], revisions: [], previews: [], controls: [], stageTransitions: [],
    viewersOnly, providerPolicy: viewersOnly ? 'Recommendation quality not claimed by this viewer diagnostic'
      : 'Actual configured provider; 300-second recommendation polling budget; no synthetic quality result' };
  const save = () => writeFile(path.join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  const setStage = async index => {
    const ack = await action(teachers[0], { type: 'SET_STAGE', payload: { id: instance.id, index } });
    assert.equal((await state()).course.currentStageIndex, index);
    evidence.stageTransitions.push({ index, ack, at: new Date().toISOString() });
    await save();
  };
  const recommendations = async label => {
    const observation = { label, startedAt: new Date().toISOString(), polls: [], completed: [] };
    evidence.recommendations.push(observation);
    observation.compatibilityPost = await send(teachers[0], 'POST', recommendationRoute, {});
    const end = Date.now() + 300000;
    while (Date.now() < end) {
      const response = await send(teachers[0], 'GET', recommendationRoute);
      const candidates = representatives.map(student => response.candidates.find(row => row.studentId === student.user.id));
      observation.polls.push({ at: new Date().toISOString(), revision: response.revision,
        pendingCount: response.pendingCount, candidates });
      await save();
      for (const candidate of candidates) assert.ok(!['failed', 'unreadable'].includes(candidate?.analysisStatus),
        `Real quality analysis failed: ${JSON.stringify(candidate)}`);
      if (candidates.every((candidate, index) => candidate?.analysisStatus === 'complete'
        && candidate.artifactVersionId === representatives[index].archived.versionId
        && candidate.analyzedArtifactVersionId === candidate.artifactVersionId && candidate.analysisFreshness === 'exact')) {
        for (let index = 0; index < representatives.length; index++) {
          const student = representatives[index], candidate = candidates[index];
          const preparedTask = await db.aiTask.findFirstOrThrow({ where: { createdById: student.user.id,
            taskType: 'SHOWCASE_RECOMMENDATION_PREPARATION', input: { path: ['courseId'], equals: instance.id } } });
          const prepared = preparedTask.output;
          const analysis = await db.aiTask.findUniqueOrThrow({ where: { id: prepared.taskId } });
          const version = await db.artifactVersion.findFirstOrThrow({ where: { id: student.archived.versionId,
            artifact: { participationId: student.participation.id } } });
          // Word archiving sanitizes markup; compare complete visible facts and
          // keep the actual archived HTML as the browser/API source of truth.
          assert.equal(plain(version.sourceHtml), plain(student.submission.content), 'Analysis source differs from confirmed student document');
          student.incrementalShowcaseSourceHtml = version.sourceHtml;
          const proof = assertIncrementalRecommendation({ candidate, versionId: version.id, sourceHtml: version.sourceHtml, prepared, analysis });
          const factsId = `showcase-facts:${hash(JSON.stringify(instance.id))}`;
          const facts = await db.aiTask.findUnique({ where: { id: factsId } });
          assertIncrementalRecommendationFactsCount(candidate, student.user.id, facts);
          const auditRequests = await db.aiInteractionEvent.findMany({ where: { participationId: student.participation.id,
            eventType: 'request', actor: 'student' }, select: { id: true, requestId: true, payload: true } });
          const actualRequests = new Set(auditRequests.filter(row => row.payload?.legacy?.stageKey === 'make'
            && row.payload.legacy.source !== 'system').map(row => row.requestId ?? `event:${row.id}`));
          assert.equal(candidate.aiRequestCount, actualRequests.size, 'Recommendation AI count differs from unique scoped request facts');
          const first = await db.artifactVersion.findFirstOrThrow({ where: { status: 'SUBMITTED', artifact: {
            type: { in: ['DOCUMENT_ARCHIVE', 'PDF_ARCHIVE'] }, participationId: student.participation.id } }, orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }] });
          assert.equal(candidate.firstSubmittedAt, (first.submittedAt ?? first.createdAt).toISOString());
          observation.completed.push({ studentId: student.user.id, brand: student.label, ...proof,
            firstSubmittedAt: candidate.firstSubmittedAt, aiRequestCount: candidate.aiRequestCount, sourceSha256: hash(version.sourceHtml),
            analysisRequestAttempts: analysis.attemptCount, requestTimes: analysis.input.requests, completedAt: analysis.completedAt });
        }
        observation.finishedAt = new Date().toISOString(); await save(); return observation;
      }
      await delay(2000);
    }
    throw new Error(`Real recommendation did not finish for both representatives within 300 seconds (${label})`);
  };
  const getPresentation = async actor => (await send(actor, 'GET', route)).activePresentation;
  const expectEnded = async presentationId => {
    assert.equal((await db.showcasePresentation.findUniqueOrThrow({ where: { id: presentationId } })).status, 'ENDED');
    for (const student of representatives) await expect(student.page.getByTestId('student-showcase-projection')).toHaveCount(0, { timeout: 30000 });
  };
  try {
    assert.equal((await state()).course.stages[(await state()).course.currentStageIndex].key, 'make');
    if (!viewersOnly) {
    // Recommendation reads are intentionally fenced to the showcase stage.
    await setStage(3);
    await recommendations('original-documents');
    await setStage(2);
    for (const student of representatives) {
      // Finalization advances the draft revision as well as creating an
      // artifact version. Resume the acknowledged database revision.
      const priorDraft = await db.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: {
        participationId: student.participation.id, stageKey: 'make:document' } } });
      const confirmed = priorDraft.payload.view ?? priorDraft.payload;
      assert.equal(confirmed.version, student.archived.submissionVersion);
      student.version = confirmed.version; student.submission = confirmed;
      const previousVersionId = student.archived.versionId;
      const marker = `INC_REVISED_${student.label}_${randomUUID()}`;
      const content = `${student.submission.content}<h2>复核后的补充证据 ${student.index + 101}</h2><p>${marker}</p>`
        + `<p>${'补充比较方法：两个地点分别固定观察十分钟，记录观察日期、地点、天气、原始计数和复核者。独立记录不能混同为同一条样本；异常值保留并注明原因。'.repeat(8)}</p>`
        + '<table><tbody><tr><th>复核项目</th><th>边界</th></tr><tr><td>观察时长</td><td>十分钟</td></tr></tbody></table>';
      const submission = { ...student.submission, content, version: student.version + 1, updatedAt: new Date().toISOString() };
      const requestId = randomUUID();
      const ack = await action(student, { type: 'UPSERT_SUBMISSION', payload: { courseId: instance.id,
        expectedSubmissionVersion: student.version, submission } }, requestId);
      assert.equal(ack.requestId, requestId); assert.equal(ack.submissionVersion, student.version + 1);
      const row = await db.classroomSubmission.findUniqueOrThrow({ where: { participationId_stageKey: {
        participationId: student.participation.id, stageKey: 'make:document' } } });
      const current = row.payload.view ?? row.payload;
      assert.equal(current.content, content); assert.equal(current.version, ack.submissionVersion);
      student.version = ack.submissionVersion; student.submission = { ...submission, version: student.version };
      student.archived = await send(student, 'POST', '/api/project-practice/submissions/finalize', {
        requestId: randomUUID(), courseId: instance.id, studentId: student.user.id, submissionId: submission.id,
        stageKey: 'make', expectedVersion: student.version });
      assert.notEqual(student.archived.versionId, previousVersionId);
      assert.equal(student.archived.submissionVersion, student.version + 1);
      student.version = student.archived.submissionVersion;
      student.submission = { ...student.submission, version: student.version, status: 'submitted', submittedAt: student.archived.submittedAt };
      student.incrementalShowcaseMarker = marker;
      evidence.revisions.push({ studentId: student.user.id, brand: student.label, previousVersionId,
        versionId: student.archived.versionId, requestId, ack, marker, sourceSha256: hash(content), archived: student.archived });
      await save();
    }
    await setStage(3);
    await recommendations('significantly-revised-documents');
    const prior = evidence.recommendations[0].completed, revised = evidence.recommendations[1].completed;
    for (let index = 0; index < prior.length; index++) {
      assert.notEqual(prior[index].snapshotFingerprint, revised[index].snapshotFingerprint);
      assert.notEqual(prior[index].analysisTaskId, revised[index].analysisTaskId);
    }
    // Let subsequent real reads verify that no old completion replaces the accepted revision.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await send(teachers[0], 'GET', recommendationRoute);
      for (const student of representatives) {
        const candidate = current.candidates.find(row => row.studentId === student.user.id);
        assert.equal(candidate?.artifactVersionId, student.archived.versionId);
        assert.equal(candidate?.analyzedArtifactVersionId, student.archived.versionId);
      }
      await delay(1000);
    }
    } else {
      await setStage(3);
      for (const student of representatives) {
        const version = await db.artifactVersion.findUniqueOrThrow({ where: { id: student.archived.versionId } });
        student.incrementalShowcaseSourceHtml = version.sourceHtml;
        const document = new JSDOM(version.sourceHtml);
        try { student.incrementalShowcaseMarker = document.window.document.querySelector('h1')?.textContent; }
        finally { document.window.close(); }
        assert.ok(student.incrementalShowcaseMarker);
      }
    }
    const selectedIds = representatives.map(student => student.user.id);
    await send(teachers[0], 'POST', route, { action: 'save-queue', orderedStudentIds: selectedIds,
      minutesPerStudent: 2, selectionMode: 'teacher-selected', selectedStudentIds: selectedIds, presenterCount: 2,
      presentationSec: 60, discussionSec: 30, transitionSec: 15 });
    const roster = await send(teachers[0], 'GET', route);
    assert.deepEqual(roster.queue.map(row => row.studentId), selectedIds);
    for (const student of representatives) {
      await student.page.goto(`${origin}/student/classroom/${instance.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await expect(student.page.locator('[aria-label="最终文档预览"]')).toContainText(student.incrementalShowcaseMarker, { timeout: 45000 });
      const response = await send(student, 'GET', `/api/courses/${instance.id}/showcase/artifacts/${student.archived.versionId}`);
      assert.equal(response.html, student.incrementalShowcaseSourceHtml);
      const screenshot = `${student.label}-document-preview.png`;
      await student.page.screenshot({ path: path.join(directory, screenshot) });
      evidence.previews.push({ brand: student.label, kind: 'document', versionId: student.archived.versionId, screenshot,
        originalSourceSha256: hash(response.html), browserRenderedMarker: student.incrementalShowcaseMarker });
    }
    const first = representatives[0], firstQueue = roster.queue.find(row => row.studentId === first.user.id);
    assert.ok(firstQueue.groupId, 'Presenter requires an actual group member');
    await send(teachers[0], 'POST', route, { action: 'assign', groupId: firstQueue.groupId, studentId: first.user.id });
    await send(teachers[0], 'POST', route, { action: 'start', studentId: first.user.id, artifactKind: 'document',
      artifactVersionId: first.archived.versionId, displayMode: 'continuous', clientId: 'incremental-teacher-0', takeover: true });
    const active = await getPresentation(teachers[0]); assert.equal(active.artifactVersionId, first.archived.versionId);
    for (const student of representatives) await expect(student.page.getByTestId('student-showcase-projection'))
      .toContainText(first.incrementalShowcaseMarker, { timeout: 45000 });
    await send(teachers[1], 'POST', route, { action: 'take-control', presentationId: active.id, clientId: 'incremental-teacher-1' });
    const taken = await getPresentation(teachers[1]);
    assert.equal(taken.controllerClientId, 'incremental-teacher-1'); assert.ok(taken.controlEpoch > active.controlEpoch);
    const oldPatch = { presentationId: active.id, clientId: 'incremental-teacher-0', controlEpoch: active.controlEpoch,
      sequence: 1, viewState: { scrollRatio: .5 } };
    const rejected = await send(teachers[0], 'PATCH', route, oldPatch, 409);
    await send(teachers[1], 'PATCH', route, { ...oldPatch, clientId: 'incremental-teacher-1', controlEpoch: taken.controlEpoch });
    assert.equal((await getPresentation(teachers[1])).viewState.scrollRatio, .5);
    evidence.controls.push({ presentationId: active.id, before: active, afterTakeover: taken, rejectedOldPatch: rejected });
    const ended = await send(teachers[1], 'POST', route, { action: 'end', presentationId: active.id });
    assert.equal(ended.status, 'ended'); await expectEnded(active.id);

    const pdf = await PDFDocument.create();
    for (let index = 0; index < 2; index++) {
      const sheet = pdf.addPage([960, 540]);
      sheet.drawRectangle({ x: 30, y: 30, width: 900, height: 480, color: index ? rgb(.85, .95, .85) : rgb(.85, .9, 1) });
      sheet.drawText(`INCREMENTAL SHOWCASE PAGE ${index + 1}`, { x: 70, y: 400, size: 32 });
    }
    const bytes = Buffer.from(await pdf.save()), second = representatives[1];
    await writeFile(path.join(directory, 'uploaded-evidence.pdf'), bytes, { mode: 0o600 });
    evidence.pdfUploadInput = { file: 'uploaded-evidence.pdf', sha256: hash(bytes), bytes: bytes.length };
    await save();
    const uploadResponse = await second.context.request.post(`${origin}/api/courses/${instance.id}/showcase/artifacts/pdf`, {
      headers: { Origin: origin, 'X-OpenPBL-Role': 'student' }, multipart: { requestId: randomUUID(),
        title: 'Incremental two-page evidence.pdf', file: { name: 'incremental-evidence.pdf', mimeType: 'application/pdf', buffer: bytes } }, timeout: 30000 });
    const uploaded = await uploadResponse.json(); assert.equal(uploadResponse.status(), 201, JSON.stringify(uploaded));
    assert.ok(uploaded.versionId);
    const download = await second.context.request.get(`${origin}/api/courses/${instance.id}/showcase/artifacts/${uploaded.versionId}`);
    assert.equal(download.status(), 200); assert.equal(hash(await download.body()), hash(bytes));
    await second.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await second.page.getByRole('button', { name: '选择主汇报资料', exact: true }).click();
    await second.page.getByRole('option').filter({ hasText: 'Incremental two-page evidence.pdf' }).click();
    await second.page.getByRole('button', { name: '逐页演示', exact: true }).click();
    await renderedPdf(second.page, 1);
    await second.page.getByRole('button', { name: '下一页', exact: true }).click();
    await renderedPdf(second.page, 2);
    await second.page.screenshot({ path: path.join(directory, 'edge-pdf-personal-page-2.png') });
    const queue = (await send(teachers[0], 'GET', route)).queue.find(row => row.studentId === second.user.id);
    assert.ok(queue?.groupId);
    await send(teachers[0], 'POST', route, { action: 'assign', groupId: queue.groupId, studentId: second.user.id });
    await send(teachers[0], 'POST', route, { action: 'start', studentId: second.user.id, artifactKind: 'pdf', artifactVersionId: uploaded.versionId,
      displayMode: 'slides', clientId: 'incremental-teacher-0', takeover: true });
    const pdfActive = await getPresentation(teachers[0]);
    for (const student of representatives) await renderedPdf(student.page, 1, true);
    await send(teachers[0], 'PATCH', route, { presentationId: pdfActive.id, clientId: 'incremental-teacher-0',
      controlEpoch: pdfActive.controlEpoch, sequence: 1, viewState: { page: 2 } });
    for (const student of representatives) {
      await renderedPdf(student.page, 2, true);
      await student.page.screenshot({ path: path.join(directory, `${student.label}-pdf-follow-page-2.png`) });
    }
    evidence.previews.push({ brand: second.label, kind: 'pdf', versionId: uploaded.versionId, sha256: hash(bytes),
      uploaded, renderedPages: [1, 2], followerBrands: representatives.map(student => student.label), presentationId: pdfActive.id });
    await setStage(2);
    await expectEnded(pdfActive.id);
    const stale = await send(teachers[0], 'PATCH', route, { presentationId: pdfActive.id, clientId: 'incremental-teacher-0',
      controlEpoch: pdfActive.controlEpoch, sequence: 2, viewState: { page: 1 } }, 409);
    evidence.controls.push({ presentationId: pdfActive.id, phaseChangeEnded: true, stalePatchRejected: stale });
    evidence.status = 'passed';
    record(viewersOnly ? 'incremental-showcase-viewers-only' : 'incremental-showcase-recommendations-and-viewers', '通过', { representatives: 2,
      recommendationVersions: viewersOnly ? 0 : 4, documentBrowserBrands: 2, pdfBrowserBrands: 2, phaseChangeEnded: true }, 'browser-real-backend');
    return { representatives: 2, recommendationVersions: viewersOnly ? 0 : 4, oldControllerRejected: true, stageChangeEndedPresentation: true,
      documentPreviews: 2, pdfPages: 2, actualProviderRecommendations: !viewersOnly, evidence: path.join(directory, 'evidence.json') };
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error.stack ?? error).slice(0, 6000); throw error;
  } finally { evidence.finishedAt = new Date().toISOString(); await save(); }
}
