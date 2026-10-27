import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Course } from "@/lib/session/types";
import { CollaborativeLaunchSummary } from "./collaborative-launch-summary";

const course = {
  learningObjectives: ["解释蒸发与沸腾的区别"],
  content: {
    stagePlan: {
      source: "collaborative-preparation", totalMinutes: 45,
      drivingQuestion: "怎样让湿衣服更快变干？", projectTask: "设计一组公平实验",
      stages: [{ key: "launch", title: "项目启动", durationMin: 5, requirements: "观察两块湿布", teacherActions: "教师私有观察提示" }],
      finalDeliverables: [{ id: "experiment", name: "实验方案", format: "表格", requirements: "写清变量与对照" }],
      evaluationCriteria: "比较方法是否公平",
    },
    confirmedPreparation: { privateConversation: "教师暂不希望学生知道的想法" },
  },
} as unknown as Course;

describe("collaborative launch summary", () => {
  it("renders the adopted student task, objectives, deliverables and minutes without private authoring data", () => {
    render(<CollaborativeLaunchSummary course={course} />);
    expect(screen.getByRole("region", { name: "项目启动说明" })).toBeTruthy();
    expect(screen.getByText("设计一组公平实验")).toBeTruthy();
    expect(screen.getByText("解释蒸发与沸腾的区别")).toBeTruthy();
    expect(screen.getByText(/写清变量与对照/)).toBeTruthy();
    expect(screen.getByText("课堂安排 · 共 45 分钟")).toBeTruthy();
    expect(screen.queryByText(/教师私有|暂不希望/)).toBeNull();
  });
  it("keeps existing imported courses unchanged", () => {
    const imported = { ...course, content: { ...course.content, stagePlan: { ...course.content.stagePlan!, source: "resource-package" as const } } };
    const { container } = render(<CollaborativeLaunchSummary course={imported} />);
    expect(container.firstChild).toBeNull();
  });
  it("collapses alongside uploaded resources and supports a scrollable presentation", () => {
    const view = render(<CollaborativeLaunchSummary course={course} compact />);
    expect(screen.getByText("项目任务与学习目标").closest("details")?.open).toBe(false);
    view.rerender(<CollaborativeLaunchSummary course={course} presentation />);
    expect(screen.getByRole("region", { name: "项目启动说明" }).className).toContain("overflow-auto");
  });
});
