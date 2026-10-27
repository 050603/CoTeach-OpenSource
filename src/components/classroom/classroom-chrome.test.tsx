import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { DEFAULT_STAGES } from "@/lib/session/types";
import { StageGateDialog, StageProgress } from "./classroom-chrome";

const course: Course = {
  id: "course-1",
  name: "测试课程",
  subject: "科学",
  grade: "六年级",
  hours: 3,
  summary: "测试",
  drivingQuestion: "如何解决问题？",
  status: "teaching",
  stages: DEFAULT_STAGES,
  currentStageIndex: 2,
  content: { pblOutline: "", knowledgePoints: [], lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: "" } },
  students: [],
  createdAt: "",
  updatedAt: "",
};

describe("StageProgress", () => {
  it("uses the enlarged current step as the single stage identity", () => {
    render(<StageProgress course={course} />);

    const current = screen.getByRole("button", { current: "step" });
    expect(current.className).toContain("min-h-14");
    expect(current.textContent).toContain("当前阶段");
    expect(current.textContent).toContain(course.stages[2].label);
    expect(screen.getByRole("button", { name: /项目启动/ }).className).toContain("min-h-10");
  });
});

describe("StageGateDialog", () => {
  it("shows the transition direction and lets the teacher continue after a resource warning", () => {
    const onConfirm = vi.fn();
    render(
      <StageGateDialog
        course={{ ...course, currentStageIndex: 0, students: [], summary: "", drivingQuestion: "" }}
        onConfirm={onConfirm}
        onOpenChange={vi.fn()}
        open
        targetIndex={1}
      />,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("heading", { name: "切换教学阶段" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "阶段切换方向" })).toHaveTextContent("当前阶段项目启动");
    expect(screen.getByRole("group", { name: "阶段切换方向" })).toHaveTextContent("即将进入知识讲授");
    expect(screen.getByText("本阶段尚未上传授课资源，可继续切换阶段")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "进入“知识讲授”" });
    expect(confirm).not.toHaveProperty("disabled", true);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("uses explicit rollback wording when returning to an earlier stage", () => {
    render(
      <StageGateDialog
        course={course}
        onConfirm={vi.fn()}
        onOpenChange={vi.fn()}
        open
        targetIndex={1}
      />,
    );

    expect(screen.getByRole("heading", { name: "回退教学阶段" })).toBeTruthy();
    expect(screen.getByText(/已有课堂记录将保留/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "本阶段检查" })).toBeNull();
    expect(screen.getByRole("button", { name: "确认回退到“知识讲授”" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /进入下一阶段/ })).toBeNull();
  });

  it("preserves incomplete conditions and explicit teacher override when advancing", () => {
    const onConfirm = vi.fn();
    render(<StageGateDialog course={{ ...course, currentStageIndex: 1 }} onConfirm={onConfirm} onOpenChange={vi.fn()} open targetIndex={2} presentation />);
    expect(screen.getByRole("dialog")).toHaveAttribute("data-presentation", "true");
    expect(screen.getByRole("heading", { name: "待处理事项" })).toBeTruthy();
    expect(screen.getByText("知识讲授内容尚未生成或关联")).toBeTruthy();
    expect(screen.getByText(/系统将记录本次未完成事项/)).toBeTruthy();
    expect(screen.getByText("授课展示")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "仍要进入“项目实践”" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("shows the next fullscreen view and cancels without switching stages", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<StageGateDialog course={{ ...course, currentStageIndex: 0 }} onConfirm={onConfirm} onOpenChange={onOpenChange} open targetIndex={1} presentation />);
    expect(screen.getByText("班级学情")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "留在当前阶段" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps satisfied checks visible without showing a fullscreen view in the normal workspace", () => {
    render(<StageGateDialog course={{ ...course, currentStageIndex: 1, aiLearningClassroomId: "classroom-1" }} onConfirm={vi.fn()} onOpenChange={vi.fn()} open targetIndex={2} />);
    expect(screen.getByText("知识讲授内容可用")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "已就绪" })).toBeTruthy();
    expect(screen.queryByText("接下来显示")).toBeNull();
    expect(screen.queryByRole("heading", { name: "待处理事项" })).toBeNull();
  });
});
