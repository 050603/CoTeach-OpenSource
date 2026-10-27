"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useShowcasePresentation, type ShowcasePresentationController } from "@/hooks/use-showcase-presentation";
import { ShowcaseArtifactViewer, type ShowcaseLoadState } from "./showcase-artifact-viewer";
import { setShowcaseReceipt } from "@/lib/showcase/projection-receipt-client";
import type { Course, FinalArtifactSummary, ShowcasePresentationSnapshot } from "@/lib/session/types";

const StudentShowcaseContext = createContext<ShowcasePresentationController | undefined>(undefined);
export const useStudentShowcaseController = () => useContext(StudentShowcaseContext);

/** One public presentation host remains mounted above all personal workspaces. */
export function StudentShowcaseProvider({ course, children }: { course?: Course; children: ReactNode }) {
  const enabled = course?.status === "teaching" && course.stages[course.currentStageIndex]?.key === "showcase";
  const controller = useShowcasePresentation(enabled ? course.id : undefined);
  const active = enabled && controller.data?.stageKey === "showcase" ? controller.data.activePresentation : undefined;
  return <StudentShowcaseContext.Provider value={controller}>
    <div style={{ display: "contents" }} inert={Boolean(active)}>{children}</div>
    {active?.status === "active" ? <StudentShowcaseProjection key={active.id} presentation={active} /> : null}
  </StudentShowcaseContext.Provider>;
}

export function StudentShowcaseProjection({ presentation }: { presentation: ShowcasePresentationSnapshot }) {
  const [loadState, setLoadState] = useState<ShowcaseLoadState>("loading");
  const currentRef = useRef(presentation);
  useEffect(() => { currentRef.current = presentation; }, [presentation]);
  const record = useCallback((status: ShowcaseLoadState) => {
    setLoadState(status);
    const current = currentRef.current;
    setShowcaseReceipt(current.courseId, { presentationId: current.id, artifactVersionId: current.artifactVersionId, revision: current.revision, status });
  }, []);
  useEffect(() => {
    const current = presentation;
    setShowcaseReceipt(current.courseId, { presentationId: current.id, artifactVersionId: current.artifactVersionId, revision: current.revision, status: loadState });
  }, [presentation, loadState]);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      setShowcaseReceipt(presentation.courseId, undefined);
      previousFocus?.focus?.();
    };
  }, [presentation.courseId]);
  const artifact: FinalArtifactSummary = { kind: presentation.artifactKind, versionId: presentation.artifactVersionId,
    title: presentation.artifactTitle, sequence: 0, submittedAt: presentation.startedAt ?? presentation.requestedAt,
    displayModes: presentation.artifactKind === "pdf" ? ["continuous", "slides"] : ["continuous"] };
  return createPortal(<section role="dialog" aria-modal="true" aria-label={`全班作品展示：${presentation.artifactTitle}`}
    data-testid="student-showcase-projection" className="fixed inset-0 z-[180] flex h-dvh min-h-0 flex-col bg-white text-stone-800">
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-stone-200 px-3 py-1.5 sm:px-5">
      <strong className="text-[var(--pbl-student)]">{presentation.studentName ?? "当前学生"} · 正在汇报</strong>
      <span className="min-w-0 flex-1 truncate text-sm">{presentation.artifactTitle}</span>
      <span className="text-xs text-stone-500" aria-live="polite">{loadState === "error" ? "作品加载失败，请重试" : loadState === "loading" ? "正在打开作品…" : "跟随教师展示"}</span>
    </header>
    <div className="min-h-0 flex-1"><ShowcaseArtifactViewer key={artifact.versionId} courseId={presentation.courseId} artifact={artifact}
      mode="follower" presentation={presentation} presentationLayout onLoadStateChange={record} /></div>
  </section>, document.body);
}
