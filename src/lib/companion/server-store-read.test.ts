// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const reads = vi.hoisted(() => ({ scope: vi.fn(), thread: vi.fn(), pair: vi.fn(), nestedParticipation: vi.fn(), transaction: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: reads.scope,
  aiConversation: { findUnique: reads.thread, findMany: reads.pair }, classroomParticipation: { findFirst: reads.nestedParticipation } } }));
vi.mock('@/lib/db/transaction-retry', () => ({ runMutationTransaction: reads.transaction }));
import { getCompanionThread, getCompanionThreadPair, loadCompanionState } from './server-store';
import { PlatformError } from '@/lib/platform/repository';
import { companionThreadId } from './scoped-message-batch';
import type { PlatformDb } from '@/lib/platform/access';

const timestamp = new Date('2026-09-27T00:00:00.000Z');
const stages = [undefined, null, 0, false, [], {}, '', 'make', '文档_%'];
const rows = stages.map((stage, index) => ({
  id: String(index), userId: 'student', metadata: stage === undefined ? {} : { legacyStageKey: stage },
  createdAt: timestamp, updatedAt: timestamp,
  messages: [{ id: `message-${index}`, role: 'user', content: 'Retained original', createdAt: timestamp, metadata: {} }],
}));
const taskInputs: unknown[] = [
  ...stages.map((stage, index) => ({ request: `Request ${index}`, legacy: {
    ...(stage === undefined ? {} : { stageKey: stage }), title: `Title ${index}`, companionId: `member-${index}`,
    evidenceIds: [`evidence-${index}`],
  } })),
  null, 7, false, [], {}, { legacy: null }, { legacy: 3 }, { legacy: ['make'] },
  { reviewSnapshot: { course: { id: 'course' }, documentHtml: '<p>Snapshot must remain durable, outside this projection.</p>' } },
];
const taskRows = taskInputs.map((input, index) => ({ id: `task-${index}`, createdById: 'student',
  taskType: 'formal-action', status: 'SAVED', input, output: { result: `Result ${index}` }, error: `Retained diagnostic ${index}`,
  createdAt: timestamp, updatedAt: timestamp,
}));
function taskStage(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const legacy = (input as { legacy?: unknown }).legacy;
  return legacy && typeof legacy === 'object' && !Array.isArray(legacy) ? (legacy as { stageKey?: unknown }).stageKey : undefined;
}
function database(filtered: boolean) {
  const findMany = vi.fn(async () => filtered ? rows.filter(row => typeof row.metadata.legacyStageKey === 'string') : rows);
  const findTasks = vi.fn(async () => filtered ? taskRows.filter(row => typeof taskStage(row.input) === 'string') : taskRows);
  return { findMany, findTasks, db: {
    aiConversation: { findMany }, aiTask: { findMany: findTasks },
    aiActionConfirmation: { findMany: vi.fn(async () => []) }, aiSupportRecord: { findMany: vi.fn(async () => []) },
  } as unknown as PlatformDb };
}
describe('companion read projection', () => {
  it.each(['student', undefined])('preserves full threads and messages when prefiltering string stage keys (%s)', async student => {
    const original = database(false), filtered = database(true);
    const before = await loadCompanionState('course', original.db, student);
    const after = await loadCompanionState('course', filtered.db, student);
    expect(after).toEqual(before);
    expect(after.companionThreads?.map(thread => thread.stageKey)).toEqual(['', 'make', '文档_%']);
    expect(after.companionThreads?.every(thread => thread.messages[0].content === 'Retained original')).toBe(true);
    expect(filtered.findMany).toHaveBeenCalledWith({
      where: { participation: { instanceId: 'course' }, ...(student ? { userId: student } : {}),
        metadata: { path: ['legacyStageKey'], string_starts_with: '' } },
      include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    });
  });
  it.each(['student', undefined])('preserves full task projection and order for string/empty stage keys while excluding non-legacy input (%s)', async student => {
    const original = database(false), filtered = database(true);
    const before = await loadCompanionState('course', original.db, student);
    const after = await loadCompanionState('course', filtered.db, student);
    expect(after).toEqual(before);
    expect(after.companionTasks?.map(task => task.stageKey)).toEqual(['', 'make', '文档_%']);
    expect(after.companionTasks?.map(task => task.id)).toEqual(['task-6', 'task-7', 'task-8']);
    expect(after.companionTasks?.[0]).toEqual({ id: 'task-6', courseId: 'course', studentId: 'student', stageKey: '',
      title: 'Title 6', companionId: 'member-6', evidenceIds: ['evidence-6'], kind: 'formal-action', status: 'saved',
      request: 'Request 6', result: 'Result 6', error: 'Retained diagnostic 6',
      createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString() });
    expect(filtered.findTasks).toHaveBeenCalledWith({ where: { conversation: { participation: { instanceId: 'course' } },
      ...(student ? { createdById: student } : {}), input: { path: ['legacy', 'stageKey'], string_starts_with: '' } } });
    await expect(filtered.findTasks.mock.results[0].value).resolves.toHaveLength(3);
  });
});

