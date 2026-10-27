import type { Course } from "@/lib/session/types";

export type CourseGenerationInputSummary = {
  source?: "resource-package" | "collaborative-preparation";
  preparationSessionId?: string | null;
  preparationRevision?: number | null;
  sourceStatus: "current" | "stale" | "unavailable";
  resourcePackageId: string | null;
  resourcePackageRevision: number | null;
  taskStatus: string;
  teacherBrief: string;
  referenceMaterials: Array<{ id: string; fileName: string; mimeType?: string }>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read only: expose saved input metadata without resuming or modifying a generation task. */
export function summarizeCourseGenerationInput(
  course: Pick<Course, "content">,
  job: { status: string; request: unknown } | null,
): CourseGenerationInputSummary | null {
  if (!job) return null;
  const request = record(job.request);
  const source = record(request.resourcePackage);
  const resourcePackageId = typeof source.id === "string" ? source.id : null;
  const resourcePackageRevision = typeof source.revision === "number" ? source.revision : null;
  const current = course.content.resourcePackage;
  const preparation = record(request.confirmedPreparation);
  const collaborative = Boolean(request.confirmedPreparation);
  const preparationSessionId = typeof preparation.sessionId === "string" ? preparation.sessionId : null;
  const preparationRevision = typeof preparation.revision === "number" ? preparation.revision : null;
  const currentPreparation = course.content.confirmedPreparation;
  const currentSource = course.content.preparationSource ?? (current ? "resource-package" : currentPreparation ? "collaborative-preparation" : null);
  const sourceStatus = collaborative
    ? !preparationSessionId || preparationRevision === null || !currentPreparation?.confirmedAt ? "unavailable"
      : currentSource === "collaborative-preparation" && currentPreparation.sessionId === preparationSessionId && currentPreparation.revision === preparationRevision ? "current" : "stale"
    : currentSource === "collaborative-preparation" ? "stale"
    : !resourcePackageId || resourcePackageRevision === null || !current ? "unavailable"
    : current.id === resourcePackageId && current.revision === resourcePackageRevision ? "current" : "stale";
  const summary: CourseGenerationInputSummary = {
    ...(collaborative ? { source: "collaborative-preparation" as const, preparationSessionId, preparationRevision } : {}),
    sourceStatus, resourcePackageId, resourcePackageRevision, taskStatus: job.status,
    teacherBrief: "", referenceMaterials: [],
  };
  if (sourceStatus !== "current") return summary;
  summary.teacherBrief = typeof request.teacherBrief === "string" ? request.teacherBrief : "";
  const packageFileIds = Object.values(record(source.documents)).map((file) => record(file).id)
    .concat(record(source.source).id).filter((id): id is string => typeof id === "string");
  const seen = new Set<string>();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  for (const value of Array.isArray(request.referenceMaterials) ? request.referenceMaterials : []) {
    const material = record(value);
    const id = typeof material.id === "string" ? material.id : "";
    if (!uuid.test(id) || seen.has(id) || typeof material.fileName !== "string" || !material.fileName.trim()
      || packageFileIds.some((fileId) => id === fileId || id.startsWith(`${fileId}:part-`))) continue;
    seen.add(id);
    summary.referenceMaterials.push({ id, fileName: material.fileName,
      ...(typeof material.mimeType === "string" ? { mimeType: material.mimeType } : {}) });
  }
  return summary;
}
