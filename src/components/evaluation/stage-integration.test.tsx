import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { StudentStageView } from "@/components/views/student/stage-dispatcher";
import { TeacherStageView } from "@/components/views/teacher/stage-dispatcher";

vi.mock("./student-evaluation", () => ({ StudentPblEvaluation: () => <div>学生项目评价</div> }));
vi.mock("./teacher-evaluation", () => ({ TeacherPblEvaluation: () => <div>教师项目评价</div> }));
vi.mock("@/components/views/student/experiment-posttest", () => ({ ExperimentPosttestStudentView: () => <div>学生旧版后测</div> }));
vi.mock("@/components/views/teacher/experiment-posttest", () => ({ NewExperimentPosttestTeacherView: () => <div>教师旧版后测</div> }));
vi.mock("@/components/views/student/ai-learning", () => ({ AiLearningView: () => null }));
vi.mock("@/components/views/teacher/ai-learning", () => ({ AiLearningTeacherView: () => null }));
vi.mock("@/components/views/student/showcase-reporting", () => ({ NewShowcaseStudentView: () => null }));
vi.mock("@/components/views/teacher/showcase-reporting", () => ({ NewShowcaseTeacherView: () => null }));
vi.mock("@/components/views/teacher/ai-collaboration-monitor", () => ({ AiCollaborationTeacherMonitor: () => null }));
vi.mock("@/components/classroom/simple-stage-resources", () => ({ SimplifiedStudentStageView: () => null, SimplifiedTeacherStageView: () => null }));

describe("PBL stage contract routing", () => {
  const course = { id: "class", stages: [{ key: "reflection", view: "experiment-posttest" }], currentStageIndex: 0 } as Course;
  it("routes V2 reflection stages to project evaluation even with a historical view key", () => {
    render(<><StudentStageView course={{ ...course, evaluationContractVersion: 2 }} view="experiment-posttest" /><TeacherStageView course={{ ...course, evaluationContractVersion: 2 }} view="experiment-posttest" /></>);
    expect(screen.getByText("学生项目评价")).toBeTruthy();
    expect(screen.getByText("教师项目评价")).toBeTruthy();
    expect(screen.queryByText("学生旧版后测")).toBeNull();
  });
  it("preserves legacy posttest for instances without the V2 marker", () => {
    render(<><StudentStageView course={course} view="reflection-survey" /><TeacherStageView course={course} view="reflection-survey" /></>);
    expect(screen.getByText("学生旧版后测")).toBeTruthy();
    expect(screen.getByText("教师旧版后测")).toBeTruthy();
  });
});
