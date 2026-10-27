// @vitest-environment node
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn(), execute: vi.fn(), active: 0, commits: 0 }));
vi.mock('@/lib/db/client', () => ({ prisma: { $transaction: mock.transaction } }));
import { CourseAdmissionTimeoutError, hasCourseMutationAdmission, runMutationTransaction, tryCourseMutationAdmission, tryPersonalMutationAdmission, tryPersonalCourseMutationAdmission, tryPersonalCourseRowMutationAdmission } from './transaction-retry';
import { lockProjectedCourse } from './session-repository';
import { courseAdmissionAttempts, courseAdmissionBusy, courseAdmissionWaiting, courseAdmissionQueued, courseAdmissionLocalActive, courseAdmissionQueueRejected } from '../observability/course-admission';
import { collectProgressTimings, progressServerTimings, type ProgressTimingSpan } from '../observability/progress-request-timing';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  mock.query.mockReset(); mock.execute.mockReset(); mock.transaction.mockReset(); mock.active = 0; mock.commits = 0;
  courseAdmissionAttempts.reset(); courseAdmissionBusy.reset(); courseAdmissionWaiting.set(0); courseAdmissionQueued.set(0); courseAdmissionLocalActive.set(0); courseAdmissionQueueRejected.reset();
  mock.transaction.mockImplementation(async callback => {
    mock.active++;
    try { const result = await callback({ $queryRaw: mock.query, $executeRaw: mock.execute }); mock.commits++; return result; }
    finally { mock.active--; }
  });
});
afterEach(() => { expect(globalThis.__openPblCourseMutationQueuesV2?.size ?? 0).toBe(0); vi.useRealTimers(); vi.restoreAllMocks(); });

it('leaves teacher and ordinary transactions on the original blocking-lock path', async () => {
  const operation = vi.fn().mockResolvedValue('teacher');
  expect(await runMutationTransaction(operation)).toBe('teacher');
  expect(mock.query).not.toHaveBeenCalled();
  expect(mock.execute).not.toHaveBeenCalled();
  expect(mock.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ maxWait: 5000, timeout: 10000 }));
});

it('releases failed admissions and admits a writer after more than five contentions', async () => {
  let attempts = 0;
  mock.query.mockImplementation(async () => [{ acquired: ++attempts > 7 }]);
  const operation = vi.fn().mockResolvedValue('saved');
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course' });
  await vi.runAllTimersAsync();
  expect(await task).toBe('saved');
  expect(attempts).toBe(8);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(1);
  expect(mock.active).toBe(0);
  expect(mock.query.mock.calls[0][1]).toBe('v2-course:course');
  expect((await courseAdmissionAttempts.get()).values[0].value).toBe(8);
  expect((await courseAdmissionBusy.get()).values[0].value).toBe(7);
  expect((await courseAdmissionWaiting.get()).values[0].value).toBe(0);
});

it('does not consume deadlock retries while waiting for admission', async () => {
  let tries = 0; let writes = 0;
  mock.query.mockImplementation(async () => [{ acquired: ++tries > 6 }]);
  const operation = vi.fn(async () => {
    if (++writes < 5) throw new Prisma.PrismaClientKnownRequestError('deadlock', { code: 'P2034', clientVersion: 'test' });
    return 'saved';
  });
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course' });
  await vi.runAllTimersAsync();
  expect(await task).toBe('saved');
  expect(writes).toBe(5);
});

it.each([0, 0.5, 0.9999])('bounds continuous contention within the deadline (jitter=%s) without invoking the writer', async jitter => {
  vi.spyOn(Math, 'random').mockReturnValue(jitter);
  mock.query.mockResolvedValue([{ acquired: false }]);
  const operation = vi.fn();
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course' }).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await task).toBeInstanceOf(CourseAdmissionTimeoutError);
  // The production guard refuses another transaction with <3ms remaining.
  // Jitter can therefore exhaust usable budget 0–2ms before the deadline;
  // assert the strict upper bound, not an exact wake-up at 10000ms.
  expect(performance.now()).toBeGreaterThanOrEqual(9998);
  expect(performance.now()).toBeLessThanOrEqual(10000);
  expect(operation).not.toHaveBeenCalled();
  expect(mock.commits).toBe(0);
  const budgets = mock.transaction.mock.calls.map(call => call[1].timeout);
  expect(budgets.at(-1)).toBeLessThan(budgets[0]);
});

