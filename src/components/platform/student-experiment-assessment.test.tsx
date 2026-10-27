import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudentExperimentAssessment, paginateExperimentQuestions, type ExperimentQuestion } from "./student-experiment-assessment";
import { parseDesignAnswer } from "@/lib/platform/experiment-design-answer";
import { COTEACH_COMMUNITY_REFERENCE, createCoTeachAssessmentTemplate } from "@/lib/platform/experiment-templates";
import { composeExperimentForms, publicExperimentQuestions } from "@/lib/platform/experiment";

const group = { id: "g", title: "研究情境", instruction: "阅读情境后作答" };
const questions: ExperimentQuestion[] = [
  { id: "q1", type: "single-choice", prompt: "第一题", options: ["甲", "乙"], group },
  { id: "q2", type: "multiple-choice", prompt: "第二题", options: ["甲", "乙"], group },
  { id: "q3", type: "true-false", prompt: "第三题" },
  { id: "q4", type: "scale", prompt: "第四题", scale: { min: 1, max: 5 } },
  { id: "q5", type: "short-answer", prompt: "第五题" },
];

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function assessment(draft: unknown = null, submission: unknown = null) {
  return { enabled: true, available: true, questions, draft, submission, studentKey: "student-1" };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("student experiment assessment", () => {
  it("keeps stale browser answers isolated after a posttest is closed and reopened", async () => {
    localStorage.setItem("experiment-draft:v1:student-1:run-1:posttest:access-1", JSON.stringify({ answers: { q4: "5" }, currentPage: 0, version: 0, pending: true }));
    vi.mocked(fetch).mockResolvedValue(response({ ...assessment(), accessVersion: 3, questions: [questions[3]] }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    expect(await screen.findByRole("radio", { name: "5 分" })).not.toBeChecked();
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("sends the current access version and requires reloading after a lifecycle conflict", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? response({ code: "ASSESSMENT_ACCESS_VERSION_CONFLICT" }, 409)
      : response({ ...assessment(), accessVersion: 1, questions: [questions[3]] }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    fireEvent.click(await screen.findByRole("radio", { name: "4 分" }));
    expect(await screen.findByRole("button", { name: "重新加载测验" }, { timeout: 2000 })).toBeVisible();
    const calls = vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "PUT");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({ accessVersion: 1, phase: "posttest", answers: { q4: "4" } });
    expect(screen.queryByRole("button", { name: "保留本机作答" })).not.toBeInTheDocument();
  });
  it.each(["classroom", "standalone"] as const)("blocks a closed %s posttest without restoring or syncing a pending local draft", async (source) => {
    const key = source === "classroom" ? "experiment-draft:v1:student-1:run-1:posttest" : "posttest-draft:v1:student-1:task-1:questions-v1";
    const saved = JSON.stringify({ answers: { q4: "4" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z", pending: true });
    localStorage.setItem(key, saved);
    vi.mocked(fetch).mockResolvedValue(response({ ...assessment(), available: false, questions: [], questionVersion: "questions-v1", blockedReason: "课程已结束，后测已关闭，仅可查看已提交的答案。" }));
    render(source === "classroom" ? <StudentExperimentAssessment instanceId="run-1" phase="posttest" /> : <StudentExperimentAssessment activityId="task-1" phase="posttest" />);
    expect(await screen.findByRole("heading", { name: "暂时无法作答后测" })).toBeVisible();
    expect(screen.getByText("课程已结束，后测已关闭，仅可查看已提交的答案。")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "确认提交后测" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新状态" }));
    await screen.findByRole("heading", { name: "暂时无法作答后测" });
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method)).toBe(true);
    expect(localStorage.getItem(key)).toBe(saved);
  });

  it("closes an existing answering tab when saving discovers the classroom has ended", async () => {
    const request = vi.mocked(fetch);
    let closed = false;
    request.mockImplementation(async (_url, options) => {
      if (options?.method === "PUT") { closed = true; return response({ code: "ASSESSMENT_UNAVAILABLE", message: "当前无法保存测验草稿" }, 409); }
      return response({ ...assessment(), available: !closed, questions: closed ? [] : [questions[3]], blockedReason: closed ? "课程已结束，后测已关闭，仅可查看已提交的答案。" : null });
    });
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    fireEvent.click(await screen.findByRole("radio", { name: "4 分" }));
    const original = localStorage.getItem("experiment-draft:v1:student-1:run-1:posttest");
    expect(await screen.findByRole("heading", { name: "暂时无法作答后测" }, { timeout: 2000 })).toBeVisible();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByText("另一页面更新了这份草稿")).not.toBeInTheDocument();
    fireEvent(window, new Event("online"));
    expect(request.mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(1);
    expect(request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
    expect(localStorage.getItem("experiment-draft:v1:student-1:run-1:posttest")).toBe(original);
  });

  it("saves and submits a standalone posttest with an isolated draft and question version", async () => {
    const request = vi.mocked(fetch);
    request.mockImplementation(async (_url, options) => {
      if (options?.method === "PUT") return response({ draft: { ...JSON.parse(String(options.body)), version: 1, updatedAt: "2026-01-01T00:00:00Z" } });
      if (options?.method === "POST") return response({ submission: { id: "submission", submittedAt: "2026-01-01T00:00:00Z" } });
      return response({ ...assessment(), questions: [questions[3]], questionVersion: "questions-v1" });
    });
    render(<StudentExperimentAssessment activityId="task-1" phase="posttest" />);
    fireEvent.click(await screen.findByRole("radio", { name: "4 分" }));
    expect(localStorage.getItem("posttest-draft:v1:student-1:task-1:questions-v1")).toContain('"q4":"4"');
    expect(localStorage.getItem("experiment-draft:v1:student-1:task-1:posttest")).toBeNull();
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/platform/activities/task-1/posttest", expect.objectContaining({ method: "PUT", body: JSON.stringify({ questionVersion: "questions-v1", answers: { q4: "4" }, currentPage: 0, version: 0 }) })), { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    fireEvent.click(screen.getByRole("button", { name: "确认提交后测" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("/api/platform/activities/task-1/posttest", expect.objectContaining({ method: "POST", body: JSON.stringify({ questionVersion: "questions-v1", answers: { q4: "4" } }) })));
    expect(await screen.findByText("答案已锁定")).toBeVisible();
    expect(localStorage.getItem("posttest-draft:v1:student-1:task-1:questions-v1")).toBeNull();
  });

  it("requires reload when a teacher changes the standalone questions during answering", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? response({ code: "QUESTION_VERSION_CONFLICT", message: "题目已更新" }, 409)
      : response({ ...assessment(), questions: [questions[3]], questionVersion: "old-questions" }));
    render(<StudentExperimentAssessment activityId="task-1" phase="posttest" />);
    fireEvent.click(await screen.findByRole("radio", { name: "4 分" }));
    expect(await screen.findByRole("button", { name: "重新加载题目" }, { timeout: 2000 })).toBeVisible();
    expect(screen.queryByRole("button", { name: "保留本机作答" })).not.toBeInTheDocument();
  });

  it("keeps old answers separate when recovery after a failed submission finds changed questions", async () => {
    let loads = 0;
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      if (options?.method === "PUT") return response({ draft: { ...JSON.parse(String(options.body)), version: 1, updatedAt: "2026-01-01T00:00:00Z" } });
      if (options?.method === "POST") throw new Error("连接中断");
      return response({ ...assessment(), questionVersion: ++loads === 1 ? "old" : "new", questions: [{ ...questions[3], prompt: loads === 1 ? "原有体验题" : "修改后的体验题" }] });
    });
    render(<StudentExperimentAssessment activityId="task-1" phase="posttest" />);
    fireEvent.click(await screen.findByRole("radio", { name: "4 分" }));
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    fireEvent.click(screen.getByRole("button", { name: "确认提交后测" }));
    expect(await screen.findByRole("button", { name: "重新加载题目" })).toBeVisible();
    expect(screen.queryByText("修改后的体验题")).not.toBeInTheDocument();
    expect(localStorage.getItem("posttest-draft:v1:student-1:task-1:old")).toContain('"q4":"4"');
    expect(localStorage.getItem("posttest-draft:v1:student-1:task-1:new")).toBeNull();
  });

  it.each(["pretest", "posttest"] as const)("shows %s instructions openly and keeps nine knowledge questions on one page", async (phase) => {
    const config = createCoTeachAssessmentTemplate();
    const form = publicExperimentQuestions(composeExperimentForms(config, "none", () => 0).pretest);
    const introduction = phase === "pretest" ? config.pretestIntroduction : config.posttestIntroduction;
    vi.mocked(fetch).mockResolvedValue(response({ ...assessment({ answers: { [form[0].id]: form[0].options![0] }, currentPage: 2, version: 1, updatedAt: "2026-01-01T00:00:00Z" }), questions: form, introduction, minutes: 12 }));
    render(<StudentExperimentAssessment instanceId="run-1" phase={phase} />);
    const instructions = await screen.findByRole("region", { name: `${phase === "pretest" ? "前测" : "后测"}作答说明` });
    expect(instructions).toBeVisible();
    expect(instructions).toHaveTextContent(introduction!);
    expect(instructions.closest("details")).toBeNull();
    expect(screen.queryByText("自动保存进度")).not.toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(9);
    expect(screen.queryByRole("button", { name: "下一步" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上一步" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "检查并提交" })).toBeVisible();
    expect(screen.getByRole("radio", { name: form[0].options![0] })).toBeChecked();
  });

  it("offers compact ratings without a directory and lets students revisit missing answers", async () => {
    const ratings: ExperimentQuestion[] = Array.from({ length: 9 }, (_, index) => ({ id: `r${index}`, prompt: `我的感受 ${index + 1}`, type: "scale", scale: { min: 1, max: 5, minLabel: "不同意", maxLabel: "同意" }, group }));
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? response({ draft: { ...JSON.parse(String(options.body)), version: 1, updatedAt: "2026-01-01T00:00:00Z" } })
      : response({ ...assessment(), questions: [...ratings, { ...ratings[0], id: "extra", prompt: "补充感受", group: { id: "extra-group", title: "补充体验" } }] }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="pretest" />);
    await screen.findByText("我的感受 1");
    expect(screen.queryByText("答题目录")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getAllByRole("group")).toHaveLength(9);
    expect(screen.getAllByRole("listitem", { name: "1 分 · 不同意" })).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("radio", { name: "4 分" })[0]);
    fireEvent.click(screen.getAllByRole("radio", { name: "3 分" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getAllByRole("group")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.getAllByRole("radio", { name: "4 分" })[0]).toBeChecked();
    expect(screen.getAllByRole("radio", { name: "3 分" })[1]).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "提交检查" }));
    expect(screen.getByText("还有 8 题待完成")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "第 10 题未答" }));
    expect(screen.getByText("补充感受")).toBeVisible();
    expect(screen.queryByText("我的感受 1")).not.toBeInTheDocument();
  });

  it("preserves topic navigation and locked answers during submitted review", async () => {
    const ratings: ExperimentQuestion[] = Array.from({ length: 6 }, (_, index) => ({ id: `r${index}`, prompt: `感受 ${index}`, type: "scale", scale: { min: 1, max: 5 }, group: index < 3 ? group : { id: "next-topic", title: "另一主题" } }));
    vi.mocked(fetch).mockResolvedValue(response({ ...assessment(null, { id: "s1", answers: { r0: "4", r3: "2" }, submittedAt: "2026-01-01T00:00:00Z" }), questions: ratings }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("感受 0");
    // Submitted answers must also use the same page boundaries as active answering.
    expect(screen.getAllByRole("radio", { name: "4 分" })[0]).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("感受 3")).toBeVisible();
    expect(screen.getAllByRole("radio", { name: "2 分" })[0]).toBeChecked();
    expect(screen.getAllByRole("radio").every((input) => (input as HTMLInputElement).disabled)).toBe(true);
    expect(screen.queryByRole("button", { name: /确认提交/ })).not.toBeInTheDocument();
  });

  it("restores the complete social-presence group with its full explanation", async () => {
    const form = publicExperimentQuestions(composeExperimentForms(createCoTeachAssessmentTemplate(), "none", () => 0).posttest);
    const pages = paginateExperimentQuestions(form);
    const socialStart = pages.findIndex((page) => page.questions[0].id === "CoI14");
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? response({ draft: { ...JSON.parse(String(options.body)), version: 2, updatedAt: "2026-01-01T00:00:00Z" } })
      : response({ ...assessment({ answers: {}, currentPage: socialStart, version: 1, updatedAt: "2026-01-01T00:00:00Z" }), questions: form }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    const dialog = await screen.findByRole("dialog", { name: "先读懂题目中的指代" });
    expect(within(dialog).getByText(COTEACH_COMMUNITY_REFERENCE)).toBeVisible();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(dialog).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "我已阅读，开始作答" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(form.find((question) => question.id === "CoI14")!.prompt)).toBeVisible();
    expect(screen.getByText(COTEACH_COMMUNITY_REFERENCE)).toBeVisible();
    expect(screen.getAllByRole("group")).toHaveLength(9);
    expect(screen.getByText(form.find((question) => question.id === "CoI19")!.prompt)).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText(COTEACH_COMMUNITY_REFERENCE)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "重新阅读说明" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "我已阅读，开始作答" }));
    expect(screen.getByText(form.find((question) => question.id === "CoI22")!.prompt)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText(form.find((question) => question.id === "CoI23")!.prompt)).toBeVisible();
    expect(screen.queryByText(COTEACH_COMMUNITY_REFERENCE)).not.toBeInTheDocument();
  });

  it("shows each new referent once, preserves answers, and does not interrupt submitted review", async () => {
    const form = publicExperimentQuestions(composeExperimentForms(createCoTeachAssessmentTemplate(), "none", () => 0).posttest);
    const active = [form[9], form[22], form[43]];
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "PUT"
      ? response({ draft: { ...JSON.parse(String(options.body)), version: 2, updatedAt: "2026-01-01T00:00:00Z" } })
      : response({ ...assessment(), questions: active }));
    const { unmount } = render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    for (const question of active) {
      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveAccessibleDescription(question.group!.referenceNote);
      fireEvent.click(within(dialog).getByRole("button", { name: "我已阅读，开始作答" }));
      fireEvent.click(screen.getByRole("radio", { name: "4 分" }));
      if (question !== active[2]) fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "4 分" })).toBeChecked();
    unmount();
    vi.mocked(fetch).mockResolvedValue(response({ ...assessment(null, { id: "submitted", answers: { [active[0].id]: "4" }, submittedAt: "2026-01-01T00:00:00Z" }), questions: active }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("答案已锁定");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "4 分" })).toBeChecked();
  });

  it.each(["confirmed", "recovered"] as const)("calls onSubmitted only after a %s server submission", async (mode) => {
    const onSubmitted = vi.fn();
    let posted = false;
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      if (options?.method === "POST") { posted = true; return mode === "confirmed" ? response({ submission: { id: "submitted", submittedAt: "2026-01-01T00:01:00Z" } }) : response({ message: "连接中断" }, 503); }
      return response({ ...assessment({ answers: { q1: "甲" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z" }, posted && mode === "recovered" ? { id: "submitted", answers: { q1: "甲" }, submittedAt: "2026-01-01T00:01:00Z" } : null), questions: questions.slice(0, 1) });
    });
    render(<StudentExperimentAssessment instanceId="run-1" onSubmitted={onSubmitted} phase="pretest" />);
    await screen.findByText("第一题");
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    fireEvent.click(screen.getByRole("button", { name: "确认提交前测" }));
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it("keeps a failed attempt and historical submission on the page", async () => {
    const onSubmitted = vi.fn();
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "POST"
      ? response({ message: "暂时无法提交" }, 503)
      : response({ ...assessment({ answers: { q1: "甲" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z" }), questions: questions.slice(0, 1) }));
    const { unmount } = render(<StudentExperimentAssessment instanceId="run-1" onSubmitted={onSubmitted} phase="pretest" />);
    await screen.findByText("第一题");
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    fireEvent.click(screen.getByRole("button", { name: "确认提交前测" }));
    await screen.findByText("暂时无法提交");
    expect(onSubmitted).not.toHaveBeenCalled();
    unmount();
    vi.mocked(fetch).mockResolvedValue(response({ ...assessment(null, { id: "previous", answers: { q1: "甲" }, submittedAt: "2026-01-01T00:01:00Z" }), questions: questions.slice(0, 1) }));
    render(<StudentExperimentAssessment instanceId="run-1" onSubmitted={onSubmitted} phase="pretest" />);
    await screen.findByText(/提交时间：/);
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it("shows the design scenario clearly and requires all three separate answers", async () => {
    const designQuestion: ExperimentQuestion = { id: "design", type: "short-answer", prompt: "为六年级改进8分钟活动。目标：根据证据判断识别结果。\n已有测试记录：原背景4／4，换背景2／4。\n现有安排：教师展示结果。\n按三点写短句。\n\n依据：说明为什么这样改。\n活动：学生具体做什么。\n评价：如何判断目标达成。" };
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url, options) => options?.method === "POST"
      ? response({ submission: { id: "s1", answers: JSON.parse(String(options.body)).answers, submittedAt: "2026-01-01T00:01:00Z" } })
      : options?.method === "PUT"
        ? response({ draft: { answers: JSON.parse(String(options.body)).answers, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z" } })
        : response({ ...assessment(), questions: [designQuestion] }));
    render(<StudentExperimentAssessment instanceId="run-1" layout="full" phase="pretest" />);
    expect(await screen.findByRole("region", { name: "题目情境" })).toHaveTextContent("原背景4／4，换背景2／4");
    const basis = screen.getByRole("textbox", { name: /^依据：/ });
    expect(screen.getByRole("textbox", { name: /^活动：/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^评价：/ })).toBeInTheDocument();
    fireEvent.change(basis, { target: { value: "采用证据探究" } });
    expect(screen.getByRole("progressbar", { name: "前测作答进度" })).toHaveAttribute("aria-valuenow", "0");
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    expect(screen.getByText("还有 1 题待完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回作答" }));
    fireEvent.change(screen.getByRole("textbox", { name: /^活动：/ }), { target: { value: "让学生比较两种背景的识别记录" } });
    fireEvent.change(screen.getByRole("textbox", { name: /^评价：/ }), { target: { value: "学生能说明条件变化后的差异" } });
    expect(screen.getByRole("progressbar", { name: "前测作答进度" })).toHaveAttribute("aria-valuenow", "1");
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    fireEvent.click(screen.getByRole("button", { name: "确认提交前测" }));
    await screen.findByText(/提交时间：/);
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    const saved = JSON.parse(String(post?.[1]?.body));
    expect(parseDesignAnswer(saved.answers.design).values).toEqual({ 依据: "采用证据探究", 活动: "让学生比较两种背景的识别记录", 评价: "学生能说明条件变化后的差异" });
    expect(screen.getByRole("textbox", { name: /^依据：/ })).toHaveAttribute("readonly");
  });
  it("lets students skip experience ratings with a reason and leave feedback blank", async () => {
    const optionalQuestions: ExperimentQuestion[] = [
      { id: "knowledge", type: "single-choice", prompt: "知识题", options: ["甲", "乙"] },
      { id: "experience", type: "scale", prompt: "体验题", scale: { min: 1, max: 7 }, optional: true, skipReasonRequired: true },
      { id: "feedback", type: "short-answer", prompt: "一条课堂反馈", optional: true },
    ];
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url, options) => options?.method === "POST"
      ? response({ submission: { id: "s1", submittedAt: "2026-01-01T00:01:00Z" } })
      : options?.method === "PUT"
        ? response({ draft: { answers: { knowledge: "甲" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z" } })
        : response({ ...assessment({ answers: { knowledge: "甲" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z" }), questions: optionalQuestions, variant: "A_PRE_B_POST", minutes: 15, skipReasonPrompt: "跳题原因" }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("体验题");
    expect(screen.getByRole("heading", { name: "后测｜情境B" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    expect(screen.getByRole("button", { name: "确认提交后测" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "跳题原因" }), { target: { value: "技术故障" } });
    fireEvent.click(screen.getByRole("button", { name: "确认提交后测" }));
    await screen.findByText(/提交时间：/);
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body)).answers).toEqual({ knowledge: "甲", __skipReason: "技术故障" });
  });
  it.each(["", "希望学习进度提示更清晰。"])("submits the full CoTeach posttest with optional final feedback %s and no skip reason", async (feedback) => {
    const form = publicExperimentQuestions(composeExperimentForms(createCoTeachAssessmentTemplate(), "none", () => 0).posttest);
    const pages = paginateExperimentQuestions(form);
    const requiredAnswers = Object.fromEntries(form.filter((question) => !question.optional).map((question) => [question.id, question.type === "scale" ? "4" : "不知道"]));
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url, options) => options?.method === "POST"
      ? response({ submission: { id: "submitted", submittedAt: "2026-01-01T00:01:00Z" } })
      : options?.method === "PUT"
        ? response({ draft: { ...JSON.parse(String(options.body)), version: 2, updatedAt: "2026-01-01T00:00:00Z" } })
        : response({ ...assessment({ answers: requiredAnswers, currentPage: pages.length - 1, version: 1, updatedAt: "2026-01-01T00:00:00Z" }), questions: form }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    const section = await screen.findByRole("region", { name: "意见与建议（选填）" });
    expect(within(section).getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getAllByRole("group")).toHaveLength(1);
    expect(section).toHaveTextContent("不填写可直接跳过，无需说明原因");
    expect(screen.getByRole("progressbar", { name: "后测作答进度" })).toHaveAttribute("aria-valuenow", "53");
    expect(screen.getByRole("progressbar", { name: "后测作答进度" })).toHaveAttribute("aria-valuemax", "53");
    if (feedback) fireEvent.change(within(section).getByRole("textbox"), { target: { value: feedback } });
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    expect(screen.getByText("必答题已完成")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "跳题原因" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认提交后测" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "确认提交后测" }));
    await screen.findByText(/提交时间：/);
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body)).answers).toEqual({ ...requiredAnswers, ...(feedback ? { F01: feedback } : {}) });
  });

  it("keeps each authored topic complete regardless of question count or question type", () => {
    const input = [...questions.slice(0, 2), ...Array.from({ length: 32 }, (_, index) => ({ id: `u${index}`, type: "short-answer" as const, prompt: `问题 ${index}` }))];
    const pages = paginateExperimentQuestions(input);
    expect(pages.map((page) => page.questions.length)).toEqual([2, 32]);
    expect(pages[0].group?.title).toBe("研究情境");
    expect(pages.at(-1)?.startIndex).toBe(2);
    expect(pages.flatMap((page) => page.questions.map((question) => question.id))).toEqual(input.map((question) => question.id));
    const knowledge = Array.from({ length: 9 }, (_, index) => ({ id: `k${index}`, type: "single-choice" as const, prompt: `知识题 ${index + 1}`, options: ["甲", "乙"], group }));
    expect(paginateExperimentQuestions(knowledge).map((page) => page.questions.length)).toEqual([9]);
    const ratings = Array.from({ length: 13 }, (_, index) => ({ id: `rating-${index}`, type: "scale" as const, prompt: `感受 ${index}`, scale: { min: 1, max: 5 }, group }));
    expect(paginateExperimentQuestions(ratings).map((page) => page.questions.length)).toEqual([13]);
    const forms = composeExperimentForms(createCoTeachAssessmentTemplate(), "none", () => 0);
    expect(paginateExperimentQuestions(publicExperimentQuestions(forms.pretest)).map((page) => page.questions.length)).toEqual([9]);
    expect(paginateExperimentQuestions(publicExperimentQuestions(forms.posttest)).map((page) => page.questions.length)).toEqual([9, 13, 9, 12, 10, 1]);
  });

  it("restores the assigned draft and submits all question types through the check page", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url, options) => options?.method === "POST"
      ? response({ submission: { id: "submission-1", phase: "posttest", submittedAt: "2026-01-01T00:01:00Z" } })
      : options?.method === "PUT"
        ? response({ draft: { answers: {}, currentPage: 1, version: 3, updatedAt: "2026-01-01T00:00:01Z" } })
        : response(assessment({ answers: { q1: "甲", q2: ["甲"], q3: "true", q4: "3" }, currentPage: 1, version: 2, updatedAt: "2026-01-01T00:00:00Z" })));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("第三题");
    expect(screen.getByText("已完成 80%")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "第五题" }), { target: { value: "我的想法" } });
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    expect(screen.getByText("所有题目已完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认提交后测" }));
    await screen.findByText(/提交时间：/);
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body)).answers).toEqual({ q1: "甲", q2: ["甲"], q3: "true", q4: "3", q5: "我的想法" });
    expect(screen.getByRole("textbox", { name: "第五题" })).toHaveAttribute("readonly");
  });

  it("shows an explicit choice when the server draft changed in another tab", async () => {
    localStorage.setItem("experiment-draft:v1:student-1:run-1:posttest", JSON.stringify({ answers: { q1: "甲" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z", pending: true }));
    vi.mocked(fetch).mockResolvedValueOnce(response(assessment({ answers: { q1: "乙" }, currentPage: 0, version: 2, updatedAt: "2026-01-01T00:01:00Z" })));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    expect(await screen.findByText("另一页面更新了这份草稿")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "使用服务器版本" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "乙" })).toBeChecked());
    expect(vi.mocked(fetch).mock.calls.filter(([, options]) => options?.method === "PUT")).toHaveLength(0);
  });

  it("saves answers and current page with a version, then advances the saved version", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (_url, options) => options?.method === "PUT"
      ? response({ draft: { answers: { q1: "甲" }, currentPage: 1, version: 1, updatedAt: "2026-01-01T00:00:01Z" } })
      : response(assessment()));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("第一题");
    fireEvent.click(screen.getByRole("radio", { name: "甲" }));
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
    const put = fetchMock.mock.calls.find(([, options]) => options?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ phase: "posttest", answers: { q1: "甲" }, currentPage: 1, version: 0 });
    expect(JSON.parse(localStorage.getItem("experiment-draft:v1:student-1:run-1:posttest") ?? "null")).toMatchObject({ version: 1, pending: false });
  });

  it("recovers a successful submission when the response is lost", async () => {
    const complete = { q1: "甲", q2: ["甲"], q3: "true", q4: "3", q5: "说明" };
    const fetchMock = vi.mocked(fetch);
    let readCount = 0;
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method === "POST") throw new Error("连接中断");
      if (options?.method === "PUT") return response({ draft: { answers: complete, currentPage: 1, version: 2, updatedAt: "2026-01-01T00:00:00Z" } });
      readCount++;
      return response(assessment({ answers: complete, currentPage: 1, version: 1, updatedAt: "2026-01-01T00:00:00Z" }, readCount > 1 ? { id: "s1", answers: complete, submittedAt: "2026-01-01T00:01:00Z" } : null));
    });
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    await screen.findByText("第三题");
    fireEvent.click(screen.getByRole("button", { name: "检查并提交" }));
    fireEvent.click(screen.getByRole("button", { name: "确认提交后测" }));
    expect(await screen.findByText(/提交时间：/)).toBeInTheDocument();
    expect(screen.queryByText("连接中断")).not.toBeInTheDocument();
  });

  it("shows saved answers after completion even when new submissions are closed", async () => {
    const key = "experiment-draft:v1:student-1:run-1:posttest";
    const original = JSON.stringify({ answers: { q1: "甲" }, currentPage: 0, version: 1, updatedAt: "2026-01-01T00:00:00Z", pending: true });
    localStorage.setItem(key, original);
    vi.mocked(fetch).mockResolvedValueOnce(response({ ...assessment(null, { id: "s1", answers: { q1: "乙" }, submittedAt: "2026-01-01T00:00:00Z" }), available: false }));
    render(<StudentExperimentAssessment instanceId="run-1" phase="posttest" />);
    expect(await screen.findByText(/提交时间：/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "乙" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(localStorage.getItem(key)).toBe(original);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});