beforeEach(() => {
  vi.resetAllMocks(); reads.scope.mockResolvedValue([{ matchesOffering: true }]);
});
describe('current narrow companion thread ownership', () => {
  it('binds course/student in one fresh read and avoids nested ownership materialization or a transaction', async () => {
    const course = 'course" OR true --'; const student = "student' OR true --";
    expect(await getCompanionThread(course, student, 'make')).toBeUndefined();
    expect(reads.scope).toHaveBeenCalledOnce();
    expect(reads.scope.mock.calls[0].slice(1)).toEqual([course, student]);
    const query = (reads.scope.mock.calls[0][0] as TemplateStringsArray).join('');
    expect(query).not.toContain(course); expect(query).not.toContain(student);
    expect(reads.nestedParticipation).not.toHaveBeenCalled(); expect(reads.transaction).not.toHaveBeenCalled();
    expect(reads.thread).toHaveBeenCalledWith({ where: { id: companionThreadId(course, student, 'make') },
      include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
  });

  it.each([['missing participation', []], ['different offering', [{ matchesOffering: false }]]])(
    'retains the same scope error for %s before reading any thread', async (_, result) => {
      reads.scope.mockResolvedValue(result);
      const failure = await getCompanionThread('course', 'student', 'make').catch(error => error);
      expect(failure).toBeInstanceOf(PlatformError);
      expect(failure).toMatchObject({ code: 'STUDENT_SCOPE_MISMATCH', status: 403, message: '协作记录不属于该课堂' });
      expect(reads.thread).not.toHaveBeenCalled(); expect(reads.transaction).not.toHaveBeenCalled();
    },
  );

  it('does not cache an earlier successful ownership check', async () => {
    await getCompanionThread('course', 'student', 'make');
    reads.scope.mockResolvedValueOnce([{ matchesOffering: false }]);
    await expect(getCompanionThread('course', 'student', 'make')).rejects.toMatchObject({ code: 'STUDENT_SCOPE_MISMATCH' });
    expect(reads.scope).toHaveBeenCalledTimes(2); expect(reads.thread).toHaveBeenCalledOnce();
  });

  it('keeps every ordered message, original text, private/hidden metadata and opening timestamp for caller filtering', async () => {
    const time = timestamp.toISOString(); const id = companionThreadId('course', 'student', 'make');
    reads.thread.mockResolvedValue({ id, metadata: { openingSentAt: time }, createdAt: timestamp, updatedAt: timestamp,
      messages: [
        { id: 'a', role: 'system', content: 'Teacher evidence', createdAt: timestamp,
          metadata: { visibility: 'teacher-only', legacyRole: 'system-trigger' } },
        { id: 'b', role: 'user', content: 'Retained student original', createdAt: timestamp,
          metadata: { hiddenFromStudentAt: time, excludedFromAiAt: time } },
        { id: 'c', role: 'assistant', content: 'Retained agent response', createdAt: timestamp, metadata: {} },
      ] });
    const thread = await getCompanionThread('course', 'student', 'make');
    expect(thread).toMatchObject({ id, courseId: 'course', studentId: 'student', stageKey: 'make', openingSentAt: time,
      createdAt: time, updatedAt: time, messages: [
        { id: 'a', role: 'system-trigger', content: 'Teacher evidence', visibility: 'teacher-only', createdAt: time },
        { id: 'b', role: 'student', content: 'Retained student original', visibility: 'student-and-teacher', hiddenFromStudentAt: time, excludedFromAiAt: time },
        { id: 'c', role: 'agent', content: 'Retained agent response', visibility: 'student-and-teacher' },
      ] });
    expect(reads.thread.mock.calls[0][0].include.messages.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('propagates a failed live relationship query without reading or allowing a thread', async () => {
    const failure = Error('database read unavailable'); reads.scope.mockRejectedValueOnce(failure);
    await expect(getCompanionThread('course', 'student', 'make')).rejects.toBe(failure);
    expect(reads.thread).not.toHaveBeenCalled();
  });
});

describe('request-local companion history pair', () => {
  const keys = ['ai-code-collaboration:make:python', 'ai-code-comments:make:python'] as const;
  const row = (student: string, stageKey: string) => ({
    id: companionThreadId('course', student, stageKey), userId: student,
    metadata: { openingSentAt: timestamp.toISOString() }, createdAt: timestamp, updatedAt: timestamp,
    messages: [
      { id: 'a', role: 'system', content: 'Original teacher evidence', createdAt: timestamp,
        metadata: { legacyRole: 'system-trigger', visibility: 'teacher-only' } },
      { id: 'b', role: 'assistant', content: 'Original answer', createdAt: timestamp,
        metadata: { hiddenFromStudentAt: timestamp.toISOString(), excludedFromAiAt: timestamp.toISOString() } },
    ],
  });

  it('reads the exact two server-derived IDs after one live check, maps unordered rows and preserves full projection', async () => {
    const first = row('student', keys[0]); const second = row('student', keys[1]);
    reads.pair.mockResolvedValue([second, first]);
    const pair = await getCompanionThreadPair('course', 'student', keys);
    expect(reads.scope).toHaveBeenCalledOnce();
    expect(reads.scope.mock.calls[0].slice(1)).toEqual(['course', 'student']);
    expect(reads.pair).toHaveBeenCalledWith({ where: { id: { in: [first.id, second.id] } },
      include: { messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    expect(reads.scope.mock.invocationCallOrder[0]).toBeLessThan(reads.pair.mock.invocationCallOrder[0]);
    reads.thread.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    expect(pair).toEqual([await getCompanionThread('course', 'student', keys[0]),
      await getCompanionThread('course', 'student', keys[1])]);
    expect(pair[0]?.messages).toHaveLength(2);
    expect(pair[0]?.messages[0]).toMatchObject({ content: 'Original teacher evidence', visibility: 'teacher-only' });
    expect(pair[0]?.messages[1]).toMatchObject({ hiddenFromStudentAt: timestamp.toISOString(), excludedFromAiAt: timestamp.toISOString() });
    expect(reads.transaction).not.toHaveBeenCalled();
  });

  it.each([[[]], [[row('student', keys[0])]], [[row('student', keys[1])]]])('retains absent thread slots without inventing history: %j', async rows => {
    reads.pair.mockResolvedValue(rows);
    const pair = await getCompanionThreadPair('course', 'student', keys);
    expect(pair.map(thread => thread?.id)).toEqual(keys.map(key => rows.find(item => item.id === companionThreadId('course', 'student', key))?.id));
    expect(reads.scope).toHaveBeenCalledOnce();
  });

  it('binds each student separately and does not reuse ownership after membership changes', async () => {
    reads.pair.mockResolvedValueOnce([row('student', keys[0])]).mockResolvedValueOnce([row('other', keys[1])]);
    const first = await getCompanionThreadPair('course', 'student', keys);
    const other = await getCompanionThreadPair('course', 'other', keys);
    expect(first.map(thread => thread?.studentId)).toEqual(['student', undefined]);
    expect(other.map(thread => thread?.studentId)).toEqual([undefined, 'other']);
    expect(reads.pair.mock.calls[1][0].where.id.in).toEqual(keys.map(key => companionThreadId('course', 'other', key)));
    reads.scope.mockResolvedValueOnce([]);
    await expect(getCompanionThreadPair('course', 'student', keys)).rejects.toMatchObject({ code: 'STUDENT_SCOPE_MISMATCH', status: 403 });
    expect(reads.pair).toHaveBeenCalledTimes(2);
  });

  it('rejects changed offering and failed live ownership before either history read', async () => {
    reads.scope.mockResolvedValueOnce([{ matchesOffering: false }]);
    await expect(getCompanionThreadPair('course', 'student', keys)).rejects.toMatchObject({ code: 'STUDENT_SCOPE_MISMATCH', status: 403 });
    const failure = Error('ownership unavailable'); reads.scope.mockRejectedValueOnce(failure);
    await expect(getCompanionThreadPair('course', 'student', keys)).rejects.toBe(failure);
    expect(reads.pair).not.toHaveBeenCalled();
  });
});
