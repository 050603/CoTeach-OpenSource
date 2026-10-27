import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StudentResetPasswordPage from "./page";

const navigation = vi.hoisted(() => ({ token: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(navigation.token ? { token: navigation.token } : {}) }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); vi.useRealTimers(); navigation.token = ""; });
const request = { id: "request-123456789", username: "20260001", displayName: "王同学", state: "pending", createdAt: "2026-10-26T07:00:00Z", expiresAt: "2026-10-26T07:30:00Z", approvedAt: null };
const requestUrl = "/api/platform/auth/password-reset-request";
function response(value: unknown) { return { ok: true, json: async () => value }; }
function fillPassword(confirmation = "new-password-123") {
  fireEvent.change(screen.getByLabelText("新密码", { exact: true }), { target: { value: "new-password-123" } });
  fireEvent.change(screen.getByLabelText("确认新密码"), { target: { value: confirmation } });
}
function submit(name: string) { fireEvent.submit(screen.getByRole("button", { name }).closest("form")!); }

describe("student password reset requests", () => {
  it("submits an application and sets a password only after approval in this browser", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ request: null }))
      .mockResolvedValueOnce(response({ request }))
      .mockResolvedValueOnce(response({ request: { ...request, state: "approved" } }))
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    render(<StudentResetPasswordPage/>);
    fireEvent.change(await screen.findByLabelText("学号"), { target: { value: "20260001" } });
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "王同学" } });
    submit("提交重置申请");
    expect(await screen.findByText(/等待任课教师核实并允许重置/)).toBeInTheDocument();
    expect(screen.queryByLabelText("新密码", { exact: true })).toBeNull();
    expect(fetcher).toHaveBeenNthCalledWith(2, requestUrl, expect.objectContaining({ body: JSON.stringify({ username: "20260001", displayName: "王同学" }) }));
    fireEvent.click(screen.getByRole("button", { name: "检查申请状态" }));
    await screen.findByLabelText("新密码", { exact: true });
    fillPassword("different-password"); submit("保存新密码");
    expect(await screen.findByRole("alert")).toHaveTextContent("两次输入的密码不一致");
    expect(fetcher).toHaveBeenCalledTimes(3);
    fillPassword(); submit("保存新密码");
    expect(await screen.findByText("密码已更新，请使用新密码登录。")).toBeInTheDocument();
    expect(fetcher).toHaveBeenLastCalledWith("/api/platform/auth/reset-password", expect.objectContaining({ body: JSON.stringify({ password: "new-password-123" }) }));
    expect(screen.getByRole("link", { name: "返回登录" })).toHaveAttribute("href", "/student/login");
  });

  it("restores an approved request on refresh without collecting a credential", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ request: { ...request, state: "approved" } })));
    render(<StudentResetPasswordPage/>);
    expect(await screen.findByLabelText("新密码", { exact: true })).toBeInTheDocument();
    expect(screen.queryByLabelText("学号")).toBeNull();
    expect(screen.getByText(/只能在提交申请的浏览器/)).toBeInTheDocument();
  });

  it("does not accept an old reset token and directs the student to a fresh application", async () => {
    navigation.token = "old-teacher-token";
    const fetcher = vi.fn().mockResolvedValue(response({ request: null }));
    vi.stubGlobal("fetch", fetcher);
    render(<StudentResetPasswordPage/>);
    expect(await screen.findByLabelText("学号")).toBeInTheDocument();
    expect(screen.getByText(/旧重置链接已停用/)).toBeInTheDocument();
    expect(screen.queryByLabelText("新密码", { exact: true })).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(requestUrl, expect.objectContaining({ cache: "no-store" }));
  });

  it.each(["expired", "cancelled"])("allows a fresh application after state %s", async state => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ request: { ...request, state } })));
    render(<StudentResetPasswordPage/>);
    expect(await screen.findByRole("button", { name: "提交重置申请" })).toBeEnabled();
    expect(screen.queryByLabelText("新密码", { exact: true })).toBeNull();
  });

  it("recognizes completion after a lost reset response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ request: { ...request, state: "used" } })));
    render(<StudentResetPasswordPage/>);
    expect(await screen.findByText("密码已更新，请使用新密码登录。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交重置申请" })).toBeNull();
  });

  it("recovers from a failed initial status check", async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("连接失败")).mockResolvedValueOnce(response({ request }));
    vi.stubGlobal("fetch", fetcher);
    render(<StudentResetPasswordPage/>);
    expect(await screen.findByRole("alert")).toHaveTextContent("连接失败");
    expect(screen.queryByRole("button", { name: "提交重置申请" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "检查申请状态" }));
    expect(await screen.findByText(/等待任课教师核实并允许重置/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("starts a fresh application after completion without reusing the earlier approval", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ request: { ...request, state: "used" } }))
      .mockResolvedValueOnce(response({ request: { ...request, id: "new-request-123", state: "pending" } }));
    vi.stubGlobal("fetch", fetcher);
    render(<StudentResetPasswordPage/>);
    fireEvent.click(await screen.findByRole("button", { name: "再次申请重置" }));
    expect(screen.getByLabelText("学号")).toHaveValue("20260001");
    expect(screen.getByLabelText("姓名")).toHaveValue("王同学");
    expect(screen.queryByLabelText("新密码", { exact: true })).toBeNull();
    submit("提交重置申请");
    expect(await screen.findByText(/等待任课教师核实并允许重置/)).toBeInTheDocument();
    expect(screen.getByText(/new-requ/)).toBeInTheDocument();
    expect(fetcher).toHaveBeenLastCalledWith(requestUrl, expect.objectContaining({ body: JSON.stringify({ username: "20260001", displayName: "王同学" }) }));
    expect(screen.queryByLabelText("新密码", { exact: true })).toBeNull();
  });

  it("polls pending requests while visible and stops polling in a hidden tab", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ request }));
    vi.stubGlobal("fetch", fetcher);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.useFakeTimers();
    await act(async () => { render(<StudentResetPasswordPage/>); });
    expect(screen.getByText(/等待任课教师核实并允许重置/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    const count = fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    fireEvent(document, new Event("visibilitychange"));
    expect(fetcher).toHaveBeenCalledTimes(count);
    visibility.mockRestore();
  });
});
