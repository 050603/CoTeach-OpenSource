import { z } from "zod";

export const ACTIVITY_TYPES = [
  "Classroom",
  "Assignment",
  "Quiz",
  "Form",
  "PostTest",
  "Resource",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ActivityTypeSchema = z.enum(ACTIVITY_TYPES);

export const ActivityConfigSchema = z.object({
  schemaVersion: z.number().int().positive().default(1),
}).passthrough();

export function isActivityType(value: string): value is ActivityType {
  return (ACTIVITY_TYPES as readonly string[]).includes(value);
}

export function isPlaceholderActivity(type: ActivityType): boolean {
  return type !== "Classroom";
}

export function teacherActivityResultsHref(activityId: string, type: string): string | null {
  if (type.toUpperCase() === "FORM") return `/teacher/surveys/${encodeURIComponent(activityId)}`;
  if (["POSTTEST", "QUIZ"].includes(type.toUpperCase())) return `/teacher/activities/${encodeURIComponent(activityId)}/results`;
  return null;
}

export function teacherActivityEditHref(offeringId: string, activityId: string): string {
  return `/teacher/classes/${encodeURIComponent(offeringId)}?editActivity=${encodeURIComponent(activityId)}`;
}

