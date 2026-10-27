import { evaluateAiCollaborationHealth, type AiCollaborationEvidence } from "@/lib/evaluation/ai-process-evaluator";
import type { CompanionMessage, CompanionThread, Course, LearningEvidence, LearningSignal } from "@/lib/session/types";
import {
  deriveStageReadiness,
  isLearningEvidenceStructurallyComplete,
} from "@/lib/learning-evidence/readiness";
import { isReadyMadeDeliverableRequest } from "@/lib/learning-evidence/ai-policy";

export type StudentLearningProfile = {
  pace: "needs-structure" | "steady" | "exploratory";
  supportStrategy: "small-step" | "verification-first" | "extension";
  collaborationHealth: "insufficient-evidence" | "support-observation";
  collaborationScore: null;
  rationale: string[];
};

function evidenceFor(
  messages: CompanionMessage[],
  evidence: LearningEvidence[],
  course: Course,
  studentId: string,
  stageKey: string,
): AiCollaborationEvidence {
  const studentMessages = messages.filter((message) => message.role === "student");
  const text = studentMessages.map((message) => message.content).join("\n");
  const completeStudentEvidence = evidence.filter((item) =>
    item.source === "student"
    && item.countsTowardReadiness
    && isLearningEvidenceStructurallyComplete(item, course.artifactSnapshots ?? []));
  const contributionRequests = (course.aiContributions ?? [])
    .filter((item) =>
      item.studentId === studentId
      && item.stageKey === stageKey)
    .map((item) => item.request);
  return {
    interactionCount: studentMessages.length,
    specificContextCount: studentMessages.filter((message) => message.content.trim().length >= 20).length,
    independentProgressCount: completeStudentEvidence.length,
    verificationCount:
      (text.match(/核对|验证|来源|测试|比较|证据/g) ?? []).length
      + completeStudentEvidence.filter((item) =>
        ["knowledge-transfer", "key-decision", "test-result"].includes(item.kind)).length,
    artifactChangeCount: completeStudentEvidence.filter((item) =>
      ["artifact-version", "revision-decision"].includes(item.kind)).length,
    corroborationCount: completeStudentEvidence.filter((item) =>
      item.evidenceRefs.length > 0
      || ["test-result", "presentation-claim", "defense-response", "reflection-chain"].includes(item.kind)).length,
    delegationPatternCount:
      studentMessages.filter((message) =>
        isReadyMadeDeliverableRequest(message.content)).length
      + contributionRequests.filter(isReadyMadeDeliverableRequest).length,
  };
}

export function deriveStudentLearningProfile(input: {
  course: Course;
  studentId: string;
  stageKey: string;
}): StudentLearningProfile {
  const messages = (input.course.companionThreads ?? [])
    .filter((thread: CompanionThread) => thread.studentId === input.studentId && thread.stageKey === input.stageKey)
    .flatMap((thread) => thread.messages);
  const evidence = (input.course.learningEvidence ?? []).filter((item) =>
    item.studentId === input.studentId && item.stageKey === input.stageKey);
  const signals = (input.course.learningSignals ?? []).filter((signal: LearningSignal) => signal.studentId === input.studentId && signal.stageKey === input.stageKey && signal.status === "open");
  const operationalEvidence = evidenceFor(
    messages,
    evidence,
    input.course,
    input.studentId,
    input.stageKey,
  );
  const collaboration = evaluateAiCollaborationHealth(operationalEvidence);
  const readiness = deriveStageReadiness(input.course, input.studentId, input.stageKey);
  const rationale = [...collaboration.reasons];
  if (signals.some((signal) => signal.kind === "idle" || signal.kind === "goal-stalled")) rationale.push("最近存在停滞信号，先缩小下一步任务");

  if (signals.length || readiness.status === "not-started" || readiness.status === "needs-revision") {
    return { pace: "needs-structure", supportStrategy: operationalEvidence.delegationPatternCount > 0 ? "verification-first" : "small-step", collaborationHealth: collaboration.status, collaborationScore: null, rationale };
  }
  if (readiness.status === "ready") {
    return { pace: "exploratory", supportStrategy: "extension", collaborationHealth: collaboration.status, collaborationScore: null, rationale };
  }
  return { pace: "steady", supportStrategy: operationalEvidence.delegationPatternCount > 0 ? "verification-first" : "small-step", collaborationHealth: collaboration.status, collaborationScore: null, rationale };
}

export function studentProfilePrompt(profile: StudentLearningProfile): string {
  return `学生画像（仅用于调整支架，不参与评分）：节奏=${profile.pace}；建议策略=${profile.supportStrategy}；AI 使用=${profile.collaborationHealth === "support-observation" ? "有支援观察" : "观察不足"}；依据=${profile.rationale.join("、") || "暂无"}`;
}
