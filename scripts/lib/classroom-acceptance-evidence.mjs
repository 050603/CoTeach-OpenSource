// Shared classroom evidence rules for the final child contract and every
// sustained lesson. No network or filesystem access; missing data stays unknown.
const pass = status => status === '通过' || status === 'passed';
const fail = status => ['失败', '未通过', 'failed'].includes(status);

export const CLASSROOM_STAGES = Object.freeze(['launch', 'ai-learning', 'make', 'showcase', 'reflection']);
// Supplementary artifact reads/writes share the normal latency/error gates,
// but never extend the five-stage duration or continuity measurement.
export const CLASSROOM_PERFORMANCE_PHASES = Object.freeze([...CLASSROOM_STAGES, 'artifact-modes']);
export const CLASSROOM_PHASE_MINUTES = Object.freeze([8, 22, 30, 10, 20]);
// Each mandatory function retains its own evidence type. A fixture label cannot
// replace real media/provider evidence, and aggregate labels cannot replace work.
export const CLASSROOM_REQUIRED_EVIDENCE = Object.freeze({
  ...Object.fromEntries([
    'roster', 'five-stage-flow', 'teacher-metrics', 'process-data-reconciliation',
    'artifact-reconciliation', 'artifact-modes', 'artifact-mode-python', 'artifact-mode-c', 'artifact-mode-other',
    'recovery', 'projection-render-latency', 'finish-and-export', 'adopted-textbook-publication',
    'concurrent-ai-save-projection', 'classroom-write-close-race',
    ...CLASSROOM_STAGES.flatMap(stage => [`phase-${stage}`, `teacher-display-${stage}`, `student-live-stage-${stage}`]),
    'learning-all-student-real-player-entry', 'learning-private-chat-access-boundaries',
    'learning-quiz-mixed-scores-with-unsubmitted-checkpoint', 'learning-quiz-all-student-scores-database-and-teacher-state',
    'learning-student-ending-review-refresh-and-process-retention', 'learning-teacher-normal-and-fullscreen-statistics',
    'learning-no-uncaught-browser-errors', 'learning-grounded-textbook-citations',
    'document-rich-editing-persistence',
    'document-prior-review-recovery', 'document-all-student-review-settlement',
  ].map(name => [name, 'browser-real-backend'])),
  'learning-concurrent-audio-and-map-pause-resume': 'browser-media',
  'learning-all-student-complete-lecture-playback': 'browser-media',
  'learning-shared-prepared-explanation-audio-and-no-personal-records': 'browser-media',
  'learning-all-student-personal-tutor-native-audio': 'browser-media',
  'learning-all-student-private-chat-and-durable-replay': 'browser-real-provider',
  'learning-all-student-personal-tutor-followup-and-replay': 'browser-real-provider',
  ...Object.fromEntries(['document-proactive-review-real-model', 'document-proactive-comment-read-reply-reopen',
    'document-ai-edit-adopt-reject-undo'].map(name => [name, 'browser-real-provider'])),
  'real-lecture-audio-preparation': 'real-provider-api',
  'real-ai': 'real-provider-api',
  'code-background-next-worker-after-caller-close': 'browser-real-provider',
  'real-public-discussion': 'real-provider-api',
  'grading-multi-format-isolated-classroom': 'isolated-backend',
  'grading-concurrent-matching-fill-and-deep-real-model': 'real-provider-api',
  'grading-receipts-raw-model-evidence-and-teacher-reconciliation': 'real-provider-api',
  'grading-finished-classroom-keeps-accepted-grades': 'isolated-backend',
  'profile-zip-reconciliation': 'isolated-backend',
  'research-export-nonempty-source-actions': 'isolated-backend',
  'complete-ai-history-export': 'isolated-backend',
  'event-volume-reconciliation': 'isolated-backend',
  'final-backup-restore': 'isolated-backend',
  'restored-application-login-history-media': 'browser-real-backend',
  'draft-save-ack-recovery': 'browser-real-backend',
  'draft-save-cross-session-conflict': 'browser-real-backend',
  'draft-save-same-context-replay': 'browser-real-backend',
  'runtime-config-binding': 'isolated-backend',
  'runtime-config-stability': 'isolated-backend',
  ...Object.fromEntries(['private-chat', 'personal-tutor', 'document-ai']
    .map(label => [`ai-capacity-admission-${label}`, 'isolated-backend'])),
  ...Object.fromEntries(['teacher-preparation-resource-persistence', 'teacher-preparation-version-isolation',
    'teacher-preparation-student-permission'].map(name => [name, 'isolated-backend'])),
  'teacher-assessment-answer-view': 'browser-real-backend',
  'resource-video-native-play-pause-seek-sync': 'browser-media',
  'teacher-resource-forced-projection': 'browser-real-backend',
  'teacher-resource-optional-viewing': 'browser-real-backend',
  'projection-does-not-complete-learning': 'browser-real-backend',
  'learning-interrupted-chat-recovery': 'browser-real-provider',
  ...Object.fromEntries(['document', 'python', 'c', 'other'].map(mode => [`teacher-artifact-preview-${mode}`, 'browser-real-backend'])),
});
export const CLASSROOM_REQUIRED_CHECKS = Object.freeze(Object.keys(CLASSROOM_REQUIRED_EVIDENCE));

