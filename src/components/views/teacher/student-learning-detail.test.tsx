import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { DEFAULT_STAGES } from "@/lib/session/types";
import { StudentLearningDetail } from "./student-learning-detail";

const course: Course = {
  id: "course-1",
  name: "测试课",
  subject: "科学",
  grade: "六年级",
  hours: 2,
  summary: "",
  drivingQuestion: "",
  status: "teaching",
  stages: DEFAULT_STAGES,
  currentStageIndex: 1,
  content: {
    pblOutline: "",
    knowledgePoints: [{ id: "kp-1", name: "变量关系", description: "" }],
    knowledgeLectureSections: [{ id: "section-1", title: "第一节 · 变量关系", order: 0, knowledgePointIds: ["kp-1"], sceneOutlineIds: ["scene-1"], quizOutlineId: "quiz-1", estimatedMinutes: 5 }],
    lessonOutline: [],
    evaluationPlan: { dimensions: [], overallRubric: "" },
  },
  students: [{ id: "student-1", name: "张三", joinedAt: "2026-07-11T09:00:00.000Z", stageProgress: {} }],
  aiLearningProgress: {
    "student-1": {
      classroomId: "classroom-1",
      studentId: "student-1",
      currentSceneIndex: 1,
      totalScenes: 2,
      completedScenes: ["scene-1"],
      masteryLevel: "in-progress",
      lastActiveAt: "2026-07-11T10:05:00.000Z",
      knowledgeLectureAttempts: [{
        id: "attempt-1",
        sectionId: "section-1",
        quizOutlineId: "quiz-1",
        runtimeSceneId: "quiz-runtime-1",
        submittedAt: "2026-07-11T10:04:00.000Z",
        score: 4,
        maxScore: 10,
        knowledgePointIds: ["kp-1"],
        questions: [{
          questionId: "question-1",
          prompt: "自变量和因变量之间是什么关系？",
          answer: "把两个数直接相加",
          referenceAnswer: "因变量随自变量变化",
          points: 10,
          earned: 4,
          correct: false,
          feedback: "需要先识别两个变量",
          knowledgePointIds: ["kp-1"],
        }],
      }],
    },
  },
  learningEvents: [{
    id: "event-1",
    idempotencyKey: "event-1",
    courseId: "course-1",
    studentId: "student-1",
    stageKey: "ai-learning",
    sceneId: "scene-1",
    type: "scene-replay",
    occurredAt: "2026-07-11T10:00:00.000Z",
    content: { sceneIndex: 5, sceneTitle: "图像像素与流程探索", sceneType: "slide" },
  }],
  createdAt: "",
  updatedAt: "",
};

describe("StudentLearningDetail", () => {
  it("defaults to the learning trajectory and uses readable event labels", () => {
    render(<StudentLearningDetail course={course} onOpenChange={vi.fn()} open studentId="student-1" />);

    expect(screen.getByRole("tab", { name: "学习轨迹" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("重新播放讲解")).toBeTruthy();
    expect(screen.getByText("第 5 页 《图像像素与流程探索》")).toBeTruthy();
    expect(screen.queryByText("scene-replay")).toBeNull();
  });

  it("can open directly on real per-question answer details", () => {
    render(<StudentLearningDetail course={course} initialTab="answers" onOpenChange={vi.fn()} open studentId="student-1" />);

    expect(screen.getByRole("tab", { name: "答题详情" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("自变量和因变量之间是什么关系？")).toBeTruthy();
    expect(screen.getByText("把两个数直接相加")).toBeTruthy();
    expect(screen.getByText("因变量随自变量变化")).toBeTruthy();
    expect(screen.getByText(/需要先识别两个变量/)).toBeTruthy();
    expect(screen.getAllByText("4/10 分")).toHaveLength(2);
  });

  it("switches between answer details and the learning trajectory inside one drawer", () => {
    render(<StudentLearningDetail course={course} initialTab="answers" onOpenChange={vi.fn()} open studentId="student-1" />);
    fireEvent.click(screen.getByRole("tab", { name: "学习轨迹" }));

    expect(screen.getByRole("tab", { name: "学习轨迹" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("重新播放讲解")).toBeTruthy();
    expect(screen.queryByText("把两个数直接相加")).toBeNull();
  });
});
