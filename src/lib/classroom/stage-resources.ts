import type { CourseResource } from "@/lib/session/types";

export function resourceBelongsToStage(
  resource: Pick<CourseResource, "stageKey">,
  stageKey: string,
): boolean {
  // Resources created before stage scoping existed were project-launch files.
  return resource.stageKey ? resource.stageKey === stageKey : stageKey === "launch";
}

export function resourcesForStage(
  resources: readonly CourseResource[] | undefined,
  stageKey: string,
): CourseResource[] {
  return (resources ?? []).filter((resource) =>
    resourceBelongsToStage(resource, stageKey));
}
