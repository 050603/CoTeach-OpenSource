"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useBodyScrollLock } from "./use-body-scroll-lock";

export type TeacherFullscreenController = ReturnType<typeof useTeacherPresentation>;

function restoreFocus(previous: HTMLElement | null) {
  window.requestAnimationFrame(() => {
    const replacement = previous?.id ? document.getElementById(previous.id) : null;
    const target = previous?.isConnected ? previous : replacement ?? [...document.querySelectorAll<HTMLElement>("[data-teacher-presentation-trigger]")].find((element) => element.getClientRects().length);
    target?.focus();
  });
}

/** Browser fullscreen is optional: the presentation layout also works without it. */
export function useTeacherPresentation(enabled = true) {
  const [active, setActive] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [notice, setNotice] = useState<string>();
  const ownsFullscreen = useRef(false);
  const generation = useRef(0);
  const requestedActive = useRef(false);
  const pendingExit = useRef<Promise<void> | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);

  const exit = useCallback(async () => {
    const request = ++generation.current;
    requestedActive.current = false;
    if (document.fullscreenElement) {
      setExiting(true);
      const leaving = pendingExit.current ?? document.exitFullscreen();
      pendingExit.current = leaving;
      try {
        await leaving;
      } catch {
        // Keep the exit control available if the browser rejects the request.
        if (request === generation.current) setNotice("浏览器未允许退出全屏，请重试或按 Esc。");
        return;
      } finally {
        if (pendingExit.current === leaving) { pendingExit.current = undefined; setExiting(false); }
      }
    }
    if (request !== generation.current) return;
    ownsFullscreen.current = false;
    setActive(false);
    restoreFocus(returnFocus.current);
  }, []);

  const enter = useCallback(async () => {
    const request = ++generation.current;
    requestedActive.current = true;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setNotice(undefined);
    if (pendingExit.current) {
      await pendingExit.current.catch(() => undefined);
      if (request !== generation.current) return;
    }
    if (document.fullscreenElement) { setActive(true); return; }
    if (!document.documentElement.requestFullscreen) {
      setNotice("浏览器不支持全屏，继续使用当前课堂窗口。");
      return;
    }
    setActive(true);
    try {
      await document.documentElement.requestFullscreen();
      if (request !== generation.current) {
        if (!requestedActive.current && document.fullscreenElement === document.documentElement) await document.exitFullscreen();
        return;
      }
      ownsFullscreen.current = true;
      setActive(true);
    } catch {
      if (request === generation.current) {
        setActive(false);
        setNotice("浏览器未允许全屏，继续使用当前课堂窗口。");
      }
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const synchronize = () => {
      if (!document.fullscreenElement) {
        ownsFullscreen.current = false;
        setActive(false);
        if (!pendingExit.current) {
          requestedActive.current = false;
          generation.current += 1;
          restoreFocus(returnFocus.current);
        }
      } else setActive(true);
    };
    document.addEventListener("fullscreenchange", synchronize);
    return () => {
      generation.current += 1;
      requestedActive.current = false;
      document.removeEventListener("fullscreenchange", synchronize);
      if (ownsFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      ownsFullscreen.current = false;
    };
  }, [enabled]);

  useBodyScrollLock(enabled && active);
  useEffect(() => {
    if (!enabled || !active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.fullscreenElement) return;
      // Let an open dialog handle Escape before leaving the fallback layout.
      if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some((node) => node.getClientRects().length)) return;
      void exit();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, active, exit]);

  return { active, exiting, enter, exit, notice };
}
