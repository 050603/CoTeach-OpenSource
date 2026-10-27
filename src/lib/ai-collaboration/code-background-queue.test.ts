import { beforeEach, expect, it, vi } from 'vitest';
import type { Course } from '@/lib/session/types';
const queueMocks = vi.hoisted(() => ({ tx: undefined as unknown, ensure: vi.fn(), capacity: vi.fn() }));
const query = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: query } }));
vi.mock('@/lib/db/transaction-retry', () => ({ runMutationTransaction: (run: (tx: unknown) => unknown) => run(queueMocks.tx) }));
vi.mock('@/lib/companion/server-store', () => ({ ensureCompanionThreadWithinTransaction: queueMocks.ensure }));
vi.mock('./document-review-admission', () => ({ hasDocumentReviewAdmissionCapacity: queueMocks.capacity }));
import { assertDocumentReviewScope, enqueueCodeReview, codeReviewGenerationRequestId, type CodeReviewSnapshot } from './document-review-queue';
import { documentTaskId } from './document-request-store';
import type { AiTask } from '@prisma/client';
import { codeRequestDigest } from './code-request';
import { codeBackgroundBodyDigest, readCodeBackgroundAlias } from './code-background-alias';

const artifact = { version: 1, language: 'python', activeFileId: 'main', files: [
  { id: 'main', path: 'main.py', content: 'print(1)' }, { id: 'helper', path: 'helper.py', content: 'return 2' },
] };
function snapshot(): CodeReviewSnapshot {
  const body = { courseId: 'course', studentId: 'student', stageKey: 'make', language: 'python', action: '', intent: 'proactive-review', artifact };
  const context = { artifact, run: null, selection: null, mode: 'discuss' };
  const prompts = { system: 'same complete policy', user: 'complete original code' };
  const fingerprintSource = JSON.stringify({ prompts, action: '', intent: body.intent, language: body.language, context });
  return { version: 2, kind: 'code-background', body, context, prompts, fingerprintSource,
    course: { stages: [{ key: 'make' }] } as Course,
    task: { courseId: 'course', studentId: 'student', participationId: 'participation', requestId: 'canonical',
      stageKey: 'make', workspaceKind: 'code:python', threadStageKey: 'comments', conversationId: 'legacy',
      fingerprint: codeRequestDigest(JSON.parse(fingerprintSource)), documentVersion: codeRequestDigest(artifact), message: '', intent: body.intent, history: [] },
    guard: { templateVersionId: 'template', offeringId: 'offering', stageIndex: 0, stageVersion: 2,
      identity: { role: 'STUDENT', status: 'ACTIVE', sessionVersion: 3 } },
  };
}
const scope = { instanceId: 'course', userId: 'student', offeringId: 'offering', enrollmentStatus: 'ACTIVE',
  instanceStatus: 'TEACHING', offeringStatus: 'OPEN', archivedAt: null, templateVersionId: 'template',
  runtimeConfig: { currentStageIndex: 0, stageVersion: 2, makeArtifactMode: 'python' },
  userRole: 'STUDENT', userStatus: 'ACTIVE', userSessionVersion: 3 };
function reordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reordered(child)]));
  return value;
}
beforeEach(() => { query.mockReset().mockResolvedValue([scope]); });
it('accepts unchanged complete code after JSONB object-key reordering without changing legacy fingerprints', async () => {
  const original = snapshot(); const persisted = reordered(original) as CodeReviewSnapshot;
  expect(JSON.stringify(persisted.context.artifact)).not.toBe(JSON.stringify(original.context.artifact));
  await expect(assertDocumentReviewScope({ $queryRaw: query }, persisted)).resolves.toBeUndefined();
  expect(persisted.task.fingerprint).toBe(original.task.fingerprint);
  expect(persisted.task.documentVersion).toBe(original.task.documentVersion);
});
it.each(['artifact', 'run', 'selection', 'prompt', 'language', 'owner', 'source'] as const)('rejects mutated immutable %s before any live query', async field => {
  const value = structuredClone(snapshot());
  if (field === 'artifact') (value.body.artifact as typeof artifact).files[1].content = 'changed';
  if (field === 'run') value.body.run = { stdout: 'changed' };
  if (field === 'selection') value.body.selection = { text: 'changed' };
  if (field === 'prompt') value.prompts.user += 'changed';
  if (field === 'language') value.body.language = 'c';
  if (field === 'owner') value.body.studentId = 'other';
  if (field === 'source') value.fingerprintSource += ' ';
  await expect(assertDocumentReviewScope({ $queryRaw: query }, value)).rejects.toMatchObject({ code: 'REVIEW_INPUT_CHANGED' });
  expect(query).not.toHaveBeenCalled();
});
it.each([{ userSessionVersion: 4 }, { enrollmentStatus: 'WITHDRAWN' }, { userStatus: 'DISABLED' },
  { instanceStatus: 'FINISHED' }, { templateVersionId: 'new-template' },
  { runtimeConfig: { ...scope.runtimeConfig, stageVersion: 3 } }, { runtimeConfig: { ...scope.runtimeConfig, makeArtifactMode: 'c' } },
])('rechecks live identity, course and mode at execution/commit: %j', async changed => {
  query.mockResolvedValue([{ ...scope, ...changed }]);
  await expect(assertDocumentReviewScope({ $queryRaw: query }, snapshot())).rejects.toThrow(/^REVIEW_/);
});
it('returns the exact client alias and canonical receipt while preserving every original body field', async () => {
  const body = { ...snapshot().body, requestId: 'client', extra: { retained: 'full raw body' } };
  const row = { status: 'COMPLETED', input: snapshot().task, output: { response: { requestId: 'canonical', status: 'completed', result: { findings: [] } } },
    error: null, createdAt: new Date(), startedAt: null, bodyDigest: codeBackgroundBodyDigest(body), requestBody: reordered(body) };
  query.mockResolvedValue([row]);
  const identity = { ...snapshot().task, requestId: 'client' };
  const response = await readCodeBackgroundAlias(identity, reordered(body) as typeof body);
  expect(await response!.json()).toMatchObject({ requestId: 'client', canonicalRequestId: 'canonical', status: 'completed', result: { findings: [] } });
  expect(response!.headers.get('cache-control')).toBe('private, no-store');
  expect((await readCodeBackgroundAlias(identity, { ...body, extra: { retained: 'different' } }))!.status).toBe(409);
  expect((await readCodeBackgroundAlias({ ...identity, stageKey: 'reflection' }))!.status).toBe(409);
});
it.each(['session', 'stage', 'stale-template', 'stale-stage'] as const)('keeps generation/accepted projection consistent without rebinding original input: %s', async change => {
  const old = snapshot(); old.task.requestId = `code-background:${'a'.repeat(64)}`;
  const baseId = documentTaskId(old.task.participationId, old.task.requestId);
  const tasks = new Map<string, AiTask>();
  const initial = { id: baseId, status: 'RUNNING', taskType: 'DOCUMENT_COLLABORATION', createdById: 'student',
    input: { ...old.task, reviewSnapshot: old }, output: null, queueKey: 'document-review-v1', error: null,
    createdAt: new Date(), startedAt: new Date(), leaseUntil: new Date(Date.now() + 125_000) } as unknown as AiTask;
  tasks.set(baseId, initial);
  const originalBytes = JSON.stringify(initial);
  const aliases = new Map<string, { taskId: string; bodyDigest: string; requestBody: Record<string, unknown> }>();
  aliases.set('old-alias', { taskId: baseId, bodyDigest: codeBackgroundBodyDigest(old.body), requestBody: old.body });
  const live = change === 'session' ? { ...scope, userSessionVersion: 4 }
    : change === 'stale-template' ? { ...scope, templateVersionId: 'new-template' }
    : { ...scope, runtimeConfig: { ...scope.runtimeConfig, stageVersion: 4 } };
  query.mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    if (parts.join('').includes('SELECT t.*')) {
      const alias = aliases.get(String(values[1])); return alias ? [{ ...tasks.get(alias.taskId), ...alias }] : [];
    }
    return [live];
  });
  queueMocks.capacity.mockResolvedValue(true); queueMocks.ensure.mockResolvedValue({ row: { id: 'conversation-row' } });
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    const task = { ...data, createdAt: new Date() } as AiTask; tasks.set(task.id, task); return task;
  });
  queueMocks.tx = { $queryRaw: query,
    $executeRaw: async (_parts: TemplateStringsArray, _participation: string, alias: string, taskId: string, bodyDigest: string, requestBody: string) => {
      aliases.set(alias, { taskId, bodyDigest, requestBody: JSON.parse(requestBody) }); return 1;
    }, aiTask: { findUnique: async ({ where }: { where: { id: string } }) => tasks.get(where.id) ?? null, create } };
  const request = { task: old.task, body: old.body, prompts: old.prompts, context: old.context,
    course: { ...old.course, stageVersion: change === 'stale-stage' ? 2 : live.runtimeConfig.stageVersion,
      platformContext: { templateVersionId: change === 'stale-template' ? 'template' : live.templateVersionId,
        offeringId: 'offering', activityId: 'activity', templateId: 'template-parent' } } };
  if (change.startsWith('stale-')) {
    // The stage key/index is unchanged after a stage leaves and returns; the
    // actual captured version still cannot be replaced with the newer guard.
    await expect(enqueueCodeReview(request, live.userSessionVersion, { requestId: 'new-alias', body: old.body }))
      .rejects.toMatchObject({ code: 'REVIEW_STAGE_CHANGED' });
    expect(create).not.toHaveBeenCalled(); expect(aliases.has('new-alias')).toBe(false);
    expect(JSON.stringify(tasks.get(baseId))).toBe(originalBytes);
    return;
  }
  const first = await enqueueCodeReview(request, live.userSessionVersion, { requestId: 'new-alias', body: old.body });
  expect(first.kind).toBe('queued'); if (first.kind !== 'queued') throw new Error('expected new generation');
  expect(first.state.requestId).not.toBe(old.task.requestId);
  const derived = [...tasks.values()].find(task => task.id !== baseId)!;
  const stored = (derived.input as unknown as { reviewSnapshot: CodeReviewSnapshot }).reviewSnapshot;
  expect(stored.baseRequestId).toBe(old.task.requestId);
  expect(stored.task.requestId).toBe(codeReviewGenerationRequestId(old.task.requestId, stored.guard, 'python'));
  await expect(assertDocumentReviewScope({ $queryRaw: query }, stored)).resolves.toBeUndefined();
  await expect(assertDocumentReviewScope({ $queryRaw: query }, { ...stored, task: { ...stored.task, requestId: 'invented' } })).rejects.toMatchObject({ code: 'REVIEW_INPUT_CHANGED' });
  const duplicate = await enqueueCodeReview(request, live.userSessionVersion, { requestId: 'second-new-alias', body: old.body });
  expect(duplicate).toMatchObject({ kind: 'existing', state: { requestId: first.state.requestId } });
  const originalAlias = await enqueueCodeReview(request, live.userSessionVersion, { requestId: 'old-alias', body: old.body });
  expect(originalAlias).toMatchObject({ kind: 'existing', state: { requestId: old.task.requestId } });
  expect(create).toHaveBeenCalledOnce(); expect(JSON.stringify(tasks.get(baseId))).toBe(originalBytes);
  expect(aliases.get('old-alias')?.taskId).toBe(baseId);
});
