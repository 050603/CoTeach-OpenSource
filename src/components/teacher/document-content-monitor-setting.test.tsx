import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse } from "@/lib/platform/pbl-template";
import { DocumentContentMonitorSetting } from "./document-content-monitor-setting";

const mocks = vi.hoisted(() => ({ updateCourse: vi.fn(), flushSaves: vi.fn(), retrySave: vi.fn() }));
vi.mock("@/lib/session/store", () => ({ useSession: () => ({ ...mocks, saveState: "saved" }) }));

describe("document content monitoring setting", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.flushSaves.mockResolvedValue(true); });

  it.each(["course-default", "classroom"] as const)("saves the chosen %s object's setting before confirming", async scope => {
    const course = createPblTemplateCourse(scope === "course-default" ? "template" : "instance");
    render(<DocumentContentMonitorSetting course={course} scope={scope} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(mocks.updateCourse).toHaveBeenCalledWith(course.id, { pblConfig: expect.objectContaining({ documentPasteMonitoringEnabled: true }) });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("已保存"));
    expect(mocks.flushSaves).toHaveBeenCalledOnce();
    expect(screen.getByText(/不自动判定 AI 来源或扣分/)).toBeTruthy();
  });

  it("does not claim success for an unsaved configuration", async () => {
    mocks.flushSaves.mockResolvedValue(false);
    render(<DocumentContentMonitorSetting course={createPblTemplateCourse("template")} scope="course-default" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveTextContent("设置尚未保存");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "重试保存设置" })).toBeTruthy();
  });

  it("keeps ended classrooms read-only", () => {
    render(<DocumentContentMonitorSetting course={{ ...createPblTemplateCourse("instance"), status: "finished" }} scope="classroom" />);
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });
});
