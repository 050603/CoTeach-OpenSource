import type { Stage } from "@/lib/session/types";

/** Local teacher display state; never persisted to the shared classroom. */
export type TeacherPresentationMode = "workspace" | "teaching" | "analytics";

export type TeacherPresentationView = Exclude<TeacherPresentationMode, "workspace"> | "student-work" | "classroom-review";

export function defaultTeacherPresentationView(stage?: Pick<Stage, "key">): TeacherPresentationView {
  return stage?.key === "ai-learning" ? "analytics" : "teaching";
}
