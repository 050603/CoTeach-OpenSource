import type { CourseStagePlan } from "@/lib/resource-package/types";
import type { CourseTextbookSelection } from "@/lib/textbook/course-evidence-types";

export type PreparationPlan = {
  courseName: string;
  subject: string;
  grade: string;
  totalMinutes: number;
  learnerContext: string;
  learningObjectives: string[];
  knowledgePoints: Array<{ id: string; name: string; depth: string; teachingApproach: string }>;
  teachingApproach: string;
  teacherRequirements: string[];
  stagePlan: CourseStagePlan;
};
export type PreparationQuestion = {
  id: string;
  prompt: string;
  reason?: string;
  options: Array<{ id: string; label: string; description: string }>;
};
export type ConfirmedPreparation = {
  sessionId: string;
  revision: number;
  confirmedAt: string;
  confirmedBy: string;
  plan: PreparationPlan;
  referenceIds: string[];
  textbookSelections: CourseTextbookSelection[];
};
export type PreparationTurn = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  question?: PreparationQuestion | null;
};
export type PreparationSessionSnapshot = {
  id: string;
  revision: number;
  status: "discussing" | "processing" | "ready" | "failed" | "confirmed";
  turns: PreparationTurn[];
  currentQuestion: PreparationQuestion | null;
  plan: Partial<PreparationPlan>;
  fieldOrigins: Record<string, "teacher-stated" | "ai-proposed">;
  readyToConfirm: boolean;
  missingFields: string[];
  suggestions: string[];
  referenceIds: string[];
  textbookSelections: CourseTextbookSelection[];
  confirmed: ConfirmedPreparation | null;
  referenceMaterials: Array<{ id: string; fileName: string; mimeType?: string }>;
  error: string | null;
};
export type PreparationMutationInput = {
  action?: "revise" | "continue" | "confirm" | "retry";
  revision: number;
  requestId: string;
  message?: string;
  selectedOptionId?: string;
  referenceIds?: string[];
  textbookSelections?: CourseTextbookSelection[];
};
export type PreparationModelResult = {
  message: string;
  question: PreparationQuestion | null;
  plan: Partial<PreparationPlan>;
  fieldOrigins: PreparationSessionSnapshot["fieldOrigins"];
  readyToConfirm: boolean;
  suggestions: string[];
};
