"use client";

import { useEffect } from "react";
import { useSession } from "@/lib/session/store";

export interface RealtimeSyncState {
  connected: boolean;
  mode: "websocket" | "polling";
}

/**
 * Subscribe the current classroom to realtime invalidations. The shared
 * socket is closed when the classroom view unmounts so background retries do
 * not survive navigation.
 */
export function useRealtimeSync(courseId: string | undefined): RealtimeSyncState {
  const { connectWebSocket, disconnectWebSocket, realtimeMode } = useSession();

  useEffect(() => {
    connectWebSocket(courseId);
    const catchUp = () => connectWebSocket(courseId);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") catchUp();
    };
    window.addEventListener("focus", catchUp);
    window.addEventListener("online", catchUp);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("focus", catchUp);
      window.removeEventListener("online", catchUp);
      document.removeEventListener("visibilitychange", handleVisibility);
      disconnectWebSocket();
    };
    // SessionProvider owns these functions; only a course switch should
    // replace the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  return {
    connected: realtimeMode === "websocket",
    mode: realtimeMode,
  };
}
