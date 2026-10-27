"use client";

import { motion, useReducedMotion } from "motion/react";
import Image from "next/image";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AiMemberPhase, EditorAiMemberControls } from "@/components/editor/openpbl-editor-context";
import styles from "./document-workspace-layout.module.css";

const DEFAULT_RATIO = 2 / 3;
const EDITOR_MIN = 400;
const MEMBER_MIN = 320;
const HANDLE_WIDTH = 8;
const SPLIT_MIN = EDITOR_MIN + MEMBER_MIN + HANDLE_WIDTH;
const DURATION = 0.32;
const EASE = [0.22, 1, 0.36, 1] as const;

type AvatarBox = { left: number; top: number; width: number; height: number };
type AvatarFlight = { from: AvatarBox; to: AvatarBox; phase: "opening" | "closing" };

export function documentWorkspaceSplit(width: number, preferredRatio: number) {
  const available = Math.max(0, width - HANDLE_WIDTH);
  if (width < SPLIT_MIN) return null;
  const editor = Math.min(available - MEMBER_MIN, Math.max(EDITOR_MIN, available * preferredRatio));
  return { editor, member: available - editor, available };
}

function avatarBox(element: HTMLElement | null): AvatarBox | null {
  if (!element) return null;
  const { left, top, width, height } = element.getBoundingClientRect();
  return width > 0 && height > 0 ? { left, top, width, height } : null;
}

