"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, LoaderCircle } from "lucide-react";
import { RichDocumentPreview } from "@/components/teacher/rich-document-preview";
import { loadPdfRuntime } from "@/lib/browser/pdf-runtime";
import type { FinalArtifactSummary, ShowcaseDisplayMode, ShowcasePresentationSnapshot } from "@/lib/session/types";
import { applyViewPosition, indexDocumentBlocks, readViewPosition } from "@/lib/showcase/view-position";
import styles from "./showcase-viewer.module.css";

export type ShowcaseViewerMode = "self" | "controller" | "follower" | "teacher";
export type ShowcaseViewStatePatch = { page?: number; scrollRatio?: number; blockId?: string; blockOffset?: number; pageOffset?: number; displayMode?: ShowcaseDisplayMode };
export type ShowcaseLoadState = "loading" | "ready" | "error";

export function ShowcaseArtifactViewer({
  courseId,
  artifact,
  mode,
  presentation,
  displayMode,
  teacherFollowing = true,
  onViewStateChange,
  initialViewState,
  presentationLayout = false,
  scale = 1,
  onLoadStateChange,
}: {
  courseId: string;
  artifact: FinalArtifactSummary;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  displayMode?: ShowcaseDisplayMode;
  teacherFollowing?: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
  initialViewState?: ShowcaseViewStatePatch;
  presentationLayout?: boolean;
  scale?: number;
  onLoadStateChange?: (state: ShowcaseLoadState, message?: string) => void;
}) {
  const canScroll = mode === "self" || mode === "controller" || (mode === "teacher" && !teacherFollowing);
  const follow = mode === "follower" || (mode === "teacher" && teacherFollowing);
  const [documentHtml, setDocumentHtml] = useState<{ url: string; html: string }>();
  const [error, setError] = useState<{ url: string; message: string }>();
  const [retry, setRetry] = useState(0);
  const callbackRef = useRef(onLoadStateChange);
  useEffect(() => { callbackRef.current = onLoadStateChange; }, [onLoadStateChange]);
  const notify = useCallback((state: ShowcaseLoadState, message?: string) => callbackRef.current?.(state, message), []);
  const retryLoad = () => { setError(undefined); setDocumentHtml(undefined); setRetry(value => value + 1); };
  const contentUrl = `/api/courses/${encodeURIComponent(courseId)}/showcase/artifacts/${encodeURIComponent(artifact.versionId)}`;

  useEffect(() => { notify("loading"); }, [contentUrl, notify, retry]);

  useEffect(() => {
    const controller = new AbortController();
    if (artifact.kind !== "document") return () => controller.abort();
    void fetch(contentUrl, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { html?: string; message?: string } | null;
        if (!response.ok || typeof payload?.html !== "string") throw new Error(payload?.message ?? "文档成果读取失败");
        if (!controller.signal.aborted) setDocumentHtml({ url: contentUrl, html: payload.html });
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          const message = caught instanceof Error ? caught.message : "文档成果读取失败";
          setError({ url: contentUrl, message }); notify("error", message);
        }
      });
    return () => controller.abort();
  }, [artifact.kind, artifact.versionId, contentUrl, retry, notify]);

  if (error?.url === contentUrl) return <ViewerError message={error.message} onRetry={retryLoad} />;
  if (artifact.kind === "document") {
    if (!documentHtml || documentHtml.url !== contentUrl) return <ViewerLoading label="正在打开最终文档…" />;
    return (
      <DocumentArtifactViewer
        canScroll={canScroll}
        follow={follow}
        html={documentHtml.html}
        mode={mode}
        onViewStateChange={onViewStateChange}
        initialViewState={initialViewState}
        presentation={presentation}
        presentationLayout={presentationLayout}
        scale={scale}
        onLoadStateChange={notify}
        onRetry={retryLoad}
      />
    );
  }
  return (
      <PdfArtifactViewer
        canScroll={canScroll}
      contentUrl={contentUrl}
      displayMode={displayMode}
      follow={follow}
      mode={mode}
      onViewStateChange={onViewStateChange}
      initialViewState={initialViewState}
      presentation={presentation}
      key={`${artifact.versionId}:${retry}`}
      scale={scale}
      onLoadStateChange={notify}
      onRetry={retryLoad}
    />
  );
}

