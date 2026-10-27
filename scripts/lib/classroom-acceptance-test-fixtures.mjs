// Deliberately synthetic, complete evidence for verifier regression tests only.
import { CLASSROOM_STAGES, CLASSROOM_PHASE_MINUTES, SUSTAINED_CLASSROOM_REQUIRED_CHECKS,
  CLASSROOM_REQUIRED_EVIDENCE } from './classroom-acceptance-evidence.mjs';
// Synthetic declared-empty process tree; never used as live process evidence.
export function syntheticProcessTreeMemory({ pid = 42, startTicks = '42000', at, rss = 1e9 } = {}) {
  return { schemaVersion: 1, expectedApp: { pid, startTicks }, startedAt: at, finishedAt: at,
    startedMonotonicMs: 1, finishedMonotonicMs: 1,
    root: { pid, ppid: 1, parentPid: null, startTicks, depth: 0, identityStatus: 'verified',
      memory: { status: 'measured', rssBytes: rss, pssBytes: rss, sampledAt: at, sampleMonotonicMs: 1 } },
    descendants: [], inventory: { status: 'complete', descendantsCount: 0, knownStableDescendantsCount: 0, threadsInspected: 1 },
    descendantTotals: { status: 'measured', rssBytes: 0, pssBytes: 0, knownStableRssSumBytes: 0, knownStablePssSumBytes: 0 }, issues: [] };
}
export function sustainedLesson({ sequence = 1, rss = 1e9 } = {}) {
  const base = Date.parse('2026-10-16T00:05:00Z') + (sequence - 1) * 93 * 60000;
  const hash = 'a'.repeat(64); let elapsed = base; const continuitySnapshots = [];
  const checks = SUSTAINED_CLASSROOM_REQUIRED_CHECKS.map(name => ({ name, status: '通过', evidence: CLASSROOM_REQUIRED_EVIDENCE[name] }));
  checks.push({ name: 'soak-classroom-finished', status: '通过', evidence: 'browser-real-backend' });
  const metrics = Object.fromEntries(CLASSROOM_STAGES.map(stage => [stage, Object.fromEntries([
    ['GET /api/course/state read', 'read'], ['POST /api/course/actions save', 'write'],
  ].map(([operation, category]) => {
    const detail = { category, samples: 30, p95Ms: 25, failures: 0, unmeasured: 0 };
    checks.push({ name: `performance-${stage}-${operation}`, status: '通过', evidence: 'browser-real-backend', detail: { ...detail } });
    return [operation, detail];
  }))]));
  const phaseTiming = CLASSROOM_STAGES.map((stageKey, index) => {
    const startedAt = new Date(elapsed).toISOString(); const duration = CLASSROOM_PHASE_MINUTES[index] * 60;
    for (let seconds = 0; seconds <= duration; seconds += 30) continuitySnapshots.push({ at: new Date(elapsed + seconds * 1000).toISOString(),
      stageKey, students: 30, authenticatedStudents: 30, teacherAlive: true, providerConfigurationSha256: hash });
    elapsed += duration * 1000;
    return { stageKey, startedAt, finishedAt: new Date(elapsed).toISOString(), actualDurationSeconds: duration };
  });
  const sample = () => ({ pid: 42, values: { process_start_time_seconds: 1000, process_resident_memory_bytes: rss,
    nodejs_heap_size_used_bytes: 100, openpbl_process_external_memory_bytes: 100, openpbl_process_array_buffer_bytes: 50 },
    hostMemory: { total: 10e9, available: 8e9 } });
  return { schemaVersion: 1, sequence, buildId: 'candidate-build', runId: 'current-run', instanceId: `class-${sequence}`,
    teachers: 1, students: 30, actualDurationSeconds: 5400, browserCounts: { 'google-chrome': 15, 'microsoft-edge': 15 },
    startedAt: new Date(base).toISOString(), finishedAt: new Date(elapsed).toISOString(),
    checks, metrics, phaseTiming, continuitySnapshots, runtimeConfiguration: { publicProviderConfigurationSha256: hash },
    processSamples: phaseTiming.map(phase => {
      const at = Date.parse(phase.startedAt) + 1000;
      return { ...sample(), stageKey: phase.stageKey, at: new Date(at).toISOString(),
        processTreeMemory: syntheticProcessTreeMemory({ at: at + 251, rss }),
        metricsCapture: { requestedAt: new Date(at + 200).toISOString(), headersAt: new Date(at + 240).toISOString(),
          receivedAt: new Date(at + 250).toISOString() } };
    }),
    quietWindow: { startedAt: new Date(elapsed).toISOString(), finishedAt: new Date(elapsed + 120100).toISOString(),
      samples: [elapsed + 100, elapsed + 120100].map(at => ({ ...sample(), at: new Date(at).toISOString(),
        processTreeMemory: syntheticProcessTreeMemory({ at, rss }),
        metricsCapture: { requestedAt: new Date(at - 100).toISOString(), headersAt: new Date(at - 50).toISOString(),
          receivedAt: new Date(at).toISOString() } })) },
    documentReviewSettlement: { status: 'passed', budget: { deadlineMs: 300000 }, settlementElapsedMs: 35500, totalElapsedMs: 36000,
      students: Array.from({ length: 30 }, (_, index) => ({ index, userId: `class-${sequence}-student-${index}`, status: 'passed',
        elapsedMs: 35000, settledElapsedMs: 35200, finalPendingKeys: [], tasks: [{ requestId: `class-${sequence}-request-${index}`, status: 'COMPLETED' }],
        proof: { completed: 1, failed: 0, running: 0, cancelled: 0, observedRequests: 1, missingTasks: [],
          declaredReviewedParagraphs: 1, retainedCheckpoints: 1, missingCheckpoints: [], settled: true } })) },
  };
}
