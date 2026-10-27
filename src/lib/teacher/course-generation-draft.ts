import { z } from "zod";

const draftSchema = z.object({
  sourceKey: z.string(),
  jobId: z.string().nullable(),
  brief: z.string().max(4000),
  generationMode: z.enum(["standard", "deep-interaction"]),
  generationScope: z.enum(["full-course", "test-lesson"]),
  assessmentMode: z.enum(["adaptive", "constructed-response"]),
  options: z.object({ enableImageGeneration: z.boolean(), enableTTS: z.boolean(), enableVideoGeneration: z.boolean() }),
  referenceMaterials: z.array(z.object({ id: z.string(), fileName: z.string(), fileType: z.string().optional(), mimeType: z.string().optional(), size: z.string().optional() })),
  textbookSelections: z.array(z.object({ revisionId: z.string(), primary: z.boolean(), sectionIds: z.array(z.string()) })),
});

export type CourseGenerationInputDraft = z.infer<typeof draftSchema>;

export type PreparationMode = "resource-package" | "collaborative-preparation";
const settingsSchema = draftSchema.pick({ generationMode: true, generationScope: true, assessmentMode: true, options: true });
export type CourseGenerationSettings = z.infer<typeof settingsSchema>;

export function courseGenerationSettingsKey(teacherId: string, courseId: string, mode: PreparationMode): string {
  return `openpbl:generation-settings:v1:${encodeURIComponent(teacherId)}:${encodeURIComponent(courseId)}:${mode}`;
}

export function readCourseGenerationSettings(storage: Pick<Storage, "getItem">, key: string): CourseGenerationSettings | null {
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(storage.getItem(key) ?? "null"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function courseGenerationDraftKey(teacherId: string, courseId: string): string {
  return `openpbl:generation-input:v1:${encodeURIComponent(teacherId)}:${encodeURIComponent(courseId)}`;
}

export function readCourseGenerationDraft(storage: Pick<Storage, "getItem">, key: string, sourceKey: string, jobId: string | null): CourseGenerationInputDraft | null {
  try {
    const parsed = draftSchema.safeParse(JSON.parse(storage.getItem(key) ?? "null"));
    return parsed.success && parsed.data.sourceKey === sourceKey && parsed.data.jobId === jobId ? parsed.data : null;
  } catch {
    return null;
  }
}