it('returns a domain timeout error and rolls back a callback that outlives its budget', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  const error = new Error('retryable domain error');
  const task = runMutationTransaction(async () => {
    await new Promise(resolve => setTimeout(resolve, 10001));
    return 'late';
  }, { lowPriorityCourseId: 'course', admissionTimeoutError: () => error }).catch(value => value);
  await vi.runAllTimersAsync();
  expect(await task).toBe(error);
  expect(mock.commits).toBe(0);
});

it('preserves nonretryable CAS and ownership errors without replaying the writer', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  const error = new Error('DRAFT_VERSION_CONFLICT');
  const operation = vi.fn().mockRejectedValue(error);
  await expect(runMutationTransaction(operation, { lowPriorityCourseId: 'course' })).rejects.toBe(error);
  expect(operation).toHaveBeenCalledTimes(1);
});

it('lets deferred admission retain a pre-existing narrow-lock order and retries the entire preparation', async () => {
  let preparations = 0; let writes = 0;
  const acquisitions = [false, false, false, true];
  mock.query.mockImplementation(async () => [{ acquired: acquisitions.shift() }]);
  const task = runMutationTransaction(async tx => {
    preparations++;
    await tryCourseMutationAdmission(tx, 'course');
    writes++;
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync(); await task;
  expect(preparations).toBe(4);
  expect(writes).toBe(1);
  expect(mock.commits).toBe(1);
});

it('performs deferred preparation once per attempt without a separate preflight transaction', async () => {
  let attempts = 0;
  mock.query.mockImplementation(async () => [{ acquired: ++attempts > 6 }]);
  const operation = vi.fn(async tx => { await tryCourseMutationAdmission(tx, 'course'); return 'saved'; });
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync();
  expect(await task).toBe('saved');
  expect(mock.transaction).toHaveBeenCalledTimes(7);
  expect(mock.query).toHaveBeenCalledTimes(7);
  expect(operation).toHaveBeenCalledTimes(7);
});

it('includes pool wait and transaction execution in the same remaining deadline', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  await runMutationTransaction(async () => 'saved', { lowPriorityCourseId: 'course' });
  const options = mock.transaction.mock.calls[0][1];
  expect(options.maxWait).toBeGreaterThan(0);
  expect(options.timeout).toBeGreaterThan(0);
  expect(options.maxWait + options.timeout).toBeLessThanOrEqual(10000);
});

it('maps Prisma pool or interactive-transaction timeouts to the caller retryable error', async () => {
  mock.transaction.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('transaction timeout', { code: 'P2028', clientVersion: 'test' }));
  const error = new Error('COURSE_BUSY');
  await expect(runMutationTransaction(async () => 'saved', { lowPriorityCourseId: 'course', admissionTimeoutError: () => error })).rejects.toBe(error);
  expect(mock.transaction).toHaveBeenCalledTimes(1);
});

it('sets a LOCAL SQL timeout with nonblocking admission before calling the writer', async () => {
  mock.query.mockResolvedValueOnce([{ acquired: false }]).mockResolvedValue([{ acquired: true }]);
  const operation = vi.fn().mockResolvedValue('saved');
  const task = runMutationTransaction(operation, { lowPriorityCourseId: 'course' });
  await vi.runAllTimersAsync(); await task;
  expect(mock.execute).not.toHaveBeenCalled();
  expect(mock.query).toHaveBeenCalledTimes(2);
  for (const call of mock.query.mock.calls) {
    expect(call[0].join('')).toContain("set_config('statement_timeout', ");
    expect(call[0].join('')).toContain(', true)');
    expect(Number(call[2])).toBeLessThanOrEqual(1000);
  }
  expect(mock.query.mock.invocationCallOrder[1]).toBeLessThan(operation.mock.invocationCallOrder[0]);
});

