import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiMemberComposer } from "./ai-member-composer";

function setup({ busy = false, disabled = false } = {}) {
  const submit = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState("我的第一段想法\n还需要核对依据。");
    return <AiMemberComposer busy={busy} disabled={disabled} draft={draft} maxLength={1200}
      onChangeDraft={setDraft} onSubmit={() => submit(draft)} placeholder="输入消息" />;
  }
  render(<Harness />);
  return submit;
}

describe("AI member long message composer", () => {
  it("preserves edits across expanding and collapsing without sending", () => {
    const submit = setup();
    fireEvent.click(screen.getByRole("button", { name: "全屏输入" }));
    const dialog = screen.getByRole("dialog", { name: "给 AI 组员发消息" });
    const input = within(dialog).getByRole("textbox");
    expect(input).toHaveFocus();
    expect(input).toHaveValue("我的第一段想法\n还需要核对依据。");
    fireEvent.change(input, { target: { value: "修改后的长消息\n第二段" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "收起" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("修改后的长消息\n第二段");
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "全屏输入" }));
    expect(within(screen.getByRole("dialog")).getByRole("textbox")).toHaveValue("修改后的长消息\n第二段");
  });

  it("sends the current full-screen draft exactly once and returns to conversation", () => {
    const submit = setup();
    fireEvent.click(screen.getByRole("button", { name: "全屏输入" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByRole("textbox"), { target: { value: "完整的问题" } });
    fireEvent.click(dialog.getByRole("button", { name: "发送给 AI 组员" }));
    expect(submit).toHaveBeenCalledExactlyOnceWith("完整的问题");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps Enter and IME composition separate from the send shortcut", () => {
    const submit = setup();
    const input = screen.getByRole("textbox");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each([{ busy: true }, { disabled: true }])("preserves send restrictions in full-screen mode: %j", (options) => {
    const submit = setup(options);
    fireEvent.click(screen.getByRole("button", { name: "全屏输入" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("textbox")).toBeDisabled();
    expect(dialog.getByRole("button", { name: "发送给 AI 组员" })).toBeDisabled();
    fireEvent.keyDown(dialog.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not send whitespace or a draft beyond the current limit", () => {
    const submit = setup();
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("maxlength", "1200");
    for (const value of [" \n ", "长".repeat(1201)]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
      expect(screen.getByRole("button", { name: "发送给 AI 组员" })).toBeDisabled();
    }
    expect(submit).not.toHaveBeenCalled();
  });
});
