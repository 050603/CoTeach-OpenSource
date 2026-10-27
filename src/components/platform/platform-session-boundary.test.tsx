import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const route = vi.hoisted(() => ({ pathname: "/student/courses/demo", search: "" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname, useSearchParams: () => new URLSearchParams(route.search) }));
vi.mock("@/lib/session/store", () => ({ SessionProvider: ({ children, search }: { children: React.ReactNode; search?: string }) => <div data-testid="classroom-session" data-session-search={search}>{children}</div> }));
import { PlatformSessionBoundary } from "./platform-session-boundary";
describe("platform session boundary", () => {
  it("renders the empty export canvas without starting a classroom session", () => {
    route.pathname = "/internal/slide-export";
    const { container } = render(<PlatformSessionBoundary>导出画布</PlatformSessionBoundary>);
    expect(screen.queryByTestId("classroom-session")).not.toBeInTheDocument();
    expect(container.querySelector(".pbl-platform-theme")).not.toBeInTheDocument();
  });
  it("applies platform styles to the student profile without loading classroom state", () => {
    route.pathname = "/student/profile";
    const { container } = render(<PlatformSessionBoundary>个人中心</PlatformSessionBoundary>);
    expect(container.querySelector(".pbl-platform-theme")).toBeInTheDocument();
    expect(screen.queryByTestId("classroom-session")).not.toBeInTheDocument();
  });
  it("does not request retired classroom session APIs on course pages", () => {
    route.pathname = "/student/courses/demo";
    render(<PlatformSessionBoundary>课程主页</PlatformSessionBoundary>);
    expect(screen.queryByTestId("classroom-session")).not.toBeInTheDocument();
  });
  it("themes settings while retaining its identity session", () => {
    route.pathname = "/teacher/settings";
    const { container } = render(<PlatformSessionBoundary>设置</PlatformSessionBoundary>);
    expect(screen.getByTestId("classroom-session")).toBeInTheDocument();
    expect(container.querySelector(".pbl-platform-theme")).toBeInTheDocument();
  });
  it("keeps survey dashboards inside the teacher platform theme", () => {
    route.pathname = "/teacher/surveys/activity";
    const { container } = render(<PlatformSessionBoundary>问卷看板</PlatformSessionBoundary>);
    expect(container.querySelector(".pbl-platform-theme")).toBeInTheDocument();
    expect(screen.queryByTestId("classroom-session")).not.toBeInTheDocument();
  });
  it("themes assessment results without starting a classroom session", () => {
    route.pathname = "/teacher/activities/assessment/results";
    const { container } = render(<PlatformSessionBoundary>后测结果</PlatformSessionBoundary>);
    expect(container.querySelector(".pbl-platform-theme")).toBeInTheDocument();
    expect(screen.queryByTestId("classroom-session")).not.toBeInTheDocument();
  });
  it("keeps textbook library pages inside the teacher platform theme", () => {
    route.pathname = "/teacher/textbooks/book-1";
    const { container } = render(<PlatformSessionBoundary>教材知识图谱</PlatformSessionBoundary>);
    expect(container.querySelector(".pbl-platform-theme")).toBeInTheDocument();
    expect(screen.queryByTestId("classroom-session")).not.toBeInTheDocument();
  });
  it("keeps teaching and preparation outside the platform theme", () => {
    route.pathname = "/teacher/teach/demo/classroom";
    const { container } = render(<PlatformSessionBoundary>授课</PlatformSessionBoundary>);
    expect(container.querySelector(".pbl-platform-theme")).not.toBeInTheDocument();
  });
  it("preserves the session provider for classroom implementation", () => {
    route.pathname = "/teacher/prepare/demo/verify";
    render(<PlatformSessionBoundary>备课</PlatformSessionBoundary>);
    expect(screen.getByTestId("classroom-session")).toBeInTheDocument();
  });
  it("updates the standalone player's session scope when its course query changes", () => {
    route.pathname = "/student/ai-learning/native-player";
    route.search = "courseId=course-1";
    const view = render(<PlatformSessionBoundary>播放器</PlatformSessionBoundary>);
    expect(screen.getByTestId("classroom-session")).toHaveAttribute("data-session-search", "courseId=course-1");
    route.search = "courseId=course-2";
    view.rerender(<PlatformSessionBoundary>播放器</PlatformSessionBoundary>);
    expect(screen.getByTestId("classroom-session")).toHaveAttribute("data-session-search", "courseId=course-2");
  });
});
