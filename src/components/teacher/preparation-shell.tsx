"use client";

import type { ReactNode } from "react";
import type { DashboardShellProps } from "@/components/dashboard-shell";
import { WorkspaceNav } from "@/components/platform/workspace-nav";
import { SaveStatus } from "@/components/ui";
import styles from "./preparation-shell.module.css";

export const preparationThemeClassName = styles.theme;

export function PreparationSurface({ children }: { children: ReactNode }) {
  return <div className={`pbl-platform-theme ${styles.theme}`}>{children}</div>;
}

/** Shared teacher libraries and preparation navigation; live classrooms keep their own shell. */
export function PreparationShell({
  children,
  backHref = "/teacher/templates",
  backLabel = "返回课程库",
  currentCourse,
  headerSlot,
  headerEndSlot,
  saveStatus,
  userName,
  wide,
  viewportLocked,
  onNavigate,
  active = "templates",
}: DashboardShellProps & { onNavigate?: (href: string) => void; active?: "classes" | "templates" | "textbooks" }) {
  const hasContext = Boolean(currentCourse || headerSlot || headerEndSlot || saveStatus);
  return <PreparationSurface>
    <div className={styles.shell} data-viewport-locked={viewportLocked || undefined}>
      <WorkspaceNav role="teacher" active={active} backHref={backHref} backLabel={backLabel}
        brandHref="/teacher/templates" fallbackDisplayName={userName} themeClassName={styles.theme} onNavigate={onNavigate}/>
      {hasContext ? <div className={styles.context}>
        {currentCourse ? <span className={styles.courseName} title={currentCourse.name}>{currentCourse.name}</span> : null}
        {headerSlot}
        <div className={styles.contextEnd}>{saveStatus ? <SaveStatus {...saveStatus}/> : null}{headerEndSlot}</div>
      </div> : null}
      <div className={styles.content} data-wide={wide || undefined}>{children}</div>
    </div>
  </PreparationSurface>;
}
