"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import { startPhasedPolling } from "@/lib/browser/scoped-read-lane";
import type { FinalArtifactSummary, ShowcasePresentationSnapshot } from "@/lib/session/types";
import { subscribeShowcasePresentation } from "@/lib/showcase/realtime-client";
import type { ShowcaseAction, ShowcaseData, ShowcaseEventPayload } from "@/lib/showcase/types";
import { projectionClientId } from "@/lib/realtime/projection-controller";
import { LatestValueQueue } from "@/lib/realtime/latest-value-queue";
import type { ShowcaseViewStatePatch } from "@/components/showcase/showcase-artifact-viewer";

type HookState = {
  courseId: string | undefined;
  role: "teacher" | "student";
  data?: ShowcaseData;
  loading: boolean;
  error?: string;
};

function isTeacherPage(): boolean {
  return typeof window !== "undefined" && window.location.pathname.startsWith("/teacher");
}

function mergeSnapshot(
  data: ShowcaseData,
  snapshot: ShowcasePresentationSnapshot,
  includeHistory = true,
): ShowcaseData {
  const previous = data.activePresentation?.id === snapshot.id ? data.activePresentation : data.presentations.find((item) => item.id === snapshot.id);
  const merged = {
    ...previous,
    ...snapshot,
    studentName: snapshot.studentName ?? previous?.studentName,
  };
  const presentations = includeHistory || data.presentations.some(item => item.id === snapshot.id) ? [
    merged,
    ...data.presentations.filter((item) => item.id !== snapshot.id),
  ] : data.presentations;
  return {
    ...data,
    presentations,
    projectionVersion: Math.max(data.projectionVersion ?? 0, snapshot.projectionVersion ?? 0),
    activePresentation: snapshot.status === "active"
      ? merged
      : data.activePresentation?.id === snapshot.id
        ? null
        : data.activePresentation,
  };
}

function applyRealtimePayload(
  data: ShowcaseData,
  payload: ShowcaseEventPayload,
  includeHistory = true,
): ShowcaseData {
  const version = payload.projectionVersion ?? payload.snapshot?.projectionVersion;
  if (version !== undefined && version < (data.projectionVersion ?? 0)) return data;
  let next = data;
  if (Object.prototype.hasOwnProperty.call(payload, "presentingGroupId")
    || Object.prototype.hasOwnProperty.call(payload, "presentingStudentId")
    || Object.prototype.hasOwnProperty.call(payload, "presentingStudentName")) {
    const presentingGroupId = Object.prototype.hasOwnProperty.call(payload, "presentingGroupId")
      ? payload.presentingGroupId
      : data.presentingGroupId;
    const presentingStudentId = Object.prototype.hasOwnProperty.call(payload, "presentingStudentId")
      ? payload.presentingStudentId
      : data.presentingStudentId;
    next = {
      ...next,
      presentingGroupId,
      presentingStudentId,
      presentingStudentName: payload.presentingStudentName
        ?? next.students.find((student) => student.studentId === presentingStudentId)?.name
        ?? (presentingStudentId === data.presentingStudentId ? data.presentingStudentName : undefined),
      students: next.students.map((student) => ({
        ...student,
        isAssigned: presentingStudentId
          ? student.studentId === presentingStudentId && student.groupId === presentingGroupId
          : Boolean(presentingGroupId) && student.groupId === presentingGroupId,
      })),
    };
  }
  if (payload.queue || payload.minutesPerStudent !== undefined) {
    const queue = payload.queue ?? next.queue;
    next = {
      ...next,
      queue,
      minutesPerStudent: payload.minutesPerStudent ?? next.minutesPerStudent,
      currentQueueItem: queue.find((item) => ["called", "pending-approval", "presenting", "evaluating", "rejected"].includes(item.status)) ?? null,
      nextQueueItem: queue.find((item) => item.status === "waiting") ?? null,
    };
  }
  if (payload.snapshot) {
    const incomingRevision = payload.snapshot.revision ?? payload.snapshot.viewState?.revision ?? 0;
    const existingRevision = (next.activePresentation?.id === payload.snapshot.id ? next.activePresentation.revision : undefined)
      ?? next.presentations.find((item) => item.id === payload.snapshot!.id)?.revision
      ?? next.presentations.find((item) => item.id === payload.snapshot!.id)?.viewState?.revision
      ?? 0;
    // Every lifecycle and viewport update carries the same server revision.
    // Do not let a delayed terminal event clear a newer active snapshot.
    if (incomingRevision >= existingRevision) {
      next = mergeSnapshot(next, payload.snapshot, includeHistory);
    }
  }
  return version === undefined ? next : { ...next, projectionVersion: Math.max(next.projectionVersion ?? 0, version) };
}

