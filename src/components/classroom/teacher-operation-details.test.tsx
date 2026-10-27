import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TeacherOperationDrawer } from "./teacher-operation-details";

function Example() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)} type="button">选择学生</button>
    <TeacherOperationDrawer open={open} onOpenChange={setOpen} title="学生列表" description="选择当前查看的学生。">
      <button type="button">小林</button>
    </TeacherOperationDrawer>
  </>;
}

describe("classroom operation drawer", () => {
  it("opens on demand and restores the classroom trigger after Escape", async () => {
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "选择学生" });
    trigger.focus();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "学生列表" });
    expect(within(drawer).getByRole("button", { name: "小林" })).toBeVisible();
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });
});
