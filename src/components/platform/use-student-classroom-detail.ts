"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StudentClassroomActivity } from "./student-classroom-detail.types";

/** Refresh classroom state without recording another activity visit. */
export function useStudentClassroomDetail(initialActivity: StudentClassroomActivity) {
  const [activity, setActivity] = useState(initialActivity);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const suspended = useRef(false);
  const unavailable = useRef(false);
  const activityId = initialActivity.id;

  const cancelRequest = useCallback(() => {
    sequence.current += 1;
    request.current?.abort();
    request.current = null;
  }, []);

  const suspendRefresh = useCallback(() => {
    suspended.current = true;
    cancelRequest();
    setRefreshing(false);
  }, [cancelRequest]);

  const resumeRefresh = useCallback(() => { suspended.current = false; }, []);

  const refresh = useCallback(async () => {
    if (suspended.current || unavailable.current || request.current || document.hidden || navigator.onLine === false) return;
    const controller = new AbortController();
    request.current = controller;
    const current = ++sequence.current;
    setRefreshing(true);
    try {
      const response = await fetch(`/api/platform/activities/${encodeURIComponent(activityId)}?refresh=1`, { cache: "no-store", signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (controller.signal.aborted || sequence.current !== current) return;
      if (!response.ok) {
        if ([401, 403, 404, 410].includes(response.status)) {
          unavailable.current = true;
          setAccessLost(true);
        }
        throw new Error(data.message || "课堂状态更新失败，请重试。");
      }
      if (!data.activity || data.activity.id !== activityId) throw new Error("课堂状态更新失败，请重试。");
      setActivity(data.activity);
      setRefreshError(null);
    } catch (reason) {
      if (!controller.signal.aborted && sequence.current === current) {
        setRefreshError(reason instanceof Error ? reason.message : "课堂状态更新失败，请重试。");
      }
    } finally {
      if (sequence.current === current) {
        request.current = null;
        setRefreshing(false);
      }
    }
  }, [activityId]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    function schedule(immediate: boolean) {
      clearInterval(timer);
      if (document.hidden || navigator.onLine === false) {
        cancelRequest();
        setRefreshing(false);
        return;
      }
      if (immediate) void refresh();
      timer = setInterval(() => void refresh(), 15_000);
    }
    const resume = () => schedule(true);
    schedule(false);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", resume);
    return () => {
      clearInterval(timer);
      cancelRequest();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
    };
  }, [cancelRequest, refresh]);

  return { activity, refreshing, refreshError, accessLost, refresh, suspendRefresh, resumeRefresh };
}
