import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiMemberProcessingBubble } from "./ai-member-processing-bubble";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("AI member processing bubble", () => {
  it("keeps the confirmed request state until the caller reports another state", () => {
    vi.useFakeTimers();
    const { unmount, rerender } = render(<AiMemberProcessingBubble phase="sending" />);
    expect(screen.getByRole("status")).toHaveTextContent("正在发送请求并等待回答");
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByRole("status")).toHaveTextContent("正在发送请求并等待回答");
    rerender(<AiMemberProcessingBubble phase="queued" />);
    expect(screen.getByRole("status")).toHaveTextContent("请求已排队");
    rerender(<AiMemberProcessingBubble phase="running" />);
    expect(screen.getByRole("status")).toHaveTextContent("正在思考并准备回答");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps decorative loading dots through a long wait and recovery without repeated live announcements", () => {
    vi.useFakeTimers();
    const { rerender } = render(<AiMemberProcessingBubble phase="running" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");
    expect(status.querySelectorAll('[aria-hidden="true"] i')).toHaveLength(3);
    act(() => vi.advanceTimersByTime(150_000));
    expect(status).toHaveTextContent("正在思考并准备回答");
    expect(status.querySelectorAll('[aria-hidden="true"] i')).toHaveLength(3);
    rerender(<AiMemberProcessingBubble recovering />);
    expect(status).toHaveTextContent("正在查询已保存的回答");
    expect(status.querySelectorAll('[aria-hidden="true"] i')).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("pauses loading motion in a background tab and resumes when visible", () => {
    const visibility = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    render(<AiMemberProcessingBubble />);
    const dots = screen.getByRole("status").querySelector('[aria-hidden="true"]');
    expect(dots).toHaveAttribute("data-paused", "false");
    visibility.mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(dots).toHaveAttribute("data-paused", "true");
    visibility.mockReturnValue(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(dots).toHaveAttribute("data-paused", "false");
  });

  it("keeps recovery and reduced-motion states still", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { rerender } = render(<AiMemberProcessingBubble />);
    expect(screen.getByRole("status")).toHaveTextContent("正在等待 AI 回答…");
    rerender(<AiMemberProcessingBubble recovering />);
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByRole("status")).toHaveTextContent("正在查询已保存的回答…");
    expect(screen.getByRole("status").querySelectorAll("i")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
