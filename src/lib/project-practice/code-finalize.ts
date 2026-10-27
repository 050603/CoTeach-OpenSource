import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AuthClaims } from "@/lib/auth/session";
import { lockProjectedCourse } from "@/lib/db/session-repository";
import { parseCodeArtifact } from "@/lib/ai-collaboration/code-artifact";
import { PlatformError } from "@/lib/platform/repository";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
export type CodeFinalizationInput = { courseId: string; submissionId: string; studentId?: string; stageKey: "make"; expectedVersion: number; requestId: string; revisionNote?: string };

/** Freeze saved source, not a client-supplied body. The course lock serializes draft CAS and finalization. */
export async function finalizeCodeArtifact(tx: Prisma.TransactionClient, claims: AuthClaims, input: CodeFinalizationInput) {
  if (claims.role !== "student" || !claims.sub) throw new PlatformError("UNAUTHENTICATED", "请重新登录", 401);
  if (input.studentId && input.studentId !== claims.sub) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "无权提交其他学生的代码", 403);
  await lockProjectedCourse(tx, input.courseId);
  const participation = await tx.classroomParticipation.findFirst({ where: { instanceId: input.courseId, enrollment: { userId: claims.sub } }, include: {
    enrollment: { include: { user: true } }, instance: { include: { activity: { include: { chapter: { include: { offering: true } } } } } },
  } });
  if (!participation) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "未加入该课堂", 403);
  const { enrollment, instance } = participation;
  const user = enrollment.user;
  const activity = instance.activity;
  const chapter = activity.chapter;
  if (user.status.toUpperCase() !== "ACTIVE" || user.role.toUpperCase() !== "STUDENT" || user.sessionVersion !== claims.sv) throw new PlatformError("UNAUTHENTICATED", "账户或会话状态已变化，请重新登录", 401);
  if (!["ACTIVE", "COMPLETED"].includes(enrollment.status.toUpperCase())) throw new PlatformError("STUDENT_SCOPE_MISMATCH", "选课状态已改变", 403);
  const receiptKey = `code-finalize:${hash(JSON.stringify([participation.id, claims.sub, input.requestId]))}`;
  const fingerprint = hash(JSON.stringify([input.submissionId, input.expectedVersion, input.stageKey, input.revisionNote ?? ""]));
  const existing = await tx.domainEvent.findUnique({ where: { idempotencyKey: receiptKey } });
  if (existing) {
    const receipt = object(existing.payload);
    if (receipt.fingerprint !== fingerprint) throw new PlatformError("IDEMPOTENCY_CONFLICT", "请求标识已用于其他提交", 409);
    return receipt;
  }
  if (instance.status.toUpperCase() !== "TEACHING" || enrollment.status.toUpperCase() !== "ACTIVE" || chapter.offering.status.toUpperCase() !== "OPEN" || activity.archivedAt || chapter.archivedAt) throw new PlatformError("COURSE_LOCKED", "课堂已结束或活动已关闭，无法提交", 409);
  const submission = await tx.classroomSubmission.findUnique({ where: { participationId_stageKey: { participationId: participation.id, stageKey: "make:code" } } });
  const original = object(submission?.payload);
  const draft = object(original.view ?? original);
  if (!submission || (submission.id !== input.submissionId && draft.id !== input.submissionId) || draft.studentId !== claims.sub || draft.type !== "code") throw new PlatformError("SUBMISSION_NOT_FOUND", "找不到自己的项目代码", 404);
  if (Number(draft.version ?? 1) !== input.expectedVersion) throw new PlatformError("DRAFT_VERSION_CONFLICT", "代码已变化，请保存最新内容后提交", 409);
  const content = typeof draft.content === "string" ? draft.content : "";
  if (content.length > 120000) throw new PlatformError("CODE_TOO_LARGE", "代码过长，请整理后提交", 413);
  const code = parseCodeArtifact(content);
  if (!code || code.files.every(file => !file.content.trim())) throw new PlatformError("CODE_REQUIRED", "没有可提交的项目代码", 422);
  const title = typeof draft.title === "string" && draft.title.trim() ? draft.title.trim() : "项目代码";
  const sourceHtml = `<article><h1>${escapeHtml(title)}</h1>${code.files.map(file => `<section><h2>${escapeHtml(file.path)}</h2><pre><code>${escapeHtml(file.content)}</code></pre></section>`).join("")}</article>`;
  const artifactId = `code:${submission.id}`;
  const artifact = await tx.artifact.upsert({ where: { id: artifactId }, create: { id: artifactId, participationId: participation.id, title, type: "CODE_ARCHIVE", status: "SUBMITTED" }, update: { title, status: "SUBMITTED" } });
  const latest = await tx.artifactVersion.findFirst({ where: { artifactId: artifact.id }, orderBy: { sequence: "desc" }, select: { sequence: true } });
  const now = new Date();
  const version = await tx.artifactVersion.create({ data: { id: randomUUID(), artifactId: artifact.id, sequence: (latest?.sequence ?? 0) + 1, sourceHtml, mimeType: "text/html", sha256: hash(sourceHtml), size: BigInt(Buffer.byteLength(sourceHtml)), status: "SUBMITTED", submittedAt: now } });
  const nextDraft = { ...draft, version: input.expectedVersion + 1, status: "submitted", submittedAt: now.toISOString(), ...(input.revisionNote ? { revisionNote: input.revisionNote } : {}) };
  // A new formal version without a note must not inherit the previous version's note.
  if (!input.revisionNote) delete nextDraft.revisionNote;
  await tx.classroomSubmission.update({ where: { id: submission.id }, data: { status: "SUBMITTED", submittedAt: now, payload: (original.view ? { ...original, view: nextDraft } : nextDraft) as Prisma.InputJsonValue } });
  const receipt = { fingerprint, requestId: input.requestId, submissionId: input.submissionId, sourceVersion: input.expectedVersion, submissionVersion: input.expectedVersion + 1, versionId: version.id, sequence: version.sequence, submittedAt: now.toISOString(), stageKey: "make", title, ...(input.revisionNote ? { revisionNote: input.revisionNote } : {}) };
  await tx.domainEvent.create({ data: { idempotencyKey: receiptKey, actorId: claims.sub, offeringId: enrollment.offeringId, classroomInstanceId: input.courseId, participationId: participation.id, researchKey: enrollment.researchKey, eventType: "code_version_submitted", payload: receipt } });
  await tx.aiInteractionEvent.create({ data: { idempotencyKey: `ai:${receiptKey}`, userId: claims.sub, offeringId: enrollment.offeringId, participationId: participation.id, researchKey: enrollment.researchKey, eventType: "submit", actor: "student", requestId: input.requestId, content: `提交项目代码第 ${version.sequence} 版`, payload: { schemaVersion: 1, legacy: { stageKey: "make", source: "submission", actorId: claims.sub }, detail: receipt } } });
  const runtime = object(instance.runtimeConfig);
  await tx.classroomInstance.update({ where: { id: input.courseId }, data: { runtimeConfig: { ...runtime, version: Number(runtime.version ?? 1) + 1 } as Prisma.InputJsonValue } });
  return receipt;
}
