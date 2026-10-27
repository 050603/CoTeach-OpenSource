import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollaborativePreparation } from "./collaborative-preparation";
import { FastCourseGenerator } from "./fast-course-generator";
import type { PreparationPlan, PreparationSessionSnapshot } from "@/lib/collaborative-preparation/types";
import type { Course } from "@/lib/session/types";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

function plan(): PreparationPlan {
  return {
    courseName: "校园数据分析", subject: "信息科技", grade: "初一", totalMinutes: 45,
    learnerContext: "学生会读取简单表格，尚未学习比较图表。", learningObjectives: ["根据数据选择合适图表并解释原因"],
    knowledgePoints: [{ id: "k1", name: "图表选择", depth: "能说明比较数量与观察变化的区别", teachingApproach: "比较校园用水量的两种图表" }],
    teachingApproach: "先比较实例，再独立选择并说明理由", teacherRequirements: ["保留校园生活情境"],
    stagePlan: { source: "collaborative-preparation", schemaVersion: 2, totalMinutes: 45, lessonCount: 1, minutesPerLesson: 45,
      drivingQuestion: "如何向同学解释校园用水变化？", projectTask: "制作带有解释的图表",
      stages: emptyResourcePackageDraft().stages.map((stage) => ({ ...stage, durationMin: 9, requirements: "分析校园数据", outputs: "图表与解释", teacherActions: "组织比较", aiActions: "追问选择依据" })),
      evaluationCriteria: "图表与数据一致，解释有依据", reflectionQuestions: ["图表选择如何影响理解？"],
      finalDeliverables: [{ id: "d1", name: "校园用水图表", format: "图片和文字", requirements: "包含数据来源与解释", required: true }],
    },
  };
}
function snapshot(patch: Partial<PreparationSessionSnapshot> = {}): PreparationSessionSnapshot {
  return {
    id: "session-1", revision: 2, status: "discussing", turns: [{ id: "turn-1", role: "user", content: "想让学生比较校园用水量", createdAt: "2026-10-23T00:00:00Z" }],
    currentQuestion: { id: "depth", prompt: "这节课希望学生解释到什么程度？", reason: "这会影响案例和检测的安排。", options: [
      { id: "basic", label: "读出图表信息", description: "重点识别数量，适合首次接触图表。" },
      { id: "compare", label: "比较并解释选择", description: "要求说明选择依据，需要更多讨论时间。" },
    ] },
    plan: plan(), fieldOrigins: { grade: "teacher-stated", teachingApproach: "ai-proposed" }, readyToConfirm: false, missingFields: [], suggestions: [],
    referenceIds: [], referenceMaterials: [], textbookSelections: [], confirmed: null, error: null, ...patch,
  };
}
function props() {
  return { courseId: "course-1", teacherId: "teacher-1", referenceMaterials: [], textbookSelections: [], sourceControls: <div>参考资料选择区</div>, generationSettings: <div>生成设置区</div>, onRestoreSources: vi.fn(), onConfirmed: vi.fn(async () => undefined) };
}

