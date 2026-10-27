import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdaptiveBranchOutline, Course, StudentAdaptiveLearningState } from "@/lib/session/types";

vi.mock("@/components/openmaic-bridge/student-stage-host", () => ({
  prefetchAdaptiveClassroom: vi.fn(async () => ({
    stage: { id: "resource-classroom" },
    scenes: [],
  })),
  StudentStageHost: ({
    classroomId,
    onSceneComplete,
    adaptiveInsertions = [],
    readOnly,
  }: {
    classroomId: string;
    readOnly?: boolean;
    adaptiveInsertions?: Array<{ id: string; classroomId: string; anchorSceneId?: string }>;
    onSceneComplete?: (detail: {
      scene: {
        id: string;
        outlineId?: string;
        title: string;
        type: "quiz" | "slide" | "interactive";
        knowledgePointIds?: string[];
      };
      quizScore?: number;
      completedSceneCount: number;
      totalSceneCount: number;
    }) => void;
  }) => (
    <button
      data-insertions={adaptiveInsertions.length}
      data-insertion-anchor={adaptiveInsertions[0]?.anchorSceneId}
      data-testid="stage-host"
      data-readonly={readOnly}
      onClick={() => onSceneComplete?.({
        scene: classroomId === "main-classroom"
          ? {
              id: "runtime-quiz",
              outlineId: "quiz-1",
              title: "强化学习模块测验",
              type: "interactive",
              knowledgePointIds: ["reinforcement-learning"],
            }
          : {
              id: "resource-slide",
              title: "机器人应用",
              type: "slide",
              knowledgePointIds: ["reinforcement-learning"],
            },
        quizScore: classroomId === "main-classroom" ? 90 : undefined,
        completedSceneCount: 1,
        totalSceneCount: 1,
      })}
      type="button"
    >
      {classroomId}
    </button>
  ),
}));

vi.mock("@openmaic/lib/quiz/persistence", () => ({
  readSubmittedState: () => ({
    kind: "reviewing",
    results: [{ questionId: "question-1", correct: true }],
  }),
}));

import { AdaptiveAiLearningRuntime } from "./adaptive-ai-learning-runtime";

const adaptiveState: StudentAdaptiveLearningState = {
  enabled: true,
  pretestScore: 100,
  pretestCompletedAt: "2026-07-26T00:00:00.000Z",
  pretestWeakKnowledgePointIds: [],
  pretestMasteredKnowledgePointIds: ["reinforcement-learning"],
  evidence: [],
  branchRuns: [],
  microLessons: [],
};

const course = {
  id: "course-1",
  students: [{ id: "student-1", name: "张三" }],
  content: {
    _openmaicSceneOutlines: [{
      id: "quiz-1",
      title: "强化学习模块测验",
      type: "quiz",
      stageKey: "ai-learning",
      audience: "student",
      knowledgePointIds: ["reinforcement-learning"],
    }],
    adaptiveLearningPlan: {
      enabled: true,
      status: "teacher-confirmed",
      updatedAt: "2026-07-26T00:00:00.000Z",
      timeBudgetMin: 8,
      thresholds: { enrichmentMasteryMin: 80 },
      prerequisiteSemanticReview: {
        status: "passed",
        summary: "当前方案的先修边界已通过独立审校。",
        decisions: [],
      },
      pretest: {
        title: "先决知识检查",
        introduction: "",
        estimatedMinutes: 3,
        questions: [],
      },
      branches: [{
        id: "resource-1",
        kind: "application",
        title: "机器人应用",
        objective: "迁移应用",
        keyPoints: ["新案例"],
        anchorKnowledgePointIds: ["reinforcement-learning"],
        prerequisiteKnowledgePointIds: [],
        noveltyStatement: "使用主课未出现的仓储机器人案例分析奖励稀疏问题。",
        mainCourseOverlapSceneIds: [],
        sceneType: "slide",
        targetDurationSec: 120,
        generationGuidance: "不得重复主课。",
        preparedResource: {
          status: "ready",
          classroomId: "resource-classroom",
          scenesCount: 1,
        },
        trigger: {
          placement: "after-module",
          assessmentSceneIds: ["quiz-1"],
          answerRule: "score-at-least",
          evidenceRule: "module-mastery",
          scoreThreshold: 80,
          minimumRemainingSec: 120,
        },
        status: "teacher-confirmed",
      }],
    },
  },
  aiLearningProgress: {
    "student-1": {
      classroomId: "main-classroom",
      studentId: "student-1",
      currentSceneIndex: 0,
      totalScenes: 1,
      completedScenes: [],
      lastActiveAt: "2026-07-26T00:00:00.000Z",
      masteryLevel: "in-progress",
      adaptiveLearning: adaptiveState,
    },
  },
} as unknown as Course;

