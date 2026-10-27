import type {
  ClassCommonIssue,
  LearningEvent,
  LearningSignal,
  LearningSignalKind,
} from "@/lib/session/types";

export const LEARNING_ANALYTICS_DEFAULTS = {
  dwellRatio: 1.5,
  minimumHumanAllowanceSec: 90,
  replayCount: 3,
  idleMs: 300_000,
  noProgressRounds: 4,
  aiAttemptsBeforeEscalation: 2,
  commonRatio: 0.3,
} as const;

export type ConversationRoundEvidence = { id: string; progressed: boolean };

export type StudentLearningAnalysisInput = {
  events: LearningEvent[];
  expectedDurationSec: number;
  ttsDurationSec?: number;
  plannedStudentActivitySec?: number;
  conversationRounds?: ConversationRoundEvidence[];
  aiInterventionAttempts?: number;
  now?: number;
};

export type StudentLearningMetrics = {
  effectiveDurationMs: number;
  expectedDurationMs: number;
  toleratedDurationMs: number;
  replayCount: number;
  lastActiveAt?: string;
};

export type StudentLearningAnalysis = {
  metrics: StudentLearningMetrics;
  signals: LearningSignal[];
};

const PROGRESS_EVENT_TYPES = new Set<LearningEvent["type"]>([
  "scene-complete",
  "interaction-result",
  "artifact-change",
  "stage-goal-complete",
]);

export function dedupeLearningEvents(events: LearningEvent[]): LearningEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.idempotencyKey)) return false;
    seen.add(event.idempotencyKey);
    return true;
  });
}

export function isLearningSignalRelevant(
  signal: LearningSignal,
  events: LearningEvent[],
  courseCompleted = false,
): boolean {
  if (!["dwell-overrun", "repeated-playback", "idle"].includes(signal.kind)) return true;
  if (courseCompleted) return false;
  const scopedEvents = dedupeLearningEvents(events)
    .filter((event) =>
      event.studentId === signal.studentId
      && event.stageKey === signal.stageKey
      && (event.sceneId ?? "") === (signal.sceneId ?? ""),
    )
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  return isScopeActivelyOpen(scopedEvents);
}

function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function issueFamily(kind: LearningSignalKind): string {
  if (kind === "dwell-overrun" || kind === "repeated-playback") return "comprehension-friction";
  if (kind === "idle") return "learning-interruption";
  if (kind === "conversation-no-progress" || kind === "goal-stalled") return "progress-blocked";
  return "help-request";
}

function stableIssueScope(signal: Pick<LearningSignal, "kind" | "stageKey" | "sceneId" | "content">): string {
  const knowledgePointIds = [...(signal.content?.knowledgePointIds ?? [])].sort();
  const contentScope = knowledgePointIds.length
    ? `kp:${knowledgePointIds.join("+")}`
    : signal.content?.activityId
      ? `activity:${signal.content.activityId}`
      : `scene:${signal.sceneId ?? "stage"}`;
  return [issueFamily(signal.kind), signal.stageKey, contentScope].join(":");
}

function commonIssueTitle(group: LearningSignal[]): string {
  const family = issueFamily(group[0].kind);
  if (family === "comprehension-friction") return "多名学生在同一知识内容上出现理解阻滞";
  if (family === "learning-interruption") return "多名学生的学习活动出现中断";
  if (family === "progress-blocked") return "多名学生未能继续推进学习任务";
  return "多名学生主动请求教师帮助";
}

function makeSignal(input: {
  kind: LearningSignalKind;
  title: string;
  summary: string;
  event: LearningEvent;
  evidenceEventIds: string[];
  aiInterventionAttempts: number;
  nowIso: string;
  baseSeverity: "notice" | "warning";
}): LearningSignal {
  const normalizedIssueKey = stableIssueScope({
    kind: input.kind,
    stageKey: input.event.stageKey,
    sceneId: input.event.sceneId,
    content: input.event.content,
  });
  return {
    id: `learning-signal-${slug(input.event.studentId)}-${slug(normalizedIssueKey)}`,
    courseId: input.event.courseId,
    studentId: input.event.studentId,
    stageKey: input.event.stageKey,
    sceneId: input.event.sceneId,
    kind: input.kind,
    severity:
      input.aiInterventionAttempts >= LEARNING_ANALYTICS_DEFAULTS.aiAttemptsBeforeEscalation
        ? "high"
        : input.baseSeverity,
    status: "open",
    title: input.title,
    summary: input.summary,
    content: input.event.content,
    normalizedIssueKey,
    evidenceEventIds: input.evidenceEventIds,
    aiInterventionAttempts: input.aiInterventionAttempts,
    firstDetectedAt: input.nowIso,
    lastDetectedAt: input.nowIso,
  };
}

