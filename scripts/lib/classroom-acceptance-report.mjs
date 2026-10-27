import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { evaluateAcceptance, evaluateStudentManifest } from './classroom-acceptance-contract.mjs';

const passed = status => ['通过', 'passed'].includes(status);
const failed = status => ['失败', 'failed', '未通过'].includes(status);
const detail = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const csv = (columns, rows) => '\uFEFF' + [columns, ...rows.map(row => columns.map(column => row[column] ?? ''))]
  .map(values => values.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const CLASS_EVIDENCE_FIELDS = ['schemaVersion', 'runId', 'instanceId', 'teachers', 'students', 'browserCounts',
  'startedAt', 'finishedAt', 'actualDurationSeconds', 'metrics', 'phaseTiming', 'documentReviewSettlement',
  'checks', 'continuitySnapshots', 'processSamples', 'quietWindow', 'runtimeConfiguration'];

/** Review artifacts are derived from this run's raw evidence, never prior reports. */
export async function writeClassroomAcceptanceReview(report, output) {
  const functions = []; const performance = []; const students = []; const phases = []; const reviews = []; const missing = [];
  const evidenceValidation = { failures: [], missing: [] };
  const verdictDiagnostics = report.failures.map(message => ({ scope: 'acceptance', detail: message }));
  const defects = [];
  missing.push(...(report.missing ?? []).map(message => ({ scope: 'acceptance', detail: message })));
  const add = row => {
    functions.push(row);
    if (failed(row.status)) defects.push(row);
    else if (!passed(row.status)) missing.push(row);
  };
  for (const run of report.runs) {
    const scope = run.check; const browser = run.brand ?? 'mixed';
    try {
      const raw = await read(run.reportPath);
      if (scope === 'unit') {
        for (const file of raw.testResults ?? []) for (const test of file.assertionResults ?? []) add({ scope, browser: '',
          feature: test.fullName ?? test.title, status: test.status, evidence: run.evidence,
          detail: detail(test.failureMessages), source: run.reportPath });
      } else {
        for (const row of raw.results ?? []) add({ scope, browser, feature: row.name, status: row.status,
          evidence: row.evidence ?? run.evidence, detail: detail(row.detail), source: run.reportPath });
        if (['ui', 'faults'].includes(scope)) {
          const ui = await read(path.join(path.dirname(run.reportPath), 'playwright.json'));
          const visit = suites => { for (const suite of suites ?? []) {
            for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) add({ scope, browser,
              feature: `${spec.file ?? suite.file}: ${spec.title}`, status: test.status === 'expected' && test.expectedStatus === 'passed'
                && test.results?.length === 1 && test.results[0].status === 'passed' ? '通过' : test.status === 'skipped' ? '未验证' : '失败',
              evidence: run.evidence, detail: detail(test.results?.flatMap(attempt => attempt.errors ?? [])), source: path.join(path.dirname(run.reportPath), 'playwright.json') });
            visit(suite.suites);
          } };
          visit(ui.suites);
        }
        if (raw.classroomAcceptance) {
          // Each class keeps its own statistics. Never pool three P95s or
          // duplicate the final class already present in classroomAcceptance.
          const finalSequence = report.options.soakClasses ?? 1;
          const lessonEvidence = new Map();
          for (const lesson of raw.classroomSoak?.classEvidence ?? []) {
            if (!Number.isInteger(lesson.sequence) || lesson.sequence < 1 || lesson.sequence > finalSequence
              || lessonEvidence.has(lesson.sequence)) {
              evidenceValidation.failures.push('Invalid or duplicate per-class delivery identity');
              continue;
            }
            lessonEvidence.set(lesson.sequence, lesson);
          }
          const summarizedFinal = lessonEvidence.get(finalSequence);
          if (finalSequence === 3 && !summarizedFinal) evidenceValidation.missing.push('Final class summary is missing');
          if (summarizedFinal) for (const field of CLASS_EVIDENCE_FIELDS) {
            if (!isDeepStrictEqual(summarizedFinal[field], raw.classroomAcceptance[field])) evidenceValidation.failures.push(`Per-class raw evidence differs: class ${finalSequence}, ${field}`);
          }
          lessonEvidence.set(finalSequence, raw.classroomAcceptance);
          if (finalSequence === 3 && lessonEvidence.size !== 3) evidenceValidation.missing.push('Per-class performance/phase/settlement delivery evidence is incomplete');
          for (const [sequence, lesson] of [...lessonEvidence].sort(([a], [b]) => a - b)) {
            const source = sequence === finalSequence ? run.reportPath
              : path.join(path.dirname(run.reportPath), 'soak', `class-${sequence}`, 'classroom.json');
            let measured = lesson;
            if (sequence !== finalSequence) {
              try {
                measured = await read(source);
                for (const field of CLASS_EVIDENCE_FIELDS) {
                  if (!isDeepStrictEqual(measured[field], lesson[field])) evidenceValidation.failures.push(`Per-class raw evidence differs: class ${sequence}, ${field}`);
                }
              } catch (error) { evidenceValidation.missing.push(`Per-class raw evidence unavailable: class ${sequence}: ${error.message}`); }
            }
            const scope = { sequence, classroomId: measured.instanceId ?? '', source };
            for (const [stage, operations] of Object.entries(measured.metrics ?? {})) {
              for (const [operation, metric] of Object.entries(operations)) performance.push({ ...scope, stage, operation, ...metric });
            }
            phases.push(...(measured.phaseTiming ?? []).map(phase => ({ ...scope, ...phase })));
            const settlement = measured.documentReviewSettlement;
            for (const student of settlement?.students ?? []) reviews.push({ ...scope,
              index: student.index, userId: student.userId, status: student.status, error: student.error,
              elapsedMs: student.elapsedMs, settledElapsedMs: student.settledElapsedMs,
              settlementElapsedMs: settlement.settlementElapsedMs, deadlineMs: settlement.budget?.deadlineMs,
              initialPendingTasks: student.initialPendingTasks, initialObservedTasks: student.initialObservedTasks,
              ...student.proof, taskEvidence: JSON.stringify(student.tasks ?? []),
              originalAttempts: JSON.stringify(student.originalAttempts ?? []),
            });
          }
          try {
            const manifest = await read(path.join(path.dirname(run.reportPath), 'student-manifest.json'));
            const verdict = evaluateStudentManifest(manifest, { students: report.options.students });
            evidenceValidation.failures.push(...verdict.failures);
            evidenceValidation.missing.push(...verdict.missing);
            if (Array.isArray(manifest)) students.push(...manifest);
          } catch (error) { evidenceValidation.missing.push(`Student reconciliation manifest unavailable: ${error.message}`); }
        }
      }
      for (const message of run.verdict?.missing ?? []) missing.push({ scope, browser, detail: message });
      for (const message of run.verdict?.failures ?? []) verdictDiagnostics.push({ scope, browser, status: '失败', detail: message });
    } catch (error) { evidenceValidation.missing.push(`Raw report unavailable (${scope}/${browser}): ${error.message}`); }
  }
  // A successful child check cannot substitute for a missing delivery artifact.
  report.evidenceValidation = evidenceValidation;
  Object.assign(report, evaluateAcceptance(report));
  missing.push(...evidenceValidation.missing.map(message => ({ scope: 'final-evidence', detail: message })));
  verdictDiagnostics.push(...evidenceValidation.failures.map(message => ({ scope: 'final-evidence', status: '失败', detail: message })));
  missing.push(...report.limitations.map(message => ({ scope: '验收范围', detail: message })));
  const write = (name, value) => writeFile(path.join(output, name), value, { mode: 0o600 });
  await write('functions.csv', csv(['scope', 'browser', 'feature', 'status', 'evidence', 'detail', 'source'], functions));
  await write('performance.csv', csv(['sequence', 'classroomId', 'source', 'stage', 'operation', 'category', 'samples', 'p95Ms', 'observerP95Ms', 'unmeasured', 'failures', 'firstAttemptFailures', 'recoveredConflicts', 'cancellations', 'expectedBoundaryResponses'], performance));
  await write('students.csv', csv(['index', 'status', 'errors', 'userId', 'participationId', 'pretestId', 'pretestAnswers', 'posttestId', 'posttestAnswers',
    'quizAttemptId', 'expectedQuizScore', 'quizScore', 'teacherQuizScore', 'quizFullScore', 'submissionId', 'documentStatus',
    'artifactSha256', 'retainedProcessEvents', 'privateChatRequestId', 'personalTutorStatus', 'personalTutorAudioStatus', 'personalTutorAudioSha256',
    'documentAiRequestId', 'documentAiStatus', 'aiTasks', 'completedAiTasks', 'failedAiTasks'], students));
  await write('defects.json', JSON.stringify({ outcome: report.outcome, countMeaning: 'Failed checks, not independent root causes; verdict diagnostics do not duplicate defects',
    defects, verdictDiagnostics, unverified: missing }, null, 2));
  await write('document-review-settlement.csv', csv(['sequence', 'classroomId', 'index', 'userId', 'status', 'error', 'elapsedMs', 'settledElapsedMs', 'settlementElapsedMs', 'deadlineMs',
    'initialPendingTasks', 'initialObservedTasks', 'declaredReviewedParagraphs', 'retainedCheckpoints', 'completed', 'failed', 'running', 'cancelled',
    'taskEvidence', 'originalAttempts', 'source'], reviews));
  await write('phases.json', JSON.stringify(phases, null, 2));
  return { functions: functions.length, defects: defects.length, unverified: missing.length, students: students.length,
    artifacts: ['functions.csv', 'performance.csv', 'students.csv', 'defects.json', 'phases.json', 'document-review-settlement.csv'] };
}