it('maps server-side statement cancellation to retryable 503 without repeating an ambiguous business operation', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  const operation = vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('cancelled', { code: 'P2010', meta: { code: '57014' }, clientVersion: 'test' }));
  await expect(runMutationTransaction(operation, { lowPriorityCourseId: 'course' })).rejects.toBeInstanceOf(CourseAdmissionTimeoutError);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(0);
});

it('rolls back a busy personal try before attempting course admission or configuring SQL timeouts', async () => {
  mock.query.mockResolvedValueOnce([{ acquired: false }]).mockResolvedValue([{ acquired: true }]);
  const task = runMutationTransaction(async tx => {
    await tryPersonalMutationAdmission(tx, 'learning-events:course:student');
    await tryCourseMutationAdmission(tx, 'course');
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync(); await task;
  expect(mock.query.mock.calls.map(call => call[1])).toEqual(['learning-events:course:student', 'learning-events:course:student', 'v2-course:course']);
  expect(mock.execute).not.toHaveBeenCalled();
  expect(mock.query.mock.calls.filter(call => call[0].join('').includes('set_config'))).toHaveLength(1);
  expect(mock.commits).toBe(1);
});

it('reuses only the same transaction and course advisory lock, while retaining the row lock', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  await runMutationTransaction(async tx => {
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(true);
    expect(hasCourseMutationAdmission(tx, 'other-course')).toBe(false);
    await lockProjectedCourse(tx, 'course');
  }, { lowPriorityCourseId: 'course' });
  const queries = mock.query.mock.calls.map(call => call[0].join(''));
  expect(queries).toHaveLength(2);
  expect(queries[0]).toContain('pg_try_advisory_xact_lock');
  expect(queries[1]).toContain('FOR UPDATE');
  mock.query.mockClear();
  await runMutationTransaction(async tx => {
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(false);
    await lockProjectedCourse(tx, 'course');
  });
  expect(mock.query.mock.calls[0][0].join('')).toContain('pg_advisory_xact_lock');
  expect(mock.query.mock.calls[1][0].join('')).toContain('FOR UPDATE');
});

it('admits 40 same-course student writes FIFO without opening transactions for queued requests', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  let releaseFirst!: () => void, firstStarted!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const order: number[] = [];
  const tasks = Array.from({ length: 40 }, (_, index) => runMutationTransaction(async () => {
    order.push(index);
    if (!index) { firstStarted(); await gate; }
    return index;
  }, { lowPriorityCourseId: 'fifo-course' }));
  await started;
  expect(mock.transaction).toHaveBeenCalledTimes(1);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(39);
  expect((await courseAdmissionLocalActive.get()).values[0].value).toBe(1);
  releaseFirst();
  expect(await Promise.all(tasks)).toEqual(Array.from({ length: 40 }, (_, index) => index));
  expect(order).toEqual(Array.from({ length: 40 }, (_, index) => index));
  expect(mock.query).toHaveBeenCalledTimes(40);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(0);
  expect((await courseAdmissionLocalActive.get()).values[0].value).toBe(0);
});

it('lets teachers and other courses proceed while a local student queue is occupied', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  let release!: () => void, firstStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = runMutationTransaction(async () => { firstStarted(); await gate; }, { lowPriorityCourseId: 'course-a' });
  await started;
  expect(await runMutationTransaction(async () => 'teacher')).toBe('teacher');
  expect(await runMutationTransaction(async () => 'another course', { lowPriorityCourseId: 'course-b' })).toBe('another course');
  expect(mock.active).toBe(1);
  release(); await first;
});

