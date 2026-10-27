export type AiCollaborationEvidence = {
  interactionCount: number;
  specificContextCount: number;
  independentProgressCount: number;
  verificationCount: number;
  artifactChangeCount: number;
  corroborationCount: number;
  delegationPatternCount: number;
};

export type AiCollaborationHealth =
  | { status: "insufficient-evidence"; score: null; reasons: string[] }
  | { status: "support-observation"; score: null; reasons: string[] };

export function evaluateAiCollaborationHealth(evidence: AiCollaborationEvidence): AiCollaborationHealth {
  const observable = evidence.specificContextCount + evidence.independentProgressCount + evidence.verificationCount + evidence.artifactChangeCount + evidence.corroborationCount + evidence.delegationPatternCount;
  if (observable < 2) return { status: "insufficient-evidence", score: null, reasons: ["可观察的提问、核验或产物变化证据不足"] };
  const reasons = [
    evidence.verificationCount ? "观察到核验或修改 AI 输出的行为" : "尚未观察到核验行为",
    evidence.artifactChangeCount ? "观察到对话后的产物推进" : "对话后产物推进证据不足",
    evidence.delegationPatternCount ? "出现直接索要完整答案或代做的模式，需要即时支援" : "未发现明显代做依赖",
    "该观察只用于调整支架，不作为分数或阶段进度",
  ];
  return { status: "support-observation", score: null, reasons };
}