describe("CollaborativePreparation", () => {
  beforeEach(() => { vi.clearAllMocks(); window.sessionStorage.clear(); window.localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("starts from natural language and saves the submitted intent without starting generation", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (!init?.method) return Response.json({ session: null });
      calls.push(JSON.parse(String(init.body)));
      return Response.json({ session: snapshot() });
    }));
    const input = props(); render(<CollaborativePreparation {...input} />);
    await waitFor(() => expect(screen.getByLabelText("备课想法")).toBeEnabled());
    fireEvent.change(screen.getByLabelText("备课想法"), { target: { value: "我想上校园数据分析课" } });
    fireEvent.click(screen.getByRole("button", { name: "开始协同备课" }));
    expect(await screen.findByText("这节课希望学生解释到什么程度？")).toBeTruthy();
    expect(calls).toEqual([expect.objectContaining({ revision: 0, requestId: expect.any(String), message: "我想上校园数据分析课", referenceIds: [] })]);
    expect(input.onConfirmed).not.toHaveBeenCalled();
  });

  it("submits an entry idea once after loading a new session, even when parent props update", async () => {
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (!init?.method) return Response.json({ session: null });
      mutations.push(JSON.parse(String(init.body)));
      return Response.json({ session: snapshot() });
    }));
    const input = props();
    const consumed = vi.fn();
    const view = render(<CollaborativePreparation {...input} initialMessage="用校园用水数据认识图表" onInitialMessageConsumed={consumed} />);
    await screen.findByRole("heading", { name: "这节课希望学生解释到什么程度？" });
    expect(mutations).toEqual([expect.objectContaining({ revision: 0, message: "用校园用水数据认识图表", requestId: expect.any(String) })]);
    expect(consumed).toHaveBeenCalledOnce();
    view.rerender(<CollaborativePreparation {...input} onInitialMessageConsumed={consumed} />);
    expect(mutations).toHaveLength(1);
    expect(screen.getByLabelText("备课想法")).toHaveValue("");
    expect(input.onConfirmed).not.toHaveBeenCalled();
  });

  it("keeps an entry idea unsent when a server discussion already exists", async () => {
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method) mutations.push(JSON.parse(String(init.body)));
      return Response.json({ session: snapshot() });
    }));
    const consumed = vi.fn();
    render(<CollaborativePreparation {...props()} initialMessage="可能重复输入的首轮想法" onInitialMessageConsumed={consumed} />);
    await screen.findByRole("heading", { name: "这节课希望学生解释到什么程度？" });
    expect(screen.getByLabelText("备课想法")).toHaveValue("可能重复输入的首轮想法");
    expect(window.sessionStorage.getItem("openpbl:preparation-message:v1:teacher-1:course-1")).toBe("可能重复输入的首轮想法");
    expect(consumed).toHaveBeenCalledOnce();
    expect(mutations).toEqual([]);
  });

  it("retains a failed initial idea and retries the same request identity without an automatic retry", async () => {
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (!init?.method) return Response.json({ session: null });
      mutations.push(JSON.parse(String(init.body)));
      if (mutations.length === 1) throw new Error("首轮网络中断");
      return Response.json({ session: snapshot() });
    }));
    const input = props();
    const consumed = vi.fn();
    const view = render(<CollaborativePreparation {...input} initialMessage="从校园观察开始这节课" onInitialMessageConsumed={consumed} />);
    expect(await screen.findByText("首轮网络中断")).toBeVisible();
    expect(screen.getByLabelText("备课想法")).toHaveValue("从校园观察开始这节课");
    expect(window.sessionStorage.getItem("openpbl:preparation-message:v1:teacher-1:course-1")).toBe("从校园观察开始这节课");
    view.rerender(<CollaborativePreparation {...input} onInitialMessageConsumed={consumed} />);
    expect(mutations).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "重试本次提交" }));
    await screen.findByRole("heading", { name: "这节课希望学生解释到什么程度？" });
    expect(mutations).toHaveLength(2);
    expect(mutations[1]).toEqual(mutations[0]);
    expect(consumed).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("备课想法")).toHaveValue("");
    expect(input.onConfirmed).not.toHaveBeenCalled();
  });

  it("supports choosing an option with a personal explanation and a freeform alternative", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method) calls.push(JSON.parse(String(init.body)));
      return Response.json({ session: snapshot({ revision: calls.length + 2 }) });
    }));
    render(<CollaborativePreparation {...props()} />);
    fireEvent.click(await screen.findByRole("radio", { name: /比较并解释选择/ }));
    fireEvent.change(screen.getByLabelText("备课想法"), { target: { value: "但不涉及公式推导" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ revision: 2, selectedOptionId: "compare", message: "比较并解释选择\n补充：但不涉及公式推导" });
    await waitFor(() => expect(screen.getByRole("radio", { name: "其他／自己输入" })).toBeEnabled());
    fireEvent.click(screen.getByRole("radio", { name: "其他／自己输入" }));
    fireEvent.change(screen.getByLabelText("备课想法"), { target: { value: "我更希望学生先找出误导性的图表" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toMatchObject({ revision: 3, message: "我更希望学生先找出误导性的图表" });
    expect(calls[1]).not.toHaveProperty("selectedOptionId");
  });

  it("requires viewing the complete plan and an explicit confirmation before generation", async () => {
    const ready = snapshot({ status: "ready", readyToConfirm: true, currentQuestion: null });
    const confirmed = { sessionId: ready.id, revision: 3, confirmedAt: "2026-10-23T01:00:00Z", confirmedBy: "teacher-1", plan: plan(), referenceIds: [], textbookSelections: [] };
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (!init?.method) return Response.json({ session: ready });
      mutations.push(JSON.parse(String(init.body)));
      return Response.json({ session: { ...ready, revision: 3, status: "confirmed", confirmed } });
    }));
    const input = props(); render(<CollaborativePreparation {...input} />);
    await screen.findByRole("button", { name: "查看完整方案" });
    expect(input.onConfirmed).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "确认方案并开始生成" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看完整方案" }));
    expect(screen.getByLabelText("完整课程方案")).toHaveTextContent("45 分钟");
    expect(screen.getByLabelText("完整课程方案")).toHaveTextContent("图表与数据一致，解释有依据");
    expect(screen.getByLabelText("完整课程方案")).toHaveTextContent("校园用水图表");
    expect(input.onConfirmed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认方案并开始生成" }));
    await waitFor(() => expect(input.onConfirmed).toHaveBeenCalledWith(confirmed));
    expect(mutations).toEqual([expect.objectContaining({ action: "confirm", revision: 2 })]);
  });

  it("locks generation settings while confirmation is pending and preserves the selection after failure", async () => {
    const ready = snapshot({ status: "ready", readyToConfirm: true, currentQuestion: null });
    const mutations: Record<string, unknown>[] = [];
    let finishConfirmation!: (response: Response) => void;
    const pendingConfirmation = new Promise<Response>((resolve) => { finishConfirmation = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (!init?.method) return Response.json({ session: ready });
      mutations.push(JSON.parse(String(init.body)));
      return pendingConfirmation;
    }));
    const input = props();
    render(<CollaborativePreparation {...input} generationSettings={<fieldset><legend>生成范围</legend>
      <label><input type="radio" name="test-generation-scope" value="full-course" defaultChecked />完整课程</label>
      <label><input type="radio" name="test-generation-scope" value="test-lesson" />单节测试</label>
    </fieldset>} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看完整方案" }));
    const fullCourse = screen.getByRole("radio", { name: "完整课程" });
    const testLesson = screen.getByRole("radio", { name: "单节测试" });
    expect(testLesson).toBeEnabled();
    fireEvent.click(testLesson);
    expect(testLesson).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "确认方案并开始生成" }));

    await waitFor(() => expect(mutations).toEqual([expect.objectContaining({ action: "confirm", revision: 2 })]));
    expect(fullCourse).toBeDisabled();
    expect(testLesson).toBeDisabled();
    expect(screen.getByRole("button", { name: "确认方案并开始生成" })).toBeDisabled();
    expect(input.onConfirmed).not.toHaveBeenCalled();

    await act(async () => { finishConfirmation(Response.json({ error: "确认保存失败，请稍后重试" }, { status: 503 })); });
    expect(await screen.findByText("确认保存失败，请稍后重试")).toBeVisible();
    expect(fullCourse).toBeEnabled();
    expect(testLesson).toBeEnabled();
    expect(testLesson).toBeChecked();
    expect(fullCourse).not.toBeChecked();
    expect(screen.getByRole("button", { name: "确认方案并开始生成" })).toBeEnabled();
    expect(input.onConfirmed).not.toHaveBeenCalled();
  });

  it("keeps the plan concise and opens complete read-only details without losing the answer", async () => {
    const saved = snapshot();
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method) mutations.push(JSON.parse(String(init.body)));
      return Response.json({ session: saved });
    }));
    const input = props();
    render(<CollaborativePreparation {...input} />);
    const sidebar = screen.getByRole("complementary", { name: "课程方案摘要" });
    expect(await within(sidebar).findByText("校园数据分析")).toBeVisible();
    expect(within(sidebar).getByText("信息科技 · 初一 · 45 分钟")).toBeVisible();
    expect(within(sidebar).queryByText(saved.plan.stagePlan!.drivingQuestion!)).toBeNull();
    expect(within(sidebar).queryByText(saved.plan.learnerContext!)).toBeNull();
    fireEvent.change(screen.getByLabelText("备课想法"), { target: { value: "保留待提交的想法" } });
    fireEvent.click(screen.getByRole("radio", { name: /比较并解释选择/ }));
    fireEvent.click(within(sidebar).getByRole("button", { name: "查看阶段与成果" }));
    const dialog = screen.getByRole("dialog", { name: "课程方案详情" });
    const stageGroup = within(dialog).getByText("阶段与成果").closest("details")!;
    const overview = within(dialog).getByText("课程概况").closest("details")!;
    expect(stageGroup).toHaveAttribute("open");
    expect(overview).not.toHaveAttribute("open");
    expect(within(dialog).getByText(/图表与数据一致，解释有依据/)).toBeVisible();
    expect(within(dialog).getByText(/包含数据来源与解释/)).toBeVisible();
    expect(within(dialog).getAllByText(/教师行动：组织比较/)).toHaveLength(5);
    expect(within(dialog).queryByRole("button", { name: "确认方案并开始生成" })).toBeNull();
    fireEvent.click(within(dialog).getByText("课程概况"));
    expect(overview).toHaveAttribute("open");
    expect(stageGroup).not.toHaveAttribute("open");
    expect(within(overview).getByText("教师已明确")).toBeVisible();
    expect(within(overview).getAllByText("AI 建议 · 待确认")).toHaveLength(4);
    fireEvent.click(within(dialog).getByRole("button", { name: "返回备课" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("备课想法")).toHaveValue("保留待提交的想法");
    expect(screen.getByRole("radio", { name: /比较并解释选择/ })).toBeChecked();
    expect(mutations).toEqual([]);
    expect(input.onConfirmed).not.toHaveBeenCalled();
  });

  it.each([
    { requirements: undefined, description: "这部分还在讨论中，明确后会显示在这里。" },
    { requirements: [], description: "尚未提出特别要求，可在讨论中随时补充。" },
  ])("shows partial and optional information accurately: $description", async ({ requirements, description }) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ session: snapshot({ plan: { courseName: "尚在讨论的课", teacherRequirements: requirements }, missingFields: ["grade", "totalMinutes", "stagePlan"] }) })));
    render(<CollaborativePreparation {...props()} />);
    const sidebar = screen.getByRole("complementary", { name: "课程方案摘要" });
    expect(await within(sidebar).findByText("尚在讨论的课")).toBeVisible();
    expect(within(sidebar).getByText("时长待明确")).toBeVisible();
    const missing = within(sidebar).getByText("还需明确 3 项").closest("details")!;
    expect(missing).not.toHaveAttribute("open");
    expect(within(missing).getByText("五阶段安排")).not.toBeVisible();
    fireEvent.click(within(sidebar).getByRole("button", { name: "查看教师要求" }));
    const dialog = screen.getByRole("dialog", { name: "课程方案详情" });
    const group = within(dialog).getByText("教师要求").closest("details")!;
    expect(group).toHaveAttribute("open");
    expect(within(group).getByText(description)).toBeVisible();
    expect(within(group).queryByText("教师已确认")).toBeNull();
  });

  it("restores saved sources and allows correcting the plan without losing the history", async () => {
    const saved = snapshot({ referenceIds: ["ref-1"], referenceMaterials: [{ id: "ref-1", fileName: "教材节选.md" }] });
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method) mutations.push(JSON.parse(String(init.body)));
      return Response.json({ session: saved });
    }));
    const input = props(); render(<CollaborativePreparation {...input} referenceMaterials={saved.referenceMaterials} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /沟通记录/ })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: /沟通记录/ }));
    expect(await screen.findByText("想让学生比较校园用水量")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "返回当前问题" }));
    expect(input.onRestoreSources).toHaveBeenCalledWith(saved.referenceMaterials, []);
    fireEvent.click(screen.getByRole("button", { name: "修改已有理解" }));
    fireEvent.change(screen.getByLabelText("修改课程设想"), { target: { value: "实际是初二学生，请提高比较难度" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ action: "revise", message: "实际是初二学生，请提高比较难度", referenceIds: ["ref-1"] });
    await waitFor(() => expect(screen.getByRole("button", { name: "提交回答" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /沟通记录/ }));
    expect(screen.getByText("想让学生比较校园用水量")).toBeTruthy();
  });

  it("keeps the active question separate from the transcript and restores historical question choices", async () => {
    const saved = snapshot();
    saved.turns.push({ id: "assistant-1", role: "assistant", content: "先讨论教学深度。", createdAt: "2026-10-23T00:01:00Z", question: saved.currentQuestion });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ session: saved })));
    render(<CollaborativePreparation {...props()} />);
    const current = await screen.findByRole("region", { name: "当前备课问题" });
    expect(await within(current).findByRole("heading", { name: saved.currentQuestion!.prompt })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "备课讨论记录" })).toBeNull();
    fireEvent.change(screen.getByLabelText("备课想法"), { target: { value: "保留我的补充" } });
    fireEvent.click(screen.getByRole("button", { name: /沟通记录/ }));
    const history = screen.getByRole("dialog", { name: "沟通记录" });
    expect(within(history).getByText("想让学生比较校园用水量")).toBeTruthy();
    expect(within(history).getByText(saved.currentQuestion!.prompt)).toBeTruthy();
    fireEvent.click(within(history).getByText("查看当时的选项"));
    expect(within(history).getByText("比较并解释选择")).toBeVisible();
    fireEvent.click(within(history).getByRole("button", { name: "返回当前问题" }));
    expect(screen.getByLabelText("备课想法")).toHaveValue("保留我的补充");
    expect(screen.getByRole("radio", { name: /比较并解释选择/ })).toBeEnabled();
  });

  it("retries a lost response with the same request identity and preserves the typed answer", async () => {
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (!init?.method) return Response.json({ session: snapshot() });
      mutations.push(JSON.parse(String(init.body)));
      if (mutations.length === 1) throw new Error("网络中断");
      return Response.json({ session: snapshot({ revision: 3 }) });
    }));
    render(<CollaborativePreparation {...props()} />);
    await screen.findByRole("radio", { name: "其他／自己输入" });
    fireEvent.change(screen.getByLabelText("备课想法"), { target: { value: "先比较错误图表" } });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await screen.findByText("网络中断");
    expect(screen.getByLabelText("备课想法")).toHaveValue("先比较错误图表");
    fireEvent.click(screen.getByRole("button", { name: "重试本次提交" }));
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]).toEqual(mutations[0]);
  });

  it("accepts restored JSONB textbook objects with reordered keys, books, chapters, and references", async () => {
    const saved = snapshot({ status: "ready", readyToConfirm: true, currentQuestion: null,
      referenceIds: ["ref-b", "ref-a"], textbookSelections: [
        { sectionIds: ["s2", "s1"], primary: true, revisionId: "book-b" },
        { sectionIds: [], primary: false, revisionId: "book-a" },
      ],
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ session: saved })));
    render(<CollaborativePreparation {...props()}
      referenceMaterials={[{ id: "ref-a", fileName: "A.md" }, { id: "ref-b", fileName: "B.md" }]}
      textbookSelections={[{ revisionId: "book-a", primary: false, sectionIds: [] }, { revisionId: "book-b", primary: true, sectionIds: ["s1", "s2"] }]} />);
    expect(await screen.findByRole("button", { name: "查看完整方案" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "根据新资料更新方案" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看完整方案" }));
    expect(screen.getByRole("button", { name: "确认方案并开始生成" })).toBeEnabled();
  });

  it.each(["primary", "chapters"])("requires discussion when the selected textbook %s actually changes", async (change) => {
    const selections = [{ revisionId: "book-a", primary: true, sectionIds: ["s1", "s2"] }, { revisionId: "book-b", primary: false, sectionIds: [] }];
    const saved = snapshot({ status: "ready", readyToConfirm: true, currentQuestion: null, textbookSelections: selections });
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method) mutations.push(JSON.parse(String(init.body)));
      return Response.json({ session: saved });
    }));
    const changed = change === "primary" ? selections.map(book => ({ ...book, primary: !book.primary })) : selections.map(book => book.revisionId === "book-a" ? { ...book, sectionIds: ["s1", "s3"] } : book);
    render(<CollaborativePreparation {...props()} textbookSelections={changed} />);
    expect(await screen.findByRole("button", { name: "查看完整方案" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "根据新资料更新方案" }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ action: "revise", textbookSelections: changed });
  });

  it("requires updating the plan when selected source materials change", async () => {
    const ready = snapshot({ status: "ready", readyToConfirm: true, currentQuestion: null });
    const mutations: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method) mutations.push(JSON.parse(String(init.body)));
      return Response.json({ session: ready });
    }));
    render(<CollaborativePreparation {...props()} referenceMaterials={[{ id: "new-source", fileName: "新增资料.md" }]} />);
    expect(await screen.findByRole("button", { name: "查看完整方案" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "根据新资料更新方案" }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]).toMatchObject({ action: "revise", referenceIds: ["new-source"] });
  });
});

