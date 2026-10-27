import { createHash } from 'node:crypto';
import type { AiTask, Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { projectDocumentTaskReceipt, type DocumentRequestIdentity, type DocumentRequestState } from './document-request-store';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function stableCodeDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function codeBackgroundBody(body: Record<string, unknown>): Record<string, unknown> {
  const result = { ...body }; delete result.requestId; return result;
}
export function codeBackgroundBodyDigest(body: Record<string, unknown>): string {
  return stableCodeDigest(codeBackgroundBody(body));
}
export type CodeRequestAlias = { requestId: string; body: Record<string, unknown> };
export async function findCodeBackgroundAlias(db: Prisma.TransactionClient, identity: DocumentRequestIdentity) {
  const [row] = await db.$queryRaw<Array<AiTask & { bodyDigest: string; requestBody: Record<string, unknown> }>>`
    SELECT t.*, a."bodyDigest", a."requestBody" FROM "AiTaskRequestAlias" a
    JOIN "AiTask" t ON t.id = a."taskId"
    JOIN "AiConversation" c ON c.id = t."conversationId"
    JOIN "ClassroomParticipation" p ON p.id = c."participationId"
    JOIN "Enrollment" e ON e.id = p."enrollmentId"
    WHERE a."participationId" = ${identity.participationId} AND a."clientRequestId" = ${identity.requestId}
      AND c."participationId" = a."participationId" AND p."instanceId" = ${identity.courseId}
      AND e."userId" = ${identity.studentId} AND t."createdById" = ${identity.studentId}
      AND t."taskType" = 'DOCUMENT_COLLABORATION'`;
  if (!row) return null;
  const saved = row.input as Record<string, unknown> | null;
  if (saved?.stageKey !== identity.stageKey || saved?.workspaceKind !== identity.workspaceKind
    || !row.requestBody || codeBackgroundBodyDigest(row.requestBody) !== row.bodyDigest) return { conflict: true as const };
  return { row, state: await projectDocumentTaskReceipt(row, identity, db) };
}
export function codeAliasResponse(state: DocumentRequestState, clientRequestId: string): Response {
  const body = state.status === 'completed' ? state.response : state;
  if (!body) return Response.json({ error: 'REQUEST_RECEIPT_MISSING', requestId: clientRequestId }, { status: 503 });
  return Response.json({ ...body, requestId: clientRequestId, canonicalRequestId: state.requestId,
    ...(state.status === 'processing' ? { retryAfterMs: 5_000 } : {}) }, {
    status: state.status === 'processing' ? 202 : state.status === 'cancelled' ? 409 : 200,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
export async function readCodeBackgroundAlias(identity: DocumentRequestIdentity, body?: Record<string, unknown>, responseRequestId = identity.requestId): Promise<Response | null> {
  const alias = await findCodeBackgroundAlias(prisma, identity);
  if (!alias) return null;
  if ('conflict' in alias || (body && alias.row.bodyDigest !== codeBackgroundBodyDigest(body))) {
    return Response.json({ error: 'REQUEST_ID_CONFLICT', requestId: identity.requestId }, { status: 409 });
  }
  return codeAliasResponse(alias.state, responseRequestId);
}
