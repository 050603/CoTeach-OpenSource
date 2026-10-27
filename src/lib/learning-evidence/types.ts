/**
 * Canonical contracts for the evidence-driven PBL classroom.
 *
 * These records deliberately separate learning evidence from operational
 * telemetry. Page views, saves, uploads and companion calls may help the
 * teacher offer support, but they are not learning evidence by themselves.
 */

export const LEARNING_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const OPERATIONAL_SIGNAL_RETENTION_DAYS = 30 as const;

export type LearningPresetId = "guided" | "standard" | "research";

export type CompanionRoleId =
  | "knowledge"
  | "ideation"
  | "critic"
  | "planner"
  | "reviewer"
  | "recorder";

export type LearningEvidenceKind =
  | "project-intent"
  | "knowledge-transfer"
  | "key-decision"
  | "plan-version"
  | "artifact-version"
  | "test-result"
  | "revision-decision"
  | "final-artifact"
  | "presentation-claim"
  | "defense-response"
  | "reflection-chain"
  | "transfer-response"
  | "ai-decision";

export type LearningEvidenceStatus =
  | "draft"
  | "submitted"
  | "teacher-confirmed"
  | "needs-revision";

export type LearningEvidenceSource =
  | "student"
  | "teacher"
  | "system";

export type ProjectIntentPayload = {
  concern: string;
  affectedPeople: string;
  importance: string;
  successIndicator: string;
  personalQuestion: string;
};

export type KnowledgeTransferPayload = {
  concept: string;
  ownExplanation: string;
  projectConstraint: string;
  application: string;
};

export type DecisionAlternative = {
  id: string;
  title: string;
  description: string;
  comparison: Record<string, string>;
};

export type KeyDecisionPayload = {
  alternatives: DecisionAlternative[];
  successCriteria: string[];
  selectedAlternativeId: string;
  reason: string;
};

export type PlanVersionPayload = {
  versionLabel: string;
  nextActions: string[];
  validationMethod: string;
  risks: string[];
  aiBoundary: string;
  changeSummary?: string;
  sources?: string[];
  methodLimitations?: string;
  ethics?: string;
};

export type ArtifactVersionPayload = {
  iterationId: string;
  versionLabel: string;
  artifactTitle: string;
  changeSummary: string;
  contentExcerpt?: string;
  snapshotId?: string;
};

export type TestResultPayload = {
  iterationId: string;
  method: string;
  target: string;
  observation: string;
  result: string;
  limitation?: string;
  researchMethod?: string;
  ethics?: string;
};

export type RevisionDecisionPayload = {
  iterationId: string;
  interpretation: string;
  decision: "revise" | "keep" | "retry";
  reason: string;
  plannedChange: string;
  nextGoal: string;
  /**
   * The making-stage UI keeps one continuous student-authored work draft.
   * Legacy structured revision fields remain readable for existing courses.
   */
  processDraft?: string;
};

export type FinalArtifactPayload = {
  title: string;
  description: string;
  snapshotId?: string;
};

export type PresentationClaimPayload = {
  claim: string;
  evidenceIds: string[];
  evidenceSummary: string;
  limitation: string;
};

export type DefenseResponsePayload = {
  question: string;
  response: string;
  evidenceIds: string[];
};

export type ReflectionChainPayload = {
  selectedEvidenceIds: string[];
  choice: string;
  action: string;
  result: string;
  learning: string;
};

export type TransferResponsePayload = {
  scenario: string;
  response: string;
  rationale: string;
};

export type AiDecisionEvidencePayload = {
  contributionId: string;
  decisionId: string;
  decision: StudentAiDecisionKind;
  reason: string;
  versionChange?: string;
};

export type LearningEvidencePayloadByKind = {
  "project-intent": ProjectIntentPayload;
  "knowledge-transfer": KnowledgeTransferPayload;
  "key-decision": KeyDecisionPayload;
  "plan-version": PlanVersionPayload;
  "artifact-version": ArtifactVersionPayload;
  "test-result": TestResultPayload;
  "revision-decision": RevisionDecisionPayload;
  "final-artifact": FinalArtifactPayload;
  "presentation-claim": PresentationClaimPayload;
  "defense-response": DefenseResponsePayload;
  "reflection-chain": ReflectionChainPayload;
  "transfer-response": TransferResponsePayload;
  "ai-decision": AiDecisionEvidencePayload;
};

export type LearningEvidence<
  Kind extends LearningEvidenceKind = LearningEvidenceKind,
