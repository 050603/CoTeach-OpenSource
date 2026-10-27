import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { RouterContext } from "next/dist/shared/lib/router-context.shared-runtime";
import { WorkspaceNav } from "@/components/platform/workspace-nav";
import { PreparationShell } from "./preparation-shell";

const route = vi.hoisted(() => ({ pathname: "/teacher/prepare/course/verify" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/components/brand/coteach-logo", () => ({ CoTeachLogo: () => <span>CoTeach</span> }));

// Vitest loads Next's public Link entry without the App Router build alias.
const router = {
  route: "/teacher/prepare/course/verify", pathname: "/teacher/prepare/course/verify", query: {}, asPath: "/teacher/prepare/course/verify", basePath: "",
  isFallback: false, isReady: true, isPreview: false, isLocaleDomain: false,
  events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  back: vi.fn(), forward: vi.fn(), reload: vi.fn(), beforePopState: vi.fn(),
  push: vi.fn().mockResolvedValue(true), replace: vi.fn().mockResolvedValue(true), prefetch: vi.fn().mockResolvedValue(undefined),
};

function renderWithRouter(children: ReactNode) {
  return render(<RouterContext.Provider value={router}>{children}</RouterContext.Provider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  route.pathname = "/teacher/prepare/course/verify";
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ user: null }) })));
});
afterEach(() => vi.unstubAllGlobals());

describe("shared preparation navigation", () => {
  it("uses the library header with navigation and account together, keeping one back link", () => {
    renderWithRouter(<PreparationShell role="teacher" userName="王老师" active="templates"
      currentCourse={{ id: "course", name: "水的蒸发", status: "preparing" }}
      headerSlot={<span>课程方案</span>} headerEndSlot={<button>版本记录</button>}
      saveStatus={{ state: "unsaved" }}><p>备课正文</p></PreparationShell>);

    const header = screen.getByRole("banner");
    expect(header).toHaveClass("pbl-platform-topbar");
    const navigation = within(header).getByRole("navigation", { name: "教师导航" });
    const actions = navigation.closest(".pbl-platform-topbar-actions");
    expect(actions).toContainElement(within(header).getByRole("button", { name: "教师账号：王老师" }));
    expect(within(navigation).getByRole("link", { name: "课程库" })).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("link", { name: "返回课程库" })).toHaveLength(1);
    expect(within(header).getByRole("link", { name: "返回课程库" })).toHaveAttribute("href", "/teacher/templates");
    expect(screen.getByText("水的蒸发")).toHaveAttribute("title", "水的蒸发");
    expect(screen.getByText("课程方案")).toBeVisible();
    expect(screen.getByRole("button", { name: "版本记录" })).toBeVisible();
    expect(screen.getByText("未保存")).toBeVisible();
    expect(screen.getByText("备课正文")).toBeVisible();
  });

  it.each([
    ["CoTeach", "/teacher/templates"],
    ["返回原页面", "/teacher/prepare/course/preview?view=content&stage=ai-learning"],
    ["教学班", "/teacher/classes"],
    ["课程库", "/teacher/templates"],
    ["教材库", "/teacher/textbooks"],
  ])("keeps the unsaved-work guard on %s", (name, target) => {
    const onNavigate = vi.fn();
    renderWithRouter(<PreparationShell role="teacher" onNavigate={onNavigate}
      backHref="/teacher/prepare/course/preview?view=content&stage=ai-learning"
      backLabel="返回原页面"><input aria-label="本地修改" defaultValue="教师尚未保存的内容" /></PreparationShell>);

    fireEvent.click(screen.getByRole("link", { name }));

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(target);
    expect(screen.getByLabelText("本地修改")).toHaveValue("教师尚未保存的内容");
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps save retry and the viewport-constrained content without an empty context row", () => {
    const retry = vi.fn();
    const { rerender } = render(<PreparationShell role="teacher" viewportLocked wide saveStatus={{ state: "error", onRetry: retry }}><p>编辑器</p></PreparationShell>);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByText("编辑器").closest("[data-wide]")).toHaveAttribute("data-wide", "true");
    expect(screen.getByRole("banner").parentElement).toHaveAttribute("data-viewport-locked", "true");

    rerender(<PreparationShell role="teacher" viewportLocked><p>编辑器</p></PreparationShell>);
    expect(screen.getByRole("banner").nextElementSibling).toContainElement(screen.getByText("编辑器"));
  });

  it("preserves the default library and student destinations for existing callers", () => {
    route.pathname = "/teacher/templates";
    const { rerender } = render(<WorkspaceNav role="teacher" active="templates" />);
    expect(screen.getByRole("link", { name: "CoTeach" })).toHaveAttribute("href", "/teacher/classes");
    expect(screen.getByRole("link", { name: "返回平台首页" })).toHaveAttribute("href", "/");

    route.pathname = "/student/profile";
    rerender(<WorkspaceNav role="student" />);
    expect(screen.getByRole("link", { name: "CoTeach" })).toHaveAttribute("href", "/student?all=1");
    expect(screen.getByRole("link", { name: "返回我的课程" })).toHaveAttribute("href", "/student?all=1");
    expect(screen.getByRole("navigation", { name: "学生导航" })).toBeVisible();
    expect(screen.getByRole("link", { name: "我的课程" })).not.toHaveAttribute("aria-current");
  });
});