export function useDocumentWorkspaceLayout(studentId: string, toolbarTop: number) {
  const panelId = useId();
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<AiMemberPhase>("closed");
  const phaseRef = useRef<AiMemberPhase>("closed");
  const [flight, setFlight] = useState<AvatarFlight | null>(null);
  const flightStartRef = useRef<AvatarBox | null>(null);
  const sourceLoadedRef = useRef(false);
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const columnsRef = useRef<HTMLDivElement>(null);
  const editorPaneRef = useRef<HTMLDivElement>(null);
  const toolbarAvatarRef = useRef<HTMLSpanElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const memberAvatarRef = useRef<HTMLSpanElement>(null);
  const memberHeadingRef = useRef<HTMLHeadingElement>(null);
  const editorBookmark = useRef<{ scrollTop: number; range: Range | null }>({ scrollTop: 0, range: null });
  const needsRestoreRef = useRef(false);
  const focusDocumentRef = useRef(false);
  const focusFrameRef = useRef<number | null>(null);
  const pendingFocusRef = useRef<"open" | "closed" | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [preferredRatio, setPreferredRatio] = useState(DEFAULT_RATIO);
  const ratioRef = useRef(DEFAULT_RATIO);
  const storageKey = `openpbl:document-workspace:split:v1:${encodeURIComponent(studentId)}`;
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ pointerId: number; target: HTMLElement } | null>(null);
  const split = documentWorkspaceSplit(size.width, preferredRatio);
  const narrow = split === null;
  const narrowRef = useRef(narrow);
  useLayoutEffect(() => { narrowRef.current = narrow; }, [narrow]);
  const memberOpen = phase !== "closed";
  const memberVisible = memberOpen && !(narrow && phase === "closing");
  const documentHidden = narrow && (phase === "opening" || phase === "open");

  const rememberEditor = useCallback(() => {
    const pane = editorPaneRef.current;
    if (!pane || pane.hidden) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    editorBookmark.current = {
      scrollTop: pane.scrollTop,
      range: range && pane.contains(range.commonAncestorContainer) ? range.cloneRange() : editorBookmark.current.range,
    };
  }, []);

  const completeTransition = useCallback(() => {
    if (phaseRef.current !== "opening" && phaseRef.current !== "closing") return;
    const next = phaseRef.current === "opening" ? "open" : "closed";
    phaseRef.current = next;
    pendingFocusRef.current = next;
    setPhase(next);
    setFlight(null);
  }, []);

  // Wait for React to commit the enabled launcher/visible panel before focus.
  // A resize can finish a flight before that commit in a concurrent render.
  useLayoutEffect(() => {
    if ((phase !== "open" && phase !== "closed") || pendingFocusRef.current !== phase) return;
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null;
      if (phaseRef.current !== phase || pendingFocusRef.current !== phase) return;
      pendingFocusRef.current = null;
      if (phase === "closed") {
        // Focusing contenteditable can collapse the native selection. Restore
        // its bookmark after focus when a preview explicitly returns to it.
        if (focusDocumentRef.current) editorPaneRef.current?.querySelector<HTMLElement>('[data-slate-editor="true"]')?.focus({ preventScroll: true });
        if (needsRestoreRef.current) {
          const pane = editorPaneRef.current;
          if (pane) pane.scrollTop = editorBookmark.current.scrollTop;
          const range = editorBookmark.current.range;
          if (range?.startContainer.isConnected && range.endContainer.isConnected) {
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          }
          needsRestoreRef.current = false;
        }
        if (!focusDocumentRef.current) launcherRef.current?.focus({ preventScroll: true });
        focusDocumentRef.current = false;
      } else memberHeadingRef.current?.focus({ preventScroll: true });
    });
    return () => {
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
      focusFrameRef.current = null;
    };
  }, [phase]);

  const beginTransition = useCallback((next: "opening" | "closing") => {
    if (phaseRef.current !== (next === "opening" ? "closed" : "open")) return;
    rememberEditor();
    if (narrowRef.current) needsRestoreRef.current = true;
    const source = next === "opening" ? toolbarAvatarRef.current : memberAvatarRef.current;
    flightStartRef.current = avatarBox(source);
    const image = source?.querySelector("img");
    sourceLoadedRef.current = Boolean(image?.complete && image.naturalWidth);
    phaseRef.current = next;
    setPhase(next);
  }, [rememberEditor]);
  const openMember = useCallback(() => beginTransition("opening"), [beginTransition]);
  const closeMember = useCallback(() => beginTransition("closing"), [beginTransition]);
  const revealDocument = useCallback(() => {
    if (!narrowRef.current || phaseRef.current === "closed") {
      editorPaneRef.current?.querySelector<HTMLElement>('[data-slate-editor="true"]')?.focus({ preventScroll: true });
      return;
    }
    focusDocumentRef.current = true;
    if (phaseRef.current === "opening") completeTransition();
    beginTransition("closing");
  }, [beginTransition, completeTransition]);

  useLayoutEffect(() => {
    if (phase !== "opening" && phase !== "closing") return;
    const from = flightStartRef.current;
    const to = avatarBox(phase === "opening" ? memberAvatarRef.current : toolbarAvatarRef.current);
    if (reducedMotion || !from || !to || !sourceLoadedRef.current) {
      completeTransition();
      return;
    }
    setFlight({ from, to, phase });
    // Always finish even when a background tab pauses the visual animation.
    const timeout = window.setTimeout(completeTransition, DURATION * 1000 + 150);
    return () => window.clearTimeout(timeout);
  }, [phase, reducedMotion, completeTransition]);

  useEffect(() => {
    let saved = DEFAULT_RATIO;
    try {
      const raw = localStorage.getItem(storageKey);
      const value = raw === null ? NaN : Number(raw);
      if (Number.isFinite(value) && value > 0 && value < 1) saved = value;
    } catch { /* Layout preferences must not interrupt classroom work. */ }
    const restore = requestAnimationFrame(() => {
      ratioRef.current = saved;
      setPreferredRatio(saved);
    });
    return () => cancelAnimationFrame(restore);
  }, [storageKey]);

  const stopDrag = useCallback((persist: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
    setDragging(false);
    if (persist && drag) {
      try { localStorage.setItem(storageKey, String(ratioRef.current)); } catch { /* Optional preference. */ }
    }
  }, [storageKey]);

  useLayoutEffect(() => {
    if (!frame) return;
    const measure = () => {
      const width = columnsRef.current?.getBoundingClientRect().width || frame.clientWidth || Math.max(0, window.innerWidth - 32);
      const viewport = window.visualViewport;
      const bottom = viewport ? viewport.height + viewport.offsetTop : window.innerHeight;
      // Conflict notices can initially push the workspace below the viewport.
      // Retain a scrollable surface instead of collapsing it to zero forever.
      const height = Math.max(160, bottom - frame.getBoundingClientRect().top - 12);
      const nextNarrow = width < SPLIT_MIN;
      if (nextNarrow && !narrowRef.current && phaseRef.current !== "closed") {
        rememberEditor();
        needsRestoreRef.current = true;
      }
      if (!nextNarrow && narrowRef.current && needsRestoreRef.current && editorPaneRef.current) {
        const savedScroll = editorBookmark.current.scrollTop;
        requestAnimationFrame(() => { if (editorPaneRef.current) editorPaneRef.current.scrollTop = savedScroll; });
      }
      setSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    const resized = () => {
      if (phaseRef.current === "opening" || phaseRef.current === "closing") completeTransition();
      stopDrag(true);
      measure();
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(frame);
    if (frame.parentElement) observer?.observe(frame.parentElement);
    window.addEventListener("resize", resized);
    window.visualViewport?.addEventListener("resize", resized);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resized);
      window.visualViewport?.removeEventListener("resize", resized);
    };
  }, [frame, toolbarTop, completeTransition, rememberEditor, stopDrag]);

  useEffect(() => () => {
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    const drag = dragRef.current;
    if (drag?.target.hasPointerCapture?.(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId);
  }, []);

  const setRatio = useCallback((ratio: number, persist: boolean) => {
    const nextSplit = documentWorkspaceSplit(size.width, ratio);
    if (!nextSplit) return;
    const next = nextSplit.editor / nextSplit.available;
    ratioRef.current = next;
    setPreferredRatio(next);
    if (persist) {
      try { localStorage.setItem(storageKey, String(next)); } catch { /* Optional preference. */ }
    }
  }, [size.width, storageKey]);
  const resizeFromPointer = (clientX: number) => {
    const bounds = columnsRef.current?.getBoundingClientRect();
    if (bounds && split) setRatio((clientX - bounds.left - HANDLE_WIDTH / 2) / split.available, false);
  };

  const aiMemberControls: EditorAiMemberControls = { phase, panelId, avatarRef: toolbarAvatarRef, launcherRef };
  return {
    phase, memberOpen, memberVisible, documentHidden, narrow, split, size, dragging, flight, reducedMotion,
    frameRef: setFrame, columnsRef, editorPaneRef, memberAvatarRef, memberHeadingRef, aiMemberControls,
    openMember, closeMember, revealDocument, completeTransition,
    dividerProps: {
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || phaseRef.current !== "open") return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, target: event.currentTarget };
        setDragging(true);
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) resizeFromPointer(event.clientX);
      },
      onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId !== event.pointerId) return;
        resizeFromPointer(event.clientX);
        stopDrag(true);
      },
      onPointerCancel: () => stopDrag(true),
      onLostPointerCapture: () => stopDrag(true),
      onDoubleClick: () => {
        ratioRef.current = DEFAULT_RATIO;
        setPreferredRatio(DEFAULT_RATIO);
        try { localStorage.setItem(storageKey, String(DEFAULT_RATIO)); } catch { /* Optional preference. */ }
      },
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!split || phaseRef.current !== "open") return;
        const current = split.editor / split.available;
        const next = event.key === "ArrowLeft" ? current - 0.02 : event.key === "ArrowRight" ? current + 0.02
          : event.key === "Home" ? 0 : event.key === "End" ? 1 : null;
        if (next !== null) { event.preventDefault(); setRatio(next, true); }
      },
    },
  };
}

