import type { TeacherResourceProjection } from "@/lib/session/types";

export function isForcedProjection(projection?: TeacherResourceProjection | null): projection is TeacherResourceProjection {
  return Boolean(projection && projection.mode !== "optional");
}

export function isOptionalProjection(projection?: TeacherResourceProjection | null): projection is TeacherResourceProjection {
  return Boolean(projection && projection.mode === "optional");
}
