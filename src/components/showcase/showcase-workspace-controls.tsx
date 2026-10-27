"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Download, Minus, Plus, X } from "lucide-react";
import type { FinalArtifactSummary, ShowcaseDisplayMode } from "@/lib/session/types";
import { useAutoHidingControls } from "@/components/classroom/use-auto-hiding-controls";
import styles from "./showcase-workspace.module.css";

export function artifactLabel(artifact: FinalArtifactSummary): string {
  if (artifact.kind === "pdf") return "PDF / 演示稿";
  if (artifact.kind === "document") return "Word 文档";
  if (artifact.mimeType?.includes("zip") || artifact.mimeType?.includes("compressed")) return "压缩包";
  if (artifact.mimeType?.startsWith("text/") || artifact.mimeType?.includes("javascript") || artifact.mimeType?.includes("json")) return "代码或文本";
  return "额外成果";
}

export function ShowcaseZoomControls({ scale, onChange, disabled = false, compact = false }: {
  scale: number; onChange: (scale: number) => void; disabled?: boolean; compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const { visible, reveal, hold, release } = useAutoHidingControls(compact, false);
  useEffect(() => {
    if (!compact) return;
    const panel = panelRef.current;
    const surface = panel?.parentElement;
    if (!panel || !surface) return;
    let keyboardNavigation = false;
    const onPointerDown = (event: Event) => {
      keyboardNavigation = false;
      release("focus");
      if (!panel.contains(event.target as Node)) setOpen(false);
      reveal();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      keyboardNavigation = true;
      if (panel.contains(document.activeElement)) hold("focus");
      if (event.key !== "Escape") reveal();
    };
    const onFocus = (event: FocusEvent) => {
      if (keyboardNavigation && panel.contains(event.target as Node)) hold("focus");
      reveal();
    };
    const onScroll = (event: Event) => {
      if (event.type !== "scroll" && !panel.contains(event.target as Node)) {
        keyboardNavigation = false;
        release("focus");
        setOpen(false);
        if (panel.contains(document.activeElement)) surface.focus({ preventScroll: true });
      }
      reveal();
    };
    surface.addEventListener("pointermove", reveal);
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("touchstart", onPointerDown, { passive: true });
    surface.addEventListener("wheel", onScroll, { passive: true });
    surface.addEventListener("scroll", onScroll, true);
    surface.addEventListener("keydown", onKeyDown);
    surface.addEventListener("focusin", onFocus);
    return () => {
      surface.removeEventListener("pointermove", reveal);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("touchstart", onPointerDown);
      surface.removeEventListener("wheel", onScroll);
      surface.removeEventListener("scroll", onScroll, true);
      surface.removeEventListener("keydown", onKeyDown);
      surface.removeEventListener("focusin", onFocus);
    };
  }, [compact, hold, release, reveal]);
  useEffect(() => {
    if (!compact) return;
    if (open) hold("pointer");
    else release("pointer");
  }, [compact, hold, open, release]);
  const controlsId = useId();
  const percent = Math.round(scale * 100);
  const controls = <>
    <button aria-label="缩小作品" disabled={disabled || percent <= 50} onClick={() => onChange(Math.max(50, percent - 10) / 100)} type="button"><Minus size={16} /></button>
    <button aria-label="恢复100%" disabled={disabled} onClick={() => onChange(1)} title="恢复原始大小" type="button">{compact ? "重置" : <output aria-label="文档缩放比例">{percent}%</output>}</button>
    <button aria-label="放大作品" disabled={disabled || percent >= 200} onClick={() => onChange(Math.min(200, percent + 10) / 100)} type="button"><Plus size={16} /></button>
  </>;
  return <div aria-label="作品缩放" className={`${styles.zoomControls} ${compact ? styles.cornerZoom : ""}`} hidden={compact && (!visible || disabled)} ref={panelRef} role="group" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); release("focus"); } }} onKeyDown={(event) => {
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); event.currentTarget.querySelector<HTMLButtonElement>("[aria-expanded]")?.focus(); }
  }}>
    {compact ? <><button aria-label="调整作品缩放" aria-expanded={open} aria-controls={controlsId} disabled={disabled} onClick={() => setOpen(value => !value)} type="button"><output aria-label="文档缩放比例">{percent}%</output></button>{open ? <div className={styles.zoomMenu} id={controlsId}>{controls}</div> : null}</> : controls}
  </div>;
}

