import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from 'node:crypto';
import type { CompanionMessage, Course } from '@/lib/session/types';

type FailureWhere = {
  id: string; status: string; taskType: string; createdById: string;
  conversation: { userId: string; participationId: string; participation: { instanceId: string; enrollment: { userId: string } } };
  AND: Array<{ input: { path: string[]; equals: string } }>;
};
type Row = {
  id: string;
  taskType: string;
  createdById: string;
  conversationId: string;
  status: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  queueKey?: string;
  leaseUntil?: Date | null;
  attemptCount?: number;
};

const mocks = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  const messages = new Map<string, { id: string; conversationId: string; content: string }>();
  const append = vi.fn<(db: unknown, input: { conversationId: string; messages: CompanionMessage[] }) => Promise<void>>().mockResolvedValue(undefined);
  const publish = vi.fn(async () => undefined);
  const db = {
    $queryRaw: vi.fn<(query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(async () => []),
    classroomParticipation: { findUniqueOrThrow: vi.fn(async () => ({ instanceId: "course-1", enrollment: { userId: "student-1", offeringId: "offering-1", researchKey: "research-1" },
      instance: { activity: { chapter: { offeringId: "offering-1" } } } })) },
    aiInteractionEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    aiMessage: { findMany: vi.fn(async ({ where }: { where: { conversationId: string; id: { in: string[] } } }) =>
      [...messages.values()].filter(message => message.conversationId === where.conversationId && where.id.in.includes(message.id))) },
    aiTask: {
      count: vi.fn(async () => rows.size),
      findUnique: vi.fn(async ({ where }: { where: { id: string; status?: string } }) => {
        const row = rows.get(where.id);
        return row && (!where.status || row.status === where.status) ? row : null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; createdById: string } }) => {
        const row = rows.get(where.id);
        return row?.createdById === where.createdById ? row : null;
      }),
      findMany: vi.fn(async () => [...rows.values()]),
      create: vi.fn(async ({ data }: { data: Partial<Row> & { id: string } }) => {
        const row = {
          status: "RUNNING", input: {}, output: null, error: null, startedAt: null,
          completedAt: null, leaseUntil: null, createdAt: new Date(), ...data,
        } as Row;
        rows.set(data.id, row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: FailureWhere; data: Partial<Row> }) => {
        const row = rows.get(where.id);
        const matches = row && row.status === where.status && row.taskType === where.taskType
          && row.createdById === where.createdById
          && where.conversation.userId === row.createdById
          && where.conversation.participationId === row.input.participationId
          && where.conversation.participation.instanceId === "course-1"
          && where.conversation.participation.enrollment.userId === row.createdById
          && where.AND.every(filter => row.input[filter.input.path[0]] === filter.input.equals);
        if (!matches) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.get(where.id)!;
        Object.assign(row, data);
        rows.set(where.id, row);
        return row;
      }),
    },
  };
  return { rows, messages, append, publish, db, transaction: vi.fn(), lifecycle: vi.fn(), replayNextTransaction: false,
    identity: { userRole: 'STUDENT', userStatus: 'ACTIVE', userSessionVersion: 1 } };
});

vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/realtime/event-bus", () => ({ publishCourseEvent: mocks.publish }));
vi.mock("@/lib/observability/classroom-ai", () => ({ recordAiCacheEvent: vi.fn() }));
vi.mock("@/lib/observability/metrics", async original => ({
  ...await original<typeof import('@/lib/observability/metrics')>(), recordDocumentReviewLifecycle: mocks.lifecycle,
}));
vi.mock("@/lib/db/transaction-retry", () => {
  // Model the participation row lock held by the real database transaction.
  let previous: Promise<unknown> = Promise.resolve();
  return { runMutationTransaction: (operation: (tx: typeof mocks.db) => unknown, options?: unknown) => {
    mocks.transaction(options);
    const result = previous.then(async () => {
      if (mocks.replayNextTransaction) {
        mocks.replayNextTransaction = false;
        const before = structuredClone([...mocks.rows]);
        await operation(mocks.db);
        // Simulate rollback/replay after the callback, before COMMIT succeeds.
        expect(mocks.lifecycle).not.toHaveBeenCalled();
        mocks.rows.clear();
        for (const [key, value] of before) mocks.rows.set(key, value);
      }
      return operation(mocks.db);
    });
    previous = result.catch(() => undefined);
    return result;
  } };
});
vi.mock("@/lib/companion/server-store", () => ({
  ensureCompanionThreadWithinTransaction: async () => ({
    row: { id: companionThreadId("course-1", "student-1", "ai-collaboration:make") },
    participation: { enrollment: { offeringId: "offering-1" } },
  }),
}));
vi.mock("@/lib/companion/scoped-message-batch", async original => ({
  ...await original<typeof import("@/lib/companion/scoped-message-batch")>(), appendScopedCompanionMessages: mocks.append,
}));
import { companionThreadId } from "@/lib/companion/scoped-message-batch";
import { enqueueDocumentReview, resumeDocumentReview, assertDocumentReviewScope, type DocumentReviewSnapshot } from './document-review-queue';
const scopeDb = mocks.db as unknown as Parameters<typeof assertDocumentReviewScope>[0];

import { buildDocumentSuggestionRequest, cachedDocumentSuggestions } from "./document-suggestion-cache";

import {
  cancelDocumentRequest,
  claimDocumentRequest,
  completeDocumentRequest,
  failDocumentRequest,
  prepareDocumentRequestResponse,
  getDocumentRequest,
  listDocumentRequests,
  projectDocumentTask,
  readDocumentRequestReceipt,
  readDelegatedWorkSummary,
  type DocumentRequestInput,
} from "./document-request-store";

const input = (requestId = "request-1"): DocumentRequestInput => ({
  requestId,
  participationId: "participation-1",
  courseId: "course-1",
  studentId: "student-1",
  stageKey: "make",
  workspaceKind: "document",
  threadStageKey: "ai-collaboration:make",
  conversationId: "logical-conversation-1",
  documentVersion: "document-v1",
  fingerprint: "same-body",
  message: "怎样核验这条数据？",
  intent: "discuss",
  history: [{ role: "user", content: "之前试过查原始表" }],
});

const answerMessage = { id: "message-1", role: "agent" as const, content: "核对原始表。",
  createdAt: "2026-10-16T00:00:00.000Z", visibility: "student-and-teacher" as const };

function queuedInput() {
  const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const documentHtml = '<p>review</p>';
  const paragraphs = [{ candidateId: 'candidate', blockIndex: 0, targetText: 'review' }];
  const task = { ...input(), intent: 'proactive-document-comments', documentVersion: digest(documentHtml),
    fingerprint: digest({ action: 'proactive-document-comments', courseId: 'course-1', stageKey: 'make',
      workspaceKind: 'document', documentHtml, proactiveParagraphs: paragraphs }) };
  return { task, documentHtml, paragraphs, course: { stages: [{ key: 'make' }] } as Course };
}