export function evaluatePerformance(classroom, rawResults, failures, missing, stages = CLASSROOM_PERFORMANCE_PHASES) {
  for (const stage of stages) {
    const metrics = Object.entries(classroom.metrics?.[stage] ?? {});
    for (const kind of ['read', 'write']) {
      const selected = metrics.filter(([operation, metric]) => (metric.category
        ?? (/^(GET|HEAD) /.test(operation) ? 'read' : 'write')) === kind);
      if (!selected.length) missing.push(`Missing measured ${kind} traffic: ${stage}`);
      for (const [operation, metric] of selected) {
        const name = `performance-${stage}-${operation}`;
        if (!Number.isInteger(metric.samples) || metric.samples <= 0 || !Number.isFinite(metric.p95Ms) || metric.p95Ms < 0
          || !Number.isInteger(metric.failures) || metric.failures < 0) missing.push(`Invalid performance sample: ${name}`);
        else if (metric.p95Ms > (kind === 'read' ? 1000 : 2000) || metric.failures) failures.push(`Performance budget or error gate failed: ${name}`);
        if ((metric.unmeasured ?? 0) !== 0) missing.push(`Browser network timing incomplete: ${name}`);
        for (const rows of [classroom.checks, rawResults]) {
          const result = rows.find(item => item.name === name);
          // An executed failing measurement is a defect, not missing evidence.
          // Its status still fails the child verdict, and its samples must agree.
          if (!result || (!pass(result.status) && !fail(result.status)) || result.evidence !== 'browser-real-backend') missing.push(`Missing performance result: ${name}`);
          else if (result.detail?.samples !== metric.samples || result.detail?.p95Ms !== metric.p95Ms || result.detail?.failures !== metric.failures) failures.push(`Performance result differs from measurements: ${name}`);
        }
      }
    }
  }
}