export function ShowcaseMaterialToolbar({ artifacts, selected, onSelect, displayMode, onDisplayModeChange, tone, children, actions, className = "", showDownload = true }: {
  artifacts: FinalArtifactSummary[];
  selected?: FinalArtifactSummary;
  onSelect: (artifact: FinalArtifactSummary) => void;
  displayMode: ShowcaseDisplayMode;
  onDisplayModeChange: (mode: ShowcaseDisplayMode) => void;
  tone: "student" | "teacher";
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  showDownload?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const filtered = artifacts.filter((artifact) => `${artifact.title} ${artifactLabel(artifact)} ${artifact.sequence}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return <div className={`${styles.toolbar} ${tone === "student" ? styles.student : ""} ${className}`}>
    {children}
    <div className={styles.picker} ref={rootRef}>
      <button aria-controls={listId} aria-expanded={open} aria-haspopup="listbox" aria-label={tone === "student" ? "选择主汇报资料" : "选择学生汇报材料"} className={styles.pickerButton} disabled={!artifacts.length} onClick={() => { setOpen((value) => !value); setQuery(""); }} ref={triggerRef} type="button"><span>{selected?.title ?? "暂无材料"}</span><ChevronDown className="ml-auto shrink-0" size={16} /></button>
      {open ? <div className={styles.pickerMenu} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); triggerRef.current?.focus(); } }}>
        <input aria-label="搜索材料" className={styles.pickerSearch} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名称或类型" ref={searchRef} type="search" value={query} />
        <div aria-label="材料列表" id={listId} role="listbox">{filtered.length ? filtered.map((artifact) => <button aria-selected={artifact.versionId === selected?.versionId} className={styles.pickerOption} key={artifact.versionId} onClick={() => { onSelect(artifact); setOpen(false); triggerRef.current?.focus(); }} role="option" type="button"><span className="block text-[11px] text-[var(--pbl-text-muted)]">{artifactLabel(artifact)} · 第 {artifact.sequence} 版</span><strong className="block font-semibold">{artifact.title}</strong></button>) : <p className="p-3 text-sm text-[var(--pbl-text-muted)]">没有匹配的材料</p>}</div>
      </div> : null}
    </div>
    <div className={styles.toolbarActions}>
      {selected?.kind === "pdf" ? <div aria-label={tone === "student" ? "PDF 预览方式" : "PDF 投屏方式"} className="flex gap-1"><button aria-pressed={displayMode === "continuous"} className={styles.toolbarButton} onClick={() => onDisplayModeChange("continuous")} type="button">连续阅读</button><button aria-pressed={displayMode === "slides"} className={styles.toolbarButton} onClick={() => onDisplayModeChange("slides")} type="button">逐页演示</button></div> : null}
      {showDownload && selected?.downloadUrl && selected.kind !== "file" ? <a className={styles.toolbarButton} download href={selected.downloadUrl}><Download size={15} />下载</a> : null}
      {actions}
    </div>
  </div>;
}

export function ShowcaseDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); }
      if (event.key === "Tab" && dialogRef.current) {
        const controls = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled)")];
        if (!controls.length) return;
        const first = controls[0]!;
        const last = controls[controls.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previousFocus.current?.focus(); };
  }, []);
  return <div className={styles.drawerBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section aria-label={title} aria-modal="true" className={styles.drawer} ref={dialogRef} role="dialog">
      <header className={styles.drawerHeader}><h2 className="text-base font-bold">{title}</h2><button aria-label={`关闭${title}`} className={styles.toolbarButton} onClick={onClose} ref={closeRef} type="button"><X size={18} /></button></header>
      <div className={styles.drawerBody}>{children}</div>
    </section>
  </div>;
}

export { styles as showcaseStyles };
