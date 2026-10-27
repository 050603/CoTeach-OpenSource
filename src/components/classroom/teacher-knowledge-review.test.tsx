import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course, CourseUiState, StudentAiProgress } from "@/lib/session/types";
import type { Scene } from "@openmaic/lib/types/stage";
import { buildTeacherQuestionCatalog, buildTeacherQuestionReview } from "@/lib/classroom/teacher-question-review";
import { TeacherClassroomReview } from "./teacher-knowledge-review";

const CHAPTER_FOCUS = { sequence: 0, mode: "chapters" as const };

const session = vi.hoisted(() => ({ setUiState: vi.fn(), addActivity: vi.fn() }));
vi.mock("@/lib/session/store", () => ({ useSession: () => session }));
vi.mock("@/lib/realtime/projection-controller", () => ({ ownsProjection: (state?: CourseUiState) => state?.projectionController?.clientId === "mine", projectionClientId: () => "mine" }));
vi.mock("@/components/openmaic-bridge/openmaic-resource-player", () => ({ OpenMaicResourcePlayer: ({ sceneId, onPlaybackStateChange }: { sceneId: string; onPlaybackStateChange?: (state: unknown) => void }) => <div data-testid="resource-player">页面 {sceneId}<button onClick={() => onPlaybackStateChange?.({ engineMode: "idle", snapshot: { sceneId, actionIndex: 1, sceneIndex: 0, consumedDiscussions: [] } })}>课件交互</button></div> }));

const outlines = ["p1", "p1", "p0", "p2", "p3", "p4", "p5"].map((pointId, index) => ({ id: `outline-${index}`, type: "slide", title: `讲解页${index + 1}`, stageKey: "ai-learning", audience: "student" as const, knowledgePointIds: [pointId], order: index }));
const scenes = outlines.map((outline, index) => ({ id: `scene-${index}`, outlineId: outline.id, title: outline.title, type: "slide", content: { type: "slide", canvas: { elements: [] } } }));

function courseFixture(): Course {
  const students = Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, name: `学生${index}`, stageProgress: {} }));
  const progress = Object.fromEntries(students.slice(0, 3).map((student, studentIndex) => [student.id, {
    classroomId: "classroom", studentId: student.id, currentSceneIndex: 0, totalScenes: 7, completedScenes: [], lastActiveAt: "2026-10-19", masteryLevel: "in-progress",
    knowledgeLectureAttempts: [{ id: `attempt-${student.id}`, quizOutlineId: "quiz", sectionId: "chapter-a", runtimeSceneId: "quiz-scene", score: studentIndex === 0 ? 22 : 20, maxScore: studentIndex === 0 ? 70 : 60, submittedAt: "2026-10-19", gradingSource: "server", gradingStatus: "graded", knowledgePointIds: [],
      questions: Array.from({ length: studentIndex === 0 ? 7 : 6 }, (_, index) => ({ questionId: `q${index}`, prompt: `解释概念${index}`, referenceAnswer: `保存的参考说明${index}`, answer: "回答", points: 10, earned: index === 0 ? 10 : 2, gradingStatus: "graded", correct: index === 0, feedback: index ? "概念混淆" : "正确", knowledgePointIds: [`p${index}`] })),
    }],
  } as StudentAiProgress]));
  return { id: "course", status: "teaching", aiLearningClassroomId: "classroom", students, aiLearningProgress: progress,
    content: { knowledgePoints: Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, name: `知识点${index}`, description: `重点${index}` })), _openmaicSceneOutlines: outlines,
      knowledgeLectureSections: [{ id: "chapter-a", title: "第一章", order: 0, knowledgePointIds: ["p0", "p1"], sceneOutlineIds: ["outline-0", "outline-1"] }, { id: "chapter-b", title: "第二章", order: 1, knowledgePointIds: ["p2", "p3"], sceneOutlineIds: ["outline-4"] }] },
  } as unknown as Course;
}

function mount(initial = courseFixture()) {
  let current = initial;
  function Host({ active = true }: { active?: boolean }) {
    const [course, setCourse] = useState(initial);
    current = course;
    session.setUiState.mockImplementation((_id, patch: Partial<CourseUiState>) => setCourse((previous) => ({ ...previous, uiState: { ...previous.uiState, ...patch, projectionController: { clientId: "mine", teacherId: "teacher" }, projectionVersion: (previous.uiState?.projectionVersion ?? 0) + 1 } })));
    return <TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active={active} />;
  }
  vi.mocked(fetch).mockImplementation(async (input) => String(input).endsWith("/projection")
    ? Response.json({ courseId: current.id, projectionVersion: current.uiState?.projectionVersion ?? 0,
      projectionController: current.uiState?.projectionController, teacherResourceProjection: current.uiState?.teacherResourceProjection })
    : Response.json({ classroom: { scenes } }));
  const view = render(<Host />);
  return { ...view, course: () => current, setActive: (active: boolean) => view.rerender(<Host active={active} />) };
}

beforeEach(() => {
  session.setUiState.mockReset();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ classroom: { scenes } })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function openRelatedCourseware() {
  fireEvent.click(screen.getByRole("button", { name: "查看相关课件" }));
  return within(screen.getByRole("region", { name: "课件预览" })).findByTestId("resource-player");
}

