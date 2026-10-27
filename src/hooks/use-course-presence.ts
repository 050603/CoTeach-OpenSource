"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { createScopedReadLane, startPhasedPolling, waitForScopedRead } from "@/lib/browser/scoped-read-lane";
import {
  onlineStudentIds,
  type PresenceMember,
  type PresenceSnapshot,
} from "@/lib/presence";
import {
  PRESENCE_SNAPSHOT_INTERVAL_MS,
  shouldReadPresence,
} from "@/lib/realtime/presence-policy";
import { unknownSubmissionSaveTelemetry } from "@/lib/browser/submission-save-telemetry";
import type { PendingSaveTelemetry } from "@/lib/presence-save-telemetry";
import { showcaseReceipt } from "@/lib/showcase/projection-receipt-client";

const HEARTBEAT_INTERVAL_MS = 20_000;
type CoursePresenceSnapshot = PresenceSnapshot & { courseId?: string; role?: "teacher" | "student"; readScope?: object };
const EMPTY_MEMBERS: PresenceMember[] = [];

export function useCoursePresence({
  courseId,
  role,
  enabled = true,
  heartbeat = false,
  readSnapshot = true,
  readPendingSaves,
}: {
  courseId?: string;
  role: "teacher" | "student";
  enabled?: boolean;
  heartbeat?: boolean;
  readSnapshot?: boolean;
  readPendingSaves?: (courseId: string) => PendingSaveTelemetry;
}) {
  const [snapshot, setSnapshot] = useState<CoursePresenceSnapshot>({ members: [] });
  // A disabled/replaced read scope cannot keep the independent heartbeat in a
  // failed state, or make an old snapshot visible when reads resume.
  const readScope = useMemo(() => ({ courseId, role, enabled, readSnapshot }), [courseId, role, enabled, readSnapshot]);
  const readScopeRef = useRef(readScope);
  const [readDegradedScope, setReadDegradedScope] = useState<typeof readScope | null>(null);
  const [heartbeatDegraded, setHeartbeatDegraded] = useState(false);
  const readFailuresRef = useRef(0);
  const heartbeatFailuresRef = useRef(0);
  const readLaneRef = useRef<{ scope: string; lane: ReturnType<typeof createScopedReadLane> } | undefined>(undefined);
  const pendingSaveReaderRef = useRef(readPendingSaves);
  useEffect(() => { pendingSaveReaderRef.current = readPendingSaves; }, [readPendingSaves]);
  useEffect(() => {
    readScopeRef.current = readScope;
    readFailuresRef.current = 0;
  }, [readScope]);

  const recordSuccess = useCallback((channel: "read" | "heartbeat") => {
    const failures = channel === "read" ? readFailuresRef : heartbeatFailuresRef;
    const otherFailures = channel === "read" ? heartbeatFailuresRef : readFailuresRef;
    if (failures.current >= 3 && otherFailures.current < 3) {
      toast.success("在线状态同步已恢复", { id: `presence-sync-${role}-${courseId}` });
    }
    failures.current = 0;
    if (channel === "read") setReadDegradedScope(null);
    else setHeartbeatDegraded(false);
  }, [courseId, role]);

  const recordFailure = useCallback((channel: "read" | "heartbeat", error: unknown) => {
    const failures = channel === "read" ? readFailuresRef : heartbeatFailuresRef;
    failures.current += 1;
    console.error("[presence] synchronization failed", error);
    if (failures.current === 3) {
      if (channel === "read") setReadDegradedScope(readScopeRef.current);
      else setHeartbeatDegraded(true);
      toast.error("在线状态同步中断", {
        id: `presence-sync-${role}-${courseId}`,
        description: "服务器未能确认最新在线状态，正在自动重试。",
      });
    }
  }, [courseId, role]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!courseId || !enabled || !readSnapshot) return;
    const current = readLaneRef.current;
    if (current?.scope !== `${role}:${courseId}`) return;
    await waitForScopedRead(current.lane.request(true), signal);
  }, [courseId, enabled, readSnapshot, role]);

  useEffect(() => {
    if (!courseId || !enabled || !readSnapshot) return;
    const lane = createScopedReadLane(async signal => {
      try {
        const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/presence`, {
          headers: { "X-OpenPBL-Role": role }, cache: "no-store", signal,
        });
        if (!response.ok) throw new Error(`Presence request failed: ${response.status}`);
        const body = (await response.json()) as PresenceSnapshot;
        if (signal.aborted) return;
        setSnapshot({ ...body, courseId, role, readScope });
        recordSuccess("read");
      } catch (error) {
        if (!signal.aborted) recordFailure("read", error);
        throw error;
      }
    });
    const owner = { scope: `${role}:${courseId}`, lane }; readLaneRef.current = owner;
    const updateSnapshot = (fresh = false) => {
      if (!shouldReadPresence(document.visibilityState)) return;
      void lane.request(fresh).catch(() => undefined);
    };
    const visibilityChanged = () => updateSnapshot(true);
    updateSnapshot();
    document.addEventListener("visibilitychange", visibilityChanged);
    const stopPolling = startPhasedPolling(() => updateSnapshot(), PRESENCE_SNAPSHOT_INTERVAL_MS[role]);
    return () => {
      lane.dispose(); stopPolling();
      document.removeEventListener("visibilitychange", visibilityChanged);
      if (readLaneRef.current === owner) readLaneRef.current = undefined;
    };
  }, [courseId, enabled, readSnapshot, readScope, recordFailure, recordSuccess, role]);

  useEffect(() => {
    if (!courseId || !enabled || !heartbeat || role !== "student") return;

    const sendHeartbeat = () => {
      let pendingSaves = unknownSubmissionSaveTelemetry();
      try { pendingSaves = pendingSaveReaderRef.current?.(courseId) ?? pendingSaves; } catch { /* Diagnostic only. */ }
      void fetch(`/api/courses/${encodeURIComponent(courseId)}/presence`, {
        method: "PUT",
        headers: { "X-OpenPBL-Role": "student", "Content-Type": "application/json" },
        body: JSON.stringify({ pendingSaves, showcaseReceipt: showcaseReceipt(courseId) }),
        keepalive: true,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Presence heartbeat failed: ${response.status}`);
          recordSuccess("heartbeat");
        })
        .catch((error) => recordFailure("heartbeat", error));
    };

    sendHeartbeat();
    const receiptChanged = (event: Event) => {
      if ((event as CustomEvent<string>).detail === courseId) sendHeartbeat();
    };
    window.addEventListener("openpbl-showcase-receipt", receiptChanged);
    const intervalId = window.setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => { window.clearInterval(intervalId); window.removeEventListener("openpbl-showcase-receipt", receiptChanged); };
  }, [courseId, enabled, heartbeat, recordFailure, recordSuccess, role]);

  const transportDegraded = heartbeatDegraded || (readSnapshot && readDegradedScope === readScope);
  const isCurrentSnapshot = enabled && readSnapshot && snapshot.courseId === courseId && snapshot.role === role && snapshot.readScope === readScope;
  const visibleMembers = isCurrentSnapshot
    ? snapshot.members
    : EMPTY_MEMBERS;
  const studentIds = useMemo(
    () => onlineStudentIds(visibleMembers),
    [visibleMembers],
  );

  return {
    members: visibleMembers,
    onlineStudentIds: studentIds,
    onlineCount: studentIds.size,
    degraded: (isCurrentSnapshot && snapshot.degraded === true) || transportDegraded,
    source: isCurrentSnapshot ? snapshot.source : undefined,
    showcaseReceipts: isCurrentSnapshot ? snapshot.showcaseReceipts : undefined,
    refresh,
  };
}
