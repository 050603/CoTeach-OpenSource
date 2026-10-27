import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PBL_COURSE_CONFIG } from "@/lib/pbl-course-config";
import type { Course } from "@/lib/session/types";
import { MakeArtifactModeSetting } from "./make-artifact-mode-setting";

const updateCourse = vi.fn();

vi.mock("@/lib/session/store", () => ({
  useSession: () => ({ updateCourse }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => <button onClick={onSelect}>{children}</button>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuSub: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSubTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const course = {
  id: "course-1",
  pblConfig: DEFAULT_PBL_COURSE_CONFIG,
} as unknown as Course;

describe("MakeArtifactModeSetting", () => {
  beforeEach(() => updateCourse.mockReset());

  it("uses a compact teacher-only menu and enables Python and C", () => {
    render(<MakeArtifactModeSetting course={course} />);

    expect(screen.getByRole("button", { name: "选择项目实践成果形式，当前：文档成果" })).toBeTruthy();
    expect(screen.queryByText("暂未开放")).toBeNull();
    expect(screen.getByText("代码成果")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Python" }));
    expect(updateCourse).toHaveBeenCalledWith("course-1", expect.objectContaining({
      pblConfig: expect.objectContaining({ makeArtifactMode: "python" }),
    }));

    fireEvent.click(screen.getByRole("button", { name: "C 语言" }));
    expect(updateCourse).toHaveBeenLastCalledWith("course-1", expect.objectContaining({
      pblConfig: expect.objectContaining({ makeArtifactMode: "c" }),
    }));
  });
});