describe("FastCourseGenerator collaborative entry", () => {
  beforeEach(() => { vi.clearAllMocks(); window.sessionStorage.clear(); window.localStorage.clear(); });
  afterEach(() => vi.unstubAllGlobals());

  it("restores the first idea on refresh and submits it directly from the entry card only once", async () => {
    let saved: PreparationSessionSnapshot | null = null;
    const mutations: Record<string, unknown>[] = [];
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
      requests.push(String(url));
      if (String(url).endsWith("/collaborative-preparation")) {
        if (init?.method === "POST") {
          mutations.push(JSON.parse(String(init.body)));
          saved = snapshot();
        }
        return Response.json({ session: saved });
      }
      return Response.json({ backgroundEnabled: true, job: null, textbooks: [] });
    }));
    const input = { course: { id: "entry-course", content: {} } as Course, teacherId: "teacher-1", onOpenDetailed: vi.fn(), simplified: true };
    const first = render(<FastCourseGenerator {...input} />);
    expect(await screen.findByRole("button", { name: "开始协同备课" })).toBeDisabled();
    expect(screen.getByRole("group", { name: "备课模式" })).toHaveAttribute("data-expanded", "true");
    fireEvent.change(screen.getByLabelText("课程想法"), { target: { value: "  " } });
    expect(screen.getByRole("button", { name: "开始协同备课" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("课程想法"), { target: { value: "我想带学生分析校园用水量" } });
    expect(window.sessionStorage.getItem("openpbl:preparation-message:v1:teacher-1:entry-course")).toBe("我想带学生分析校园用水量");
    first.unmount();

    const second = render(<FastCourseGenerator {...input} />);
    expect(await screen.findByRole("textbox", { name: "课程想法" })).toHaveValue("我想带学生分析校园用水量");
    expect(requests.some((url) => url.endsWith("/collaborative-preparation"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "开始协同备课" }));
    await screen.findByRole("heading", { name: "这节课希望学生解释到什么程度？" });
    expect(screen.getByRole("group", { name: "备课模式" })).toHaveAttribute("data-expanded", "false");
    expect(mutations).toEqual([expect.objectContaining({ revision: 0, message: "我想带学生分析校园用水量" })]);
    expect(screen.getByLabelText("备课想法")).toHaveValue("");
    expect(window.sessionStorage.getItem("openpbl:preparation-message:v1:teacher-1:entry-course")).toBe("");
    second.unmount();

    render(<FastCourseGenerator {...input} />);
    await screen.findByRole("heading", { name: "这节课希望学生解释到什么程度？" });
    expect(mutations).toHaveLength(1);
    expect(screen.queryByLabelText("课程想法")).toBeNull();
  });

  it("persists independent settings across mode switches, remounts, and a new browser session", async () => {
    const draft = emptyResourcePackageDraft();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/collaborative-preparation")) return Response.json({ session: snapshot({ status: "ready", readyToConfirm: true, currentQuestion: null }) });
      if (String(url).endsWith("/resource-package")) return Response.json({ job: { id: "package-job", status: "ready", package: {
        schemaVersion: 1, id: "package-1", revision: 1, confirmedAt: "2026-10-23T00:00:00Z", source: { id: "upload", fileName: "资料.zip", url: "/upload" }, documents: {},
        draft: { ...draft, courseName: "校园数据", grade: "初一", totalMinutes: 45 },
      } } });
      return Response.json({ backgroundEnabled: true, job: null, textbooks: [] });
    }));
    const input = { course: { id: "settings-course", content: {} } as Course, teacherId: "teacher-1", onOpenDetailed: vi.fn(), simplified: true };
    const first = render(<FastCourseGenerator {...input} />);
    await screen.findByRole("button", { name: "开始生成课程" });
    fireEvent.click(screen.getByRole("button", { name: "AI 协同备课" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看完整方案" }));
    const settings = screen.getByRole("region", { name: "生成设置" });
    expect(settings.closest("details")).toBeNull();
    for (const label of ["生成范围", "课堂检测", "交互方式"]) expect(within(settings).getByRole("radiogroup", { name: label })).toBeVisible();
    expect(within(settings).getByRole("radio", { name: "完整课程" })).toBeChecked();
    expect(within(settings).getByRole("radio", { name: "普通检测" })).toBeChecked();
    expect(within(settings).getByRole("radio", { name: "普通交互" })).toBeChecked();
    fireEvent.click(within(settings).getByRole("radio", { name: "深度交互" }));
    fireEvent.click(within(settings).getByRole("radio", { name: "单节测试" }));
    fireEvent.click(screen.getByRole("button", { name: /语音：/ }));
    fireEvent.click(screen.getByRole("button", { name: "导入交接包" }));
    await screen.findByRole("button", { name: "开始生成课程" });
    fireEvent.click(screen.getByText("生成设置", { selector: "summary", exact: false }));
    expect(screen.getByRole("button", { name: "开启深度交互模式" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "开启单节测试模式" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开启深度作答模式" }));
    fireEvent.click(screen.getByRole("button", { name: "AI 协同备课" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看完整方案" }));
    expect(screen.getByRole("region", { name: "生成设置" })).toHaveTextContent("测试一节 · 普通检测 · 深度交互");
    first.unmount();
    window.sessionStorage.clear();
    render(<FastCourseGenerator {...input} />);
    fireEvent.click(await screen.findByRole("button", { name: "查看完整方案" }));
    expect(screen.getByRole("region", { name: "生成设置" })).toHaveTextContent("测试一节 · 普通检测 · 深度交互");
    expect(screen.getByRole("radio", { name: "单节测试" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "深度交互" })).toBeChecked();
    expect(screen.getByRole("button", { name: /语音：/ })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "导入交接包" }));
    await screen.findByRole("button", { name: "开始生成课程" });
    expect(screen.getByText("生成设置", { selector: "summary", exact: false })).toHaveTextContent("完整课程 · 综合简答 · 普通交互");
  });

  it("prioritizes the current course source over browser memory and isolates an older package task's settings", async () => {
    window.localStorage.setItem("openpbl:preparation-mode:v1:teacher-1:source-course", "resource-package");
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url).endsWith("/collaborative-preparation")) return Response.json({ session: snapshot({ status: "ready", readyToConfirm: true, currentQuestion: null }) });
      if (String(url).endsWith("/design-generation")) return Response.json({ backgroundEnabled: true, job: {
        id: "old-package-job", status: "failed", step: "knowledgePoints", progress: 0, trace: [],
        requestPreview: { resourcePackageId: "old-package", generationMode: "deep-interaction", generationScope: "test-lesson" },
      } });
      return Response.json({ job: null, textbooks: [] });
    }));
    render(<FastCourseGenerator course={{ id: "source-course", content: { preparationSource: "collaborative-preparation" } } as Course} teacherId="teacher-1" onOpenDetailed={vi.fn()} simplified />);
    fireEvent.click(await screen.findByRole("button", { name: "查看完整方案" }));
    expect(screen.getByRole("button", { name: "AI 协同备课" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "生成设置" })).toHaveTextContent("完整课程 · 普通检测 · 普通交互");
  });

  it("resumes a failed collaborative first draft without creating a task or reconfirming the plan", async () => {
    const confirmed = { sessionId: "session-1", revision: 3, confirmedAt: "2026-10-23T01:00:00Z", confirmedBy: "teacher-1", plan: plan(), referenceIds: [], textbookSelections: [] };
    const mutations: Array<{ url: string; method: string; body: unknown }> = [];
    const job = { id: "saved-collaborative-job", status: "failed", step: "teachingOutline", stepIndex: 2, progress: 45, trace: [],
      requestPreview: { preparationSessionId: confirmed.sessionId, preparationRevision: confirmed.revision, confirmedPreparation: confirmed },
    };
    vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") mutations.push({ url: String(url), method: init.method, body: JSON.parse(String(init.body)) });
      if (String(url).endsWith("/collaborative-preparation")) return Response.json({ session: snapshot({ status: "confirmed", revision: 3, confirmed, readyToConfirm: true, currentQuestion: null }) });
      if (String(url).endsWith("/design-generation")) return Response.json({ backgroundEnabled: true, job: init?.method === "PATCH" ? { ...job, status: "queued" } : job });
      return Response.json({ job: null, textbooks: [] });
    }));
    const course = createPblTemplateCourse("resume-course");
    course.content.preparationSource = "collaborative-preparation";
    course.content.confirmedPreparation = confirmed;
    render(<FastCourseGenerator course={course} teacherId="teacher-1" onOpenDetailed={vi.fn()} simplified />);
    const resume = await screen.findByRole("button", { name: "继续已保存首稿" });
    await screen.findByRole("button", { name: "查看完整方案" });
    expect(screen.getByRole("button", { name: "修改已有理解" })).toBeEnabled();
    fireEvent.click(resume);
    await waitFor(() => expect(mutations).toEqual([{ url: "/api/courses/resume-course/design-generation", method: "PATCH", body: { action: "resume-saved-first-draft" } }]));
    await waitFor(() => expect(screen.queryByRole("button", { name: "继续已保存首稿" })).toBeNull());
    expect(confirmed.revision).toBe(3);
  });

  it("loads collaboration only when selected and starts the shared generator with the confirmed source", async () => {
    const ready = snapshot({ status: "ready", readyToConfirm: true, currentQuestion: null });
    const confirmed = { sessionId: ready.id, revision: 3, confirmedAt: "2026-10-23T01:00:00Z", confirmedBy: "teacher-1", plan: plan(), referenceIds: [], textbookSelections: [] };
    const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init?: RequestInit) => {
      const request = { url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined }; requests.push(request);
      if (String(url).endsWith("/collaborative-preparation")) return Response.json({ session: init?.method === "PATCH" ? { ...ready, status: "confirmed", confirmed } : ready });
      if (String(url).endsWith("/design-generation")) return Response.json({ backgroundEnabled: true, job: null });
      if (String(url).endsWith("/resource-package")) return Response.json({ job: null });
      if (String(url).startsWith("/api/textbooks")) return Response.json({ textbooks: [] });
      throw new Error(`Unexpected request ${url}`);
    }));
    render(<FastCourseGenerator course={{ id: "course-1", content: {} } as Course} teacherId="teacher-1" onOpenDetailed={vi.fn()} simplified />);
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/design-generation"))).toBe(true));
    expect(requests.some((request) => request.url.endsWith("/collaborative-preparation"))).toBe(false);
    fireEvent.change(await screen.findByLabelText("课程想法"), { target: { value: "从校园生活开始讨论" } });
    fireEvent.click(screen.getByRole("button", { name: "开始协同备课" }));
    await screen.findByRole("button", { name: "查看完整方案" });
    expect(screen.getByLabelText("备课想法")).toHaveValue("从校园生活开始讨论");
    expect(requests.some((request) => request.url.endsWith("/collaborative-preparation") && request.method === "POST")).toBe(false);
    fireEvent.click(await screen.findByRole("button", { name: "查看完整方案" }));
    fireEvent.click(screen.getByRole("radio", { name: "单节测试" }));
    fireEvent.click(screen.getByRole("radio", { name: "综合简答" }));
    fireEvent.click(screen.getByRole("radio", { name: "深度交互" }));
    fireEvent.click(screen.getByRole("button", { name: /语音：/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认方案并开始生成" }));
    await waitFor(() => expect(requests.some((request) => request.url.endsWith("/design-generation") && request.method === "POST")).toBe(true));
    const generated = requests.find((request) => request.url.endsWith("/design-generation") && request.method === "POST")!;
    expect(generated.body).toMatchObject({ preparationSessionId: "session-1", preparationRevision: 3, referenceIds: [], textbookSelections: [],
      generationScope: "test-lesson", assessmentMode: "constructed-response", generationMode: "deep-interaction", options: { enableTTS: false } });
    expect(generated.body).not.toHaveProperty("resourcePackageId");
    expect(generated.body).not.toHaveProperty("resourcePackageRevision");
  });
});