/**
 * The design duration is treated as a teaching budget, not a deadline. Actual
 * narration plus planned student activity establishes the observable floor;
 * reading, translation, pausing, and comprehension receive an additional
 * human allowance before a teacher-facing warning is eligible.
 */
export function calculateToleratedDurationSec(input: {
  expectedDurationSec: number;
  ttsDurationSec?: number;
  plannedStudentActivitySec?: number;
}): number {
  const designed = Math.max(0, input.expectedDurationSec);
  const tts = Math.max(0, input.ttsDurationSec ?? 0);
  const studentActivity = Math.max(0, input.plannedStudentActivitySec ?? 0);
  const observableFloor = tts + studentActivity;
  const reference = Math.max(designed, observableFloor);
  if (reference <= 0) return 0;
  const humanAllowance = Math.max(
    LEARNING_ANALYTICS_DEFAULTS.minimumHumanAllowanceSec,
    reference * (LEARNING_ANALYTICS_DEFAULTS.dwellRatio - 1),
    tts * 0.35 + 45,
  );
  return Math.ceil(reference + humanAllowance);
}

function isScopeActivelyOpen(events: LearningEvent[]): boolean {
  const latestEnterIndex = events.findLastIndex((event) => event.type === "scene-enter");
  if (latestEnterIndex < 0) return false;
  return !events.slice(latestEnterIndex + 1).some(
    (event) => event.type === "scene-leave" || event.type === "scene-complete" || event.type === "stage-goal-complete",
  );
}

export function analyzeStudentLearning(input: StudentLearningAnalysisInput): StudentLearningAnalysis {
  const events = dedupeLearningEvents(input.events).sort(
    (a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt),
  );
  const latest = events.at(-1);
  const now = input.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const attempts = Math.max(0, input.aiInterventionAttempts ?? 0);
  const latestEnterIndex = events.findLastIndex((event) => event.type === "scene-enter");
  const activeVisitEvents = latestEnterIndex >= 0 ? events.slice(latestEnterIndex) : events;
  const effectiveDurationMs = events.reduce(
    (sum, event) =>
      event.type === "heartbeat" && event.visible !== false
        ? sum + Math.max(0, event.durationMs ?? 0)
        : sum,
    0,
  );
  const replayEvents = events.filter((event) => event.type === "scene-replay");
  const expectedDurationMs = Math.max(0, input.expectedDurationSec) * 1_000;
  const toleratedDurationMs = calculateToleratedDurationSec({
    expectedDurationSec: input.expectedDurationSec,
    ttsDurationSec: input.ttsDurationSec,
    plannedStudentActivitySec: input.plannedStudentActivitySec,
  }) * 1_000;
  const activelyOpen = isScopeActivelyOpen(events);
  const activeVisitDurationMs = activeVisitEvents.reduce(
    (sum, event) => event.type === "heartbeat" && event.visible !== false
      ? sum + Math.max(0, event.durationMs ?? 0)
      : sum,
    0,
  );
  const hasProgress = activeVisitEvents.some(
    (event) => PROGRESS_EVENT_TYPES.has(event.type) && event.progressMarker !== "unchanged",
  );
  const signals: LearningSignal[] = [];

  if (latest && activelyOpen && toleratedDurationMs > 0 && !hasProgress && activeVisitDurationMs > toleratedDurationMs) {
    signals.push(makeSignal({
      kind: "dwell-overrun",
      title: "该学生在此环节停留时间较长",
      summary: `本次进入后前台有效学习约 ${Math.max(1, Math.round(activeVisitDurationMs / 60_000))} 分钟，已超过综合设计时长、实际语音与操作思考余量计算出的 ${Math.max(1, Math.round(toleratedDurationMs / 60_000))} 分钟容忍范围，请结合具体内容关注其学习状态。`,
      event: latest,
      evidenceEventIds: activeVisitEvents.filter((event) => event.type === "heartbeat" && event.visible !== false).map((event) => event.id),
      aiInterventionAttempts: attempts,
      nowIso,
      baseSeverity: "warning",
    }));
  }

  if (latest && activelyOpen && !hasProgress && replayEvents.length >= LEARNING_ANALYTICS_DEFAULTS.replayCount) {
    signals.push(makeSignal({
      kind: "repeated-playback",
      title: "同一内容被重复学习",
      summary: `该内容已重复播放 ${replayEvents.length} 次，建议教师巡视确认是否存在理解困难。`,
      event: latest,
      evidenceEventIds: replayEvents.map((event) => event.id),
      aiInterventionAttempts: attempts,
      nowIso,
      baseSeverity: "notice",
    }));
  }

  if (latest && activelyOpen && latest.visible !== false && now - Date.parse(latest.occurredAt) > LEARNING_ANALYTICS_DEFAULTS.idleMs) {
    signals.push(makeSignal({
      kind: "idle",
      title: "学习活动停滞",
      summary: "当前环节保持打开且连续超过 5 分钟没有新的前台学习行为或产物进展。",
      event: latest,
      evidenceEventIds: [latest.id],
      aiInterventionAttempts: attempts,
      nowIso,
      baseSeverity: "warning",
    }));
  }

  const rounds = input.conversationRounds ?? [];
  const trailingRounds = rounds.slice(-LEARNING_ANALYTICS_DEFAULTS.noProgressRounds);
  if (
    latest &&
    trailingRounds.length === LEARNING_ANALYTICS_DEFAULTS.noProgressRounds &&
    trailingRounds.every((round) => !round.progressed)
  ) {
    signals.push(makeSignal({
      kind: "conversation-no-progress",
      title: "多轮对话没有形成新进展",
      summary: "连续 4 轮对话没有新增事实、选择或产物变化。",
      event: latest,
      evidenceEventIds: trailingRounds.map((round) => round.id),
      aiInterventionAttempts: attempts,
      nowIso,
      baseSeverity: "warning",
    }));
  }

  return {
    metrics: {
      effectiveDurationMs,
      expectedDurationMs,
      toleratedDurationMs,
      replayCount: replayEvents.length,
      lastActiveAt: latest?.occurredAt,
    },
    signals,
  };
}

