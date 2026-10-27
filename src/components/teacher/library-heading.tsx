import type { ReactNode } from "react";
import { LearningArt } from "@/components/platform/learning-art";
import styles from "./library-heading.module.css";

export const teacherLibraryThemeClassName = styles.theme;

/** Reuse the original teacher dashboard heading across all three libraries. */
export function TeacherLibraryHeading({ eyebrow, title, summaryLabel, metrics, action }: {
  eyebrow: string;
  title: string;
  summaryLabel: string;
  metrics: ReadonlyArray<{ label: string; value: ReactNode }>;
  action: ReactNode;
}) {
  return <header className="pbl-page-heading pbl-classes-heading pbl-teacher-dashboard-heading" data-teacher-library-heading>
    <LearningArt />
    <div><p className="text-xs font-semibold tracking-[0.18em] text-[var(--pbl-teacher)]">{eyebrow}</p><h1 className="mt-3 text-3xl font-semibold md:text-4xl">{title}</h1></div>
    <div className="pbl-classes-heading-actions">
      <dl className="pbl-heading-metrics" aria-label={summaryLabel}>
        {metrics.map(({ label, value }) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {action}
    </div>
  </header>;
}
