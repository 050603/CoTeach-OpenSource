"use client";

import { useEffect, useState } from "react";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import type { Scene } from "@openmaic/lib/types/stage";

/** Read a classroom once, independently of the selected preview page. */
export function useKnowledgeReviewResources(classroomId: string | undefined, enabled: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ scope?: string; scenes: Scene[]; error?: string; ready: boolean }>({ scenes: [], ready: false });
  useEffect(() => {
    if (!enabled || !classroomId) return;
    const controller = new AbortController();
    // Fetching an external classroom is one scoped bridge operation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResult({ scope: classroomId, scenes: [], ready: false });
    void (async () => {
      try {
        const response = await boundedFetch(`/api/openmaic/classroom?id=${encodeURIComponent(classroomId)}`, { cache: "no-store", signal: controller.signal }, 30_000);
        if (!response.ok) throw new Error(`课件加载失败（HTTP ${response.status}）`);
        const payload = await response.json() as { classroom?: { scenes?: Scene[] } };
        if (!Array.isArray(payload.classroom?.scenes)) throw new Error("课件数据不完整，请重试");
        if (!controller.signal.aborted) setResult({ scope: classroomId, scenes: payload.classroom.scenes, ready: true });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ scope: classroomId, scenes: [], ready: true, error: error instanceof Error ? error.message : "课件加载失败" });
      }
    })();
    return () => controller.abort();
  }, [classroomId, enabled, attempt]);
  const current = result.scope === classroomId ? result : { scenes: [], ready: false };
  return { ...current, retry: () => setAttempt((value) => value + 1) };
}
