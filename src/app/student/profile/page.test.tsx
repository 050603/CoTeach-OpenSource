import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StudentProfilePage from "./page";
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("@/components/platform/student-shell", () => ({ StudentShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("student password help", () => {
  it("shows the browser-bound teacher approval workflow", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { role: "student", displayName: "王同学", username: "20260001" } }) }));
    render(<StudentProfilePage/>);
    expect(await screen.findByText(/任课教师核实并允许后/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "申请重置密码" })).toHaveAttribute("href", "/student/reset-password");
    expect(screen.queryByLabelText("当前密码")).toBeNull();
  });
});