export function aggregateCommonIssues(
  signals: LearningSignal[],
  totalStudents: number,
): ClassCommonIssue[] {
  if (totalStudents < 2) return [];
  const groups = new Map<string, LearningSignal[]>();
  for (const signal of signals) {
    if (signal.status !== "open") continue;
    const groupKey = stableIssueScope(signal);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), signal]);
  }

  return [...groups.entries()].flatMap(([normalizedIssueKey, group]) => {
    const byStudent = new Map<string, LearningSignal[]>();
    group.forEach((signal) => byStudent.set(signal.studentId, [...(byStudent.get(signal.studentId) ?? []), signal]));
    const affected = [...byStudent.values()].map((studentSignals) =>
      [...studentSignals].sort((left, right) => Number(right.severity === "high") - Number(left.severity === "high"))[0],
    );
    const requiredStudents = Math.min(
      totalStudents,
      Math.max(2, Math.ceil(totalStudents * LEARNING_ANALYTICS_DEFAULTS.commonRatio)),
    );
    const qualifies = affected.length >= requiredStudents;
    if (!qualifies) return [];
    const first = affected[0];
    const firstDetectedAt = affected.map((signal) => signal.firstDetectedAt).sort()[0];
    const lastDetectedAt = affected.map((signal) => signal.lastDetectedAt).sort().at(-1) ?? first.lastDetectedAt;
    return [{
      id: `class-issue-${slug(first.courseId)}-${slug(normalizedIssueKey)}`,
      courseId: first.courseId,
      stageKey: first.stageKey,
      normalizedIssueKey,
      title: commonIssueTitle(group),
      summary: `${affected.length} 名学生出现同类问题；系统已合并同一知识内容上的重复行为信号。`,
      content: first.content,
      severity: affected.some((signal) => signal.severity === "high") ? "high" as const : "warning" as const,
      studentIds: affected.map((signal) => signal.studentId),
      signalIds: group.map((signal) => signal.id),
      affectedStudents: affected.map((signal) => ({
        studentId: signal.studentId,
        signalId: signal.id,
        reason: (byStudent.get(signal.studentId) ?? []).map((item) => item.summary).join("；"),
      })),
      status: "open" as const,
      firstDetectedAt,
      lastDetectedAt,
    }];
  });
}