> = {
  id: string;
  schemaVersion: typeof LEARNING_EVIDENCE_SCHEMA_VERSION;
  courseId: string;
  studentId: string;
  stageKey: string;
  kind: Kind;
  title: string;
  summary: string;
  payload: LearningEvidencePayloadByKind[Kind];
  status: LearningEvidenceStatus;
  source: LearningEvidenceSource;
  /**
   * False for evidence records such as AI-decision provenance that may enter
   * evaluation context but are not a completion requirement by themselves.
   */
  countsTowardReadiness: boolean;
  evidenceRefs: string[];
  artifactSnapshotIds: string[];
  revisionOf?: string;
  teacherFeedback?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  confirmedAt?: string;
};

export type ArtifactInspectionStatus =
  | "inspectable"
  | "student-annotated"
  | "metadata-only"
  | "unsupported";

export type ArtifactSnapshot = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  artifactVersionEvidenceId?: string;
  title: string;
  fileName?: string;
  fileType: string;
  sourceUrl?: string;
  inspectionStatus: ArtifactInspectionStatus;
  /**
   * Only inspectable extracted text or a student-authored excerpt may be
   * passed to an AI. Metadata-only files are never represented as read.
   */
  inspectableText?: string;
  studentExcerpt?: string;
  annotation?: string;
  contentHash?: string;
  createdAt: string;
};

export type AiContributionImpact = "low" | "high";
export type AiContributionStatus = "pending-decision" | "decided";

export type AiContribution = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  companionId: CompanionRoleId;
  impact: AiContributionImpact;
  request: string;
  suggestion: string;
  sourceEvidenceIds: string[];
  proposedChange?: string;
  status: AiContributionStatus;
  createdAt: string;
};

export type StudentAiDecisionKind = "adopted" | "modified" | "rejected";

export type StudentAiDecision = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  contributionId: string;
  decision: StudentAiDecisionKind;
  /** Required for all high-impact suggestions, including rejection. */
  reason: string;
  appliedChangeSummary?: string;
  resultingEvidenceIds: string[];
  decidedAt: string;
};

export type StageReadinessStatus =
  | "not-started"
  | "working"
  | "awaiting-calibration"
  | "needs-revision"
  | "ready";

export type StageReadinessCheck = {
  id: string;
  label: string;
  satisfied: boolean;
  evidenceIds: string[];
  detail?: string;
};

export type TeacherCalibrationState =
  | "not-required"
  | "pending"
  | "confirmed"
  | "needs-revision";

export type StageReadiness = {
  courseId: string;
  studentId: string;
  stageKey: string;
  preset: LearningPresetId;
  status: StageReadinessStatus;
  checks: StageReadinessCheck[];
  missingEvidenceKinds: LearningEvidenceKind[];
  evidenceIds: string[];
  completedIterations: number;
  requiredIterations: number;
  teacherCalibration: TeacherCalibrationState;
  reason: string;
  derivedAt: string;
};

export type MissionActionDefinition = {
  id: string;
  label: string;
  description: string;
  evidenceKinds: LearningEvidenceKind[];
  doneWhen: string;
};

export type StageMissionDefinition = {
  id: string;
  stageKey: string;
  preset: LearningPresetId;
  objective: string;
  currentAction: MissionActionDefinition;
  actions: MissionActionDefinition[];
  completionCriteria: string[];
  suggestedMinutes: number;
  allowedCompanionIds: CompanionRoleId[];
  leadCompanionId?: CompanionRoleId;
  supportingCompanionId?: CompanionRoleId;
  requiredEvidenceKinds: LearningEvidenceKind[];
  requiredIterations: number;
  targetIterations: number;
  teacherRequirement: "none" | "scope-confirmation" | "plan-approval" | "live-evaluation";
};

export type AiAssessmentConfidence = "low" | "medium" | "high";
export type AiAssessmentSuggestionStatus =
  | "pending-teacher-confirmation"
  | "confirmed"
  | "adjusted"
  | "rejected"
  | "insufficient-evidence";

export type AiAssessmentDimensionSuggestion = {
  dimensionId: string;
  dimensionLabel: string;
  suggestedScore?: number;
  rationale: string;
  evidenceIds: string[];
  evidenceGaps: string[];
};

export type AiAssessmentSuggestion = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  dimensions: AiAssessmentDimensionSuggestion[];
  evidenceIds: string[];
  evidenceGaps: string[];
  confidence: AiAssessmentConfidence;
  suggestedTotal?: number;
  status: AiAssessmentSuggestionStatus;
  teacherScore?: number;
  teacherComment?: string;
  teacherName?: string;
  createdAt: string;
  reviewedAt?: string;
};

export const STAGE_READINESS_LABEL: Record<StageReadinessStatus, string> = {
  "not-started": "未开始",
  working: "进行中",
  "awaiting-calibration": "待校准",
  "needs-revision": "需修订",
  ready: "已达标",
};
