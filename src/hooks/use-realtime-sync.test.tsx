import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({
  connectWebSocket: vi.fn(),
  disconnectWebSocket: vi.fn(),
  realtimeMode: "websocket" as const,
}));

vi.mock("@/lib/session/store", () => ({
  useSession: () => session,
}));

import { useRealtimeSync } from "./use-realtime-sync";

describe("useRealtimeSync", () => {
  beforeEach(() => {
    session.connectWebSocket.mockClear();
    session.disconnectWebSocket.mockClear();
  });

  it("catches up after focus, network recovery, and returning to the tab", () => {
    const { unmount } = renderHook(() => useRealtimeSync("course-1"));
    expect(session.connectWebSocket).toHaveBeenCalledTimes(1);

    act(() => window.dispatchEvent(new Event("focus")));
    act(() => window.dispatchEvent(new Event("online")));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    expect(session.connectWebSocket).toHaveBeenCalledTimes(4);
    expect(session.connectWebSocket).toHaveBeenLastCalledWith("course-1");

    unmount();
    expect(session.disconnectWebSocket).toHaveBeenCalledTimes(1);
  });
});