export function evaluateContinuity(classroom, options, failures, missing) {
  const timing = Array.isArray(classroom.phaseTiming) ? classroom.phaseTiming : [];
  const snapshots = Array.isArray(classroom.continuitySnapshots) ? classroom.continuitySnapshots : [];
  const maximumGapMs = 45_000;
  let previousEnd;
  let sumSeconds = 0;
  const started = Date.parse(classroom.startedAt);
  const finished = Date.parse(classroom.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) missing.push('Classroom start/end timestamps are missing or invalid');
  else if (Math.abs((finished - started) / 1000 - classroom.actualDurationSeconds) > 1) failures.push('Classroom duration differs from its measured timestamps');
  if (timing.length !== CLASSROOM_STAGES.length || timing.some((phase, index) => phase.stageKey !== CLASSROOM_STAGES[index])) missing.push('Classroom phases were not measured once in the required order');
  for (const [index, stageKey] of CLASSROOM_STAGES.entries()) {
    const phase = timing.find(item => item.stageKey === stageKey);
    const minimumSeconds = options.minutes * 60 * CLASSROOM_PHASE_MINUTES[index] / 90;
    if (!Number.isFinite(phase?.actualDurationSeconds) || phase.actualDurationSeconds + 0.01 < minimumSeconds) missing.push(`Classroom phase duration incomplete: ${stageKey}`);
    else sumSeconds += phase.actualDurationSeconds;
    const phaseStart = Date.parse(phase?.startedAt);
    const phaseEnd = Date.parse(phase?.finishedAt);
    if (!Number.isFinite(phaseStart) || !Number.isFinite(phaseEnd) || phaseEnd <= phaseStart) {
      missing.push(`No measured classroom phase timestamps: ${stageKey}`);
      continue;
    }
    if (Math.abs((phaseEnd - phaseStart) / 1000 - phase.actualDurationSeconds) > 1) failures.push(`Phase duration differs from timestamps: ${stageKey}`);
    if (phaseStart < started || phaseEnd > finished || (previousEnd !== undefined && phaseStart < previousEnd)) failures.push(`Phase timestamps overlap or escape the classroom interval: ${stageKey}`);
    if (previousEnd !== undefined && phaseStart - previousEnd > maximumGapMs) missing.push(`Unobserved gap between classroom phases: ${stageKey}`);
    previousEnd = phaseEnd;
    const samples = snapshots.filter(sample => sample.stageKey === stageKey)
      .map(sample => Date.parse(sample.at)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!samples.length) missing.push(`No classroom continuity samples: ${stageKey}`);
    else {
      if (samples.some(at => at < phaseStart || at > phaseEnd)) failures.push(`Continuity samples escape their phase: ${stageKey}`);
      const boundaries = [phaseStart, ...samples, phaseEnd];
      if (boundaries.some((at, i) => i && at - boundaries[i - 1] > maximumGapMs)) missing.push(`Classroom continuity sample gap exceeds 45 seconds: ${stageKey}`);
    }
  }
  if (Number.isFinite(classroom.actualDurationSeconds) && Math.abs(classroom.actualDurationSeconds - sumSeconds) > 45) missing.push('Classroom duration is not supported by the sum of measured phases');
  for (const sample of snapshots) {
    if (!Number.isFinite(Date.parse(sample.at)) || !CLASSROOM_STAGES.includes(sample.stageKey)) failures.push('Invalid classroom continuity sample identity');
    if (sample.students !== options.students || sample.authenticatedStudents !== options.students || sample.teacherAlive !== true) failures.push('Classroom continuity lost a teacher or authenticated student');
  }
}

/** Final-only restart, supplementary artifacts and restore checks are deliberately
 * excluded. These functions and their original evidence are mandatory in EVERY
 * sustained class, not only the final class that also runs fault scenarios. */
export const SUSTAINED_CLASSROOM_REQUIRED_CHECKS = Object.freeze([
  'runtime-config-binding', 'runtime-config-stability', 'adopted-textbook-publication',
  'real-lecture-audio-preparation', 'teacher-preparation-resource-persistence',
  'teacher-preparation-version-isolation', 'teacher-preparation-student-permission',
  'roster', 'projection-render-latency', 'five-stage-flow', 'teacher-metrics',
  ...CLASSROOM_STAGES.flatMap(stage => [`phase-${stage}`, `teacher-display-${stage}`, `student-live-stage-${stage}`]),
  'learning-all-student-real-player-entry', 'learning-concurrent-audio-and-map-pause-resume',
  'learning-all-student-private-chat-and-durable-replay', 'learning-private-chat-access-boundaries',
  'learning-all-student-complete-lecture-playback', 'learning-quiz-mixed-scores-with-unsubmitted-checkpoint',
  'learning-quiz-all-student-scores-database-and-teacher-state',
  'learning-shared-prepared-explanation-audio-and-no-personal-records',
  'learning-all-student-personal-tutor-followup-and-replay', 'learning-all-student-personal-tutor-native-audio',
  'learning-student-ending-review-refresh-and-process-retention', 'learning-teacher-normal-and-fullscreen-statistics',
  'learning-no-uncaught-browser-errors', 'learning-grounded-textbook-citations', 'real-ai', 'real-public-discussion',
  ...['private-chat', 'personal-tutor', 'document-ai'].map(label => `ai-capacity-admission-${label}`),
  'document-rich-editing-persistence', 'concurrent-ai-save-projection', 'document-proactive-review-real-model',
  'document-proactive-comment-read-reply-reopen', 'document-ai-edit-adopt-reject-undo',
  'document-prior-review-recovery', 'artifact-reconciliation', 'document-all-student-review-settlement',
  'teacher-artifact-preview-document', 'teacher-assessment-answer-view',
]);

