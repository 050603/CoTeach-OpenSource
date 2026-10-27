"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type ControlInteraction = "pointer" | "focus";

export function useAutoHidingControls(enabled: boolean, initiallyVisible = true) {
  const [visible, setVisible] = useState(initiallyVisible);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const interactions = useRef(new Set<ControlInteraction>());

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  }, []);

  const scheduleHide = useCallback(() => {
    clearTimer();
    if (enabled && interactions.current.size === 0) {
      timer.current = setTimeout(() => setVisible(false), 1_800);
    }
  }, [clearTimer, enabled]);

  const reveal = useCallback(() => {
    if (!enabled) return;
    setVisible(true);
    scheduleHide();
  }, [enabled, scheduleHide]);

  const hide = useCallback(() => {
    if (!enabled || interactions.current.size > 0) return;
    clearTimer();
    setVisible(false);
  }, [clearTimer, enabled]);

  const hold = useCallback((interaction: ControlInteraction) => {
    if (!enabled) return;
    interactions.current.add(interaction);
    clearTimer();
    setVisible(true);
  }, [clearTimer, enabled]);

  const release = useCallback((interaction: ControlInteraction) => {
    interactions.current.delete(interaction);
    scheduleHide();
  }, [scheduleHide]);

  const dismiss = useCallback(() => {
    interactions.current.clear();
    hide();
  }, [hide]);

  useEffect(() => {
    scheduleHide();
    return clearTimer;
  }, [clearTimer, scheduleHide]);

  return { visible: !enabled || visible, reveal, hide, hold, release, dismiss };
}
