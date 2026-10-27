"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProjectMemoryEntry } from "@/lib/ai-collaboration/project-support-types";

function continuationFor(memories: ProjectMemoryEntry[]): string | undefined {
  const open = memories.find((memory) => memory.kind === "open-question");
  if (open) return `上次还没有解决的问题是：${open.content}`;
  const attempt = memories.find((memory) => memory.kind === "attempt-result");
  return attempt ? `可以从上次的尝试继续：${attempt.content}` : undefined;
}

export function useProjectMemory(input: {
  courseId: string;
  studentId: string;
  enabled: boolean;
  initialRead?: "immediate" | "deferred";
}) {
  const scopeKey = input.enabled ? `${input.courseId}:${input.studentId}` : "";
  // A distinct lifetime also fences A -> B -> A and callbacks retained by an old view.
  const identity = useMemo(() => ({ courseId: input.courseId, studentId: input.studentId, enabled: input.enabled }), [input.courseId, input.studentId, input.enabled]);
  const lifetimeRef = useRef<{ identity: typeof identity; reads: Set<AbortController> } | null>(null);
  const [memoryState, setMemoryState] = useState<{ identity: typeof identity | null; entries: ProjectMemoryEntry[] }>({ identity: null, entries: [] });
  const memories = useMemo(
    () => memoryState.identity === identity ? memoryState.entries : [],
    [memoryState.entries, memoryState.identity, identity],
  );
  const setMemories = useCallback((value: ProjectMemoryEntry[] | ((current: ProjectMemoryEntry[]) => ProjectMemoryEntry[])) => {
    const lifetime = lifetimeRef.current;
    if (lifetime?.identity !== identity) return;
    setMemoryState((current) => {
      if (lifetimeRef.current !== lifetime) return current;
      const active = current.identity === identity ? current.entries : [];
      return { identity, entries: typeof value === "function" ? value(active) : value };
    });
  }, [identity]);

  useEffect(() => {
    const lifetime = { identity, reads: new Set<AbortController>() };
    lifetimeRef.current = lifetime;
    return () => {
      lifetimeRef.current = null;
      for (const controller of lifetime.reads) controller.abort();
      lifetime.reads.clear();
    };
  }, [identity]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const lifetime = lifetimeRef.current;
    if (!scopeKey || !input.courseId || !input.studentId || lifetime?.identity !== identity || signal?.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    lifetime.reads.add(controller);
    const query = new URLSearchParams({ courseId: input.courseId, studentId: input.studentId });
    try {
      const response = await fetch(`/api/ai-collaboration/memory?${query.toString()}`, { cache: "no-store", signal: controller.signal });
      const payload = await response.json() as { memories?: ProjectMemoryEntry[] };
      if (response.ok && !controller.signal.aborted && lifetimeRef.current === lifetime) setMemories(payload.memories ?? []);
    } catch { /* Preserve the current list when the optional read is unavailable. */ }
    finally {
      signal?.removeEventListener("abort", abort);
      lifetime.reads.delete(controller);
    }
  }, [input.courseId, input.studentId, identity, scopeKey, setMemories]);

  useEffect(() => {
    if (input.initialRead !== "deferred") {
      let active = true;
      queueMicrotask(() => { if (active) void refresh(); });
      return () => { active = false; };
    }
  }, [input.initialRead, refresh]);

  const updateMemory = useCallback((memoryId: string, content: string) => {
    const lifetime = lifetimeRef.current;
    if (lifetime?.identity !== identity) return;
    void fetch("/api/ai-collaboration/memory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", courseId: input.courseId, studentId: input.studentId, memoryId, content }),
    }).then(async (response) => {
      const payload = await response.json() as { memories?: ProjectMemoryEntry[] };
      if (response.ok && lifetimeRef.current === lifetime) setMemories(payload.memories ?? []);
    }).catch(() => undefined);
  }, [input.courseId, input.studentId, identity, setMemories]);

  const deleteMemory = useCallback((memoryId: string) => {
    const lifetime = lifetimeRef.current;
    if (lifetime?.identity !== identity) return;
    const query = new URLSearchParams({ courseId: input.courseId, studentId: input.studentId, memoryId });
    void fetch(`/api/ai-collaboration/memory?${query.toString()}`, { method: "DELETE" })
      .then(async (response) => {
        const payload = await response.json() as { memories?: ProjectMemoryEntry[] };
        if (response.ok && lifetimeRef.current === lifetime) setMemories(payload.memories ?? []);
      }).catch(() => undefined);
  }, [input.courseId, input.studentId, identity, setMemories]);

  const clearMemories = useCallback(() => {
    const lifetime = lifetimeRef.current;
    if (lifetime?.identity !== identity) return;
    void fetch("/api/ai-collaboration/memory", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear", courseId: input.courseId, studentId: input.studentId }),
    }).then(async (response) => {
      const payload = await response.json() as { memories?: ProjectMemoryEntry[] };
      if (response.ok && lifetimeRef.current === lifetime) setMemories(payload.memories ?? []);
    }).catch(() => undefined);
  }, [input.courseId, input.studentId, identity, setMemories]);

  return {
    memories,
    continuation: useMemo(() => continuationFor(memories), [memories]),
    replaceMemories: setMemories,
    refresh,
    updateMemory,
    deleteMemory,
    clearMemories,
  };
}
