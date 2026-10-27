import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { DEFAULT_PBL_RUBRIC, type PblEvaluationSnapshot } from "@/lib/evaluation/pbl-contract";
import { TeacherEvaluationWorkspace } from "./teacher-evaluation";

const mocks = vi.hoisted(() => ({ snapshot: undefined as PblEvaluationSnapshot | undefined, command: vi.fn(), refresh: vi.fn(), form: vi.fn() }));
vi.mock("./use-evaluation", () => ({ useEvaluation: () => ({ snapshot: mocks.snapshot, error: "", command: mocks.command, refresh: mocks.refresh }) }));
vi.mock("./process-evaluation-panel", () => ({ ProcessEvaluationEntry: () => null }));
vi.mock("./evaluation-export", () => ({ EvaluationExport: () => <button>导出全班评价</button> }));
vi.mock("@/components/classroom/teacher-operation-details", () => ({ TeacherOperationDrawer: () => null }));
vi.mock("./evaluation-form", () => ({ EvaluationForm: (props: { participationId: string; command: (input: unknown) => Promise<unknown> }) => {
  mocks.form(props);
  return <button type="button" onClick={() => void props.command({ action: "save", source: "teacher", participationId: props.participationId })}>保存目标评价</button>;
} }));
const course = { id: "course", status: "finished" } as Course;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.snapshot = { contractVersion: 2, role: "teacher", instanceId: "course", stage: "reflection", canWrite: true, canConfigureRubric: false, canPublish: true,
    config: { version: 0, rubric: DEFAULT_PBL_RUBRIC, peerMode: "off", reviewsPerStudent: 2, anonymous: true },
    participants: ["first", "target"].map(id => ({ participationId: id, studentId: `student-${id}`, name: id === "first" ? "首位学生" : "目标学生", artifacts: [], selfEvaluation: null, peerEvaluations: [], teacherEvaluation: null, processReport: null, published: null })),
    assignments: [], completion: { total: 2, selfSubmitted: 0, peerAssigned: 0, peerSubmitted: 0, teacherSubmitted: 0, published: 0 } };
  mocks.command.mockImplementation(async () => mocks.snapshot);
});
afterEach(cleanup);
describe("teacher evaluation student scope", () => {
  it("pins the requested student, scopes publication and reports successful changes", async () => {
    const changed = vi.fn();
    render(<TeacherEvaluationWorkspace course={course} participationId="target" onEvaluationChange={changed} />);
    expect(screen.getByText("目标学生")).toBeVisible();
    expect(screen.queryByText("首位学生")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("选择学生")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "评价设置与互评分配" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "导出全班评价" })).not.toBeInTheDocument();
    expect(mocks.form.mock.lastCall?.[0]).toMatchObject({ participationId: "target" });
    fireEvent.click(screen.getByRole("button", { name: "保存目标评价" }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("发布评价结果"));
    fireEvent.click(screen.getByRole("button", { name: "发布给当前学生" }));
    await waitFor(() => expect(mocks.command).toHaveBeenLastCalledWith({ action: "publish", participationIds: ["target"], includeTeacher: true, includeProcess: true }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
  });
  it("never falls back to a different student when the requested record is missing", () => {
    render(<TeacherEvaluationWorkspace course={course} participationId="missing" />);
    expect(screen.getByText("未找到该学生的评价档案")).toBeVisible();
    expect(mocks.form).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("发布评价结果"));
    expect(screen.getByRole("button", { name: "发布给当前学生" })).toBeDisabled();
  });
  it("does not carry an earlier student's pending publication status into a new dossier", async () => {
    let finish: (result: PblEvaluationSnapshot) => void = () => undefined;
    mocks.command.mockImplementationOnce(() => new Promise<PblEvaluationSnapshot>(resolve => { finish = resolve; }));
    const view = render(<TeacherEvaluationWorkspace course={course} participationId="target" />);
    fireEvent.click(screen.getByText("发布评价结果"));
    fireEvent.click(screen.getByRole("button", { name: "发布给当前学生" }));
    expect(screen.getByRole("button", { name: "发布给当前学生" })).toBeDisabled();
    view.rerender(<TeacherEvaluationWorkspace course={course} participationId="first" />);
    expect(screen.getByText("首位学生")).toBeVisible();
    fireEvent.click(screen.getByText("发布评价结果"));
    expect(screen.getByRole("button", { name: "发布给当前学生" })).toBeEnabled();
    finish(mocks.snapshot!);
    await waitFor(() => expect(mocks.form.mock.lastCall?.[0]).toMatchObject({ participationId: "first" }));
    expect(screen.queryByText(/已向 .* 位学生发布评价结果/)).not.toBeInTheDocument();
  });
  it("preserves the class-wide selection and settings outside a student dossier", () => {
    render(<TeacherEvaluationWorkspace course={course} />);
    expect(screen.getByLabelText("选择学生")).toHaveValue("first");
    expect(screen.getByRole("button", { name: "评价设置与互评分配" })).toBeVisible();
    fireEvent.change(screen.getByLabelText("选择学生"), { target: { value: "target" } });
    expect(mocks.form.mock.lastCall?.[0]).toMatchObject({ participationId: "target" });
  });
});