it('correlates only the actual local permit wait with its request before opening a transaction', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  let release!: () => void, firstStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = runMutationTransaction(async () => { firstStarted(); await gate; }, { lowPriorityCourseId: 'timed-course' });
  await started;
  const spans: ProgressTimingSpan[] = [];
  let callbackStarted: number | undefined;
  const second = collectProgressTimings(performance.now(), spans, () => runMutationTransaction(async () => {
    callbackStarted = performance.now();
    return 'saved';
  }, { lowPriorityCourseId: 'timed-course' }));
  await vi.advanceTimersByTimeAsync(137);
  expect(mock.transaction).toHaveBeenCalledTimes(1);
  expect(spans).toEqual([]);
  release(); await first;
  expect(await second).toBe('saved');
  expect(spans).toEqual([
    { phase: 'course-queue', sequence: 0, startMs: 0, endMs: 137, outcome: 'ok' },
    { phase: 'course-admission', sequence: 1, startMs: 137, endMs: 137, outcome: 'ok' },
  ]);
  expect(callbackStarted).toBeGreaterThanOrEqual(spans[0].endMs);
  expect(mock.transaction).toHaveBeenCalledTimes(2);
});

it('counts local queue time in the same 10s deadline and removes expired waiters before they can write', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  let release!: () => void, firstStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = runMutationTransaction(async () => { firstStarted(); await gate; }, { lowPriorityCourseId: 'course' }).catch(error => error);
  await started;
  const write = vi.fn();
  const spans: ProgressTimingSpan[] = [];
  const queued = collectProgressTimings(performance.now(), spans,
    () => runMutationTransaction(write, { lowPriorityCourseId: 'course' })).catch(error => error);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await queued).toBeInstanceOf(CourseAdmissionTimeoutError);
  expect(write).not.toHaveBeenCalled();
  expect(mock.transaction).toHaveBeenCalledTimes(1);
  expect(spans).toEqual([{ phase: 'course-queue', sequence: 0, startMs: 0, endMs: 10000, outcome: 'error' }]);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(0);
  release(); expect(await first).toBeInstanceOf(CourseAdmissionTimeoutError);
  expect(globalThis.__openPblCourseMutationQueuesV2?.size).toBe(0);
  expect(await runMutationTransaction(async () => 'recovered', { lowPriorityCourseId: 'course' })).toBe('recovered');
});

it('rejects queue overflow explicitly without touching the database and cleans up after draining', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  let release!: () => void, firstStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const first = runMutationTransaction(async () => { firstStarted(); await gate; return 'first'; }, { lowPriorityCourseId: 'course' });
  await started;
  const tasks = Array.from({ length: 258 }, () => runMutationTransaction(async () => 'saved', { lowPriorityCourseId: 'course' }).catch(error => error));
  await Promise.resolve();
  expect((await courseAdmissionQueueRejected.get()).values[0].value).toBe(2);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(256);
  expect(mock.transaction).toHaveBeenCalledTimes(1);
  release(); await first;
  const results = await Promise.all(tasks);
  expect(results.filter(result => result === 'saved')).toHaveLength(256);
  expect(results.filter(result => result instanceof CourseAdmissionTimeoutError)).toHaveLength(2);
  expect((await courseAdmissionQueued.get()).values[0].value).toBe(0);
});

it('releases a local permit after a nonretryable business failure so the next writer can run', async () => {
  mock.query.mockResolvedValue([{ acquired: true }]);
  const first = runMutationTransaction(async () => { throw new Error('CAS_CONFLICT'); }, { lowPriorityCourseId: 'course' }).catch(error => error);
  const second = runMutationTransaction(async () => 'second', { lowPriorityCourseId: 'course' });
  expect(await first).toMatchObject({ message: 'CAS_CONFLICT' });
  expect(await second).toBe('second');
  expect(mock.commits).toBe(1);
});