function DocumentArtifactViewer({
  html,
  mode,
  presentation,
  follow,
  canScroll,
  onViewStateChange,
  initialViewState,
  presentationLayout,
  scale,
  onLoadStateChange,
  onRetry,
}: {
  html: string;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  follow: boolean;
  canScroll: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
  initialViewState?: ShowcaseViewStatePatch;
  presentationLayout: boolean;
  scale: number;
  onLoadStateChange: (state: ShowcaseLoadState, message?: string) => void;
  onRetry: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [imageError, setImageError] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const savedPosition = useRef<ShowcaseViewStatePatch>(initialViewState ?? presentation?.viewState ?? {});
  useEffect(() => {
    const images = Array.from(scrollRef.current?.querySelectorAll("img") ?? []);
    let failed = false;
    const report = () => {
      if (failed) return;
      if (images.some(image => image.complete && image.naturalWidth === 0)) {
        failed = true; setImageError(true); onLoadStateChange("error", "作品中的图片读取失败");
      } else if (images.every(image => image.complete)) onLoadStateChange("ready");
    };
    images.forEach(image => { image.addEventListener("load", report); image.addEventListener("error", report); });
    report();
    return () => images.forEach(image => { image.removeEventListener("load", report); image.removeEventListener("error", report); });
  }, [html, onLoadStateChange]);
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);
  useEffect(() => {
    if (!follow) return;
    savedPosition.current = presentation?.viewState ?? {};
    const applyRatio = () => {
      const container = scrollRef.current;
      if (!container) return;
      indexDocumentBlocks(container);
      applyViewPosition(container, presentation?.viewState ?? {}, "document");
    };
    const frame = window.requestAnimationFrame(applyRatio);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(applyRatio);
    if (observer && scrollRef.current) {
      observer.observe(scrollRef.current);
      if (scrollRef.current.firstElementChild) observer.observe(scrollRef.current.firstElementChild);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [follow, html, presentation?.viewState, scale]);
  useEffect(() => {
    if (follow) return;
    const applyRatio = () => {
      const container = scrollRef.current;
      if (container) { indexDocumentBlocks(container); applyViewPosition(container, savedPosition.current, "document"); }
    };
    const frame = window.requestAnimationFrame(applyRatio);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(applyRatio);
    if (observer && scrollRef.current) {
      observer.observe(scrollRef.current);
      if (scrollRef.current.firstElementChild) observer.observe(scrollRef.current.firstElementChild);
    }
    return () => { window.cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [follow, html, scale]);

  function queueSync() {
    if (!(["controller", "self"].includes(mode)) || !onViewStateChange) return;
    if (mode === "self") {
      const container = scrollRef.current;
      if (container) {
        savedPosition.current = readViewPosition(container, "document");
        onViewStateChange(savedPosition.current);
      }
      return;
    }
    if (timerRef.current !== undefined) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      const container = scrollRef.current;
      if (!container) return;
      savedPosition.current = readViewPosition(container, "document");
      onViewStateChange(savedPosition.current);
    }, 140);
  }

  return (
    <div className={`relative h-full min-h-0 overflow-hidden bg-stone-100 ${presentationLayout ? styles.presentationDocument : "rounded-lg"}`} style={{ "--showcase-font-size": `${(presentationLayout ? 24 : 14) * scale}px`, "--showcase-compact-font-size": `${(presentationLayout ? 22 : 14) * scale}px` } as React.CSSProperties}>
      {imageError ? <div role="alert" className="absolute right-3 top-3 z-10 rounded-md border border-rose-200 bg-white px-3 text-xs text-rose-700">作品中的图片读取失败 <button type="button" className="min-h-11 font-semibold underline" onClick={onRetry}>重试打开作品</button></div> : null}
      <div
        aria-label={follow ? "跟随汇报学生的文档" : "最终文档预览"}
        className={`h-full overflow-y-auto ${presentationLayout ? "p-2 sm:p-3" : "p-4 sm:p-7"} ${canScroll ? "" : "pointer-events-none overscroll-none"}`}
        onScroll={queueSync}
        ref={scrollRef}
      >
        <div className={`mx-auto min-h-full bg-white ${presentationLayout ? "w-full px-4 py-4 sm:px-10" : "max-w-4xl rounded-lg p-5 shadow-sm sm:p-8"}`}>
          <RichDocumentPreview html={html} minHeight={280} />
        </div>
      </div>
    </div>
  );
}

function PdfArtifactViewer({
  contentUrl,
  mode,
  presentation,
  displayMode,
  follow,
  canScroll,
  onViewStateChange,
  initialViewState,
  scale,
  onLoadStateChange,
  onRetry,
}: {
  contentUrl: string;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  displayMode?: ShowcaseDisplayMode;
  follow: boolean;
  canScroll: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
  initialViewState?: ShowcaseViewStatePatch;
  scale: number;
  onLoadStateChange: (state: ShowcaseLoadState, message?: string) => void;
  onRetry: () => void;
}) {
  const [pdf, setPdf] = useState<PdfDocument>();
  const [error, setError] = useState<string>();
  const hadRenderError = useRef(false);
  const reportRender = useCallback((state: ShowcaseLoadState, message?: string) => {
    if (state === "error") hadRenderError.current = true;
    if (state !== "ready" || !hadRenderError.current) onLoadStateChange(state, message);
  }, [onLoadStateChange]);
  useEffect(() => {
    const controller = new AbortController();
    let loaded: PdfDocument | undefined;
    void fetch(contentUrl, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`PDF 读取失败（${response.status}）`);
        const data = await response.arrayBuffer();
        const pdfjs = await loadPdfRuntime() as PdfJsModule;
        loaded = await pdfjs.getDocument({ data }).promise;
        if (!controller.signal.aborted) setPdf(loaded);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          const message = caught instanceof Error ? caught.message : "PDF 读取失败";
          setError(message); onLoadStateChange("error", message);
        }
      });
    return () => {
      controller.abort();
      void loaded?.destroy?.();
    };
  }, [contentUrl, onLoadStateChange]);
  if (error) return <ViewerError message={error} onRetry={onRetry} />;
  if (!pdf) return <ViewerLoading label="正在解析最终 PDF…" />;
  const slides = (presentation?.displayMode ?? displayMode) === "slides";
  return slides ? (
    <PdfSlidesViewer
      canScroll={canScroll}
      follow={follow}
      mode={mode}
      onViewStateChange={onViewStateChange}
      initialViewState={initialViewState}
      pdf={pdf}
      presentation={presentation}
      scale={scale}
      onLoadStateChange={reportRender}
      onRetry={onRetry}
    />
  ) : (
    <PdfContinuousViewer
      canScroll={canScroll}
      follow={follow}
      mode={mode}
      onViewStateChange={onViewStateChange}
      initialViewState={initialViewState}
      pdf={pdf}
      presentation={presentation}
      scale={scale}
      onLoadStateChange={reportRender}
      onRetry={onRetry}
    />
  );
}

