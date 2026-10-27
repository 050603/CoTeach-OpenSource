import type { ExperimentQuestion } from "./student-experiment-assessment";

export type ClassroomExperiment = { enabled: boolean; pretest: ExperimentQuestion[]; posttest: ExperimentQuestion[] };
export type StudentClassroomInstance = {
  id: string;
  status: string;
  runNo?: number;
  startedAt?: string | null;
  endedAt?: string | null;
  canWrite?: boolean;
  coverImageUrl?: string | null;
  pretestSubmitted?: boolean;
  posttestSubmitted?: boolean;
  posttestAvailable?: boolean;
  evaluationContractVersion?: 1 | 2;
  experiment?: ClassroomExperiment | null;
};
export type StudentClassroomActivity = {
  id: string;
  title: string;
  description?: string | null;
  isOpen: boolean;
  offering: { id: string; name: string; status: string };
  chapter: { title: string };
  experiment?: ClassroomExperiment | null;
  instance: StudentClassroomInstance | null;
  instances?: StudentClassroomInstance[];
};

export function classroomExperiment(activity: StudentClassroomActivity, instance: StudentClassroomInstance) {
  return instance.experiment === undefined ? activity.experiment : instance.experiment;
}