describe("AdaptiveAiLearningRuntime seamless sequencing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens an ended course without a warm-up, new branches or progress writes", async () => {
    const ended = structuredClone(course);
    ended.status = "finished";
    const state = ended.aiLearningProgress!["student-1"].adaptiveLearning!;
    delete state.pretestCompletedAt;
    ended.content.adaptiveLearningPlan!.pretest.questions = [{ id: "entry", type: "single-choice", prompt: "课前检查", options: ["A", "B"], correctOptionIndex: 0, knowledgePointIds: [] }];
    state.branchRuns = [{ id: "completed-branch", branchOutlineId: "resource-1", kind: "application", status: "completed", classroomId: "resource-classroom", reason: "当时的补充学习", createdAt: "2026-07-26T00:00:00Z" }];
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const before = structuredClone(ended);
    render(<AdaptiveAiLearningRuntime backHref="/student" classroomId="main-classroom" course={ended} studentId="student-1" studentName="张三" />);
    const host = screen.getByTestId("stage-host");
    expect(host).toHaveAttribute("data-readonly", "true");
    expect(host).toHaveAttribute("data-insertions", "1");
    expect(screen.queryByText("课前检查")).toBeNull();
    fireEvent.click(host);
    fireEvent(window, new CustomEvent("openpbl:knowledge-lecture-quiz-reviewed", { detail: { sceneId: "runtime-quiz" } }));
    await act(async () => undefined);
    expect(fetch).not.toHaveBeenCalled();
    expect(ended).toEqual(before);
  });

  it("shows a student-friendly warm-up and marks unanswered questions as unknown when time expires", async () => {
    vi.useFakeTimers();
    const pretestCourse = structuredClone(course) as Course;
    delete pretestCourse.aiLearningProgress!["student-1"].adaptiveLearning!.pretestCompletedAt;
    const pretest = pretestCourse.content.adaptiveLearningPlan!.pretest;
    pretest.title = "课程入口 · 前序能力诊断";
    pretest.introduction = "这些题只检查学习本课之前理应掌握的基础。";
    pretest.estimatedMinutes = 1;
    pretest.questions = [
      {
        id: "choice-1",
        type: "single-choice",
        prompt: "选择一个答案",
        options: ["A", "B"],
        correctOptionIndex: 0,
        knowledgePointIds: ["prerequisite-1"],
      },
      {
        id: "matching-1",
        type: "matching",
        prompt: "完成匹配",
        options: ["右侧一", "右侧二"],
        correctOptionIndex: 0,
        matchingPairs: [
          { left: "左侧一", right: "右侧一" },
          { left: "左侧二", right: "右侧二" },
        ],
        knowledgePointIds: ["prerequisite-2"],
      },
    ];
    const completedState = {
      ...adaptiveState,
      pretestCompletedAt: "2026-08-24T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return Response.json({ state: completedState });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdaptiveAiLearningRuntime
        backHref="/student/course-1"
        classroomId="main-classroom"
        course={pretestCourse}
        studentId="student-1"
        studentName="张三"
      />,
    );

    expect(screen.getByText("课前热身")).toBeTruthy();
    expect(screen.getByText("先来做2道小题")).toBeTruthy();
    expect(screen.queryByText("课程入口 · 前序能力诊断")).toBeNull();
    expect(screen.queryByText("这些题只检查学习本课之前理应掌握的基础。")).toBeNull();
    expect(screen.getByRole("timer").textContent).toContain("1:00");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      action: string;
      answers: Record<string, unknown>;
    };
    expect(body.action).toBe("submit-pretest");
    expect(body.answers).toEqual({ "choice-1": -1, "matching-1": {} });
  });

  it("keeps one main player mounted and inserts prepared scenes into its queue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ state: adaptiveState })));
    render(
      <AdaptiveAiLearningRuntime
        backHref="/student/course-1"
        classroomId="main-classroom"
        course={course}
        studentId="student-1"
        studentName="张三"
      />,
    );

    expect(screen.getAllByTestId("stage-host")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("main-classroom"));
    await waitFor(() =>
      expect(screen.getByTestId("stage-host").getAttribute("data-insertions")).toBe("1"),
    );
    expect(screen.getByTestId("stage-host").getAttribute("data-insertion-anchor"))
      .toBe("runtime-quiz");
    expect(screen.getByText("main-classroom")).toBeTruthy();
    expect(screen.getAllByTestId("stage-host")).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(['none', 'stall', 'lost-ack'])("keeps prerequisite preparation recoverable after %s", async (fault) => {
    const stalls = fault !== 'none';
    if (stalls) vi.useFakeTimers();
    const courseWithGap = structuredClone(course) as Course;
    const plan = courseWithGap.content.adaptiveLearningPlan!;
    plan.pretest.questions = [{
      id: "q-prerequisite",
      type: "single-choice",
      prompt: "哪一项属于可靠的分类特征？",
      options: ["可观察特征", "随机猜测"],
      correctOptionIndex: 0,
      knowledgePointIds: ["prereq-classification"],
    }];
    const matchingBranch: AdaptiveBranchOutline = {
      ...plan.branches[0],
      id: "prerequisite-resource",
      kind: "prerequisite",
      prerequisiteKnowledgePointIds: ["prereq-classification"],
      anchorKnowledgePointIds: ["reinforcement-learning"],
      noveltyStatement: "补充主课未讲授、但理解后续分类任务必需的可观察特征基础。",
      trigger: {
        placement: "before-main-course",
        evidenceRule: "pretest-gap",
        minimumRemainingSec: 120,
      },
    };
    plan.branches = [
      {
        ...matchingBranch,
        id: "unrelated-prerequisite-resource",
        title: "不相关的先决知识回顾",
        prerequisiteKnowledgePointIds: ["prereq-unrelated"],
        preparedResource: { status: "ready", classroomId: "unrelated-classroom", scenesCount: 1 },
      },
      matchingBranch,
    ];
    const stateWithGap: StudentAdaptiveLearningState = {
      ...adaptiveState,
      pretestScore: 0,
      pretestWeakKnowledgePointIds: ["prereq-classification"],
      pretestMasteredKnowledgePointIds: [],
    };
    courseWithGap.aiLearningProgress!["student-1"].adaptiveLearning = stateWithGap;
    let releaseRequest: (() => void) | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const savedRunIds: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (fault === 'lost-ack') {
        if (body.action === 'upsert-branch-run') {
          savedRunIds.push(body.run.id);
          stateWithGap.branchRuns = [...stateWithGap.branchRuns.filter((run) => run.id !== body.run.id), body.run];
          if (savedRunIds.length === 1) await firstRequest;
        }
      } else await firstRequest;
      return Response.json({ state: stateWithGap });
    }));

    render(
      <AdaptiveAiLearningRuntime
        backHref="/student/course-1"
        classroomId="main-classroom"
        course={courseWithGap}
        studentId="student-1"
        studentName="张三"
      />,
    );

    expect(screen.queryByTestId("stage-host")).toBeNull();
    expect(screen.getByText("正在准备必需的先决知识回顾")).toBeTruthy();
    if (stalls) {
      await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
      expect(screen.getByText('先决知识回顾暂未准备好')).toBeTruthy();
      expect(screen.getByText(/服务器响应超时/)).toBeTruthy();
      expect(screen.queryByTestId('stage-host')).toBeNull();
      releaseRequest?.();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新准备' })); });
      expect(screen.getByTestId('stage-host')).toBeTruthy();
      if (fault === 'lost-ack') {
        expect(savedRunIds).toHaveLength(2);
        expect(new Set(savedRunIds).size).toBe(1);
        expect(stateWithGap.branchRuns).toHaveLength(1);
        expect(screen.getByTestId('stage-host').getAttribute('data-insertions')).toBe('1');
      }
      return;
    }
    releaseRequest?.();
    await waitFor(() => expect(screen.getByTestId("stage-host")).toBeTruthy());
    expect(screen.getByTestId("stage-host").getAttribute("data-insertions")).toBe("1");
  });

  it("enters the main course directly when prerequisite analysis explicitly requires no pretest", () => {
    const courseWithoutPretest = structuredClone(course) as Course;
    delete courseWithoutPretest.aiLearningProgress!["student-1"].adaptiveLearning!.pretestCompletedAt;
    courseWithoutPretest.content.adaptiveLearningPlan!.pretest.questions = [];
    courseWithoutPretest.content.adaptiveLearningPlan!.prerequisiteKnowledgePoints = [];
    courseWithoutPretest.content.adaptiveLearningPlan!.prerequisiteAnalysis = {
      summary: "本课从必要基础开始教学。",
      decisions: [{
        targetKnowledgePointId: "reinforcement-learning",
        decision: "teach-in-main-course",
        prerequisiteKnowledgePointIds: [],
        rationale: "这是本课新授内容。",
      }],
    };

    render(
      <AdaptiveAiLearningRuntime
        backHref="/student/course-1"
        classroomId="main-classroom"
        course={courseWithoutPretest}
        studentId="student-1"
        studentName="张三"
      />,
    );

    expect(screen.getByTestId("stage-host")).toBeTruthy();
    expect(screen.queryByText("开始学习")).toBeNull();
  });

  it("does not expose a legacy pretest that never passed prerequisite-boundary review", () => {
    const legacyCourse = structuredClone(course) as Course;
    delete legacyCourse.content.adaptiveLearningPlan!.prerequisiteSemanticReview;
    delete legacyCourse.aiLearningProgress!["student-1"].adaptiveLearning!.pretestCompletedAt;
    legacyCourse.content.adaptiveLearningPlan!.pretest.questions = [{
      id: "legacy-fake-pretest",
      type: "single-choice",
      prompt: "‘猫喜欢鱼’中的‘喜欢’是什么词性？",
      options: ["名词", "动词", "形容词", "副词"],
      correctOptionIndex: 1,
      knowledgePointIds: ["fake-prerequisite"],
    }];

    render(
      <AdaptiveAiLearningRuntime
        backHref="/student/course-1"
        classroomId="main-classroom"
        course={legacyCourse}
        studentId="student-1"
        studentName="张三"
      />,
    );

    expect(screen.getByTestId("stage-host")).toBeTruthy();
    expect(screen.queryByText("‘猫喜欢鱼’中的‘喜欢’是什么词性？")).toBeNull();
  });

  it("restores a ready companion micro lesson inside the same main player", () => {
    const courseWithMicroLesson = structuredClone(course) as Course;
    courseWithMicroLesson.aiLearningProgress!["student-1"].adaptiveLearning = {
      ...adaptiveState,
      microLessons: [{
        id: "lesson-1",
        stageKey: "proposal",
        topic: "证据可信度",
        decision: "systematic-lesson",
        rationale: "需要系统讲解",
        classroomId: "micro-classroom",
        status: "ready",
        createdAt: "2026-07-26T00:00:00.000Z",
      }],
    };

    render(
      <AdaptiveAiLearningRuntime
        backHref="/student/course-1"
        classroomId="main-classroom"
        course={courseWithMicroLesson}
        studentId="student-1"
        studentName="张三"
      />,
    );

    expect(screen.getAllByTestId("stage-host")).toHaveLength(1);
    expect(screen.getByTestId("stage-host").getAttribute("data-insertions")).toBe("1");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not insert a resource that exceeds the live AI-stage remainder", async () => {
    const timedCourse = structuredClone(course) as Course;
    timedCourse.uiState = {
      classroomTiming: {
        schemaVersion: 1,
        status: "paused",
        sessionStartedAt: "2026-07-28T01:00:00.000Z",
        activeStageKey: "ai-learning",
        pausedAt: "2026-07-28T01:01:00.000Z",
        updatedAt: "2026-07-28T01:01:00.000Z",
        stages: [{
          stageKey: "ai-learning",
          label: "AI 授知",
          basePlannedSec: 120,
          adjustmentSec: 0,
          elapsedSec: 60,
          status: "active",
          startedAt: "2026-07-28T01:00:00.000Z",
        }],
      },
    };
    const fetchMock = vi.fn(async () => Response.json({ state: adaptiveState }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AdaptiveAiLearningRuntime
        backHref="/student/course-1"
        classroomId="main-classroom"
        course={timedCourse}
        studentId="student-1"
        studentName="张三"
      />,
    );
    fireEvent.click(screen.getByText("main-classroom"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId("stage-host").getAttribute("data-insertions")).toBe("0");
  });
});