it('combines heartbeat personal→course admission in one query before the separate row lock and fresh read', async () => {
  mock.query.mockResolvedValue([{ personal_acquired: true, acquired: true }]);
  await runMutationTransaction(async tx => {
    await tryPersonalCourseMutationAdmission(tx, 'learning-events:course:student', 'course');
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(true);
    await lockProjectedCourse(tx, 'course');
    await tx.$queryRaw`SELECT 'fresh context'`;
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  const calls = mock.query.mock.calls;
  expect(calls).toHaveLength(3);
  expect(calls[0].slice(1)).toEqual(['learning-events:course:student', 'v2-course:course', '1000']);
  expect(calls[0][0].join('')).toContain('WITH personal AS MATERIALIZED');
  expect(calls[0][0].join('')).toContain('CASE WHEN personal.acquired THEN pg_try_advisory_xact_lock');
  expect(calls[1][0].join('')).toContain('FOR UPDATE');
  expect(calls[2][0].join('')).toContain('fresh context');
  expect((await courseAdmissionAttempts.get()).values[0].value).toBe(2);
});

it.each([false, true])('rolls back combined busy admission (personal acquired=%s) before retrying', async personal_acquired => {
  mock.query.mockResolvedValueOnce([{ personal_acquired, acquired: false }]).mockResolvedValue([{ personal_acquired: true, acquired: true }]);
  const write = vi.fn();
  const task = runMutationTransaction(async tx => {
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(false);
    await tryPersonalCourseMutationAdmission(tx, 'learning-events:course:student', 'course');
    write();
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync(); await task;
  expect(mock.transaction).toHaveBeenCalledTimes(2); expect(mock.query).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledTimes(1); expect(mock.commits).toBe(1); expect(mock.active).toBe(0);
  expect((await courseAdmissionAttempts.get()).values[0].value).toBe(personal_acquired ? 4 : 3);
});

it('combines learning personal, course and row locks in one ordered statement before a separate fresh read', async () => {
  mock.query.mockResolvedValue([{ personal_acquired: true, acquired: true }]);
  await runMutationTransaction(async tx => {
    await tryPersonalCourseRowMutationAdmission(tx, 'learning-events:course:student', 'course');
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(true);
    await tx.$queryRaw`SELECT 'fresh context after all locks'`;
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  expect(mock.query).toHaveBeenCalledTimes(2);
  const [admission, context] = mock.query.mock.calls;
  expect(admission.slice(1)).toEqual(['1000', 'learning-events:course:student', 'v2-course:course', 'course']);
  const sql = admission[0].join('');
  expect(sql).toContain('CASE WHEN personal.acquired THEN pg_try_advisory_xact_lock');
  expect(sql).toContain('WHERE course.acquired AND ci.id =');
  expect(sql).toContain('FOR UPDATE OF ci NOWAIT');
  expect(sql.indexOf('settings AS MATERIALIZED')).toBeLessThan(sql.indexOf('personal AS MATERIALIZED'));
  expect(sql.indexOf('personal AS MATERIALIZED')).toBeLessThan(sql.indexOf('course AS MATERIALIZED'));
  expect(sql.indexOf('course AS MATERIALIZED')).toBeLessThan(sql.indexOf('locked AS MATERIALIZED'));
  expect(context[0].join('')).toContain('fresh context after all locks');
  expect((await courseAdmissionAttempts.get()).values[0].value).toBe(2);
});

it.each([false, true])('rolls back busy learning admission before reading context (personal acquired=%s)', async personal_acquired => {
  mock.query.mockResolvedValueOnce([{ personal_acquired, acquired: false }]).mockResolvedValue([{ personal_acquired: true, acquired: true }]);
  const read = vi.fn();
  const task = runMutationTransaction(async tx => {
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(false);
    await tryPersonalCourseRowMutationAdmission(tx, 'learning-events:course:student', 'course');
    read();
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync(); await task;
  expect(mock.transaction).toHaveBeenCalledTimes(2);
  expect(mock.query).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(1);
  expect(mock.active).toBe(0);
});

it('rolls back a learning row NOWAIT conflict and retries with a new transaction before business reads', async () => {
  const rowBusy = new Prisma.PrismaClientKnownRequestError('row is busy', { code: 'P2010', clientVersion: 'test', meta: { code: '55P03' } });
  mock.query.mockRejectedValueOnce(rowBusy).mockResolvedValue([{ personal_acquired: true, acquired: true }]);
  const transactions = new Set<Prisma.TransactionClient>();
  const read = vi.fn();
  const task = runMutationTransaction(async tx => {
    transactions.add(tx);
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(false);
    await tryPersonalCourseRowMutationAdmission(tx, 'personal', 'course');
    read();
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync(); await task;
  expect(transactions.size).toBe(2);
  expect(read).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(1);
  expect((await courseAdmissionBusy.get()).values[0].value).toBe(1);
  expect((await courseAdmissionAttempts.get()).values[0].value).toBe(4);
});

it('does not treat a later business row-lock error as retryable learning admission', async () => {
  mock.query.mockResolvedValue([{ personal_acquired: true, acquired: true }]);
  const failure = new Prisma.PrismaClientKnownRequestError('business statement failed', { code: 'P2010', clientVersion: 'test', meta: { code: '55P03' } });
  await expect(runMutationTransaction(async tx => {
    await tryPersonalCourseRowMutationAdmission(tx, 'personal', 'course');
    throw failure;
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true })).rejects.toBe(failure);
  expect(mock.transaction).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(0);
});

it('keeps non-contention failures from the combined learning lock statement unchanged', async () => {
  const failure = new Prisma.PrismaClientKnownRequestError('permission denied', { code: 'P2010', clientVersion: 'test', meta: { code: '42501' } });
  mock.query.mockRejectedValue(failure);
  const read = vi.fn();
  await expect(runMutationTransaction(async tx => {
    await tryPersonalCourseRowMutationAdmission(tx, 'personal', 'course');
    read();
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true })).rejects.toBe(failure);
  expect(mock.transaction).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(0);
  expect(read).not.toHaveBeenCalled();
});

it('preserves the remaining statement budget for combined learning row admission', async () => {
  mock.query.mockResolvedValue([{ personal_acquired: true, acquired: true }]);
  await runMutationTransaction(async tx => {
    await vi.advanceTimersByTimeAsync(9500);
    await tryPersonalCourseRowMutationAdmission(tx, 'personal', 'course');
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  expect(mock.query.mock.calls[0].slice(1)).toEqual(['500', 'personal', 'v2-course:course', 'course']);
  expect(mock.commits).toBe(1);
});

it.each([0, 0.5, 0.9999])('bounds combined heartbeat contention within the original 10s budget (jitter=%s) with no writes', async jitter => {
  vi.spyOn(Math, 'random').mockReturnValue(jitter);
  mock.query.mockResolvedValue([{ personal_acquired: true, acquired: false }]);
  const write = vi.fn();
  const task = runMutationTransaction(async tx => {
    await tryPersonalCourseMutationAdmission(tx, 'learning-events:course:student', 'course'); write();
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true }).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await task).toBeInstanceOf(CourseAdmissionTimeoutError);
  // The production guard refuses another transaction with <3ms remaining.
  // Jitter can therefore exhaust usable budget 0–2ms before the deadline;
  // assert the strict upper bound, not an exact wake-up at 10000ms.
  expect(performance.now()).toBeGreaterThanOrEqual(9998);
  expect(performance.now()).toBeLessThanOrEqual(10000); expect(write).not.toHaveBeenCalled(); expect(mock.commits).toBe(0);
  expect(Number(mock.query.mock.calls.at(-1)?.[3])).toBeLessThan(1000);
});

it('shares exact transaction admission across independently evaluated modules without skipping another transaction or course lock', async () => {
  vi.resetModules();
  const other = await import('./transaction-retry');
  expect(other.runMutationTransaction).not.toBe(runMutationTransaction);
  mock.query.mockResolvedValue([{ acquired: true }]);
  await other.runMutationTransaction(async tx => {
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(true);
    expect(hasCourseMutationAdmission(tx, 'another-course')).toBe(false);
    const unrelated = { $queryRaw: mock.query } as unknown as Prisma.TransactionClient;
    expect(hasCourseMutationAdmission(unrelated, 'course')).toBe(false);
    await lockProjectedCourse(tx, 'course');
  }, { lowPriorityCourseId: 'course' });
  expect(mock.query).toHaveBeenCalledTimes(2);
  expect(mock.query.mock.calls[1][0].join('')).toContain('FOR UPDATE');
});

it('a foreign helper respects the original transaction remaining statement budget', async () => {
  vi.resetModules();
  const other = await import('./transaction-retry');
  mock.query.mockResolvedValue([{ personal_acquired: true, acquired: true }]);
  await other.runMutationTransaction(async tx => {
    await vi.advanceTimersByTimeAsync(9500);
    await tryPersonalCourseMutationAdmission(tx, 'personal', 'course');
    expect(other.hasCourseMutationAdmission(tx, 'course')).toBe(true);
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  expect(mock.query.mock.calls[0].slice(1)).toEqual(['personal', 'v2-course:course', '500']);
  expect(mock.commits).toBe(1);
});

it('retries contention thrown by a foreign module while preserving fresh transaction identity', async () => {
  vi.resetModules();
  const other = await import('./transaction-retry');
  const transactions = new Set<Prisma.TransactionClient>();
  mock.query.mockResolvedValueOnce([{ personal_acquired: true, acquired: false }])
    .mockResolvedValue([{ personal_acquired: true, acquired: true }]);
  const write = vi.fn();
  const task = other.runMutationTransaction(async tx => {
    transactions.add(tx);
    expect(hasCourseMutationAdmission(tx, 'course')).toBe(false);
    await tryPersonalCourseMutationAdmission(tx, 'personal', 'course');
    write();
  }, { lowPriorityCourseId: 'course', deferCourseAdmission: true });
  await vi.runAllTimersAsync(); await task;
  expect(transactions.size).toBe(2); expect(write).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(1); expect(mock.active).toBe(0);
});

it('does not retry lookalike admission messages, incomplete codes or arbitrary objects', async () => {
  for (const error of [new Error('COURSE_ADMISSION_CONTENDED'),
    Object.assign(new Error(), { name: 'CourseAdmissionContended', code: 'OTHER' }),
    Object.assign(new Error(), { code: 'COURSE_ADMISSION_CONTENDED' }),
    { name: 'CourseAdmissionContended', code: 'COURSE_ADMISSION_CONTENDED' }]) {
    const operation = vi.fn().mockRejectedValue(error);
    await expect(runMutationTransaction(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  }
});

it('separates failed course admission query awaits, retry sleeps and successful admission in the same request', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  let attempts = 0;
  mock.query.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 7));
    return [{ acquired: ++attempts > 1 }];
  });
  const spans: ProgressTimingSpan[] = [];
  const value = { receipt: 'original receipt' };
  const operation = vi.fn().mockResolvedValue(value);
  const task = collectProgressTimings(performance.now(), spans,
    () => runMutationTransaction(operation, { lowPriorityCourseId: 'private-course-id' }));
  await vi.runAllTimersAsync();
  expect(await task).toBe(value);
  expect(operation).toHaveBeenCalledTimes(1);
  expect(mock.commits).toBe(1);
  expect(mock.active).toBe(0);
  expect(spans).toEqual([
    { phase: 'course-queue', sequence: 0, startMs: 0, endMs: 0, outcome: 'ok' },
    { phase: 'course-admission', sequence: 1, startMs: 0, endMs: 7, outcome: 'error' },
    { phase: 'course-admission-backoff', sequence: 2, startMs: 7, endMs: 17, outcome: 'ok' },
    { phase: 'course-admission', sequence: 3, startMs: 17, endMs: 24, outcome: 'ok' },
  ]);
  expect(progressServerTimings(spans).join()).not.toContain('private-course-id');
});

it('keeps separate and combined personal admission attempts distinct without changing their lock order', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  let attempt = 0;
  mock.query.mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 7));
    return [{ personal_acquired: true, acquired: ++attempt > 1 }];
  });
  const combined: ProgressTimingSpan[] = [];
  const task = collectProgressTimings(performance.now(), combined,
    () => runMutationTransaction(async tx => {
      await tryPersonalCourseMutationAdmission(tx, 'private-personal-key', 'course');
      return 'saved';
    }, { lowPriorityCourseId: 'course', deferCourseAdmission: true }));
  await vi.runAllTimersAsync();
  expect(await task).toBe('saved');
  expect(combined.map(({ phase, startMs, endMs, outcome }) => ({ phase, startMs, endMs, outcome }))).toEqual([
    { phase: 'course-queue', startMs: 0, endMs: 0, outcome: 'ok' },
    { phase: 'personal-course-admission', startMs: 0, endMs: 7, outcome: 'error' },
    { phase: 'course-admission-backoff', startMs: 7, endMs: 17, outcome: 'ok' },
    { phase: 'personal-course-admission', startMs: 17, endMs: 24, outcome: 'ok' },
  ]);
  const separate: ProgressTimingSpan[] = [];
  const next = collectProgressTimings(performance.now(), separate,
    () => runMutationTransaction(async tx => {
      await tryPersonalMutationAdmission(tx, 'private-personal-key');
      await tryCourseMutationAdmission(tx, 'course');
      return 'another receipt';
    }, { lowPriorityCourseId: 'course', deferCourseAdmission: true }));
  await vi.runAllTimersAsync();
  expect(await next).toBe('another receipt');
  expect(separate.map(({ phase, startMs, endMs, outcome }) => ({ phase, startMs, endMs, outcome }))).toEqual([
    { phase: 'course-queue', startMs: 0, endMs: 0, outcome: 'ok' },
    { phase: 'personal-admission', startMs: 0, endMs: 7, outcome: 'ok' },
    { phase: 'course-admission', startMs: 7, endMs: 14, outcome: 'ok' },
  ]);
  expect(combined).toHaveLength(4);
  expect(progressServerTimings([...combined, ...separate]).join()).not.toContain('private-personal-key');
});

it('reports database retry backoff separately while preserving the five-attempt limit and original failure', async () => {
  vi.spyOn(Math, 'random').mockReturnValue(0);
  const failure = new Prisma.PrismaClientKnownRequestError('private database detail', { code: 'P2034', clientVersion: 'test' });
  const operation = vi.fn().mockRejectedValue(failure);
  const spans: ProgressTimingSpan[] = [];
  const task = collectProgressTimings(performance.now(), spans,
    () => runMutationTransaction(operation)).catch(error => error);
  await vi.runAllTimersAsync();
  expect(await task).toBe(failure);
  expect(operation).toHaveBeenCalledTimes(5);
  expect(mock.commits).toBe(0);
  expect(mock.active).toBe(0);
  expect(spans).toEqual([
    { phase: 'transaction-retry-backoff', sequence: 0, startMs: 0, endMs: 10, outcome: 'ok' },
    { phase: 'transaction-retry-backoff', sequence: 1, startMs: 10, endMs: 30, outcome: 'ok' },
    { phase: 'transaction-retry-backoff', sequence: 2, startMs: 30, endMs: 70, outcome: 'ok' },
    { phase: 'transaction-retry-backoff', sequence: 3, startMs: 70, endMs: 150, outcome: 'ok' },
  ]);
  expect(progressServerTimings(spans).join()).not.toContain(failure.message);
});