function PdfContinuousViewer({
  pdf,
  mode,
  presentation,
  follow,
  canScroll,
  onViewStateChange,
  initialViewState,
  scale,
  onLoadStateChange,
  onRetry,
}: {
  pdf: PdfDocument;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  follow: boolean;
  canScroll: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
  initialViewState?: ShowcaseViewStatePatch;
  scale: number;
  onLoadStateChange: (state: ShowcaseLoadState, message?: string) => void;
  onRetry: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const savedPosition = useRef<ShowcaseViewStatePatch>(initialViewState ?? presentation?.viewState ?? {});
  useEffect(() => () => {
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
  }, []);
  useEffect(() => {
    if (!follow) return;
    savedPosition.current = presentation?.viewState ?? {};
    const applyRatio = () => {
      const container = scrollRef.current;
      if (!container) return;
      applyViewPosition(container, presentation?.viewState ?? {}, "pdf");
    };
    const frame = window.requestAnimationFrame(applyRatio);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(applyRatio);
    if (observer && scrollRef.current) {
      observer.observe(scrollRef.current);
      if (scrollRef.current.firstElementChild) observer.observe(scrollRef.current.firstElementChild);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [follow, pdf, presentation?.viewState, scale]);
  useEffect(() => {
    if (follow) return;
    const applyRatio = () => {
      const container = scrollRef.current;
      if (container) applyViewPosition(container, savedPosition.current, "pdf");
    };
    const frame = window.requestAnimationFrame(applyRatio);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(applyRatio);
    if (observer && scrollRef.current) {
      observer.observe(scrollRef.current);
      if (scrollRef.current.firstElementChild) observer.observe(scrollRef.current.firstElementChild);
    }
    return () => { window.cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [follow, pdf, scale]);
  function queueSync() {
    if (!(["controller", "self"].includes(mode)) || !onViewStateChange) return;
    if (mode === "self") {
      const container = scrollRef.current;
      if (container) {
        savedPosition.current = readViewPosition(container, "pdf");
        onViewStateChange(savedPosition.current);
      }
      return;
    }
    if (timerRef.current !== undefined) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      const container = scrollRef.current;
      if (!container) return;
      savedPosition.current = readViewPosition(container, "pdf");
      onViewStateChange(savedPosition.current);
    }, 140);
  }
  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-stone-200">
      <div className={`h-full overflow-y-auto p-3 sm:p-5 ${canScroll ? "" : "pointer-events-none overscroll-none"}`} onScroll={queueSync} ref={scrollRef}>
        <div className="mx-auto space-y-4" style={{ width: `${scale * 100}%` }}>
          {Array.from({ length: pdf.numPages }, (_, index) => <div data-showcase-page={index + 1} key={index + 1}><PdfPageCanvas pageNumber={index + 1} pdf={pdf} onLoadStateChange={onLoadStateChange} onRetry={onRetry} /></div>)}
        </div>
      </div>
    </div>
  );
}

function PdfSlidesViewer({
  pdf,
  mode,
  presentation,
  follow,
  canScroll,
  onViewStateChange,
  initialViewState,
  scale,
  onLoadStateChange,
  onRetry,
}: {
  pdf: PdfDocument;
  mode: ShowcaseViewerMode;
  presentation?: ShowcasePresentationSnapshot;
  follow: boolean;
  canScroll: boolean;
  onViewStateChange?: (patch: ShowcaseViewStatePatch) => void;
  initialViewState?: ShowcaseViewStatePatch;
  scale: number;
  onLoadStateChange: (state: ShowcaseLoadState, message?: string) => void;
  onRetry: () => void;
}) {
  const [localPage, setLocalPage] = useState(() => initialViewState?.page ?? presentation?.viewState?.page ?? 1);
  const projectedPage = presentation?.viewState?.page ?? 1;
  const page = follow ? projectedPage : localPage;
  const safePage = Math.min(pdf.numPages, Math.max(1, page));
  function changePage(next: number) {
    const value = Math.min(pdf.numPages, Math.max(1, next));
    setLocalPage(value);
    if (mode === "controller" || mode === "self") onViewStateChange?.({ page: value });
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-stone-950">
      <div className={`min-h-0 flex-1 items-center justify-center overflow-auto p-2 ${canScroll ? "flex" : "pointer-events-none flex"}`}>
        <PdfSlideCanvas key={safePage} pageNumber={safePage} pdf={pdf} scale={scale} onLoadStateChange={onLoadStateChange} onRetry={onRetry} />
      </div>
      <div className="flex h-14 shrink-0 items-center justify-center gap-4 border-t border-white/10 bg-stone-900 px-4 text-white">
        {canScroll ? <button aria-label="上一页" className="grid size-11 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" disabled={safePage <= 1} onClick={() => changePage(safePage - 1)} type="button"><ChevronLeft size={19} /></button> : null}
        <span className="min-w-32 text-center text-sm font-semibold">{safePage} / {pdf.numPages}{follow ? " · 跟随汇报" : ""}</span>
        {canScroll ? <button aria-label="下一页" className="grid size-11 place-items-center rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-30" disabled={safePage >= pdf.numPages} onClick={() => changePage(safePage + 1)} type="button"><ChevronRight size={19} /></button> : null}
      </div>
    </div>
  );
}

function PdfSlideCanvas({ pdf, pageNumber, scale, onLoadStateChange, onRetry }: { pdf: PdfDocument; pageNumber: number; scale: number; onLoadStateChange: (state: ShowcaseLoadState, message?: string) => void; onRetry: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let task: { promise: Promise<void>; cancel?: () => void } | undefined;
    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: 1.75 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      task = page.render({ canvas, canvasContext: context, viewport });
      return task.promise.then(() => { if (!cancelled) onLoadStateChange("ready"); });
    }).catch(() => {
      if (!cancelled) { setError(true); onLoadStateChange("error", `第 ${pageNumber} 页加载失败`); }
    });
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [pageNumber, pdf, onLoadStateChange]);
  if (error) return <ViewerError message={`第 ${pageNumber} 页加载失败`} onRetry={onRetry} />;
  return <canvas aria-label={`PDF 第 ${pageNumber} 页`} className="block max-h-full max-w-full bg-white shadow-2xl" style={scale > 1 ? { maxWidth: "none", maxHeight: "none", width: `${scale * 100}%`, flexShrink: 0 } : undefined} ref={canvasRef} />;
}

