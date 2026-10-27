import type { Course } from "@/lib/session/types";
import type { PlatformDb } from "./access";
import { prisma } from "@/lib/db/client";
import { createPblTemplateCourse, decodePblTemplate } from "./pbl-template";

export async function loadPblTemplateCourse(id: string, db: PlatformDb = prisma): Promise<Course | null> {
  const template = await db.classroomTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: "desc" }, take: 1 } } });
  if (!template || template.status.toUpperCase() === "DELETED") return null;
  const version = template.versions[0];
  const design = decodePblTemplate(version?.snapshot);
  if (!design) return null;
  return { ...createPblTemplateCourse(id, design, { createdAt: template.createdAt.toISOString(), updatedAt: template.updatedAt.toISOString() }), version: template.updatedAt.getTime(), status: version.status === "PUBLISHED" ? "ready" : "preparing" };
}
