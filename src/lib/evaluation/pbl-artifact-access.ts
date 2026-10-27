import type { AuthClaims } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { pblObject } from "./pbl-policy";
const enrollmentStatus = { in: ["ACTIVE", "active", "COMPLETED", "completed"] };
/** Only a live assignment grants peer access, scoped to its immutable submitted version. */
export async function canReadPblPeerArtifact(claims: AuthClaims, instanceId: string, versionId: string): Promise<boolean> {
  if (claims.role !== "student" || !claims.sub) return false;
  const assignment = await prisma.peerReviewAssignment.findFirst({ where: { instanceId, artifactVersionId: versionId, status: "ACTIVE",
    reviewer: { instanceId, enrollment: { userId: claims.sub, status: enrollmentStatus } },
    target: { instanceId, enrollment: { status: enrollmentStatus } }, artifactVersion: { status: "SUBMITTED", artifact: { participation: { instanceId } } } },
    select: { instance: { select: { runtimeConfig: true, activity: { select: { chapter: { select: { offeringId: true } } } } } }, reviewer: { select: { enrollment: { select: { offeringId: true } } } }, target: { select: { enrollment: { select: { offeringId: true } } } } } });
  return !!assignment && pblObject(assignment.instance.runtimeConfig).evaluationContractVersion === 2
    && assignment.reviewer.enrollment.offeringId === assignment.instance.activity.chapter.offeringId
    && assignment.target.enrollment.offeringId === assignment.instance.activity.chapter.offeringId;
}
export async function canReadPblPeerAsset(claims: AuthClaims, file: { id: string; offeringId?: string | null; uploadedById?: string | null }): Promise<boolean> {
  if (claims.role !== "student" || !claims.sub || !file.offeringId) return false;
  const rows = await prisma.peerReviewAssignment.findMany({ where: { status: "ACTIVE", reviewer: { enrollment: { userId: claims.sub, offeringId: file.offeringId, status: enrollmentStatus } }, target: { enrollment: { userId: file.uploadedById ?? "", offeringId: file.offeringId, status: enrollmentStatus } } }, select: { instanceId: true, artifactVersionId: true, artifactVersion: { select: { sourceHtml: true, fileAssetId: true } } } });
  for (const row of rows) {
    const html = row.artifactVersion.sourceHtml ?? "";
    const referenced = row.artifactVersion.fileAssetId === file.id || (html.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi) ?? []).some(attribute => {
      const url = attribute.replace(/^[^=]+=\s*["']|["']$/g, "");
      try { return new URL(url, "http://localhost").pathname === `/api/uploads/${encodeURIComponent(file.id)}`; } catch { return false; }
    });
    if (referenced && await canReadPblPeerArtifact(claims, row.instanceId, row.artifactVersionId)) return true;
  }
  return false;
}
