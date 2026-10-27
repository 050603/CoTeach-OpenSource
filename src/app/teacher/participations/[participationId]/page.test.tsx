import { describe, expect, it, vi } from "vitest";
import Page from "./page";
vi.mock("@/components/platform/classroom-workspace", () => ({ ClassroomWorkspace: () => null }));

describe("teacher classroom record return path", () => {
  it.each(["/teacher/classes/class-one/students?student=one&filter=pending", "/teacher/classrooms/classroom-one?query=%E5%B0%8F%E6%9E%97"])("retains the safe list and its query: %s", async returnTo => {
    const page = await Page({ params: Promise.resolve({ participationId: "p" }), searchParams: Promise.resolve({ returnTo }) });
    expect(page.props.returnHref).toBe(returnTo);
  });
  it.each(["https://evil.example/teacher/classes/c/students", "//evil.example/teacher/classrooms/c", "/teacher/classes/c/students/../../../../student", "/teacher/classes/c/settings", "/teacher/classrooms/c\\evil", ["/teacher/classrooms/c", "https://evil.example"]])("rejects external or unrelated returns: %s", async returnTo => {
    const page = await Page({ params: Promise.resolve({ participationId: "p" }), searchParams: Promise.resolve({ returnTo }) });
    expect(page.props.returnHref).toBeUndefined();
  });
});
