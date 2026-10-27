import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExperimentQuestionCard, ExperimentQuestionList } from "./experiment-question-card";

afterEach(cleanup);

describe("experiment question presentation", () => {
  it("uses the same ordered score columns for the shared guide and each compact rating", () => {
    const scale = { min: 1, max: 5, minLabel: "非常不同意", maxLabel: "非常同意" };
    const group = { id: "ratings", title: "学习体验" };
    render(<ExperimentQuestionList compact answers={{}} inputNamePrefix="rating" onAnswerChange={vi.fn()} questions={[
      { id: "r1", type: "scale", prompt: "我能完成任务", scale, group },
      { id: "r2", type: "scale", prompt: "我能解决问题", scale, group },
    ]} />);
    const guide = screen.getByRole("list", { name: "分值含义" });
    expect(within(guide).getAllByRole("listitem").map((item) => item.getAttribute("aria-label"))).toEqual(["1 分 · 非常不同意", "2 分", "3 分", "4 分", "5 分 · 非常同意"]);
    for (const row of screen.getAllByRole("group")) {
      expect(row).toHaveAccessibleDescription(expect.stringContaining("非常不同意"));
      expect(within(row).getAllByRole("radio").map((input) => input.getAttribute("aria-label"))).toEqual(["1 分", "2 分", "3 分", "4 分", "5 分"]);
    }
  });

  it("supports compact keyboard scoring and clearing optional answers without changing a locked answer", () => {
    const question = { id: "rating", type: "scale" as const, prompt: "我能完成任务", optional: true, scale: { min: 1, max: 5 } };
    const onAnswerChange = vi.fn();
    const { rerender } = render(<ExperimentQuestionCard compact index={0} inputName="rating" question={question} answer="3" onAnswerChange={onAnswerChange} />);
    const fieldset = screen.getByRole("group");
    fireEvent.keyDown(fieldset, { key: "5" });
    expect(onAnswerChange).toHaveBeenLastCalledWith("5");
    fireEvent.keyDown(fieldset, { key: "0" });
    expect(onAnswerChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "清除作答并跳过" }));
    expect(onAnswerChange).toHaveBeenLastCalledWith("");
    rerender(<ExperimentQuestionCard compact readOnly index={0} inputName="rating" question={question} answer="3" onAnswerChange={onAnswerChange} />);
    fireEvent.keyDown(fieldset, { key: "4" });
    expect(onAnswerChange).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("radio", { name: "3 分" })).toBeChecked();
  });

  it.each(["K01　", "CoI14　", "CY02：", "S06 "])("hides the legacy %s code while keeping the question number and answer identity", (prefix) => {
    const onAnswerChange = vi.fn();
    render(<ExperimentQuestionList answers={{}} inputNamePrefix="posttest" onAnswerChange={onAnswerChange} questions={[
      { id: "copied-id", type: "single-choice", prompt: `${prefix}请选择最符合的描述。`, options: ["第一项", "第二项"] },
    ]} />);
    expect(screen.getByRole("group")).toHaveAccessibleName("第 1 题，必答： 请选择最符合的描述。");
    expect(screen.queryByText(new RegExp(`^${prefix}`))).not.toBeInTheDocument();
    expect(screen.getByText("01")).toBeVisible();
    fireEvent.click(screen.getByRole("radio", { name: "第一项" }));
    expect(onAnswerChange).toHaveBeenCalledWith("copied-id", "第一项");
  });

  it("hides the old C-SUS publication paragraph and keeps response guidance", () => {
    const group = { id: "copied-sus", title: "系统使用体验问卷（C-SUS）", instruction: "请根据实际使用感受作答。\n\n1＝非常不同意；5＝非常同意。\n\n量表：Chinese System Usability Scale（C-SUS），10题。来源：Wang et al. DOI: 10.1080/10447318.2019.1700644。" };
    render(<ExperimentQuestionList answers={{}} inputNamePrefix="posttest" onAnswerChange={vi.fn()} questions={[
      { id: "copied-sus-1", type: "scale", prompt: "S01　我愿意经常使用这个系统。", scale: { min: 1, max: 5 }, group },
    ]} />);
    expect(screen.getByText("请根据实际使用感受作答。")).toBeVisible();
    expect(screen.getByRole("group")).toHaveAccessibleDescription(expect.stringContaining("1＝非常不同意；5＝非常同意"));
    expect(screen.queryByText(/Chinese System|来源：|DOI/)).not.toBeInTheDocument();
    expect(screen.queryByText("量表题")).not.toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
  });

  it("preserves numbers and codes that belong to the question content", () => {
    render(<ExperimentQuestionCard index={0} inputName="content" onAnswerChange={vi.fn()} question={{ id: "content", type: "short-answer", prompt: "比较 K01 和 K02 的记录，说明 3 个差异。" }} />);
    expect(screen.getByRole("textbox")).toHaveAccessibleName("比较 K01 和 K02 的记录，说明 3 个差异。");
  });

  it("keeps paragraph breaks and line breaks in long prompts and options", () => {
    const onAnswerChange = vi.fn();
    const question = { id: "choice", type: "single-choice" as const, prompt: "阅读下面的情境：\r\n你和同伴需要完成调查。\n\n你会先做什么？", options: ["先观察\n再记录", "直接提出结论"] };
    const { rerender } = render(<ExperimentQuestionCard answer={undefined} index={0} inputName="choice" onAnswerChange={onAnswerChange} question={question} />);
    const group = screen.getByRole("group", { name: /阅读下面的情境/ });
    const title = document.getElementById(group.getAttribute("aria-labelledby") ?? "")!;
    expect(title.querySelectorAll("p")).toHaveLength(2);
    expect(title.querySelectorAll("p")[0].textContent).toBe("阅读下面的情境：\n你和同伴需要完成调查。");
    expect(title.querySelectorAll("p")[0]).toHaveClass("whitespace-pre-wrap");
    const option = within(group).getByRole("radio", { name: /先观察\s+再记录/ });
    expect(option.closest("label")?.querySelector(".whitespace-pre-wrap")).toHaveClass("whitespace-pre-wrap");
    fireEvent.click(option);
    expect(onAnswerChange).toHaveBeenCalledWith("先观察\n再记录");
    rerender(<ExperimentQuestionCard answer={"先观察\n再记录"} index={0} inputName="choice" onAnswerChange={onAnswerChange} question={question} />);
    expect(option).toBeChecked();
    expect(option.closest("label")).toHaveClass("border-[var(--pbl-student)]");
  });

  it("shows readable scale endpoints and an explicit selected score", () => {
    const onAnswerChange = vi.fn();
    const question = { id: "scale", type: "scale" as const, prompt: "我能够完成任务", scale: { min: 0, max: 10, minLabel: "完全没有信心", maxLabel: "非常有信心" } };
    const { rerender } = render(<ExperimentQuestionCard answer={undefined} index={2} inputName="scale" onAnswerChange={onAnswerChange} question={question} />);
    expect(screen.getAllByRole("radio")).toHaveLength(11);
    expect(screen.getByText("0 分 · 完全没有信心")).toBeInTheDocument();
    expect(screen.getByText("10 分 · 非常有信心")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "7 分" }));
    expect(onAnswerChange).toHaveBeenCalledWith("7");
    rerender(<ExperimentQuestionCard answer="7" index={2} inputName="scale" onAnswerChange={onAnswerChange} question={question} />);
    expect(screen.getByRole("radio", { name: "7 分" })).toBeChecked();
    expect(screen.getByText("已选择 7 分")).toBeInTheDocument();
  });

  it("places related questions under one accessible title and shared instruction", () => {
    const group = { id: "confidence", title: "任务信心", instruction: "请根据现在的感受：\n选择最符合自己的一项。" };
    const questions = [
      { id: "first", type: "scale" as const, prompt: "我能完成任务", scale: { min: 1, max: 5 }, group },
      { id: "other", type: "short-answer" as const, prompt: "其他感受" },
      { id: "second", type: "scale" as const, prompt: "我能解决问题", scale: { min: 1, max: 5 }, group },
    ];
    const onAnswerChange = vi.fn();
    render(<ExperimentQuestionList answers={{}} inputNamePrefix="pretest" onAnswerChange={onAnswerChange} questions={questions} />);
    const section = screen.getByRole("region", { name: "任务信心" });
    expect(within(section).getAllByRole("group")).toHaveLength(2);
    expect(section).toHaveTextContent(/请根据现在的感受：\s*选择最符合自己的一项。/);
    expect(within(section).getAllByRole("group")[0]).toHaveAttribute("aria-describedby", expect.any(String));
    expect(screen.getAllByRole("group")).toHaveLength(3);
    fireEvent.click(within(section).getAllByRole("radio", { name: "4 分" })[0]);
    expect(onAnswerChange).toHaveBeenCalledWith("first", "4");
  });

  it("keeps a prominent reference note accessible with and without ordinary instructions", () => {
    const group = { id: "social", title: "社会性存在", referenceNote: "课程参与者包括 AI、人类教师和其他同学。" };
    const question = { id: "social-1", type: "scale" as const, prompt: "我能够形成清晰的印象", scale: { min: 1, max: 5 }, group };
    const { rerender } = render(<ExperimentQuestionList answers={{}} inputNamePrefix="posttest" onAnswerChange={vi.fn()} questions={[question]} />);
    const fieldset = screen.getByRole("group");
    expect(fieldset).toHaveAccessibleDescription(expect.stringContaining(group.referenceNote));
    expect(screen.getByText(group.referenceNote)).toBeVisible();
    expect(screen.getByText("指代说明 · 请先阅读")).toBeVisible();
    rerender(<ExperimentQuestionCard index={0} inputName="standalone" onAnswerChange={vi.fn()} question={question} />);
    expect(screen.getByText(group.referenceNote)).toBeVisible();
    expect(screen.getByRole("group")).toHaveAccessibleDescription(expect.stringContaining(group.referenceNote));
  });
});
