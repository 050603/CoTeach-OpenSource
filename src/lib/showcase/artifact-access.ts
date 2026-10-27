import type { AuthClaims } from "@/lib/auth/session";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { prisma } from "@/lib/db/client";
import { showcaseStore } from "./persistence";

/** A public classroom projection grants access only while that exact version is active. */
export async function canReadActiveShowcaseArtifact(claims: AuthClaims, courseId: string, versionId: string): Promise<boolean> {
  if (claims.role !== "student" || !(await canAccessLegacyCourse(claims, courseId, "read"))) return false;
  const course = await showcaseStore.loadCourse({ where: { id: courseId }, select: { status: true, currentStageIndex: true, stages: true } });
  const stage = Array.isArray(course?.stages) ? course.stages[course.currentStageIndex] : undefined;
  if (course?.status !== "teaching" || !stage || typeof stage !== "object" || !("key" in stage) || stage.key !== "showcase") return false;
  return Boolean(await showcaseStore.findPresentation({ where: { courseId, artifactVersionId: versionId, status: "active" } }));
}

/** Protected inline assets inherit the active document's classroom scope and exact version. */
export async function canReadActiveShowcaseAsset(claims: AuthClaims, file: { id: string; offeringId?: string | null; uploadedById?: string | null }): Promise<boolean> {
  if (claims.role !== "student" || !claims.sub || !file.offeringId) return false;
  const active = await prisma.showcasePresentation.findMany({ where: {
    status: "ACTIVE", participation: { instance: { participations: { some: { enrollment: { userId: claims.sub } } } } },
    artifactVersion: { artifact: { participation: { enrollment: { offeringId: file.offeringId } } } },
  }, select: { artifactVersionId: true, participation: { select: { instanceId: true, enrollment: { select: { userId: true } } } }, artifactVersion: { select: { sourceHtml: true } } } });
  const encodedId = encodeURIComponent(file.id);
  for (const item of active) {
    if (!item.artifactVersionId || !item.artifactVersion?.sourceHtml || file.uploadedById !== item.participation.enrollment.userId) continue;
    const urls = item.artifactVersion.sourceHtml.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi) ?? [];
    const referenced = urls.some((attribute) => {
      const value = attribute.replace(/^[^=]+=\s*["']|["']$/g, "");
      try { return new URL(value, "http://localhost").pathname === `/api/uploads/${encodedId}`; } catch { return false; }
    });
    if (referenced && await canReadActiveShowcaseArtifact(claims, item.participation.instanceId, item.artifactVersionId)) return true;
  }
  return false;
}
