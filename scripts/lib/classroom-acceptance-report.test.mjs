import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ACCEPTANCE_CHECKS, ACCEPTANCE_BRANDS, parseAcceptanceOptions } from './classroom-acceptance-contract.mjs';
import { writeClassroomAcceptanceReview } from './classroom-acceptance-report.mjs';

test('a missing, duplicated or failed student artifact cannot leave a green final report', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'classroom-final-evidence-'));
  try {
    const runs = ACCEPTANCE_CHECKS.flatMap(check => (['unit', 'classroom'].includes(check) ? [undefined] : ACCEPTANCE_BRANDS)
      .map(brand => ({ check, brand, exitCode: 0, evidence: 'test-fixture', verdict: { outcome: 'passed' },
        reportPath: path.join(directory, check, brand ?? 'all', 'report.json') })));
    for (const run of runs) {
      await mkdir(path.dirname(run.reportPath), { recursive: true });
      await writeFile(run.reportPath, JSON.stringify(run.check === 'unit' ? { testResults: [] }
        : { results: [], ...(run.check === 'classroom' ? { classroomAcceptance: {} } : {}) }));
      if (['ui', 'faults'].includes(run.check)) await writeFile(path.join(path.dirname(run.reportPath), 'playwright.json'), '{"suites":[]}');
    }
    const classroom = runs.find(run => run.check === 'classroom');
    const lessons = [1, 2, 3].map(sequence => ({ sequence, instanceId: `class-${sequence}` }));
    await writeFile(classroom.reportPath, JSON.stringify({ results: [], classroomAcceptance: lessons[2], classroomSoak: { classEvidence: lessons } }));
    for (const lesson of lessons.slice(0, 2)) {
      const directory = path.join(path.dirname(classroom.reportPath), 'soak', `class-${lesson.sequence}`);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'classroom.json'), JSON.stringify(lesson));
    }
    const manifestFile = path.join(path.dirname(classroom.reportPath), 'student-manifest.json');
    const manifest = Array.from({ length: 30 }, (_, index) => ({ index, userId: `user-${index}`,
      participationId: `participation-${index}`, status: '通过', errors: '' }));
    for (const scenario of ['missing', 'valid', 'duplicate', 'failed']) {
      const report = { options: parseAcceptanceOptions(), build: { status: 'passed', buildId: 'fixture' }, identityVerified: true,
        outcome: 'passed', failures: [], limitations: [], runs };
      const rows = structuredClone(manifest);
      if (scenario === 'duplicate') rows[29] = { ...rows[0] };
      if (scenario === 'failed') rows[7].status = '失败';
      if (scenario !== 'missing') await writeFile(manifestFile, JSON.stringify(rows));
      await writeClassroomAcceptanceReview(report, directory);
      const expected = scenario === 'valid' ? 'passed' : scenario === 'missing' ? 'partial' : 'failed';
      assert.equal(report.outcome, expected, scenario);
      assert.equal(JSON.parse(await readFile(path.join(directory, 'defects.json'), 'utf8')).outcome, expected, scenario);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('final review CSV retains individual timeout, original failure and task timestamp evidence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'classroom-review-queue-'));
  try {
    const reportPath = path.join(directory, 'classroom.json');
    await writeFile(reportPath, JSON.stringify({ results: [{ name: 'document-all-student-review-settlement',
      status: '失败', evidence: 'browser-real-backend', detail: 'Student 7 timed out' }], classroomAcceptance: {
      documentReviewSettlement: { budget: { deadlineMs: 300000 }, students: [{ index: 7, userId: 'student-7',
        status: 'failed', error: 'Current text not reviewed', elapsedMs: 300000, initialPendingTasks: 1,
        initialObservedTasks: 1, proof: { declaredReviewedParagraphs: 2, retainedCheckpoints: 1, failed: 1 },
        tasks: [{ requestId: 'original-request', status: 'FAILED', taskTimestampDeltaMs: 180000 }],
        originalAttempts: [{ error: 'AI_PROACTIVE_REVIEW_BUSY', elapsedMs: 9 }],
      }] },
    } }));
    await writeFile(path.join(directory, 'student-manifest.json'), JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
      index, userId: `student-${index}`, participationId: `participation-${index}`, status: '通过', errors: '',
    }))));
    const report = { options: parseAcceptanceOptions(), build: { status: 'passed', buildId: 'fixture' }, identityVerified: true,
      outcome: 'failed', failures: ['Review timeout'], limitations: [], runs: [{ check: 'classroom', reportPath,
        exitCode: 1, verdict: { outcome: 'failed' }, evidence: 'browser-real-backend' }] };
    const result = await writeClassroomAcceptanceReview(report, directory);
    assert.ok(result.artifacts.includes('document-review-settlement.csv'));
    const csv = await readFile(path.join(directory, 'document-review-settlement.csv'), 'utf8');
    for (const text of ['student-7', 'Current text not reviewed', '300000', '180000', 'original-request', 'AI_PROACTIVE_REVIEW_BUSY']) {
      assert.ok(csv.includes(text), text);
    }
    assert.equal(report.outcome, 'failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('all three raw classes reach separate delivery tables without pooling or duplicating the final class', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'classroom-review-three-'));
  try {
    const lessons = [1, 2, 3].map(sequence => ({ sequence, instanceId: `class-${sequence}`,
      metrics: { make: { 'GET /api/owned read': { category: 'read', samples: 30, p95Ms: sequence * 100, failures: 0 } } },
      phaseTiming: [{ stageKey: 'make', actualDurationSeconds: 1800 }],
      documentReviewSettlement: { budget: { deadlineMs: 300000 }, students: [{ index: 0, userId: `student-class-${sequence}`,
        status: sequence === 1 ? 'failed' : 'passed', error: sequence === 1 ? 'Original class 1 failure' : '',
        elapsedMs: 35000, tasks: [{ requestId: `original-class-${sequence}`, status: sequence === 1 ? 'FAILED' : 'COMPLETED' }] }] },
    }));
    const reportPath = path.join(directory, 'report.json');
    await writeFile(reportPath, JSON.stringify({ results: [], classroomAcceptance: lessons[2], classroomSoak: { classEvidence: lessons } }));
    for (const lesson of lessons.slice(0, 2)) {
      const folder = path.join(directory, 'soak', `class-${lesson.sequence}`); await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, 'classroom.json'), JSON.stringify(lesson));
    }
    await writeFile(path.join(directory, 'student-manifest.json'), JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
      index, userId: `student-${index}`, participationId: `participation-${index}`, status: '通过', errors: '',
    }))));
    const fresh = () => ({ options: parseAcceptanceOptions(), build: { status: 'passed', buildId: 'fixture' }, identityVerified: true,
      failures: ['Preserved first-class failure'], limitations: [], runs: [{ check: 'classroom', reportPath, exitCode: 1,
        verdict: { outcome: 'failed' }, evidence: 'browser-real-backend' }] });
    await writeClassroomAcceptanceReview(fresh(), directory);
    const performance = await readFile(path.join(directory, 'performance.csv'), 'utf8');
    assert.equal(performance.trim().split('\n').length, 4);
    for (const [sequence, p95] of [[1, 100], [2, 200], [3, 300]]) {
      assert.ok(performance.includes(`"${sequence}","class-${sequence}"`)); assert.ok(performance.includes(`"${p95}"`));
    }
    const phases = JSON.parse(await readFile(path.join(directory, 'phases.json'), 'utf8'));
    assert.deepEqual(phases.map(row => row.sequence), [1, 2, 3]);
    const settlement = await readFile(path.join(directory, 'document-review-settlement.csv'), 'utf8');
    assert.equal(settlement.trim().split('\n').length, 4);
    for (const sequence of [1, 2, 3]) assert.ok(settlement.includes(`student-class-${sequence}`));
    assert.ok(settlement.includes('Original class 1 failure'));
    // A summary may not replace a different classroom identity or its clocks,
    // including the final class that is also embedded in the main report.
    for (const sequence of [1, 3]) for (const field of ['runId', 'startedAt', 'finishedAt', 'teachers', 'students', 'browserCounts']) {
      const summaries = structuredClone(lessons);
      summaries[sequence - 1][field] = field === 'browserCounts' ? { 'google-chrome': 1 } : 'different';
      await writeFile(reportPath, JSON.stringify({ results: [], classroomAcceptance: lessons[2], classroomSoak: { classEvidence: summaries } }));
      const current = fresh(); await writeClassroomAcceptanceReview(current, directory);
      assert.ok(current.evidenceValidation.failures.some(message => message.includes(`class ${sequence}, ${field}`)), `${sequence}: ${field}`);
    }
    lessons[0].metrics.make['GET /api/owned read'].p95Ms = 1;
    await writeFile(reportPath, JSON.stringify({ results: [], classroomAcceptance: lessons[2], classroomSoak: { classEvidence: lessons } }));
    const mismatch = fresh(); await writeClassroomAcceptanceReview(mismatch, directory);
    assert.ok(mismatch.evidenceValidation.failures.some(message => message.includes('class 1, metrics')));
    await rm(path.join(directory, 'soak/class-2/classroom.json'));
    const missing = fresh(); await writeClassroomAcceptanceReview(missing, directory);
    assert.ok(missing.evidenceValidation.missing.some(message => message.includes('class 2')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