function PdfPageCanvas({ pdf, pageNumber, onLoadStateChange, onRetry }: { pdf: PdfDocument; pageNumber: number; onLoadStateChange: (state: ShowcaseLoadState, message?: string) => void; onRetry: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let task: { promise: Promise<void>; cancel?: () => void } | undefined;
    void pdf.getPage(pageNumber).then((page) => {
      if (cancelled || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: 1.55 });
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      task = page.render({ canvas, canvasContext: context, viewport });
      return task.promise.then(() => { if (!cancelled && pageNumber === 1) onLoadStateChange("ready"); });
    }).catch(() => {
      if (!cancelled) { setError(true); onLoadStateChange("error", `第 ${pageNumber} 页加载失败`); }
    });
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [pageNumber, pdf, onLoadStateChange]);
  if (error) return <ViewerError message={`第 ${pageNumber} 页加载失败`} onRetry={onRetry} />;
  return <canvas aria-label={`PDF 第 ${pageNumber} 页`} className="block w-full rounded bg-white shadow-sm" ref={canvasRef} />;
}

function ViewerLoading({ label }: { label: string }) {
  return <div className="grid h-full min-h-72 place-items-center rounded-lg border border-stone-200 bg-stone-50 text-sm text-stone-500"><span className="inline-flex items-center gap-2"><LoaderCircle className="animate-spin" size={18} />{label}</span></div>;
}

function ViewerError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="grid h-full min-h-0 place-items-center border border-rose-200 bg-rose-50 px-5 text-center text-sm text-rose-700"><div><FileText className="mx-auto" size={24} /><p className="mt-2">{message}</p>{onRetry ? <button className="mt-3 min-h-11 rounded-md border border-rose-300 bg-white px-4 font-semibold" onClick={onRetry} type="button">重试打开作品</button> : null}</div></div>;
}

type PdfPage = { getViewport: (input: { scale: number }) => { width: number; height: number }; render: (input: { canvas: HTMLCanvasElement; canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => { promise: Promise<void>; cancel?: () => void } };
type PdfDocument = { numPages: number; getPage: (pageNumber: number) => Promise<PdfPage>; destroy?: () => Promise<void> };
type PdfJsModule = { GlobalWorkerOptions: { workerSrc: string }; getDocument: (input: { data: ArrayBuffer }) => { promise: Promise<PdfDocument> } };