export type DocumentWorkspaceController = ReturnType<typeof useDocumentWorkspaceLayout>;

export function DocumentWorkspaceLayout({ controller: workspace, editor, member }: {
  controller: DocumentWorkspaceController;
  editor: ReactNode;
  member: ReactNode;
}) {
  const { split, flight, narrow, phase, frameRef, size, columnsRef, dragging, memberVisible,
    documentHidden, editorPaneRef, dividerProps, aiMemberControls, reducedMotion, completeTransition } = workspace;
  return <div
    className={styles.frame}
    data-document-workspace=""
    data-layout={narrow ? "single" : "split"}
    data-member-state={phase}
    ref={frameRef}
    style={{ height: size.width ? size.height : "calc(100dvh - 160px)" }}
  >
    <div
      className={styles.columns}
      data-dragging={dragging || undefined}
      ref={columnsRef}
      style={{ gridTemplateColumns: memberVisible && split ? `${split.editor}px ${HANDLE_WIDTH}px minmax(0, 1fr)` : "minmax(0, 1fr)" }}
    >
      <div className={styles.documentPane} data-document-pane="" hidden={documentHidden} inert={documentHidden} ref={editorPaneRef}>
        {editor}
      </div>
      {memberVisible && split ? <div
        {...dividerProps}
        aria-label="调整文档与 AI 组员的宽度"
        aria-controls={aiMemberControls.panelId}
        aria-orientation="vertical"
        aria-valuemin={Math.round(EDITOR_MIN / split.available * 100)}
        aria-valuemax={Math.round((split.available - MEMBER_MIN) / split.available * 100)}
        aria-valuenow={Math.round(split.editor / split.available * 100)}
        aria-valuetext={`文档 ${Math.round(split.editor / split.available * 100)}%，组员 ${Math.round(split.member / split.available * 100)}%`}
        aria-disabled={phase !== "open" || undefined}
        className={styles.divider}
        role="separator"
        tabIndex={0}
        title="拖动调整比例，双击恢复默认"
      ><span /></div> : null}
      <motion.div
        animate={{ opacity: phase === "closing" || phase === "closed" ? 0 : 1,
          clipPath: phase === "closing" || phase === "closed" ? "inset(0 0 0 100%)" : "inset(0 0 0 0%)" }}
        className={styles.memberPane}
        data-ai-member-pane=""
        hidden={!memberVisible}
        inert={!memberVisible || phase === "closing"}
        initial={false}
        transition={{ duration: reducedMotion ? 0 : DURATION, ease: EASE }}
      >{member}</motion.div>
    </div>
    {flight ? createPortal(<motion.div
      animate={{ left: [flight.from.left, (flight.from.left + flight.to.left) / 2, flight.to.left], top: [flight.from.top, Math.min(flight.from.top, flight.to.top) - 16, flight.to.top], width: flight.to.width, height: flight.to.height }}
      aria-hidden="true"
      className={styles.flyingAvatar}
      data-ai-member-flight={flight.phase}
      initial={{ left: flight.from.left, top: flight.from.top, width: flight.from.width, height: flight.from.height }}
      key={flight.phase}
      onAnimationComplete={completeTransition}
      transition={{ duration: DURATION, ease: EASE }}
    ><Image alt="" className="rounded-full object-cover" fill sizes="32px" src="/openmaic/avatars/ai-teammate.webp" /></motion.div>, document.body) : null}
  </div>;
}