function mergeLoadedData(current: ShowcaseData | undefined, incoming: ShowcaseData): ShowcaseData {
  if (!current) return incoming;
  const currentById = new Map(current.presentations.map((item) => [item.id, item]));
  const presentations = incoming.presentations.map((next) => {
    const previous = currentById.get(next.id);
    if (!previous || next.revision >= previous.revision) return next;
    return previous;
  }).sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  // `presentations` is the revision-merged source of truth. Looking up the
  // active row there avoids resurrecting a delayed lower-revision
  // `activePresentation` field from a polling response.
  const incomingVersion = incoming.projectionVersion ?? 0;
  const currentVersion = current.projectionVersion ?? 0;
  let activePresentation = incoming.activePresentation ?? null;
  if (incomingVersion < currentVersion) return { ...incoming, ...current, presentations, ownArtifacts: incoming.ownArtifacts };
  const previousActive = current.activePresentation;
  if (previousActive && activePresentation?.id === previousActive.id && activePresentation.revision < previousActive.revision) activePresentation = previousActive;
  const historical = activePresentation && presentations.find(item => item.id === activePresentation!.id);
  if (historical && historical.revision >= activePresentation!.revision) activePresentation = historical.status === "active" ? historical : null;
  return {
    ...incoming,
    presentations,
    activePresentation,
  };
}

export function latestArtifact(
  artifacts: FinalArtifactSummary[],
  kind: FinalArtifactSummary["kind"],
): FinalArtifactSummary | undefined {
  return artifacts.find((artifact) => artifact.kind === kind);
}

type ReadScope = {
  courseId: string;
  role: "teacher" | "student";
  active: boolean;
  actionSequence: number;
  request: (fresh: boolean) => Promise<void>;
  invalidatePending: () => void;
};

