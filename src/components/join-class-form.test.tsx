import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JoinClassForm } from "./join-class-form";

describe("JoinClassForm", () => {
  it("centers both student entry fields", () => {
    render(<JoinClassForm onSubmit={vi.fn()} />);

    expect(screen.getByLabelText("邀请码").className).toContain("text-center");
    expect(screen.getByLabelText("姓名").className).toContain("text-center");
  });

  it("accepts a grouped invite code pasted with an internal space", () => {
    const onSubmit = vi.fn();
    render(<JoinClassForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("邀请码"), { target: { value: "A2K 9QP" } });
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "张三" } });
    fireEvent.click(screen.getByRole("button", { name: "进入课堂" }));

    expect(onSubmit).toHaveBeenCalledWith("A2K9QP", "张三");
  });
});