describe("document collaboration request receipts", () => {
  beforeEach(() => {
    mocks.rows.clear();
    mocks.messages.clear();
    mocks.replayNextTransaction = false;
    Object.assign(mocks.identity, { userRole: 'STUDENT', userStatus: 'ACTIVE', userSessionVersion: 1 });
    vi.clearAllMocks();
    mocks.append.mockImplementation(async (_tx, input) => {
      for (const message of input.messages) if (!mocks.messages.has(message.id)) {
        mocks.messages.set(message.id, { id: message.id, conversationId: input.conversationId, content: message.content });
      }
    });
    mocks.db.$queryRaw.mockImplementation(async (query, ...values) => {
      const sql = query.join("");
      if (sql.includes('COUNT(*) AS outstanding')) {
        const rows = [...mocks.rows.values()].filter(row => row.queueKey === values[0]
          && (['PENDING', 'RUNNING'].includes(row.status) || (row.status === 'FAILED' && row.leaseUntil != null)));
        return [{ outstanding: BigInt(rows.length), waiting: BigInt(rows.filter(row => row.status === 'PENDING'
          || row.leaseUntil == null || row.leaseUntil.getTime() <= Date.now()).length) }];
      }
      if (sql.includes('WITH target AS MATERIALIZED')) {
        const row = mocks.rows.get(String(values[0]));
        const result = { prepared: false, legacy: false, missingIdentity: false, invalidIdentity: false };
        if (!row || row.taskType !== values[1] || row.createdById !== values[2]) return [result];
        if (!row.queueKey) return [{ ...result, legacy: true }];
        if (row.queueKey !== 'document-review-v1' || row.status !== 'RUNNING') return [result];
        const snapshot = row.input.reviewSnapshot as DocumentReviewSnapshot;
        const identity = snapshot?.guard?.identity;
        if (identity?.role !== 'STUDENT' || identity.status !== 'ACTIVE' || !Number.isInteger(identity.sessionVersion) || identity.sessionVersion < 1) {
          return [{ ...result, missingIdentity: true }];
        }
        if (mocks.identity.userRole !== 'STUDENT' || mocks.identity.userStatus !== 'ACTIVE' || mocks.identity.userSessionVersion !== identity.sessionVersion) {
          return [{ ...result, invalidIdentity: true }];
        }
        const expected = JSON.parse(String(values.find(value => typeof value === 'string' && value.startsWith('{') && value.includes('"token":')))) as Record<string, unknown>;
        if (Object.entries(expected).some(([key, value]) => row.input[key] !== value)) return [result];
        const output = JSON.parse(String(values.find(value => typeof value === 'string' && value.startsWith('{"preparedResponse":')))) as Record<string, unknown>;
        if (row.output?.preparedResponse && JSON.stringify(row.output.preparedResponse) !== JSON.stringify(output.preparedResponse)) return [result];
        row.output = output;
        return [{ ...result, prepared: true }];
      }
      if (sql.includes('FROM "AiTask" task')) {
        const single = sql.includes('WHERE task.id =');
        const [taskType, creator, participation] = values.slice(single ? 2 : 1);
        const tasks = [...mocks.rows.values()].filter(row =>
          (!single || row.id === values[1]) && row.taskType === taskType && row.createdById === creator
          && row.conversationId === companionThreadId("course-1", "student-1", "ai-collaboration:make")
          && participation === "participation-1"
          && (single || ["PENDING", "RUNNING", "FAILED", "CANCELLED"].includes(row.status)))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, single ? 1 : 30);
        const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
        return tasks.map(row => ({ status: row.status, error: row.error, createdAt: row.createdAt,
          startedAt: row.startedAt, queueKey: row.queueKey, leaseUntil: row.leaseUntil, conversationId: row.conversationId,
          input: Object.fromEntries(['requestId', 'stageKey', 'workspaceKind', 'conversationId', 'documentVersion', 'message', 'intent', 'executionMode'].map(key => [key, object(row.input)[key] ?? null])),
          output: { response: object(row.output).response ?? null, schemaVersion: object(row.output).schemaVersion,
            responseContentRefs: object(row.output).responseContentRefs },
        }));
      }
      return sql.includes('FROM "AiConversation"') ? [{
      conversationId: companionThreadId("course-1", "student-1", "ai-collaboration:make"), userId: "student-1",
      offeringId: "offering-1", participationId: "participation-1", metadata: { legacyStageKey: "ai-collaboration:make" },
      instanceId: "course-1", enrollmentUserId: "student-1", enrollmentOfferingId: "offering-1", chapterOfferingId: "offering-1", researchKey: "research-1",
    }] : query.join('').includes('JOIN "Enrollment"') ? [{
      instanceId: 'course-1', userId: 'student-1', offeringId: 'offering-1', enrollmentStatus: 'ACTIVE',
      instanceStatus: 'TEACHING', offeringStatus: 'OPEN', archivedAt: null, templateVersionId: 'template-1',
      runtimeConfig: { stageVersion: 1, currentStageIndex: 0, makeArtifactMode: 'document' },
      ...mocks.identity,
    }] : [];
    });
  });

  it.each(['fresh', 'expired'] as const)('returns a recoverable %s failure consistently through single/list/lease-rejection receipts', async lease => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== 'run') throw new Error('Expected run');
    const row = [...mocks.rows.values()][0];
    Object.assign(row, { queueKey: 'document-review-v1', leaseUntil: new Date(Date.now() + (lease === 'fresh' ? 60_000 : -60_000)) });
    expect(await failDocumentRequest({ ...input(), token: claim.token, error: 'AI_RESPONSE_INVALID_STRUCTURE' })).toBe(true);
    const before = structuredClone(row); const phase = lease === 'fresh' ? 'running' : 'queued';
    const expected = { requestId: input().requestId, status: 'processing', phase, retryable: false, error: 'AI_RESPONSE_INVALID_STRUCTURE' };
    expect(await getDocumentRequest(input())).toMatchObject(expected);
    expect(await listDocumentRequests(input())).toEqual([expect.objectContaining(expected)]);
    expect(await readDocumentRequestReceipt(input())).toMatchObject({ status: 202, body: expected });
    expect(row).toEqual(before);
    row.leaseUntil = null;
    expect(await getDocumentRequest(input())).toMatchObject({ status: 'failed', retryable: false, error: 'AI_RESPONSE_INVALID_STRUCTURE' });
    expect(await getDocumentRequest(input())).not.toHaveProperty('phase');
    expect(await readDocumentRequestReceipt(input())).toMatchObject({ status: 503, body: { status: 'failed', error: 'AI_RESPONSE_INVALID_STRUCTURE' } });
  });

  it.each(['fresh', 'expired'] as const)('cancels a recoverable %s failure without deleting its original evidence', async lease => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== 'run') throw new Error('Expected run');
    const row = [...mocks.rows.values()][0];
    Object.assign(row, { queueKey: 'document-review-v1', leaseUntil: new Date(Date.now() + (lease === 'fresh' ? 60_000 : -60_000)) });
    await failDocumentRequest({ ...input(), token: claim.token, error: 'AI_RESPONSE_INVALID_STRUCTURE' });
    row.output = { preparedResponse: { preserved: true } }; const originalInput = structuredClone(row.input);
    expect(await cancelDocumentRequest(input())).toMatchObject({ status: 'cancelled' });
    expect(row.leaseUntil).toBeNull(); expect(row.input).toEqual(originalInput);
    expect(row.output).toEqual({ preparedResponse: { preserved: true } });
    expect(await prepareDocumentRequestResponse({ ...input(), token: claim.token, response: {} })).toBe(false);
    expect(await completeDocumentRequest({ ...input(), token: claim.token, messages: [], response: {} })).toBe(false);
    expect(await failDocumentRequest({ ...input(), token: claim.token, error: 'stale' })).toBe(false);
    expect(await readDocumentRequestReceipt(input())).toMatchObject({ status: 409, body: { status: 'cancelled' } });
  });

  it('does not cancel or revive an already terminal queued failure or relabel legacy failures', async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== 'run') throw new Error('Expected run');
    const row = [...mocks.rows.values()][0];
    Object.assign(row, { queueKey: 'document-review-v1', leaseUntil: null });
    await failDocumentRequest({ ...input(), token: claim.token, error: 'terminal' });
    const before = structuredClone(row);
    expect(await cancelDocumentRequest(input())).toMatchObject({ status: 'failed' });
    expect(row).toEqual(before);
    row.queueKey = undefined; row.leaseUntil = new Date(Date.now() + 60_000);
    expect(await getDocumentRequest(input())).toMatchObject({ status: 'failed' });
  });

  it('projects old/new task states and complete nested receipts without reading execution payloads or mutating storage', async () => {
    await claimDocumentRequest(input());
    const row = [...mocks.rows.values()][0];
    row.input.reviewSnapshot = { large: 'snapshot'.repeat(10000) };
    row.input.history = [{ role: 'user', content: 'history'.repeat(1000) }];
    const response = { requestId: input().requestId, nested: { text: 'final receipt'.repeat(1000), values: [null, false, 1, { preserved: true }] } };
    row.output = { response, preparedResponse: { large: 'prepared'.repeat(10000) } };
    for (const queueKey of [undefined, 'document-review-v1']) {
      for (const status of ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED']) {
        for (const startedAt of [null, new Date(0), new Date()]) {
          Object.assign(row, { queueKey, status, startedAt, error: status === 'FAILED' ? 'FIXTURE_ERROR' : null });
          const before = structuredClone(row);
          expect(await getDocumentRequest(input())).toEqual(projectDocumentTask(before));
          expect(row).toEqual(before);
        }
      }
    }
    const call = mocks.db.$queryRaw.mock.calls.at(-1)!;
    const columns = (call[1] as { sql: string }).sql;
    expect(columns).toContain("task.input -> 'requestId'");
    expect(columns).toContain("task.output -> 'response'");
    expect(columns).toContain('task."leaseUntil"');
    expect(columns).not.toMatch(/reviewSnapshot|history|preparedResponse|token|->>/);
    const sql = call[0].join('');
    expect(sql).toContain('JOIN "AiConversation" conversation ON conversation.id = task."conversationId"');
    expect(sql).toContain('task."taskType" ='); expect(sql).toContain('task."createdById" =');
    expect(sql).toContain('conversation."participationId" =');
    expect(mocks.db.aiTask.findFirst).not.toHaveBeenCalled();
  });

  it('retains legacy JSON type/default rules and refuses non-object identity inputs', async () => {
    await claimDocumentRequest(input()); const row = [...mocks.rows.values()][0];
    const original = structuredClone(row.input);
    for (const value of [undefined, null, 12, false, ['a', 3], { nested: true }]) {
      row.input = { ...original, message: value, intent: value, documentVersion: value };
      for (const output of [null, false, 'primitive', ['array'], {}, { response: null }, { response: [] }, { response: { all: value ?? null } }]) {
        row.output = output as Row['output'];
        expect(await getDocumentRequest(input())).toEqual(projectDocumentTask(row));
      }
    }
    for (const key of ['stageKey', 'workspaceKind', 'conversationId']) {
      row.input = { ...original, [key]: 12 };
      expect(await getDocumentRequest({ ...input(), [key]: '12' })).toBeNull();
      expect(await listDocumentRequests({ ...input(), [key]: '12' })).toEqual([]);
    }
    for (const invalid of [null, false, 'primitive', []]) {
      row.input = invalid as unknown as Row['input'];
      expect(await getDocumentRequest(input())).toBeNull();
      expect(await listDocumentRequests(input())).toEqual([]);
    }
  });

  it('keeps exact read ownership/logical predicates and the intentional GET-only empty conversation wildcard', async () => {
    await claimDocumentRequest(input()); const row = [...mocks.rows.values()][0];
    for (const changed of [{ studentId: 'other' }, { participationId: 'other' }, { requestId: 'other' },
      { stageKey: 'other' }, { workspaceKind: 'code' }, { conversationId: 'other' }]) {
      expect(await getDocumentRequest({ ...input(), ...changed })).toBeNull();
    }
    expect(await getDocumentRequest({ ...input(), conversationId: '' })).toEqual(projectDocumentTask(row));
    expect(await listDocumentRequests({ ...input(), conversationId: '' })).toEqual([]);
    row.taskType = 'OTHER'; expect(await getDocumentRequest(input())).toBeNull();
    row.taskType = 'DOCUMENT_COLLABORATION'; row.conversationId = 'foreign-participation-thread';
    expect(await getDocumentRequest(input())).toBeNull();
  });

  it('keeps latest 30 before logical filters, status selection and descending order', async () => {
    await claimDocumentRequest(input()); const template = structuredClone([...mocks.rows.values()][0]); mocks.rows.clear();
    for (let index = 0; index < 31; index++) {
      const row = { ...structuredClone(template), id: `history-${index}`, createdAt: new Date(1000 + index),
        status: 'PENDING', input: { ...template.input, requestId: `history-${index}`, workspaceKind: index ? 'code' : 'document' } };
      mocks.rows.set(row.id, row);
    }
    expect(await listDocumentRequests(input())).toEqual([]);
    const latest = mocks.rows.get('history-30')!; latest.input.workspaceKind = 'document';
    const next = mocks.rows.get('history-29')!; next.input.workspaceKind = 'document'; next.status = 'CANCELLED';
    const completed = { ...structuredClone(latest), id: 'completed', createdAt: new Date(99999), status: 'COMPLETED' };
    mocks.rows.set(completed.id, completed);
    expect(await listDocumentRequests(input())).toEqual([projectDocumentTask(latest), projectDocumentTask(next)]);
  });

  it('counts committed logical enqueue/resume once despite transaction replay and duplicate HTTP submissions', async () => {
    const enqueue = queuedInput(); const { task } = enqueue;
    mocks.replayNextTransaction = true;
    expect((await enqueueDocumentReview(enqueue, 1)).kind).toBe('queued');
    expect((await enqueueDocumentReview(enqueue, 1)).kind).toBe('existing');
    expect(mocks.lifecycle.mock.calls).toEqual([['enqueued']]);
    [...mocks.rows.values()][0].status = 'FAILED';
    mocks.lifecycle.mockClear(); mocks.replayNextTransaction = true;
    expect((await resumeDocumentReview(task)).kind).toBe('queued');
    expect((await resumeDocumentReview(task)).kind).toBe('existing');
    expect(mocks.lifecycle.mock.calls).toEqual([['resumed']]);
  });

  it.each([{ userStatus: 'DISABLED' }, { userRole: 'TEACHER' }, { userSessionVersion: 2 }])('rejects invalidated identity on admission and execution: %j', async changed => {
    const enqueue = queuedInput(); await enqueueDocumentReview(enqueue, 1);
    const row = [...mocks.rows.values()][0]; const snapshot = row.input.reviewSnapshot as DocumentReviewSnapshot;
    expect(snapshot.guard.identity).toEqual({ role: 'STUDENT', status: 'ACTIVE', sessionVersion: 1 });
    Object.assign(mocks.identity, changed);
    await expect(assertDocumentReviewScope(scopeDb, snapshot)).rejects.toMatchObject({ code: 'REVIEW_IDENTITY_CHANGED' });
    mocks.rows.clear();
    await expect(enqueueDocumentReview(enqueue, 1)).rejects.toMatchObject({ code: 'REVIEW_IDENTITY_CHANGED' });
  });

  it('does not revive an old request after a role is restored with a new identity version', async () => {
    const enqueue = queuedInput(); await enqueueDocumentReview(enqueue, 1);
    const row = [...mocks.rows.values()][0]; row.status = 'FAILED';
    Object.assign(mocks.identity, { userRole: 'TEACHER', userSessionVersion: 2 });
    await expect(resumeDocumentReview(enqueue.task)).rejects.toMatchObject({ code: 'REVIEW_IDENTITY_CHANGED' });
    Object.assign(mocks.identity, { userRole: 'STUDENT', userSessionVersion: 3 });
    await expect(resumeDocumentReview(enqueue.task)).rejects.toMatchObject({ code: 'REVIEW_IDENTITY_CHANGED' });
  });

  it('rejects a snapshot without recorded identity instead of borrowing the current login', async () => {
    const enqueue = queuedInput(); await enqueueDocumentReview(enqueue, 1);
    const row = [...mocks.rows.values()][0]; row.status = 'FAILED';
    const snapshot = row.input.reviewSnapshot as DocumentReviewSnapshot;
    Reflect.deleteProperty(snapshot.guard, 'identity');
    await expect(assertDocumentReviewScope(scopeDb, snapshot)).rejects.toMatchObject({ code: 'REVIEW_IDENTITY_SNAPSHOT_MISSING' });
    await expect(resumeDocumentReview(enqueue.task)).rejects.toMatchObject({ code: 'REVIEW_IDENTITY_SNAPSHOT_MISSING' });
  });

  it('counts committed queue completion once and marks only later executions as recovered', async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== 'run') throw new Error('expected run');
    Object.assign([...mocks.rows.values()][0], { queueKey: 'document-review-v1', attemptCount: 2 });
    mocks.replayNextTransaction = true;
    const completion = { ...input(), token: claim.token, messages: [], response: {} };
    expect(await completeDocumentRequest(completion)).toBe(true);
    expect(await completeDocumentRequest(completion)).toBe(false);
    expect(mocks.lifecycle.mock.calls).toEqual([['completed'], ['completed_recovered']]);
  });

  it('does not count rolled-back completion or classify a first execution as recovered', async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== 'run') throw new Error('expected run');
    Object.assign([...mocks.rows.values()][0], { queueKey: 'document-review-v1', attemptCount: 1 });
    const completion = { ...input(), token: claim.token, messages: [], response: {},
      auditEvents: [{ idempotencyKey: 'metric-decision', eventType: 'policy', actor: 'system' as const, content: '', payload: {} }] };
    mocks.db.aiInteractionEvent.createMany.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(completeDocumentRequest(completion)).rejects.toThrow('audit unavailable');
    expect(mocks.lifecycle).not.toHaveBeenCalled();
    expect(await completeDocumentRequest(completion)).toBe(true);
    expect(mocks.lifecycle.mock.calls).toEqual([['completed']]);
  });

  it("returns the persisted first request time, including a later lease retry", async () => {
    const acceptedAt = new Date("2026-10-16T03:56:13.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(acceptedAt);
    try {
      const first = await claimDocumentRequest(input());
      if (first.kind !== "run") throw new Error("expected run");
      expect(first.createdAt).toBe(acceptedAt.toISOString());
      expect([...mocks.rows.values()][0].createdAt).toEqual(acceptedAt);
      await failDocumentRequest({ ...input(), token: first.token, error: "AI_COLLABORATION_TIMEOUT" });
      vi.setSystemTime(new Date("2026-10-16T03:56:20.000Z"));
      const retry = await claimDocumentRequest(input());
      if (retry.kind !== "run") throw new Error("expected retry");
      expect(retry.createdAt).toBe(first.createdAt);
      expect([...mocks.rows.values()][0].startedAt).toEqual(new Date());
    } finally { vi.useRealTimers(); }
  });

  it("returns processing for a concurrent duplicate, then replays one committed answer", async () => {
    const first = await claimDocumentRequest(input());
    expect(first.kind).toBe("run");
    expect(await claimDocumentRequest(input())).toMatchObject({
      kind: "existing",
      state: { requestId: "request-1", status: "processing" },
    });
    if (first.kind !== "run") throw new Error("expected run");
    const response = { result: { kind: "discussion", message: "核对原始表。" }, messages: [{ id: "message-1" }] };
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [answerMessage], response })).toBe(true);
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [answerMessage], response })).toBe(false);
    expect(mocks.append).toHaveBeenCalledTimes(1);
    expect(await claimDocumentRequest(input())).toMatchObject({
      kind: "existing",
      state: { status: "completed", response },
    });
    expect(await getDocumentRequest(input())).toMatchObject({ status: "completed", response });
  });

  it("retries a failed identical request using its original conversation history", async () => {
    const first = await claimDocumentRequest(input());
    if (first.kind !== "run") throw new Error("expected run");
    expect(await failDocumentRequest({ ...input(), token: first.token, error: "AI_COLLABORATION_TIMEOUT" })).toBe(true);
    expect(await claimDocumentRequest({ ...input(), fingerprint: "changed-body" })).toEqual({ kind: "conflict" });
    const retried = await claimDocumentRequest({ ...input(), history: [{ role: "user", content: "另一标签页的新消息" }] });
    expect(retried).toMatchObject({ kind: "run", history: input().history });
    if (retried.kind !== "run") throw new Error("expected retried run");
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [], response: {} })).toBe(false);
    expect(await completeDocumentRequest({ ...input(), token: retried.token, messages: [], response: {} })).toBe(true);
  });

  it("terminates a failed lease without waiting for the course queue or rewriting evidence", async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    mocks.transaction.mockClear(); mocks.db.$queryRaw.mockClear(); mocks.db.aiTask.update.mockClear();
    expect(await failDocumentRequest({ ...input(), token: claim.token, error: "COURSE_BUSY" })).toBe(true);
    expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.db.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.db.aiTask.update).not.toHaveBeenCalled(); expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.db.aiTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      taskType: "DOCUMENT_COLLABORATION", createdById: "student-1", status: "RUNNING",
      conversation: { userId: "student-1", participationId: "participation-1",
        participation: { instanceId: "course-1", enrollment: { userId: "student-1" } } },
    }) }));
    expect(await getDocumentRequest(input())).toMatchObject({ status: "failed", error: "COURSE_BUSY" });
  });

  it.each(["complete", "cancel"])("does not overwrite the existing %s terminal state", async terminal => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    if (terminal === "complete") await completeDocumentRequest({ ...input(), token: claim.token, messages: [], response: { result: "saved" } });
    else await cancelDocumentRequest(input());
    const before = structuredClone([...mocks.rows.values()][0]);
    expect(await failDocumentRequest({ ...input(), token: claim.token, error: "late failure" })).toBe(false);
    expect([...mocks.rows.values()][0]).toEqual(before);
  });

  it("rejects completion after failure won the task state transition", async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    await failDocumentRequest({ ...input(), token: claim.token, error: "COURSE_BUSY" });
    expect(await completeDocumentRequest({ ...input(), token: claim.token, messages: [answerMessage], response: {} })).toBe(false);
    expect(mocks.append).not.toHaveBeenCalled();
    expect(await getDocumentRequest(input())).toMatchObject({ status: "failed", error: "COURSE_BUSY" });
  });

  it("does not let an expired worker fail its replacement lease", async () => {
    const first = await claimDocumentRequest(input()); if (first.kind !== "run") throw new Error("expected run");
    [...mocks.rows.values()][0].startedAt = new Date(Date.now() - 130_000);
    const replacement = await claimDocumentRequest(input()); if (replacement.kind !== "run") throw new Error("expected replacement");
    expect(await failDocumentRequest({ ...input(), token: first.token, error: "old worker" })).toBe(false);
    expect(await getDocumentRequest(input())).toMatchObject({ status: "processing" });
    expect(await completeDocumentRequest({ ...input(), token: replacement.token, messages: [], response: {} })).toBe(true);
  });

  it("keeps background work owned after the old lease expires, then permits bounded recovery", async () => {
    const task = { ...input(), executionMode: "background" as const };
    const first = await claimDocumentRequest(task);
    if (first.kind !== "run") throw new Error("expected run");
    const row = [...mocks.rows.values()][0];
    row.startedAt = new Date(Date.now() - 150_000);
    expect(await getDocumentRequest(task)).toMatchObject({ status: "processing" });
    // Even an older tab cannot steal the live background task.
    expect(await claimDocumentRequest(input())).toMatchObject({ kind: "existing", state: { status: "processing" } });
    row.startedAt = new Date(Date.now() - 336_000);
    expect(await getDocumentRequest(task)).toMatchObject({ status: "failed", error: "REQUEST_INTERRUPTED" });
    const replacement = await claimDocumentRequest(task);
    expect(replacement.kind).toBe("run");
    expect(await completeDocumentRequest({ ...task, token: first.token, messages: [], response: {} })).toBe(false);
  });

  it.each([{ courseId: "other-course" }, { studentId: "other-student" }, { stageKey: "other-stage" },
    { workspaceKind: "other-workspace" }, { conversationId: "other-logical-thread" }])("rejects changed failure scope %j", async changed => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    expect(await failDocumentRequest({ ...input(), ...changed, token: claim.token, error: "wrong scope" })).toBe(false);
    expect(await getDocumentRequest(input())).toMatchObject({ status: "processing" });
  });

  it.each(["prepare", "complete", "cancel"])("locks participation then task before %s's fresh task read", async operation => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    mocks.db.$queryRaw.mockClear(); mocks.db.aiTask.findUnique.mockClear(); mocks.db.aiTask.findFirst.mockClear();
    if (operation === "prepare") await prepareDocumentRequestResponse({ ...input(), token: claim.token, response: { candidates: [] } });
    else if (operation === "complete") await completeDocumentRequest({ ...input(), token: claim.token, messages: [], response: {} });
    else await cancelDocumentRequest(input());
    const offset = operation === 'prepare' ? 2 : 0; // Budget + queue-kind probe precede legacy preparation.
    expect(mocks.db.$queryRaw.mock.calls[offset][0].join("")).toContain('FROM "ClassroomParticipation"');
    expect(mocks.db.$queryRaw.mock.calls[offset + 1][0].join("")).toContain('FROM "AiTask"');
    expect(mocks.db.$queryRaw.mock.calls[offset + 1][0].join("")).toContain("FOR UPDATE");
    const read = operation === "cancel" ? mocks.db.aiTask.findFirst : mocks.db.aiTask.findUnique;
    expect(read.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.db.$queryRaw.mock.invocationCallOrder[offset + 1]);
  });

  async function runningQueuedCheckpoint() {
    const value = queuedInput();
    await enqueueDocumentReview(value, 1);
    const row = [...mocks.rows.values()][0];
    row.status = 'RUNNING'; row.input.token = 'lease-1';
    mocks.transaction.mockClear(); mocks.db.aiTask.findUnique.mockClear(); mocks.db.$queryRaw.mockClear();
    return { row, request: { ...value.task, token: 'lease-1', response: { preparedReview: { receipt: { complete: true } } } } };
  }

  it('checkpoints a queued result without course admission or reading its execution snapshot, preserving the first result', async () => {
    const { row, request } = await runningQueuedCheckpoint();
    expect(await prepareDocumentRequestResponse(request)).toBe(true);
    expect(await prepareDocumentRequestResponse(request)).toBe(true);
    expect(await prepareDocumentRequestResponse({ ...request, response: { preparedReview: { receipt: { complete: false } } } })).toBe(false);
    expect(row.output).toEqual({ preparedResponse: request.response });
    expect(mocks.transaction.mock.calls.every(([options]) => options === undefined)).toBe(true);
    expect(mocks.db.aiTask.findUnique).not.toHaveBeenCalled();
    expect(mocks.db.$queryRaw).toHaveBeenCalledTimes(6);
    expect(mocks.db.$queryRaw.mock.calls[0][0].join('')).toContain("set_config('statement_timeout'");
    const sql = mocks.db.$queryRaw.mock.calls[1][0].join('');
    expect(sql).toContain('FOR UPDATE OF t'); expect(sql).toContain('FOR SHARE OF u');
    expect(sql).not.toMatch(/pg_advisory|SELECT t\.\*|SELECT t\.input|FOR UPDATE OF p/);
    expect(row.status).toBe('RUNNING'); expect(mocks.append).not.toHaveBeenCalled();
  });

  it.each(['token', 'courseId', 'studentId', 'participationId', 'requestId', 'stageKey', 'workspaceKind', 'conversationId', 'threadStageKey', 'fingerprint', 'documentVersion', 'intent'] as const)('rejects a queued checkpoint with changed %s', async field => {
    const { row, request } = await runningQueuedCheckpoint();
    expect(await prepareDocumentRequestResponse({ ...request, [field]: 'foreign' })).toBe(false);
    expect(row.output).toBeNull(); expect(mocks.transaction).toHaveBeenCalledWith(undefined);
  });

  it.each(['COMPLETED', 'CANCELLED', 'FAILED', 'PENDING'])('does not revive %s while checkpointing', async status => {
    const { row, request } = await runningQueuedCheckpoint(); row.status = status;
    expect(await prepareDocumentRequestResponse(request)).toBe(false);
    expect(row.status).toBe(status); expect(row.output).toBeNull();
  });

  it.each([{ userStatus: 'DISABLED' }, { userRole: 'TEACHER' }, { userSessionVersion: 2 }])('rejects live identity changes at checkpoint: %j', async changed => {
    const { row, request } = await runningQueuedCheckpoint(); Object.assign(mocks.identity, changed);
    await expect(prepareDocumentRequestResponse(request)).rejects.toMatchObject({ code: 'REVIEW_IDENTITY_CHANGED' });
    expect(row.output).toBeNull(); expect(mocks.transaction).toHaveBeenCalledWith(undefined);
  });

  it('never sends a queued task with a missing guard or unknown queue through legacy preparation', async () => {
    const { row, request } = await runningQueuedCheckpoint();
    Reflect.deleteProperty((row.input.reviewSnapshot as DocumentReviewSnapshot).guard, 'identity');
    await expect(prepareDocumentRequestResponse(request)).rejects.toMatchObject({ code: 'REVIEW_IDENTITY_SNAPSHOT_MISSING' });
    row.queueKey = 'unknown-queue';
    expect(await prepareDocumentRequestResponse(request)).toBe(false);
    expect(mocks.transaction.mock.calls.every(([options]) => options === undefined)).toBe(true); expect(row.output).toBeNull();
  });

  it('fails closed if a legacy task is adopted into the durable queue after the checkpoint probe', async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== 'run') throw new Error('expected run');
    const row = [...mocks.rows.values()][0];
    mocks.db.$queryRaw.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      row.queueKey = 'document-review-v1';
      return [{ prepared: false, legacy: true, missingIdentity: false, invalidIdentity: false }];
    });
    expect(await prepareDocumentRequestResponse({ ...input(), token: claim.token, response: { stale: true } })).toBe(false);
    expect(row.output).toBeNull();
  });

  it("replays a completed receipt without entering the course mutation queue", async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    const response = { requestId: "request-1", result: { message: "已保存" } };
    await completeDocumentRequest({ ...input(), token: claim.token, messages: [answerMessage], response });
    mocks.transaction.mockClear(); mocks.append.mockClear(); mocks.db.aiTask.update.mockClear();
    await expect(claimDocumentRequest(input())).resolves.toMatchObject({ kind: "existing", state: { status: "completed", response } });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.db.aiTask.update).not.toHaveBeenCalled();
  });

  it("stores response message references and restores identical responses for polling, retry and cancellation", async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    const response = { requestId: input().requestId, messages: [answerMessage], result: { message: "结构化结果仍完整保留" } };
    await completeDocumentRequest({ ...input(), token: claim.token, messages: [answerMessage], response });
    expect([...mocks.rows.values()][0].output).toMatchObject({ schemaVersion: 2,
      responseContentRefs: [{ path: "messages.0", messageId: answerMessage.id }],
      response: { result: response.result, messages: [expect.not.objectContaining({ content: expect.any(String) })] },
    });
    mocks.messages.set("later-message", { id: "later-message", conversationId: [...mocks.rows.values()][0].conversationId, content: "之后的消息" });
    expect((await getDocumentRequest(input()))?.response).toEqual(response);
    expect(await readDocumentRequestReceipt(input())).toEqual({ status: 200, body: response });
    expect(await claimDocumentRequest(input())).toMatchObject({ kind: "existing", state: { response } });
    expect((await cancelDocumentRequest(input()))?.response).toEqual(response);
  });

  it("compacts existing comment history by stable message IDs without changing legacy inline entries", async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    const oldMessage = { id: "old-message", role: "assistant", content: "原有完整批注", createdAt: answerMessage.createdAt };
    mocks.messages.set(oldMessage.id, { id: oldMessage.id, conversationId: [...mocks.rows.values()][0].conversationId, content: oldMessage.content });
    const legacyMessage = { id: "legacy-missing-row", role: "assistant", content: "缺少原始消息行的旧批注，继续保留正文" };
    const response = { commentThread: { id: "comment-thread", comments: [oldMessage, legacyMessage, { ...answerMessage, role: "assistant" }] },
      commentThreads: [{ id: "comment-thread", comments: [oldMessage] }] };
    await completeDocumentRequest({ ...input(), token: claim.token, messages: [answerMessage], response });
    const output = [...mocks.rows.values()][0].output!;
    expect(output.responseContentRefs).toEqual([
      { path: "commentThread.comments.0", messageId: oldMessage.id },
      { path: "commentThread.comments.2", messageId: answerMessage.id },
      { path: "commentThreads.0.comments.0", messageId: oldMessage.id },
    ]);
    expect(JSON.stringify(output.response)).toContain(legacyMessage.content);
    expect(JSON.stringify(output.response)).not.toContain(oldMessage.content);
    expect((await getDocumentRequest(input()))?.response).toEqual(response);
  });

  it("keeps legacy receipts readable and fails a missing reference until its message is available again", async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    const response = { messages: [answerMessage] };
    await completeDocumentRequest({ ...input(), token: claim.token, messages: [answerMessage], response });
    const storedMessage = mocks.messages.get(answerMessage.id)!;
    mocks.messages.delete(answerMessage.id);
    await expect(getDocumentRequest(input())).rejects.toMatchObject({ code: "REQUEST_RECEIPT_MISSING", status: 503 });
    expect(await readDocumentRequestReceipt(input())).toMatchObject({ status: 503,
      body: { error: "REQUEST_RECEIPT_MISSING", retryable: true } });
    expect([...mocks.rows.values()][0].status).toBe("COMPLETED");
    mocks.messages.set(answerMessage.id, storedMessage);
    expect((await getDocumentRequest(input()))?.response).toEqual(response);
    [...mocks.rows.values()][0].output = { schemaVersion: 1, response };
    mocks.db.aiMessage.findMany.mockClear();
    expect((await getDocumentRequest(input()))?.response).toEqual(response);
    expect(mocks.db.aiMessage.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { fingerprint: "other" }, { stageKey: "proposal" }, { workspaceKind: "external-artifact" },
    { conversationId: "another-logical-thread" }, { documentVersion: "changed" },
  ])("rejects changed request identity instead of returning a completed receipt: %j", async changed => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    await completeDocumentRequest({ ...input(), token: claim.token, messages: [], response: { secret: "answer" } });
    mocks.transaction.mockClear();
    await expect(claimDocumentRequest({ ...input(), ...changed })).resolves.toEqual({ kind: "conflict" });
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("does not replay a completed task whose persisted ownership chain changed", async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    await completeDocumentRequest({ ...input(), token: claim.token, messages: [], response: {} });
    mocks.db.$queryRaw.mockResolvedValueOnce([]);
    await expect(claimDocumentRequest(input())).rejects.toMatchObject({ code: "MESSAGE_SCOPE_MISMATCH" });
  });

  it("does not commit a receipt when its batched history or research facts fail", async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    mocks.append.mockRejectedValueOnce(new Error("batch evidence write failed"));
    await expect(completeDocumentRequest({ ...input(), token: claim.token, messages: [answerMessage], response: {} }))
      .rejects.toThrow("batch evidence write failed");
    expect((await getDocumentRequest(input()))?.status).toBe("processing");
  });

  it("passes the immutable task/request/stage association to canonical message facts", async () => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    const messageFacts = { [answerMessage.id]: { source: "selection", detail: { contributionId: "suggestion" } } };
    await completeDocumentRequest({ ...input(), token: claim.token, messages: [answerMessage], response: {}, messageFacts });
    expect(mocks.append).toHaveBeenCalledWith(mocks.db, expect.objectContaining({
      requestId: input().requestId, taskId: expect.any(String), stageKey: input().threadStageKey,
      researchStageKey: input().stageKey, messageFacts,
    }));
    expect(mocks.publish).toHaveBeenCalledWith(input().courseId, expect.objectContaining({ type: "companion-message",
      payload: expect.objectContaining({ source: "ai-interaction-event", requestId: input().requestId }) }));
  });

  it("lets an expired lease be reclaimed without accepting the old worker's result", async () => {
    const first = await claimDocumentRequest(input());
    if (first.kind !== "run") throw new Error("expected run");
    const row = [...mocks.rows.values()][0];
    row.startedAt = new Date(Date.now() - 130_000);
    expect(await getDocumentRequest(input())).toMatchObject({
      status: "failed",
      error: "REQUEST_INTERRUPTED",
    });
    const second = await claimDocumentRequest(input());
    if (second.kind !== "run") throw new Error("expected reclaimed run");
    expect(second.token).not.toBe(first.token);
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [answerMessage], response: {} })).toBe(false);
    expect(await completeDocumentRequest({ ...input(), token: second.token, messages: [answerMessage], response: {} })).toBe(true);
    expect(mocks.append).toHaveBeenCalledTimes(1);
  });
  it("returns the actual running or completed receipt after an old review token is replaced", async () => {
    const review = { ...input(), intent: "proactive-document-comments" };
    const first = await claimDocumentRequest(review); if (first.kind !== "run") throw new Error("expected run");
    [...mocks.rows.values()][0].startedAt = new Date(Date.now() - 130_000);
    const replacement = await claimDocumentRequest(review); if (replacement.kind !== "run") throw new Error("expected replacement");
    expect(await completeDocumentRequest({ ...review, token: first.token, messages: [], response: { wrong: true } })).toBe(false);
    expect(await readDocumentRequestReceipt(review)).toMatchObject({ status: 202, body: { requestId: review.requestId, status: "processing" } });
    const response = { requestId: review.requestId, status: "completed", commentThreads: [], reviewDecision: { outcome: "no-comment" } };
    expect(await completeDocumentRequest({ ...review, token: replacement.token, messages: [], response })).toBe(true);
    expect(await readDocumentRequestReceipt(review)).toEqual({ status: 200, body: response });
    expect(mocks.append).not.toHaveBeenCalled();
  });
  it("returns cancellation only when the persistent task is cancelled", async () => {
    expect(await readDocumentRequestReceipt(input())).toMatchObject({ status: 503, body: { status: "failed" } });
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    await cancelDocumentRequest(input());
    expect(await completeDocumentRequest({ ...input(), token: claim.token, messages: [], response: {} })).toBe(false);
    expect(await readDocumentRequestReceipt(input())).toMatchObject({ status: 409, body: { status: "cancelled" } });
  });
  it("reads scoped delegation summaries across logical chats without loading document bodies", async () => {
    mocks.db.$queryRaw.mockResolvedValueOnce([
      { requestId: "newer", createdAt: new Date("2026-10-19T08:00:00Z"), scope: "整理单位", kind: "work-delivery", title: "单位表", summary: "已转换单位", responsibility: "独立分析", decision: "adopted" },
      { requestId: "older", createdAt: new Date("2026-10-19T07:00:00Z"), scope: "排版资料", kind: "work-delivery", title: "资料表", summary: "排版完成", responsibility: "独立判断", decision: null },
    ]);
    const summary = await readDelegatedWorkSummary(input());
    expect(summary.indexOf('"requestId":"newer"')).toBeLessThan(summary.indexOf('"requestId":"older"'));
    expect(summary).toContain('"studentDecision":"未确认"');
    expect(summary).toContain('"studentDecision":"已采纳"');
    const [query, ...values] = mocks.db.$queryRaw.mock.calls.at(-1)!;
    const sql = query.join("?");
    expect(sql).toContain('participation."instanceId" =');
    expect(sql).toContain('enrollment."userId" =');
    expect(sql).toContain("task.input ->> 'stageKey' =");
    expect(sql).toContain("task.input ->> 'workspaceKind' =");
    expect(sql).not.toMatch(/SELECT\s+task\.(?:input|output)\s*(?:,|FROM)/);
    expect(sql).not.toContain("deliverable,content");
    expect(values).toContain(input().participationId);
    expect(values).toContain(input().courseId);
    expect(values).not.toContain(input().conversationId);
  });
  it("marks truncated delegation history as incomplete and never invents an adoption", async () => {
    mocks.db.$queryRaw.mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({
      requestId: String(index), createdAt: new Date(), scope: "辅助工作", kind: "work-delivery", title: "交付", summary: "摘要", responsibility: null,
      decision: index === 0 ? "rejected" : index === 1 ? "undone" : "unknown",
    })));
    const summary = await readDelegatedWorkSummary(input());
    expect(summary).toContain("更早内容未展开");
    expect(summary).toContain('"studentDecision":"已拒绝"');
    expect(summary).toContain('"studentDecision":"采纳后已撤销"');
    expect(summary).not.toContain('"studentDecision":"已采纳"');
    expect(summary.startsWith("【历史不完整】")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(6_000);
  });
  it("does not turn an unavailable delegation history into an empty safe history", async () => {
    mocks.db.$queryRaw.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(readDelegatedWorkSummary(input())).rejects.toMatchObject({ code: "DOCUMENT_DELEGATION_HISTORY_UNAVAILABLE" });
  });
  it("keeps the newest delegations and an upfront warning when fewer than 100 rows exceed the summary budget", async () => {
    mocks.db.$queryRaw.mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => ({
      requestId: `request-${index}`, createdAt: new Date(), scope: "范围".repeat(300), kind: "work-delivery", title: "标题".repeat(80),
      summary: "摘要".repeat(250), responsibility: "责任".repeat(200), decision: null,
    })));
    const summary = await readDelegatedWorkSummary(input());
    expect(summary.startsWith("【历史不完整】")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(6_000);
    const included = summary.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
    expect(included[0].requestId).toBe("request-0");
    expect(included.at(-1).requestId).not.toBe("request-9");
    expect(included.length).toBeGreaterThan(1);
  });
  it("retains a readable newest row even when JSON escaping expands its bounded fields", async () => {
    mocks.db.$queryRaw.mockResolvedValueOnce([{
      requestId: "newest", createdAt: new Date(), scope: "\u0001".repeat(600), kind: "work-delivery", title: "\u0001".repeat(160),
      summary: "\u0001".repeat(500), responsibility: "\u0001".repeat(400), decision: null,
    }]);
    const summary = await readDelegatedWorkSummary(input());
    expect(summary.startsWith("【历史不完整】")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(6_000);
    expect(JSON.parse(summary.split("\n").at(-1)!)).toMatchObject({ requestId: "newest", entryTruncated: true });
  });
  describe("delegation history read deadlines", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });
    it("fails a hanging mandatory history read after the default eight seconds", async () => {
      mocks.db.$queryRaw.mockImplementationOnce(() => new Promise(() => {}));
      const result = readDelegatedWorkSummary(input());
      const assertion = expect(result).rejects.toMatchObject({ message: "DOCUMENT_DELEGATION_HISTORY_UNAVAILABLE", code: "DOCUMENT_DELEGATION_HISTORY_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    });
    it("uses an explicit deadline and consumes a late query rejection", async () => {
      let rejectQuery!: (error: unknown) => void;
      mocks.db.$queryRaw.mockImplementationOnce(() => new Promise((_, reject) => { rejectQuery = reject; }));
      const result = readDelegatedWorkSummary(input(), { timeoutMs: 100 });
      const assertion = expect(result).rejects.toHaveProperty("code", "DOCUMENT_DELEGATION_HISTORY_UNAVAILABLE");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      rejectQuery(new Error("late database failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(0);
    });
    it("cancels promptly using the parent signal and does not start an already cancelled read", async () => {
      mocks.db.$queryRaw.mockImplementationOnce(() => new Promise(() => {}));
      const controller = new AbortController();
      const result = readDelegatedWorkSummary(input(), { signal: controller.signal });
      const assertion = expect(result).rejects.toThrow("parent cancelled");
      controller.abort(new Error("parent cancelled"));
      await assertion;
      const count = mocks.db.$queryRaw.mock.calls.length;
      await expect(readDelegatedWorkSummary(input(), { signal: controller.signal })).rejects.toThrow("parent cancelled");
      expect(mocks.db.$queryRaw).toHaveBeenCalledTimes(count);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
  it.each([
    ["AI_COLLABORATION_TIMEOUT", "超时", true],
    ["AI_COLLABORATION_RATE_LIMITED", "请求较多", true],
    ["AI_RESPONSE_INVALID_STRUCTURE", "格式", true],
    ["AI_DISCUSSION_REVIEW_FAILED", "事实与推理检查", false],
    ["AI_DELEGATED_DELIVERY_INCOMPLETE", "请调整问题后重新发送", false],
    ["AI_COLLABORATION_INPUT_REJECTED", "编辑原消息", false],
    ["REVIEW_STAGE_CHANGED", "课程或对话", false],
  ] as const)("preserves the explanation and retry policy for recovered %s failures", async (error, explanation, retryable) => {
    const claim = await claimDocumentRequest(input()); if (claim.kind !== "run") throw new Error("expected run");
    await failDocumentRequest({ ...input(), token: claim.token, error });
    const state = await getDocumentRequest(input());
    expect(state).toMatchObject({ status: "failed", error, retryable, failureMessage: expect.stringContaining(explanation), message: input().message });
    expect(await readDocumentRequestReceipt(input())).toMatchObject({ body: { error, retryable, failureMessage: state!.failureMessage } });
  });
  it("commits a no-comment review with a scoped decision receipt and replays it without extra messages", async () => {
    const review = { ...input(), intent: "proactive-document-comment" };
    const claim = await claimDocumentRequest(review); if (claim.kind !== "run") throw new Error("expected run");
    const response = { commentThread: null, reviewDecision: { outcome: "no-comment", reasonCodes: ["MODEL_NO_COMMENT"] } };
    const auditEvents = [{ idempotencyKey: "review-decision", eventType: "policy", actor: "system" as const, content: "不批注", payload: { detail: response.reviewDecision } }];
    expect(await completeDocumentRequest({ ...review, token: claim.token, messages: [], response, auditEvents })).toBe(true);
    expect(mocks.db.aiInteractionEvent.createMany).toHaveBeenCalledWith({ data: [expect.objectContaining({ userId: "student-1", participationId: "participation-1", offeringId: "offering-1", researchKey: "research-1", requestId: "request-1", taskId: expect.any(String), content: "不批注" })] });
    expect(await claimDocumentRequest(review)).toMatchObject({ kind: "existing", state: { status: "completed", response } });
    expect(mocks.db.aiInteractionEvent.createMany).toHaveBeenCalledOnce();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith("course-1", expect.objectContaining({ type: "companion-message", payload: expect.objectContaining({ requestId: "request-1", studentId: "student-1" }) }));
  });
  it('publishes an owned receipt hint for queued starters even without message/audit writes', async () => {
    const review = { ...input(), intent: 'code-task-starters' };
    const claim = await claimDocumentRequest(review); if (claim.kind !== 'run') throw new Error('expected run');
    [...mocks.rows.values()][0].queueKey = 'document-review-v1';
    expect(await completeDocumentRequest({ ...review, token: claim.token, messages: [], response: { starters: ['retained'] } })).toBe(true);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledWith(review.courseId, expect.objectContaining({ payload: {
      source: 'ai-task-completed', scope: 'student', studentId: review.studentId, stageKey: review.stageKey, requestId: review.requestId,
    } }));
    expect(mocks.append).not.toHaveBeenCalled(); expect(mocks.db.aiInteractionEvent.createMany).not.toHaveBeenCalled();
    expect(await completeDocumentRequest({ ...review, token: claim.token, messages: [], response: {} })).toBe(false);
    expect(mocks.publish).toHaveBeenCalledOnce();
  });
  it("does not acknowledge completion when the review decision write fails", async () => {
    const review = input(); const claim = await claimDocumentRequest(review); if (claim.kind !== "run") throw new Error("expected run");
    mocks.db.aiInteractionEvent.createMany.mockRejectedValueOnce(new Error("decision write unavailable"));
    await expect(completeDocumentRequest({ ...review, token: claim.token, messages: [], response: { commentThread: null },
      auditEvents: [{ idempotencyKey: "review-decision", eventType: "policy", actor: "system", content: "不批注", payload: {} }] })).rejects.toThrow("decision write unavailable");
    expect((await getDocumentRequest(review))?.status).toBe("processing");
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("still rejects changed student or classroom scope when a receipt has no messages", async () => {
    const review = input(); const claim = await claimDocumentRequest(review);
    if (claim.kind !== "run") throw new Error("expected run");
    for (const changed of [{ studentId: "student-2" }, { courseId: "course-2" }]) {
      await expect(completeDocumentRequest({ ...review, ...changed, token: claim.token, messages: [], response: {} }))
        .rejects.toThrow(/REVIEW_EVENT_SCOPE_MISMATCH|消息归属不一致/);
    }
    expect((await getDocumentRequest(review))?.status).toBe("processing");
    expect(mocks.db.aiInteractionEvent.createMany).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("retains the completed database receipt if only its realtime notification fails", async () => {
    const review = input(); const claim = await claimDocumentRequest(review); if (claim.kind !== "run") throw new Error("expected run");
    mocks.publish.mockRejectedValueOnce(new Error("realtime unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await completeDocumentRequest({ ...review, token: claim.token, messages: [], response: { commentThread: null },
        auditEvents: [{ idempotencyKey: "review-decision", eventType: "policy", actor: "system", content: "不批注", payload: {} }] })).toBe(true);
      expect((await getDocumentRequest(review))?.status).toBe("completed");
    } finally { log.mockRestore(); }
  });

  it("keeps cancellation final and prevents a late answer from being saved", async () => {
    const first = await claimDocumentRequest(input());
    if (first.kind !== "run") throw new Error("expected run");
    expect(await cancelDocumentRequest(input())).toMatchObject({ status: "cancelled" });
    expect(await completeDocumentRequest({ ...input(), token: first.token, messages: [], response: {} })).toBe(false);
    expect(await claimDocumentRequest(input())).toMatchObject({ kind: "existing", state: { status: "cancelled" } });
    expect(mocks.append).not.toHaveBeenCalled();
  });
});


describe("persistent document work suggestions", () => {
  const context = () => ({
    courseId: "course-1", studentId: "student-1", participationId: "participation-1", stageKey: "make",
    workspaceKind: "document", threadStageKey: "ai-collaboration:make", documentHtml: "<p>调查记录</p>",
    generationPrompts: { system: "生成任务", user: "完整课程要求和文稿" },
    reviewPrompts: { system: "审核边界", user: "完整课程要求和文稿" },
    model: { endpoint: "https://example.test", model: "configured-model" },
  });
  beforeEach(() => { mocks.rows.clear(); vi.clearAllMocks(); });

  it("invalidates reuse for every relevant identity, complete document, prompt and model change", () => {
    const original = context();
    const first = buildDocumentSuggestionRequest(original);
    expect(buildDocumentSuggestionRequest(context())).toEqual(first);
    for (const change of [
      { studentId: "other-student" }, { participationId: "another-class" }, { courseId: "course-2" },
      { stageKey: "proposal" }, { workspaceKind: "external-artifact" },
      { documentHtml: `${original.documentHtml}<p>新增中间段落</p>` },
      { generationPrompts: { ...original.generationPrompts, user: "新的课程要求" } },
      { reviewPrompts: { ...original.reviewPrompts, system: "新版审核规则" } },
      { model: { ...original.model, model: "updated-model" } },
    ]) expect(buildDocumentSuggestionRequest({ ...original, ...change }).requestId).not.toBe(first.requestId);
  });

  it("merges 30 simultaneous requests and reuses a completed no-suggestion decision", async () => {
    const task = buildDocumentSuggestionRequest(context());
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const generate = vi.fn(async () => { started(); await gate; return []; });
    const first = cachedDocumentSuggestions(task, generate);
    await startedPromise;
    const joined = await Promise.all(Array.from({ length: 29 }, () => cachedDocumentSuggestions(task, generate)));
    expect(joined.every(result => result.status === 202)).toBe(true);
    release();
    expect(await first).toMatchObject({ status: 200, body: { starters: [], resultSource: "generated" } });
    const replayed = await Promise.all(Array.from({ length: 30 }, () => cachedDocumentSuggestions(task, generate)));
    expect(replayed.every(result => result.status === 200 && result.body.resultSource === "reused")).toBe(true);
    expect(generate).toHaveBeenCalledOnce();
    expect(mocks.db.aiInteractionEvent.createMany).toHaveBeenCalledOnce();
  });

  it("retains successful model work if committing its decision audit fails", async () => {
    const task = buildDocumentSuggestionRequest(context());
    const generate = vi.fn(async () => ["整理文稿中已有数据的记录表"]);
    mocks.db.aiInteractionEvent.createMany.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(cachedDocumentSuggestions(task, generate)).rejects.toThrow("audit unavailable");
    expect(await cachedDocumentSuggestions(task, generate)).toMatchObject({
      status: 200, body: { starters: ["整理文稿中已有数据的记录表"] },
    });
    expect(generate).toHaveBeenCalledOnce();
  });

  it("does not treat generation failure as a cached empty answer", async () => {
    const task = buildDocumentSuggestionRequest(context());
    const generate = vi.fn().mockRejectedValueOnce(new Error("upstream timeout")).mockResolvedValueOnce([]);
    await expect(cachedDocumentSuggestions(task, generate)).rejects.toThrow("upstream timeout");
    expect(await cachedDocumentSuggestions(task, generate)).toMatchObject({ status: 200, body: { starters: [] } });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("resumes paid candidates after a review timeout but never publishes unreviewed suggestions", async () => {
    const task = buildDocumentSuggestionRequest(context());
    const generate = vi.fn(async () => ["未审核候选"]);
    const review = vi.fn().mockRejectedValueOnce(new Error("review timed out")).mockResolvedValueOnce(["已审核建议"]);
    const work = async (token: string, prepared?: string[]) => {
      const candidates = prepared ?? await generate();
      if (!prepared) await prepareDocumentRequestResponse({ ...task, token, response: { candidateStarters: candidates } });
      return review(candidates);
    };
    await expect(cachedDocumentSuggestions(task, work)).rejects.toThrow("review timed out");
    expect(await readDocumentRequestReceipt(task)).toMatchObject({ body: { status: "failed" } });
    expect((await readDocumentRequestReceipt(task)).body).not.toHaveProperty("starters");
    expect(await cachedDocumentSuggestions(task, work)).toMatchObject({ status: 200, body: { starters: ["已审核建议"] } });
    expect(generate).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("never gives another student's saved suggestion to a changed authenticated identity", async () => {
    const generate = vi.fn(async () => ["整理当前文稿中已有的引用来源清单"]);
    const task = buildDocumentSuggestionRequest(context());
    await cachedDocumentSuggestions(task, generate);
    expect(await cachedDocumentSuggestions({ ...task, studentId: "student-2" }, generate)).toMatchObject({ status: 409 });
    expect(generate).toHaveBeenCalledOnce();
  });
});