export function useShowcasePresentation(courseId: string | undefined) {
  const role = isTeacherPage() ? "teacher" : "student";
  const [state, setState] = useState<HookState>({ courseId, role, loading: Boolean(courseId) });
  const scopeRef = useRef<ReadScope | null>(null);
  const [controlError, setControlError] = useState<string>();
  const viewportQueue = useRef<LatestValueQueue<ShowcaseViewStatePatch> | null>(null);
  const pendingViewport = useRef<ShowcaseViewStatePatch>({});
  const active = state.courseId === courseId && state.role === role ? state.data?.activePresentation : undefined;
  const needsTakeover = role === "teacher" && Boolean(active && (active.controllerClientId !== projectionClientId() || active.controlEpoch === undefined));
  const activeId = active?.id;
  const activeControlEpoch = active?.controlEpoch ?? 0;

  const load = useCallback(() => {
    const scope = scopeRef.current;
    if (!scope?.active || scope.courseId !== courseId || scope.role !== role) return Promise.resolve();
    return scope.request(true);
  }, [courseId, role]);

  useEffect(() => {
    setState({ courseId, role, loading: Boolean(courseId) });
    setControlError(undefined);
    if (!courseId) return;
    const controller = new AbortController();
    pendingViewport.current = {};
    let inFlight: Promise<void> | undefined;
    let pendingFreshRead = false;
    const scope: ReadScope = {
      courseId, role, active: true, actionSequence: 0,
      invalidatePending: () => { if (inFlight) pendingFreshRead = true; },
      request: (fresh) => {
        if (!scope.active) return Promise.resolve();
        if (inFlight) {
          // Poll ticks can join a current read. A later invalidation cannot be
          // acknowledged by a snapshot whose request predates that event.
          if (fresh) pendingFreshRead = true;
          return inFlight;
        }
        inFlight = (async () => {
          do {
            pendingFreshRead = false;
            try {
              const response = await boundedFetch(`/api/courses/${encodeURIComponent(courseId)}/showcase/presentation`, {
                cache: "no-store", signal: controller.signal,
                headers: { "X-OpenPBL-Role": role },
              });
              const payload = await response.json().catch(() => null) as ShowcaseData & { message?: string } | null;
              if (!response.ok) throw new Error(payload?.message ?? `汇报状态读取失败（${response.status}）`);
              if (scope.active && !pendingFreshRead) {
                setState((current) => ({
                  ...current,
                  data: mergeLoadedData(current.data, payload as ShowcaseData),
                  loading: false, error: undefined,
                }));
              }
            } catch (error) {
              if (scope.active && !controller.signal.aborted && !pendingFreshRead) {
                setState((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "汇报状态读取失败" }));
              }
            }
          } while (scope.active && pendingFreshRead);
        })().finally(() => {
          inFlight = undefined;
          // A notification may arrive in the microtask between the last
          // response and this finalizer. It still requires a fresh request.
          if (scope.active && pendingFreshRead) return scope.request(false);
        });
        return inFlight;
      },
    };
    scopeRef.current = scope;
    void scope.request(false);
    const unsubscribe = subscribeShowcasePresentation(courseId, (payload) => {
      if (!scope.active) return;
      // Lifecycle fields such as the queue/assignment have no independent
      // revision. Even a complete event cannot be followed by a GET that
      // started before it; bootstrap may not yet have data to patch at all.
      // Pure active-snapshot viewport updates retain their revision merge and
      // do not turn every scroll event into another network request.
      if (payload.queue !== undefined || payload.minutesPerStudent !== undefined
        || Object.prototype.hasOwnProperty.call(payload, "presentingGroupId")
        || Object.prototype.hasOwnProperty.call(payload, "presentingStudentId")
        || Object.prototype.hasOwnProperty.call(payload, "presentingStudentName")
        || (payload.snapshot && payload.snapshot.status !== "active")) {
        scope.invalidatePending();
      }
      if (payload.snapshot || Object.prototype.hasOwnProperty.call(payload, "presentingGroupId") || Object.prototype.hasOwnProperty.call(payload, "presentingStudentId") || Object.prototype.hasOwnProperty.call(payload, "presentingStudentName")) {
        setState((current) => current.data ? { ...current, data: applyRealtimePayload(current.data, payload, role === "teacher"), error: undefined } : current);
        if (!payload.queue && (Object.prototype.hasOwnProperty.call(payload, "presentingStudentId") || payload.snapshot?.status !== "active")) {
          void scope.request(true);
        }
      } else {
        void scope.request(true);
      }
    });
    const stopPolling = startPhasedPolling(() => {
      if (document.visibilityState === "visible") void scope.request(false);
    }, 3_000);
    const reconcile = () => { if (document.visibilityState === "visible") void scope.request(true); };
    window.addEventListener("online", reconcile);
    document.addEventListener("visibilitychange", reconcile);
    return () => {
      scope.active = false;
      if (scopeRef.current === scope) scopeRef.current = null;
      controller.abort();
      unsubscribe();
      stopPolling();
      window.removeEventListener("online", reconcile);
      document.removeEventListener("visibilitychange", reconcile);
    };
  }, [courseId, role]);

  useEffect(() => {
    if (!courseId || role !== "teacher" || !activeId || needsTakeover) return;
    const controller = new AbortController();
    pendingViewport.current = {};
    const presentationId = activeId;
    const controlEpoch = activeControlEpoch;
    let sequence = Date.now();
    let lastSentAt = 0;
    const queue = new LatestValueQueue<ShowcaseViewStatePatch>(async viewState => {
      if (pendingViewport.current === viewState) pendingViewport.current = {};
      const delay = Math.max(0, lastSentAt + 250 - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (controller.signal.aborted) return;
      lastSentAt = Date.now();
      const { displayMode, ...position } = viewState;
      const response = await boundedFetch(`/api/courses/${encodeURIComponent(courseId)}/showcase/presentation`, {
        method: "PATCH", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "teacher" },
        body: JSON.stringify({ presentationId, clientId: projectionClientId(), controlEpoch, sequence: ++sequence, viewState: position, ...(displayMode ? { displayMode } : {}) }),
      }, 5_000);
      const payload = await response.json().catch(() => null) as ShowcasePresentationSnapshot & { message?: string } | null;
      if (controller.signal.aborted) return;
      if (!response.ok || !payload?.id) {
        const message = payload?.message ?? "阅读位置同步失败，正在重试";
        if ([403, 404, 409].includes(response.status)) {
          setControlError(message);
          queue.dispose();
          void scopeRef.current?.request(true);
          return;
        }
        throw new Error(message);
      }
      setControlError(undefined);
      setState(current => current.courseId === courseId && current.data ? { ...current, data: applyRealtimePayload(current.data, { snapshot: payload }) } : current);
    }, 250, 1_000, error => {
      if (!controller.signal.aborted) setControlError(error instanceof Error ? error.message : "阅读位置同步失败");
    });
    viewportQueue.current = queue;
    return () => {
      controller.abort(); queue.dispose();
      if (viewportQueue.current === queue) viewportQueue.current = null;
    };
  }, [activeId, activeControlEpoch, courseId, needsTakeover, role]);

  const updateViewState = useCallback((patch: ShowcaseViewStatePatch) => {
    const next = patch.displayMode ? patch : { ...pendingViewport.current, ...patch };
    pendingViewport.current = next;
    viewportQueue.current?.enqueue(next, Boolean(patch.displayMode));
  }, []);

  const runAction = useCallback(async (action: ShowcaseAction) => {
    const scope = scopeRef.current;
    if (!courseId || !scope?.active || scope.courseId !== courseId || scope.role !== role) throw new Error("COURSE_REQUIRED");
    const sequence = ++scope.actionSequence;
    const response = await boundedFetch(`/api/courses/${encodeURIComponent(courseId)}/showcase/presentation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-OpenPBL-Role": role,
      },
      body: JSON.stringify(action.action === "start" ? { ...action, clientId: projectionClientId() } : action),
    });
    const payload = await response.json().catch(() => null) as ShowcaseData | ShowcasePresentationSnapshot | { message?: string } | null;
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
        ? payload.message
        : `汇报操作失败（${response.status}）`;
      throw new Error(message);
    }
    if (!scope.active || scopeRef.current !== scope) return payload;
    if (sequence !== scope.actionSequence) {
      // An older command's ACK is not the current controller state. Reconcile
      // from the server without allowing it to overwrite the later command.
      void scope.request(true);
      return payload;
    }
    scope.invalidatePending();
    setState((current) => {
      if (!current.data || !payload || typeof payload !== "object") return current;
      if ("courseId" in payload && "status" in payload && "id" in payload) {
        return { ...current, data: applyRealtimePayload(current.data, { snapshot: payload as ShowcasePresentationSnapshot }, role === "teacher") };
      }
      return { ...current, data: payload as ShowcaseData, error: undefined };
    });
    if (action.action === "end" || action.action === "start" || action.action === "take-control") void scope.request(true);
    return payload;
  }, [courseId, role]);

  const takeControl = useCallback(async () => {
    if (!active) return;
    await runAction({ action: "take-control", presentationId: active.id, clientId: projectionClientId() });
    setControlError(undefined);
  }, [active, runAction]);

  // A new course or role must render its own loading state before the effect
  // cleans up the old scope, including when the previous read left an error.
  return useMemo(() => {
    const visibleState: Pick<HookState, "data" | "loading" | "error"> = state.courseId === courseId && state.role === role
      ? { data: state.data, loading: state.loading, error: state.error }
      : { loading: Boolean(courseId) };
    return { ...visibleState, runAction, reload: load, updateViewState, controlError, needsTakeover, takeControl };
  }, [courseId, load, role, runAction, state, updateViewState, controlError, needsTakeover, takeControl]);
}

/** Shared controller shape used by the classroom shell and both showcase views. */
export type ShowcasePresentationController = ReturnType<typeof useShowcasePresentation>;
