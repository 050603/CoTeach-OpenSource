import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TeacherPresentationActionsProvider } from "@/components/classroom/teacher-presentation-actions";
import type { Course } from "@/lib/session/types";
import { AiCollaborationTeacherMonitor } from "./ai-collaboration-monitor";
const course = { id: "course-1", students: [{ id: "student-1", name: "小明" }], groups: [], submissions: [], aiContributions: [] } as unknown as Course;
describe("practice projection", () => {
  it("requires explicit artifact selection and never includes AI conversations in the projected artifact", () => {
    const projectedCourse = {
      ...course,
      stages: [{ key: "make", label: "项目实践", view: "ai-collaboration", description: "比较实验数据并提交方案。" }],
      currentStageIndex: 0,
      pblConfig: { makeArtifactMode: "document" },
      content: { teachingOutline: [] },
      submissions: [{ id: "work-1", studentId: "student-1", stageKey: "make", type: "document", title: "学生方案", content: "<p>已经选中的公开作品</p>", updatedAt: "2026-09-01T01:00:00.000Z" }],
      aiInteractionEvents: [{ id: "private-1", courseId: "course-1", studentId: "student-1", stageKey: "make", source: "sidebar", eventType: "request", actorRole: "student", content: "不应投影的私人提问", createdAt: "2026-09-01T01:00:00.000Z" }],
    } as unknown as Course;
    const { rerender } = render(<AiCollaborationTeacherMonitor course={projectedCourse} presentation="teaching" />, { wrapper: ({ children }) => <TeacherPresentationActionsProvider target={document.body}>{children}</TeacherPresentationActionsProvider> });
    expect(screen.getByText("比较实验数据并提交方案。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /外部内容提醒/ })).toBeNull();
    expect(screen.getByText("小明")).not.toBeVisible();
    expect(screen.queryByText("已经选中的公开作品")).toBeNull();
    rerender(<AiCollaborationTeacherMonitor course={projectedCourse} presentation="teaching" showStudentWork />);
    expect(screen.queryByRole("region", { name: "当前阶段任务" })).toBeNull();
    expect(screen.queryByText("已经选中的公开作品")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /小明/ }));
    expect(screen.getByText("已经选中的公开作品")).toBeTruthy();
    expect(screen.queryByText("不应投影的私人提问")).toBeNull();
    expect(screen.queryByText("学生与 AI 协作对话")).toBeNull();
    rerender(<AiCollaborationTeacherMonitor course={projectedCourse} presentation="analytics" />);
    rerender(<AiCollaborationTeacherMonitor course={projectedCourse} presentation="teaching" showStudentWork />);
    expect(screen.getByText("已经选中的公开作品")).toBeTruthy();
    rerender(<AiCollaborationTeacherMonitor course={projectedCourse} presentation="workspace" />);
    expect(screen.queryByRole("button", { name: /外部内容提醒/ })).toBeNull();
    rerender(<AiCollaborationTeacherMonitor course={projectedCourse} presentation="teaching" showStudentWork />);
    expect(screen.queryByRole("button", { name: /外部内容提醒/ })).toBeNull();
    expect(screen.getByText("已经选中的公开作品")).toBeTruthy();
  });
});