function returnToQuestions() {
  fireEvent.click(screen.getByRole("button", { name: "返回分析" }));
  const returnQuestion = screen.queryByRole("button", { name: "返回题目" });
  if (returnQuestion) fireEvent.click(returnQuestion);
}

function projectionReceiptLabel(mode: "forced" | "optional" = "forced") {
  return `投屏已提交 · ${mode === "optional" ? "自主查看" : "强制全屏"}`;
}

function knowledgeDirectoryOrder() {
  return within(screen.getByRole("complementary", { name: "讲解目录" })).getAllByRole("button")
    .map((button) => button.getAttribute("aria-label")).filter((label) => label?.startsWith("知识点"));
}

function chapterDirectoryOrder() {
  return within(screen.getByRole("complementary", { name: "讲解目录" })).getAllByRole("button")
    .map((button) => button.getAttribute("aria-label")).filter((label) => !label?.startsWith("查看第 "));
}

describe("按知识点补讲", () => {
  it("defaults to recommendations first and separates teaching, review feedback and actionable resources", async () => {
    const course = courseFixture();
    course.content.knowledgePoints[1].keyInfo = "区分现象与证据";
    course.content.knowledgePoints[1].masteryBoundary = "能用证据完成判断";
    render(<TeacherClassroomReview course={course} active />);
    expect(screen.getByRole("button", { name: "按知识点补讲" })).toHaveAttribute("aria-pressed", "true");
    expect(knowledgeDirectoryOrder()).toEqual(["知识点1", "知识点2", "知识点3", "知识点4", "知识点5", "知识点0", "知识点6", "知识点7"]);
    expect(screen.getByRole("button", { name: "知识点1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "补讲依据" })).not.toBeInTheDocument();
    expect(screen.queryByText("为什么需要关注")).not.toBeInTheDocument();
    expect(screen.queryByText(/已有足够作答证据/)).not.toBeInTheDocument();
    expect(screen.queryByText(/统计口径与推荐依据/)).not.toBeInTheDocument();
    expect(screen.queryByText(/未达标 3 \/ 有效作答 3/)).not.toBeInTheDocument();
    const teaching = screen.getByRole("region", { name: "补讲重点" });
    expect(teaching).toHaveTextContent("重点1");
    expect(teaching).toHaveTextContent("区分现象与证据");
    expect(teaching).toHaveTextContent("能用证据完成判断");
    expect(within(teaching).getByRole("heading", { name: "建议讲法" })).toBeInTheDocument();
    expect(within(teaching).getByRole("heading", { name: "讲解要点" })).toBeInTheDocument();
    const feedback = screen.getByRole("region", { name: "评阅提示" });
    expect(feedback).toHaveTextContent("概念理解错误");
    expect(feedback).toHaveTextContent("3 人");
    const feedbackDetails = feedback.querySelector("details")!;
    expect(feedbackDetails).not.toHaveAttribute("open");
    fireEvent.click(feedbackDetails.querySelector("summary")!);
    expect(within(feedback).getByText("概念混淆")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "知识点关联题目" })).getByRole("button", { name: "查看关联题目" })).toBeEnabled();
    expect(within(screen.getByRole("region", { name: "知识点关联课件" })).getByRole("button", { name: "查看相关课件" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "题目讲解" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "课件预览" })).not.toBeInTheDocument();
    expect(session.setUiState).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("keeps all points in teaching order without data and offers manual teaching rather than declaring mastery", async () => {
    const course = courseFixture();
    course.aiLearningProgress = {};
    render(<TeacherClassroomReview course={course} active />);
    expect(knowledgeDirectoryOrder()).toEqual(Array.from({ length: 8 }, (_, index) => `知识点${index}`));
    expect(screen.getByRole("button", { name: "知识点0" })).toHaveTextContent("暂无有效作答");
    expect(screen.queryByRole("region", { name: "补讲依据" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看关联题目" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "查看相关课件" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "知识点7" }));
    expect(within(screen.getByRole("region", { name: "知识点关联课件" })).getByText("暂无关联课件")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "浏览全部课件" }));
    expect(within(screen.getByRole("dialog")).getAllByRole("button", { name: /预览第/ })).toHaveLength(7);
    expect(session.setUiState).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("shows a compact excerpt of a long teaching point and reveals its full original text on demand", async () => {
    const course = courseFixture();
    const description = "先辨别观察到的现象，再列出能够支持判断的具体证据，最后说明结论成立的条件与适用边界。".repeat(6);
    course.content.knowledgePoints[1].description = description;
    render(<TeacherClassroomReview course={course} active />);
    const teaching = screen.getByRole("region", { name: "补讲重点" });
    const fullText = within(teaching).getByText(description, { exact: true });
    const details = fullText.closest("details")!;
    const summary = details.querySelector("summary")!;
    const excerpt = Array.from(description).slice(0, 90).join("");
    expect(details).not.toHaveAttribute("open");
    expect(summary).toHaveTextContent(`${excerpt}… 展开`);
    expect(fullText).not.toBeVisible();
    fireEvent.click(summary);
    await waitFor(() => expect(summary).toHaveTextContent(/^收起$/));
    expect(details).toHaveAttribute("open");
    expect(fullText).toBeVisible();
    expect(fullText.textContent).toBe(description);
    fireEvent.click(summary);
    await waitFor(() => expect(summary).toHaveTextContent(`${excerpt}… 展开`));
    expect(details).not.toHaveAttribute("open");
    expect(fullText).not.toBeVisible();
    expect(session.setUiState).not.toHaveBeenCalled();
  });

  it("distinguishes insufficient samples from no responses and no shared issue", async () => {
    render(<TeacherClassroomReview course={courseFixture()} active />);
    fireEvent.click(screen.getByRole("button", { name: "知识点6" }));
    expect(screen.getByRole("button", { name: "知识点6" })).toHaveTextContent("样本不足");
    expect(screen.queryByText(/推荐至少需要/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "知识点7" }));
    expect(screen.getByRole("button", { name: "知识点7" })).toHaveTextContent("暂无有效作答");
    fireEvent.click(screen.getByRole("button", { name: "知识点0" }));
    expect(screen.getByRole("button", { name: "知识点0" })).toHaveTextContent("暂未发现共性问题");
    expect(screen.queryByText(/未达标 0 \/ 有效作答/)).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("updates live evidence without changing the selected point or ordering until the teacher refreshes", async () => {
    const course = courseFixture();
    const view = render(<TeacherClassroomReview course={course} active />);
    fireEvent.click(screen.getByRole("button", { name: "知识点4" }));
    const order = knowledgeDirectoryOrder();
    const updated = structuredClone(course);
    for (const entry of Object.values(updated.aiLearningProgress!)) {
      const questions = entry.knowledgeLectureAttempts![0].questions;
      questions[0].earned = 0; questions[0].correct = false;
      questions[1].earned = 10; questions[1].correct = true;
    }
    view.rerender(<TeacherClassroomReview course={updated} active={false} />);
    view.rerender(<TeacherClassroomReview course={updated} active />);
    expect(knowledgeDirectoryOrder()).toEqual(order);
    expect(screen.getByRole("button", { name: "知识点1" })).toHaveTextContent("暂未发现共性问题");
    expect(screen.getByRole("button", { name: "知识点0" })).toHaveTextContent("建议补讲");
    expect(screen.getByRole("button", { name: "知识点4" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "更新推荐排序" }));
    expect(knowledgeDirectoryOrder()[0]).toBe("知识点0");
    expect(screen.getByRole("button", { name: "知识点4" })).toHaveAttribute("aria-pressed", "true");
    expect(session.setUiState).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("links a chapter question to knowledge teaching and restores the same question and expanded details", async () => {
    render(<TeacherClassroomReview course={courseFixture()} active />);
    fireEvent.click(screen.getByRole("button", { name: "按章节查题" }));
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    fireEvent.click(screen.getByRole("button", { name: "查看原始作答" }));
    await screen.findByText("保存的参考说明2");
    fireEvent.click(screen.getByRole("button", { name: "补讲知识点：知识点2" }));
    expect(screen.getByRole("button", { name: "按知识点补讲" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "知识点2", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "补讲重点" })).toHaveTextContent("重点2");
    fireEvent.click(screen.getByRole("button", { name: "返回题目" }));
    expect(screen.getByRole("heading", { name: "解释概念2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏答案与解析" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "收起原始作答" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    fireEvent.click(screen.getByRole("button", { name: "第一章" }));
    expect(screen.getByRole("heading", { name: "解释概念2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏答案与解析" })).toHaveAttribute("aria-expanded", "true");
    expect(session.setUiState).not.toHaveBeenCalled();
  });

  it("opens the exact associated question across chapters and returns through its preview without losing the point", async () => {
    const course = courseFixture();
    const original = course.aiLearningProgress!.s0.knowledgeLectureAttempts![0];
    course.aiLearningProgress!.s0.knowledgeLectureAttempts!.push({ ...original, id: "another-section", sectionId: "chapter-b", quizOutlineId: "quiz-b", runtimeSceneId: "quiz-scene-b",
      questions: [{ ...original.questions[1], questionId: "cross-chapter", prompt: "第二章关联知识点1的原题" }] });
    render(<TeacherClassroomReview course={course} active />);
    const questions = screen.getByRole("region", { name: "知识点关联题目" });
    expect(questions).toHaveTextContent("第一章");
    expect(questions).toHaveTextContent("第二章");
    fireEvent.click(within(questions).getByRole("button", { name: /第二章关联知识点1的原题/ }));
    expect(screen.getByRole("heading", { name: "第二章关联知识点1的原题" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "选择讲解题目" })).toHaveDisplayValue(/第二章关联知识点1的原题/);
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    expect(await openRelatedCourseware()).toHaveTextContent("scene-0");
    fireEvent.click(screen.getByRole("button", { name: "返回题目" }));
    expect(screen.getByRole("heading", { name: "第二章关联知识点1的原题" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏答案与解析" })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "返回知识点" }));
    expect(screen.getByRole("button", { name: "知识点1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "补讲重点" })).toBeVisible();
    expect(session.setUiState).not.toHaveBeenCalled();
  });
});

it("isolates unassigned questions from all configured chapters", () => {
  const course = courseFixture();
  const original = course.aiLearningProgress!.s0.knowledgeLectureAttempts![0];
  course.aiLearningProgress!.s0.knowledgeLectureAttempts!.push({ ...original,
    id: "unassigned-attempt", sectionId: "", quizOutlineId: "unassigned-quiz", runtimeSceneId: "unassigned-scene",
    questions: [{ ...original.questions[0], questionId: "unassigned-question", prompt: "未归属的题目" }],
  });
  render(<TeacherClassroomReview course={course} active focus={{ sequence: 0, mode: "chapters" }} />);
  fireEvent.click(screen.getByRole("button", { name: "未归属章节" }));
  expect(screen.getByRole("heading", { name: "未归属的题目" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "解释概念1" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下一题" })).toBeDisabled();
});

describe("外部题目定位与题目目录降级", () => {
  it("opens an externally focused exact row in its own chapter without requiring a chapter ID", async () => {
    const course = courseFixture();
    const original = course.aiLearningProgress!.s0.knowledgeLectureAttempts![0];
    course.aiLearningProgress!.s0.knowledgeLectureAttempts!.push({ ...original, id: "second-chapter-attempt", sectionId: "chapter-b",
      quizOutlineId: "second-quiz", runtimeSceneId: "second-quiz-scene",
      questions: [{ ...original.questions[1], questionId: "external-question", prompt: "外部定位第二章原题" }] });
    const target = buildTeacherQuestionReview(course).rows.find((row) => row.snapshot.questionId === "external-question")!;
    const view = render(<TeacherClassroomReview course={course} active />);
    expect(screen.getByRole("button", { name: "按知识点补讲" })).toHaveAttribute("aria-pressed", "true");
    view.rerender(<TeacherClassroomReview course={course} active focus={{ sequence: 1, questionId: target.id }} />);
    expect(screen.getByRole("button", { name: "按章节查题" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "第二章" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "外部定位第二章原题" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "讲解目录" }).parentElement).toHaveAttribute("data-mobile-detail", "true");
    expect(session.setUiState).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("waits for the async catalog before applying an exact unsubmitted question focus", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const course = courseFixture();
    course.content.knowledgeLectureSections![1].quizOutlineId = "new-second-quiz";
    const quiz: Scene = { id: "new-second-scene", outlineId: "new-second-quiz", title: "第二章小测", type: "quiz",
      content: { type: "quiz", questions: [{ id: "unsubmitted-target", type: "single", question: "尚未作答的外部定位原题",
        options: [{ value: "A", label: "第一项" }, { value: "B", label: "第二项" }], answer: ["B"], points: 10, knowledgePointIds: ["p2"] }] } } as Scene;
    const loadedScenes = [...scenes, quiz] as Scene[];
    const target = (await buildTeacherQuestionCatalog(course, loadedScenes)).rows.find((row) => row.snapshot.questionId === "unsubmitted-target")!;
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    render(<TeacherClassroomReview course={course} active focus={{ sequence: 1, questionId: target.id }} />);
    expect(screen.getByRole("button", { name: "按知识点补讲" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "尚未作答的外部定位原题" })).not.toBeInTheDocument();
    await act(async () => resolve(Response.json({ classroom: { scenes: loadedScenes } })));
    await screen.findByRole("heading", { name: "尚未作答的外部定位原题" });
    expect(screen.getByRole("button", { name: "按章节查题" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "第二章" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("本题作答情况")).toHaveTextContent("未作答");
    expect(screen.getByLabelText("本题作答情况")).toHaveTextContent("已提交 0 人");
    const questionPreview = within(screen.getByRole("complementary", { name: "讲解目录" })).getByRole("button", { name: "查看第 1 题：尚未作答的外部定位原题" });
    expect(questionPreview).toHaveTextContent("未作答");
    expect(within(questionPreview).getByRole("img")).toHaveAccessibleName(/未作答/);
    expect(questionPreview).not.toHaveTextContent(/答错|0\/0/);
    expect(screen.queryByRole("button", { name: "查看原始作答" })).not.toBeInTheDocument();
    expect(session.setUiState).not.toHaveBeenCalled();
  });

  it("keeps saved questions and their live grades current while the original catalog remains unavailable", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 503 }));
    const course = courseFixture();
    const view = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    await screen.findByText("完整题目目录未加载，已保存的作答仍可查看。");
    expect(screen.getByRole("heading", { name: "解释概念1" })).toBeInTheDocument();
    expect(screen.getByLabelText("本题作答情况")).toHaveTextContent("答错 3/3 人");
    const updated = structuredClone(course);
    for (const entry of Object.values(updated.aiLearningProgress!)) {
      entry.knowledgeLectureAttempts![0].questions[1].earned = 10;
      entry.knowledgeLectureAttempts![0].questions[1].correct = true;
    }
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={updated} active />);
    expect(screen.getByRole("heading", { name: "解释概念1" })).toBeInTheDocument();
    expect(screen.getByLabelText("本题作答情况")).toHaveTextContent("答错 0/3 人");
    expect(screen.getByText("完整题目目录未加载，已保存的作答仍可查看。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试加载题目目录" })).toBeEnabled();
    expect(session.setUiState).not.toHaveBeenCalled();
  });
});

describe("按章节讲题与相关课件", () => {
  it("opens the chapter directory explicitly and starts with its first wrong question", () => {
    render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={courseFixture()} active />);
    const directory = screen.getByRole("complementary", { name: "讲解目录" });
    expect(chapterDirectoryOrder()).toEqual(["第一章", "第二章"]);
    expect(within(directory).getByRole("button", { name: "第一章" })).toHaveAttribute("aria-pressed", "true");
    expect(within(directory).getByRole("button", { name: "第一章" })).toHaveTextContent("7 题");
    expect(within(directory).getAllByRole("button", { name: /查看第 \d+ 题：/ })).toHaveLength(7);
    const selectedQuestion = within(directory).getByRole("button", { name: "查看第 2 题：解释概念1" });
    expect(selectedQuestion).toHaveAttribute("aria-current", "true");
    expect(selectedQuestion).toHaveTextContent("3/3");
    expect(within(selectedQuestion).getByRole("img")).toHaveAccessibleName(/答错 3 人/);
    expect(screen.getByRole("heading", { name: "解释概念1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按知识点补讲" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "按章节查题" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("group", { name: "讲解题目范围" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText("统计口径")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "查看相关课件" })).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "课件预览" })).not.toBeInTheDocument();
    expect(session.setUiState).not.toHaveBeenCalled();
  });

  it("opens the exact question from a chapter preview and tracks paging without resetting a live-updated selection", async () => {
    const course = courseFixture();
    const view = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    const directory = screen.getByRole("complementary", { name: "讲解目录" });
    const first = within(directory).getByRole("button", { name: "查看第 1 题：解释概念0" });
    const second = within(directory).getByRole("button", { name: "查看第 2 题：解释概念1" });
    fireEvent.click(first);
    expect(screen.getByRole("heading", { name: "解释概念0" })).toBeInTheDocument();
    expect(first).toHaveAttribute("aria-current", "true");
    expect(second).not.toHaveAttribute("aria-current", "true");
    fireEvent.click(second);
    expect(screen.getByRole("heading", { name: "解释概念1" })).toBeInTheDocument();
    expect(second).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    const third = within(directory).getByRole("button", { name: "查看第 3 题：解释概念2" });
    expect(third).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    const updated = structuredClone(course);
    for (const entry of Object.values(updated.aiLearningProgress!)) {
      entry.knowledgeLectureAttempts![0].questions[2].earned = 10;
      entry.knowledgeLectureAttempts![0].questions[2].correct = true;
    }
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={updated} active />);
    expect(third).toHaveAttribute("aria-current", "true");
    expect(third).toHaveTextContent("0/3");
    expect(screen.getByRole("heading", { name: "解释概念2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏答案与解析" })).toHaveAttribute("aria-expanded", "true");
    expect(session.setUiState).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("targets stable question versions when separate chapters and historical bodies share a question number", async () => {
    const course = courseFixture();
    course.aiLearningProgress!.s1.knowledgeLectureAttempts![0].questions[0].prompt = "第一章同题号另一版本";
    const original = course.aiLearningProgress!.s0.knowledgeLectureAttempts![0];
    course.aiLearningProgress!.s0.knowledgeLectureAttempts!.push({ ...original, id: "chapter-b-attempt", sectionId: "chapter-b", quizOutlineId: "quiz-b", runtimeSceneId: "quiz-scene-b",
      questions: [{ ...original.questions[0], prompt: "第二章同题号原题" }, { ...original.questions[1], prompt: "第二章另一题" }] });
    const rows = buildTeacherQuestionReview(course).rows;
    render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    for (const prompt of ["第二章同题号原题", "第一章同题号另一版本", "解释概念0"]) {
      fireEvent.click(screen.getByRole("button", { name: `查看第 1 题：${prompt}` }));
      expect(screen.getByRole("heading", { name: prompt })).toBeInTheDocument();
      expect(screen.getByRole("combobox", { name: "选择讲解题目" })).toHaveValue(rows.find((row) => row.snapshot.prompt === prompt)!.id);
      expect(screen.getByRole("button", { name: `查看第 1 题：${prompt}` })).toHaveAttribute("aria-current", "true");
    }
    expect(session.setUiState).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("shows pending and unverified answers in the preview without labelling them wrong", async () => {
    const course = courseFixture();
    for (const entry of Object.values(course.aiLearningProgress!)) {
      entry.knowledgeLectureAttempts![0].questions[0].gradingStatus = "pending";
      entry.knowledgeLectureAttempts![0].questions[1].earned = Number.NaN;
    }
    render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    const directory = screen.getByRole("complementary", { name: "讲解目录" });
    for (const [name, status] of [["查看第 1 题：解释概念0", "待评"], ["查看第 2 题：解释概念1", "待核验"]]) {
      const question = within(directory).getByRole("button", { name });
      expect(question).toHaveTextContent(status);
      expect(question).not.toHaveTextContent(/答错|未达标|0\//);
      expect(within(question).getByRole("img")).toHaveAccessibleName(/答错 0 人，未评 3 人/);
    }
    expect(session.setUiState).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it("opens the selected question's related slides and returns to its exact position, revealed answer and source notice", async () => {
    render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={courseFixture()} active />);
    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    fireEvent.click(screen.getByRole("button", { name: "显示答案与解析" }));
    await screen.findByText(/历史作答未保存原题版本/);
    expect(await openRelatedCourseware()).toHaveTextContent("scene-3");
    fireEvent.click(screen.getByRole("button", { name: "返回题目" }));
    expect(screen.getByRole("heading", { name: "解释概念2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "隐藏答案与解析" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/历史作答未保存原题版本/)).toBeInTheDocument();
    expect(screen.getByText("保存的参考说明2")).toBeInTheDocument();
    expect(session.setUiState).not.toHaveBeenCalled();
  });

  it("opens an empty chapter's saved courseware explicitly and does not guess missing associations", async () => {
    const course = courseFixture();
    const view = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    expect(screen.queryByRole("region", { name: "课件预览" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看本章课件" }));
    expect(await within(screen.getByRole("region", { name: "课件预览" })).findByTestId("resource-player")).toHaveTextContent("scene-4");
    expect(screen.getByRole("button", { name: "返回题目" })).toBeInTheDocument();
    const noBinding = structuredClone(course);
    noBinding.content.knowledgeLectureSections![1].sceneOutlineIds = [];
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={noBinding} active />);
    expect(within(screen.getByRole("region", { name: "课件预览" })).queryByTestId("resource-player")).not.toBeInTheDocument();
    expect(screen.getByText(/暂无关联课件，可点击/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "投屏" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "选择课件" })).toBeEnabled();
    expect(session.setUiState).not.toHaveBeenCalled();
  });

  it("loads shared resources once while previewing related pages, changing chapters and hiding the view", async () => {
    const course = courseFixture();
    const view = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    expect(await openRelatedCourseware()).toHaveTextContent("scene-0");
    fireEvent.click(screen.getByRole("button", { name: "下一页课件" }));
    expect(within(screen.getByRole("region", { name: "课件预览" })).getByTestId("resource-player")).toHaveTextContent("scene-1");
    fireEvent.click(screen.getByRole("button", { name: "返回题目" }));
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active={false} />);
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    fireEvent.click(screen.getByRole("button", { name: "第一章" }));
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input).startsWith("/api/openmaic/classroom?"))).toHaveLength(1);
    expect(session.setUiState).not.toHaveBeenCalled();
  });

  it("preserves the selected chapter and chapter order across grading updates and hidden views", () => {
    const course = courseFixture();
    const view = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    const updated = structuredClone(course);
    for (const entry of Object.values(updated.aiLearningProgress!)) entry.knowledgeLectureAttempts![0].questions[0].earned = 0;
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={updated} active={false} />);
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={updated} active />);
    expect(screen.getByRole("button", { name: "第二章" })).toHaveAttribute("aria-pressed", "true");
    expect(chapterDirectoryOrder()).toEqual(["第一章", "第二章"]);
  });

  it("chooses the current first chapter needing review when a previously hidden view is first opened", () => {
    const course = courseFixture();
    for (const entry of Object.values(course.aiLearningProgress!)) entry.knowledgeLectureAttempts![0].sectionId = "chapter-b";
    const view = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={{ ...course, aiLearningProgress: {} }} active={false} />);
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    expect(screen.getByRole("button", { name: "第二章" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "解释概念1" })).toBeInTheDocument();
  });

  it("offers original-course manual page selection when no points or chapter bindings exist", async () => {
    const course = courseFixture();
    course.content.knowledgePoints = [];
    course.aiLearningProgress = {};
    course.content.knowledgeLectureSections![0].sceneOutlineIds = [];
    render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    fireEvent.click(screen.getByRole("button", { name: "查看本章课件" }));
    fireEvent.click(screen.getByRole("button", { name: "选择课件" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "预览第 3 页：讲解页3" }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "课件预览" })).getByTestId("resource-player")).toHaveTextContent("scene-2"));
    expect(screen.getByRole("button", { name: "投屏" })).toBeEnabled();
    expect(session.setUiState).not.toHaveBeenCalled();
  });

  it("retries failed classroom loading and aborts requests on removal", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }));
    const view = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={courseFixture()} active />);
    fireEvent.click(screen.getByRole("button", { name: "查看相关课件" }));
    await within(screen.getByRole("region", { name: "课件预览" })).findByText("课件加载失败（HTTP 503）");
    fireEvent.click(screen.getByRole("button", { name: "重试加载课件" }));
    await within(screen.getByRole("region", { name: "课件预览" })).findByTestId("resource-player");
    view.unmount();
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const pending = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={courseFixture()} active />);
    const signal = fetchMock.mock.calls.at(-1)![1]!.signal;
    pending.unmount();
    expect(signal!.aborted).toBe(true);
  });

  it("keeps projection disabled when resources load through a legacy classroom ID without an active AI classroom", async () => {
    const course = courseFixture();
    delete course.aiLearningClassroomId;
    course.content._openmaicClassroomId = "classroom";
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    fireEvent.click(screen.getByRole("button", { name: "查看相关课件" }));
    await act(async () => resolve(Response.json({ classroom: { scenes } })));
    expect(screen.getByRole("button", { name: "投屏" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    expect(session.setUiState).not.toHaveBeenCalled();
  });
});

describe("讲题、课件预览与学生投屏隔离", () => {
  it.each(["forced", "optional"] as const)("starts %s projection explicitly, turns related pages and preserves progress", async (mode) => {
    const course = courseFixture();
    const initialProgress = structuredClone(course.aiLearningProgress);
    const view = mount(course);
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "下一页课件" }));
    fireEvent.click(within(screen.getByRole("region", { name: "课件预览" })).getByRole("button", { name: "课件交互" }));
    expect(session.setUiState).not.toHaveBeenCalled();
    expect(screen.queryByRole("combobox", { name: "学生端展示方式" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "投屏设置" }));
    fireEvent.change(screen.getByRole("combobox", { name: "学生端展示方式" }), { target: { value: mode } });
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    expect(view.course().uiState?.teacherResourceProjection).toMatchObject({ sceneId: "scene-1", mode, engineMode: "idle", playback: { actionIndex: 0 } });
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    await screen.findByText(projectionReceiptLabel(mode));
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(view.course().uiState?.teacherResourceProjection?.sceneId).toBe("scene-0");
    await screen.findByText(projectionReceiptLabel(mode));
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await screen.findByText(projectionReceiptLabel(mode));
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    returnToQuestions();
    fireEvent.click(screen.getByRole("button", { name: "第二章" }));
    fireEvent.click(screen.getByRole("button", { name: "查看本章课件" }));
    expect(within(screen.getByRole("region", { name: "课件预览" })).getByTestId("resource-player")).toHaveTextContent("scene-4");
    expect(view.course().uiState?.teacherResourceProjection?.sceneId).toBe("scene-1");
    fireEvent.click(screen.getByRole("button", { name: "停止投屏" }));
    expect(view.course().uiState?.teacherResourceProjection).toBeNull();
    expect(view.course().aiLearningProgress).toEqual(initialProgress);
  });

  it("uses the full original course order when projecting a manually selected other page", async () => {
    const view = mount();
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "选择课件" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "预览第 3 页：讲解页3" }));
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    await screen.findByText(projectionReceiptLabel());
    expect(screen.getByRole("group", { name: "投屏翻页" })).toHaveTextContent("3/7");
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(view.course().uiState?.teacherResourceProjection?.sceneId).toBe("scene-3");
  });

  it("keeps the question selection if another workspace replaces the projected page", async () => {
    const view = mount();
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    returnToQuestions();
    act(() => session.setUiState("course", { teacherResourceProjection: {
      ...view.course().uiState!.teacherResourceProjection!, sceneId: "scene-2", title: "全班补讲 · 讲解页3",
    } }));
    expect(screen.getByRole("heading", { name: "解释概念1" })).toBeInTheDocument();
    expect(screen.getByText("当前投屏：讲解页3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看投屏" })).toBeInTheDocument();
  });

  it("keeps the active projection and stop action visible while reviewing questions", async () => {
    const view = mount();
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    returnToQuestions();
    await screen.findByText(projectionReceiptLabel());
    session.setUiState.mockClear();
    expect(screen.getByRole("heading", { name: "解释概念1" })).toBeInTheDocument();
    expect(screen.getByText("当前投屏：讲解页1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止投屏" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "当前投屏课件" })).not.toBeInTheDocument();
    expect(session.setUiState).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "停止投屏" }));
    expect(view.course().uiState?.teacherResourceProjection).toBeNull();
  });

  it("requests explicit takeover and never stops another controller's projection", async () => {
    const course = courseFixture();
    course.uiState = { projectionController: { clientId: "other", teacherId: "teacher" } };
    render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "接管并投屏" }));
    expect(session.setUiState).toHaveBeenCalledWith("course", { teacherResourceProjection: expect.objectContaining({ sceneId: "scene-0" }) }, { takeover: true });
    expect(screen.queryByRole("button", { name: "停止投屏" })).not.toBeInTheDocument();
  });

  it("confirms the authoritative projection receipt and syncs only the controlling projected player", async () => {
    const view = mount();
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    const projectedPlayer = screen.getByRole("region", { name: "当前投屏课件" });
    const player = within(projectedPlayer).getByTestId("resource-player");
    const startedAt = view.course().uiState?.teacherResourceProjection?.startedAt;
    expect(screen.getByText("正在确认投屏同步…")).toBeInTheDocument();
    expect(within(projectedPlayer).getByTestId("resource-player")).toHaveTextContent("scene-0");
    await screen.findByText(projectionReceiptLabel());
    fireEvent.click(within(projectedPlayer).getByRole("button", { name: "课件交互" }));
    expect(view.course().uiState?.teacherResourceProjection?.playback?.actionIndex).toBe(1);
    expect(view.course().uiState?.teacherResourceProjection?.startedAt).toBe(startedAt);
    expect(within(projectedPlayer).getByTestId("resource-player")).toBe(player);
  });

  it.each(["forced", "optional"] as const)("starts a new controlling player when the same page is explicitly projected again in %s mode", async (mode) => {
    const view = mount();
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    const surface = screen.getByRole("region", { name: "当前投屏课件" });
    const firstPlayer = within(surface).getByTestId("resource-player");
    const firstStartedAt = view.course().uiState?.teacherResourceProjection?.startedAt;
    await screen.findByText(projectionReceiptLabel());
    fireEvent.click(within(surface).getByRole("button", { name: "课件交互" }));
    expect(view.course().uiState?.teacherResourceProjection?.playback?.actionIndex).toBe(1);
    expect(within(surface).getByTestId("resource-player")).toBe(firstPlayer);
    returnToQuestions();
    await openRelatedCourseware();
    if (mode === "optional") {
      fireEvent.click(screen.getByRole("button", { name: "投屏设置" }));
      fireEvent.change(screen.getByRole("combobox", { name: "学生端展示方式" }), { target: { value: mode } });
    }
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    expect(view.course().uiState?.teacherResourceProjection).toMatchObject({ sceneId: "scene-0", mode, engineMode: "idle", playback: { actionIndex: 0 } });
    expect(view.course().uiState?.teacherResourceProjection?.startedAt).not.toBe(firstStartedAt);
    expect(within(screen.getByRole("region", { name: "当前投屏课件" })).getByTestId("resource-player")).not.toBe(firstPlayer);
    expect(firstPlayer).not.toBeInTheDocument();
    await screen.findByText(projectionReceiptLabel(mode));
  });

  it("keeps the same controlling player through return to questions, related preview, inactive views and reopening", async () => {
    const view = mount();
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    const surface = screen.getByRole("region", { name: "当前投屏课件" });
    const player = within(surface).getByTestId("resource-player");
    await screen.findByText(projectionReceiptLabel());
    session.setUiState.mockClear();
    returnToQuestions();
    expect(screen.getByRole("heading", { name: "解释概念1" })).toBeInTheDocument();
    expect(surface).not.toBeVisible();
    expect(within(surface).getByTestId("resource-player")).toBe(player);
    await openRelatedCourseware();
    expect(within(surface).getByTestId("resource-player")).toBe(player);
    view.setActive(false);
    expect(within(surface).getByTestId("resource-player")).toBe(player);
    view.setActive(true);
    fireEvent.click(screen.getByRole("button", { name: "查看投屏" }));
    expect(screen.getByRole("region", { name: "当前投屏课件" })).toBe(surface);
    expect(within(surface).getByTestId("resource-player")).toBe(player);
    expect(player).toBeVisible();
    expect(session.setUiState).not.toHaveBeenCalled();
  });

  it("does not retry an old confirmed projection after it is stopped outside this view", async () => {
    const course = courseFixture();
    const view = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    const projected = session.setUiState.mock.calls.at(-1)![1].teacherResourceProjection;
    const projectedCourse = { ...course, uiState: { teacherResourceProjection: projected, projectionVersion: 1, projectionController: { clientId: "mine", teacherId: "teacher" } } };
    vi.mocked(fetch).mockImplementation(async () => Response.json({ courseId: "course", projectionVersion: 1,
      projectionController: projectedCourse.uiState.projectionController, teacherResourceProjection: projected }));
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={projectedCourse} active />);
    returnToQuestions();
    await screen.findByText(projectionReceiptLabel());
    const reads = vi.mocked(fetch).mock.calls.length;
    vi.useFakeTimers();
    const stopped = { ...course, uiState: { teacherResourceProjection: null, projectionVersion: 2 } };
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={stopped} active={false} />);
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={stopped} active />);
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(reads);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试投屏同步" })).not.toBeInTheDocument();
  });

  it("restores the courseware preview if projection is stopped elsewhere while its player is open", async () => {
    mount();
    await openRelatedCourseware();
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    await screen.findByText(projectionReceiptLabel());
    act(() => session.setUiState("course", { teacherResourceProjection: null }));
    expect(screen.queryByRole("region", { name: "当前投屏课件" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "课件预览" })).getByTestId("resource-player")).toHaveTextContent("scene-0");
  });

  it("bounds failed receipt reads and offers a retry without reporting success", async () => {
    mount();
    await openRelatedCourseware();
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementation(async () => Response.json({ courseId: "wrong-course" }));
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    returnToQuestions();
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(screen.getByRole("alert")).toHaveTextContent("投屏状态所属课堂不匹配，请重试");
    expect(screen.getByRole("button", { name: "重试投屏同步" })).toBeInTheDocument();
    expect(screen.queryByText(projectionReceiptLabel())).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试投屏同步" }));
    expect(screen.getByText("正在确认投屏同步…")).toBeInTheDocument();
  });

  it("ignores a slow classroom-resource response from the previous classroom", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    const course = courseFixture();
    const view = render(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={course} active />);
    fireEvent.click(screen.getByRole("button", { name: "查看相关课件" }));
    view.rerender(<TeacherClassroomReview focus={CHAPTER_FOCUS} course={{ ...course, aiLearningClassroomId: "new-classroom" }} active />);
    await within(screen.getByRole("region", { name: "课件预览" })).findByTestId("resource-player");
    await act(async () => resolve(Response.json({ classroom: { scenes: [] } })));
    expect(within(screen.getByRole("region", { name: "课件预览" })).getByTestId("resource-player")).toHaveTextContent("scene-0");
  });
});
