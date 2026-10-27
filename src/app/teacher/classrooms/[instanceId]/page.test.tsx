import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ClassroomMonitor from "./page";
vi.mock("next/navigation", () => ({ useParams: () => ({ instanceId: "instance-1" }), usePathname: () => "/teacher/classrooms/instance-1" }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
function classroom(status: string, kind = "pbl-course") {
  return { instance: { id: "instance-1", title: "城市探索", offeringId: "course-1", status, snapshot: { kind }, coverImageUrl: "/generated/city-cover.png" }, participants: [] };
}
describe("课堂学习记录入口", () => {
  it.each([
    ["scheduled", "pbl-course", "进入课堂", "/teacher/teach/instance-1/setup"],
    ["teaching", "pbl-course", "继续授课", "/teacher/teach/instance-1/classroom"],
    ["teaching", "lesson", "继续授课", "/teacher/teach/instance-1/setup?enter=1"],
    ["finished", "pbl-course", "返回教学工作台", "/teacher/teach/instance-1/setup"],
  ])("routes %s %s to its supported workspace", async (status, kind, label, href) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("/experiment/results") ? { enabled: false, submissions: [] } : classroom(status, kind) })));
    render(<ClassroomMonitor/>);
    expect(await screen.findByRole("img", { name: "城市探索课堂封面" })).toBeTruthy();
    expect((await screen.findByRole("link", { name: label })).getAttribute("href")).toBe(href);
    expect(screen.queryByRole("button", { name: "开始课堂" })).toBeNull();
    expect(screen.queryByRole("button", { name: "结束课堂" })).toBeNull();
    expect(screen.getByText("等待第一份学习记录")).toBeTruthy();
  });
  it("recovers from a failed load and clears its error", async () => {
    let attempts = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url === "/api/auth/me") return { ok: true, json: async () => ({ user: { role: "teacher", displayName: "李老师", username: "teacher.li" } }) };
      if (url.includes("/experiment/results")) return { ok: true, json: async () => ({ enabled: false, submissions: [] }) };
      attempts += 1;
      return attempts === 1
        ? { ok: false, json: async () => ({ message: "读取暂时失败" }) }
        : { ok: true, json: async () => classroom("scheduled") };
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ClassroomMonitor/>);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByLabelText("课堂概况").textContent).toContain("—");
    expect(screen.queryByText("等待第一份学习记录")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(await screen.findByText("等待第一份学习记录")).toBeTruthy();
  });

  it("filters by student account and teacher state, preserving the filtered return route", async () => {
    const participants = [
      { id: "p1", displayName: "小林", username: "lin.01", lastEnteredAt: null, completedAt: null, hasLearningEvidence: true, hasFinalOutput: true, submittedArtifactVersionCount: 2, evaluationSummary: { teacherStatus: "draft", pending: true, published: true, publishedTeacher: false }, _count: { artifacts: 1, reflections: 0, evaluations: 3 } },
      { id: "p2", displayName: "小周", username: "zhou.02", lastEnteredAt: null, completedAt: null, hasLearningEvidence: true, hasFinalOutput: true, submittedArtifactVersionCount: 1, evaluationSummary: { teacherStatus: "submitted", pending: false, published: false, publishedTeacher: false }, _count: { artifacts: 1, reflections: 2, evaluations: 1 } },
    ];
    window.history.replaceState(null, "", "/teacher/classrooms/instance-1?evaluation=pending&returnTo=%2Fteacher%2Fclasses%2Fcourse-1%2Fstudents%3Fstudent%3De1");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("/experiment/results") ? { enabled: false, submissions: [] } : { ...classroom("finished"), participants } })));
    render(<ClassroomMonitor/>);
    const link = await screen.findByRole("link", { name: "查看与评价 小林" });
    expect(screen.queryByRole("link", { name: "查看与评价 小周" })).toBeNull();
    expect(screen.getByText("显示 1 / 2 位学生")).toBeTruthy();
    const returnTo = new URL(link.getAttribute("href")!, "http://localhost").searchParams.get("returnTo")!;
    expect(returnTo).toContain("evaluation=pending");
    expect(new URL(returnTo, "http://localhost").searchParams.get("returnTo")).toBe("/teacher/classes/course-1/students?student=e1");
    const lin = screen.getByRole("rowheader", { name: /小林\s*lin\.01/ }).closest("tr")!;
    expect(within(lin).getByText("评价草稿")).toBeTruthy();
    expect(within(lin).getByText("已发布过程报告")).toBeTruthy();
    expect(within(lin).getByText("2 个版本")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "评价状态" }), { target: { value: "submitted" } });
    expect(screen.getByRole("link", { name: "查看与评价 小周" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索学生姓名或账号" }), { target: { value: "zhou.02" } });
    expect(window.location.search).toContain("q=zhou.02");
    expect(screen.getByRole("link", { name: "查看与评价 小周" })).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索学生姓名或账号" }), { target: { value: "不存在" } });
    expect(screen.getByText("没有符合条件的学生")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "显示全部学生" }));
    expect(screen.getByText("显示 2 / 2 位学生")).toBeTruthy();
  });

  it("restores URL filters on browser history navigation and retains data after a refresh failure", async () => {
    let fail = false;
    const participants = [{ id: "p1", displayName: "小林", username: "lin", lastEnteredAt: null, completedAt: null, hasLearningEvidence: true, hasFinalOutput: true, submittedArtifactVersionCount: 1, evaluationSummary: { teacherStatus: "submitted", pending: false, published: true, publishedTeacher: true }, _count: { artifacts: 1, reflections: 0, evaluations: 2 } }];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/participants") ? { ok: !fail, json: async () => fail ? { message: "刷新失败" } : { ...classroom("finished"), participants } } : { ok: true, json: async () => ({ enabled: false, submissions: [] }) }));
    render(<ClassroomMonitor/>);
    expect(await screen.findByRole("link", { name: "查看与评价 小林" })).toBeTruthy();
    window.history.replaceState(null, "", "/teacher/classrooms/instance-1?q=lin&evaluation=published");
    fireEvent.popState(window);
    expect((screen.getByRole("textbox", { name: "搜索学生姓名或账号" }) as HTMLInputElement).value).toBe("lin");
    expect((screen.getByRole("combobox", { name: "评价状态" }) as HTMLSelectElement).value).toBe("published");
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("刷新失败。以下保留上次成功读取的记录。")).toBeTruthy();
    expect(screen.getByRole("link", { name: "查看与评价 小林" })).toBeTruthy();
    expect(screen.queryByText("等待第一份学习记录")).toBeNull();
  });
});