export function evaluateSustainedClassroom(classroom, options) {
  const failures = []; const missing = [];
  if (classroom.teachers !== 1 || classroom.students !== options.students
    || classroom.browserCounts?.['google-chrome'] !== Math.ceil(options.students / 2)
    || classroom.browserCounts?.['microsoft-edge'] !== Math.floor(options.students / 2)) failures.push('Sustained classroom roster or browser split differs');
  const checks = Array.isArray(classroom.checks) ? classroom.checks : [];
  for (const name of SUSTAINED_CLASSROOM_REQUIRED_CHECKS) {
    const matches = checks.filter(row => row.name === name);
    if (matches.length > 1) failures.push(`Duplicate sustained check: ${name}`);
    const result = matches[0];
    if (!result || !pass(result.status)) (result && fail(result.status) ? failures : missing).push(`Required sustained check: ${name}`);
    else if (result.evidence !== CLASSROOM_REQUIRED_EVIDENCE[name]) missing.push(`Insufficient sustained evidence: ${name}`);
  }
  for (const result of checks) {
    if (fail(result.status)) failures.push(`Sustained check failed: ${result.name}`);
    else if (!pass(result.status)) missing.push(`Unverified sustained check: ${result.name}`);
  }
  evaluateContinuity(classroom, options, failures, missing);
  evaluatePerformance(classroom, checks, failures, missing, CLASSROOM_STAGES);
  const providerHash = classroom.runtimeConfiguration?.publicProviderConfigurationSha256;
  if (!/^[a-f0-9]{64}$/.test(providerHash ?? '')) missing.push('Missing sustained provider fingerprint');
  else for (const sample of classroom.continuitySnapshots ?? []) {
    if (!sample.providerConfigurationSha256) missing.push('Missing sustained provider monitoring');
    else if (sample.providerConfigurationSha256 !== providerHash) failures.push('Sustained provider configuration changed');
  }
  const settlement = classroom.documentReviewSettlement;
  if (!settlement || settlement.status !== 'passed' || settlement.budget?.deadlineMs !== 300000
    || !Number.isFinite(settlement.totalElapsedMs) || settlement.totalElapsedMs < 0
    || !Number.isFinite(settlement.settlementElapsedMs) || settlement.settlementElapsedMs < 0
    || settlement.settlementElapsedMs > settlement.totalElapsedMs
    || !Array.isArray(settlement.students) || settlement.students.length !== options.students) missing.push('Whole-class durable review settlement is missing or incomplete');
  else {
    if (settlement.settlementElapsedMs > settlement.budget.deadlineMs) failures.push('Whole-class durable review settlement exceeded five minutes');
    const identities = new Set(); const indices = new Set();
    for (const student of settlement.students) {
      const proof = student.proof;
      if (student.status !== 'passed') failures.push('A sustained review did not finish successfully');
      if (!student.userId || identities.has(student.userId) || !Number.isInteger(student.index)
        || student.index < 0 || student.index >= options.students || indices.has(student.index)) failures.push('Sustained review student identity is missing or duplicated');
      identities.add(student.userId); indices.add(student.index);
      if (!Number.isFinite(student.elapsedMs) || student.elapsedMs < 0 || student.elapsedMs > 300000
        || !Number.isFinite(student.settledElapsedMs) || student.settledElapsedMs < student.elapsedMs
        || student.settledElapsedMs > settlement.settlementElapsedMs
        || student.elapsedMs > settlement.totalElapsedMs || !Array.isArray(student.finalPendingKeys)
        || student.finalPendingKeys.length || !proof || proof.settled !== true
        || !Number.isInteger(proof.completed) || proof.completed < 1
        || !Number.isInteger(proof.observedRequests) || proof.observedRequests < 1
        || proof.observedRequests > proof.completed
        || proof.failed !== 0 || proof.running !== 0 || proof.cancelled !== 0
        || !Array.isArray(proof.missingTasks) || proof.missingTasks.length
        || !Array.isArray(proof.missingCheckpoints) || proof.missingCheckpoints.length
        || !Number.isInteger(proof.declaredReviewedParagraphs) || proof.declaredReviewedParagraphs < 0
        || proof.retainedCheckpoints !== proof.declaredReviewedParagraphs
        || !Array.isArray(student.tasks) || student.tasks.length !== proof.completed
        || student.tasks.some(task => task.status !== 'COMPLETED' || typeof task.requestId !== 'string' || !task.requestId.trim())
        || new Set(student.tasks.map(task => task.requestId)).size !== student.tasks.length) missing.push('Sustained review receipt/checkpoint or deadline evidence is incomplete');
    }
  }
  return { failures: [...new Set(failures)], missing: [...new Set(missing)] };
}
