import type { ReactNode } from "react";
import { WorkspaceNav } from "./workspace-nav";

type TeacherPlatformHeaderProps = {
  active?: "classes" | "templates" | "textbooks" | "settings";
  /** @deprecated Breadcrumb content is retained for call-site compatibility. Use backHref/backLabel. */
  leading?: ReactNode;
  backHref?: string;
  backLabel?: string;
  compact?: boolean;
  themeClassName?: string;
};

export function TeacherPlatformHeader({ active, backHref, backLabel, compact, themeClassName }: TeacherPlatformHeaderProps) {
  return <WorkspaceNav role="teacher" active={active} backHref={backHref} backLabel={backLabel} compact={compact} themeClassName={themeClassName} />;
}

export function TeacherPlatformPage({ children, className = "" }: { children: ReactNode; compactNav?: boolean; className?: string }) {
  return <main className={`pbl-platform-page pbl-workspace min-h-screen text-[var(--pbl-text)] ${className}`}>{children}</main>;
}
