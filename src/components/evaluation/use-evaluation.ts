"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import type { PblEvaluationCommand, PblEvaluationSnapshot } from "@/lib/evaluation/pbl-contract";

export type EvaluationInput = PblEvaluationCommand extends infer Command
  ? Command extends PblEvaluationCommand ? Omit<Command, "idempotencyKey"> : never : never;

export class EvaluationRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function readResponse(response: Response): Promise<PblEvaluationSnapshot> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new EvaluationRequestError(body?.error?.message ?? body?.message ?? (typeof body?.error === "string" ? body.error : "评价暂时无法保存，请重试。"), response.status);
  if (body?.contractVersion !== 2) throw new EvaluationRequestError("评价数据尚未准备好，请刷新重试。", 502);
  return body;
}

export function useEvaluation(instanceId: string, enabled = true, role: "teacher" | "student" = "teacher") {
  const [snapshot, setSnapshot] = useState<PblEvaluationSnapshot>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const revision = useRef(0);
  const mounted = useRef(true);
  const retries = useRef(new Map<string, string>());
  const endpoint = `/api/platform/classroom-instances/${encodeURIComponent(instanceId)}/evaluation`;
  const refresh = useCallback(async () => {
    const current = ++revision.current;
    try {
      const next = await readResponse(await boundedFetch(endpoint, { cache: "no-store", headers: { "x-auth-role": role } }, 15_000));
      if (mounted.current && current === revision.current) { setSnapshot(next); setError(""); }
      return next;
    } catch (reason) {
      if (mounted.current && current === revision.current) setError(reason instanceof Error ? reason.message : "评价加载失败，请重试。");
      return undefined;
    } finally {
      if (mounted.current && current === revision.current) setLoading(false);
    }
  }, [endpoint, role]);
  const command = useCallback(async (input: EvaluationInput) => {
    const signature = JSON.stringify(input);
    const idempotencyKey = retries.current.get(signature) ?? crypto.randomUUID();
    retries.current.set(signature, idempotencyKey);
    ++revision.current;
    try {
      const next = await readResponse(await boundedFetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", "x-auth-role": role },
        body: JSON.stringify({ ...input, idempotencyKey }),
      }, 20_000));
      retries.current.delete(signature);
      ++revision.current;
      if (mounted.current) { setSnapshot(next); setError(""); }
      return next;
    } catch (reason) {
      if (reason instanceof EvaluationRequestError && reason.status < 500) retries.current.delete(signature);
      throw reason;
    }
  }, [endpoint, role]);
  useEffect(() => {
    mounted.current = true;
    if (!enabled) return;
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("online", visible);
    return () => { mounted.current = false; window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener("online", visible); };
  }, [enabled, refresh]);
  return { snapshot, error, loading, refresh, command };
}
