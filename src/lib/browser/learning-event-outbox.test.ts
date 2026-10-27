import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LearningEvent } from '@/lib/session/types';
import { enqueueLearningWrite, learningWriteScopes, readLearningWrites } from './learning-outbox';

const send = vi.hoisted(() => vi.fn());
vi.mock('@/lib/learning-analytics/telemetry', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/learning-analytics/telemetry')>(), postLearningEvents: send,
}));
const event = (id: string, patch: Partial<LearningEvent> = {}): LearningEvent => ({
  id, idempotencyKey: `key-${id}`, courseId: 'course', studentId: 'student', stageKey: 'ai-learning',
  type: 'heartbeat', occurredAt: '2026-10-16T00:00:00.000Z', durationMs: 10000, ...patch,
});
const load = () => import('./learning-event-outbox');
beforeEach(() => { localStorage.clear(); vi.resetModules(); send.mockReset().mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('combines synchronous producers in one actor/course flight without changing any event', async () => {
  const { enqueueLearningEvent: enqueue, flushLearningEvents: flush } = await load();
  const a = event('scene'), b = event('resource', { type: 'resource-open' }), c = event('explanation', { type: 'knowledge_explanation_view' });
  enqueue(a); const first = flush('course', 'student'); enqueue(b); enqueue(c);
  expect(flush('course', 'student')).toBe(first);
  await first;
  expect(send).toHaveBeenCalledExactlyOnceWith({ courseId: 'course', studentId: 'student', events: [a, b, c] });
  expect(localStorage.length).toBe(0);
});

it('keeps in-flight bodies immutable and sends interleaved new facts only after ACK', async () => {
  const { enqueueLearningEvent: enqueue, flushLearningEvents: flush } = await load();
  let release!: () => void;
  send.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const original = event('first'); enqueue(original); const first = flush('course', 'student');
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  original.durationMs = 99999;
  enqueue(event('second')); expect(flush('course', 'student')).toBe(first);
  expect(send).toHaveBeenCalledTimes(1); release(); await first;
  expect(send.mock.calls.map(call => call[0].events)).toEqual([[event('first')], [event('second')]]);
});

it('replays the exact lost-ACK batch across reload before adding newer events', async () => {
  let api = await load();
  api.enqueueLearningEvent(event('original'));
  send.mockRejectedValueOnce(new Error('ACK lost after commit'));
  await expect(api.flushLearningEvents('course', 'student')).rejects.toThrow('ACK lost');
  const first = JSON.stringify(send.mock.calls[0][0]);
  vi.resetModules(); api = await load();
  api.enqueueLearningEvent(event('new-edit'));
  await api.flushLearningEvents('course', 'student');
  expect(JSON.stringify(send.mock.calls[1][0])).toBe(first);
  expect(send.mock.calls[0][1]).toBeUndefined();
  expect(send.mock.calls[1][1]).toEqual({ replay: true });
  expect(send.mock.calls[2][0].events).toEqual([event('new-edit')]);
  expect(send.mock.calls[2][1]).toBeUndefined();
  expect(localStorage.length).toBe(0);
});

it('replays both legacy source scopes without migration, and preserves other actors/progress/AI queues', async () => {
  enqueueLearningWrite('events:course:student:old-classroom', event('old-scene'), 'old-scene');
  enqueueLearningWrite('resource-events:course:student', event('old-resource'), 'old-resource');
  enqueueLearningWrite('events:course:other:classroom', event('foreign', { studentId: 'other' }), 'foreign');
  enqueueLearningWrite('events:other:student:classroom', event('other-course', { courseId: 'other' }), 'other-course');
  enqueueLearningWrite('progress:course:student:classroom', { requestId: 'progress' }, 'progress');
  enqueueLearningWrite('ai-events:course:student', { requestId: 'ai' }, 'ai');
  const before = localStorage.length;
  const { flushLearningEvents: flush } = await load();
  send.mockImplementationOnce(async () => {
    expect(readLearningWrites('events:course:student:old-classroom')).toHaveLength(1);
    expect(readLearningWrites('resource-events:course:student')).toHaveLength(1);
    throw new Error('offline');
  });
  await expect(flush('course', 'student')).rejects.toThrow('offline');
  expect(localStorage.length).toBe(before + 1); // checkpoint, no deleted legacy entries
  await flush('course', 'student');
  expect(send.mock.calls[1][0].events).toEqual([event('old-scene'), event('old-resource')]);
  expect(localStorage.length).toBe(4);
  expect(readLearningWrites('progress:course:student:classroom')).toHaveLength(1);
});

it('refuses foreign bodies even if someone put them under the selected legacy scope', async () => {
  enqueueLearningWrite('events:course:student:classroom', event('foreign', { studentId: 'other' }), 'foreign');
  const { flushLearningEvents: flush } = await load();
  await expect(flush('course', 'student')).rejects.toThrow('归属不一致');
  expect(send).not.toHaveBeenCalled(); expect(localStorage.length).toBe(1);
});

it('preserves the legacy reader order for same-millisecond writes and historical timestamp ties', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(100);
  const scope = 'events:course:student:classroom';
  enqueueLearningWrite(scope, event('z'), 'z');
  enqueueLearningWrite(scope, event('a'), 'a');
  expect(readLearningWrites(scope).map(entry => entry.createdAt)).toEqual([100, 101]);
  // Older externally persisted entries with equal times already used ID order.
  const prefix = `openpbl.learning-outbox.v1:${encodeURIComponent(scope)}:`;
  localStorage.setItem(`${prefix}b`, JSON.stringify({ id: 'b', createdAt: 101, value: event('b') }));
  const original = readLearningWrites<LearningEvent>(scope).map(entry => entry.value);
  const api = await load(); await api.flushLearningEvents('course', 'student');
  expect(send.mock.calls[0][0].events).toEqual(original);
  expect(original.map(event => event.id)).toEqual(['z', 'a', 'b']);
});

it('retains storage-failed events in order and retries after storage recovers', async () => {
  const { enqueueLearningEvent: enqueue, flushLearningEvents: flush } = await load();
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
  const first = event('first');
  expect(() => enqueue(first)).toThrow('无法暂存');
  first.durationMs = 99;
  expect(() => enqueue(event('second'))).toThrow('无法暂存');
  await expect(flush('course', 'student')).rejects.toThrow('无法暂存');
  expect(send).not.toHaveBeenCalled(); spy.mockRestore();
  await flush('course', 'student');
  expect(send.mock.calls[0][0].events).toEqual([event('first'), event('second')]);
});

it('does not send if the original batch checkpoint cannot be made durable', async () => {
  const api = await load(); api.enqueueLearningEvent(event('one'));
  const original = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.includes('learning-event-batch')) throw new Error('checkpoint quota');
    original.call(this, key, value);
  });
  await expect(api.flushLearningEvents('course', 'student')).rejects.toThrow('checkpoint quota');
  expect(send).not.toHaveBeenCalled(); spy.mockRestore();
  await api.flushLearningEvents('course', 'student'); expect(send).toHaveBeenCalledTimes(1);
});

it('retries a committed batch if removing ACKed storage fails, without dropping later edits', async () => {
  const api = await load(); api.enqueueLearningEvent(event('one'));
  const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('storage unavailable'); });
  await expect(api.flushLearningEvents('course', 'student')).rejects.toThrow('storage unavailable');
  spy.mockRestore(); api.enqueueLearningEvent(event('two'));
  await api.flushLearningEvents('course', 'student');
  expect(send.mock.calls.map(call => call[0].events)).toEqual([[event('one')], [event('one')], [event('two')]]);
});

it('rejects a changed body with an existing event ID without poisoning the original queue', async () => {
  const api = await load(); api.enqueueLearningEvent(event('one'));
  expect(() => api.enqueueLearningEvent(event('one', { durationMs: 2 }))).toThrow('标识已用于');
  await api.flushLearningEvents('course', 'student');
  expect(send.mock.calls[0][0].events).toEqual([event('one')]);
});

it('keeps the existing 20-event bound and original per-source sequence', async () => {
  const api = await load();
  for (let i = 0; i < 41; i++) api.enqueueLearningEvent(event(`event-${i}`));
  await api.flushLearningEvents('course', 'student');
  expect(send.mock.calls.map(call => call[0].events.length)).toEqual([20, 20, 1]);
  expect(send.mock.calls.flatMap(call => call[0].events.map((row: LearningEvent) => row.id))).toEqual(Array.from({ length: 41 }, (_, i) => `event-${i}`));
});

it('drains an event enqueued as the last completed flight releases its Web Lock', async () => {
  const api = await load(); let injected = false; let follow!: Promise<void>;
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, callback: () => Promise<void>) => {
    await callback();
    if (!injected) {
      injected = true;
      queueMicrotask(() => { api.enqueueLearningEvent(event('late')); follow = api.flushLearningEvents('course', 'student'); });
    }
  } } });
  api.enqueueLearningEvent(event('first')); await api.flushLearningEvents('course', 'student'); await follow;
  expect(send.mock.calls.map(call => call[0].events)).toEqual([[event('first')], [event('late')]]);
  expect(localStorage.length).toBe(0);
});

it('does not spin or reset identities after a failed send', async () => {
  const api = await load(); api.enqueueLearningEvent(event('one')); send.mockRejectedValue(new Error('offline'));
  await expect(api.flushLearningEvents('course', 'student')).rejects.toThrow('offline');
  await Promise.resolve(); expect(send).toHaveBeenCalledTimes(1);
  expect(learningWriteScopes()).toHaveLength(2);
});

it('serializes independently loaded producers sharing browser storage with a scope Web Lock', async () => {
  const locks = new Map<string, Promise<void>>();
  vi.stubGlobal('navigator', { locks: { request: (name: string, callback: () => Promise<void>) => {
    const flight = (locks.get(name) ?? Promise.resolve()).then(callback);
    locks.set(name, flight.catch(() => undefined));
    return flight;
  } } });
  const first = await load(); vi.resetModules(); const second = await load();
  first.enqueueLearningEvent(event('scene'));
  second.enqueueLearningEvent(event('resource', { type: 'resource-open' }));
  await Promise.all([first.flushLearningEvents('course', 'student'), second.flushLearningEvents('course', 'student')]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0].events).toEqual([event('scene'), event('resource', { type: 'resource-open' })]);
  expect(localStorage.length).toBe(0);
});

it('applies review coalescing to an existing flight and gathers new facts until its fixed ACK deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const api = await load();
  let release!: () => void;
  send.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  api.enqueueLearningEvent(event('first'));
  const flight = api.flushLearningEvents('course', 'student');
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
  api.enqueueLearningEvent(event('during-send'));
  expect(api.flushLearningEvents('course', 'student', { coalesce: true })).toBe(flight);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(1);
  expect(learningWriteScopes().some(scope => scope.startsWith('learning-event-batch:'))).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  api.enqueueLearningEvent(event('during-window'));
  api.flushLearningEvents('course', 'student', { coalesce: true });
  await vi.advanceTimersByTimeAsync(499);
  expect(send).toHaveBeenCalledTimes(1);
  api.enqueueLearningEvent(event('near-deadline'));
  api.flushLearningEvents('course', 'student', { coalesce: true });
  await vi.advanceTimersByTimeAsync(1);
  await flight;
  expect(send.mock.calls.map(call => call[0].events)).toEqual([
    [event('first')], [event('during-send'), event('during-window'), event('near-deadline')],
  ]);
  await vi.advanceTimersByTimeAsync(1); // jsdom queues storage notifications for the next tick.
  expect(vi.getTimerCount()).toBe(0);
  expect(localStorage.length).toBe(0);
});

it('remembers ACK time between flights while sending the first review batch immediately and staying idle without facts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const api = await load();
  api.enqueueLearningEvent(event('first'));
  await api.flushLearningEvents('course', 'student', { coalesce: true });
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(0);
  await api.flushLearningEvents('course', 'student', { coalesce: true });
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  api.enqueueLearningEvent(event('next-flight'));
  const next = api.flushLearningEvents('course', 'student', { coalesce: true });
  await vi.advanceTimersByTimeAsync(999);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await next;
  expect(send.mock.calls[1][0].events).toEqual([event('next-flight')]);
  await vi.advanceTimersByTimeAsync(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('isolates review windows and forced drains by both student and course', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const api = await load();
  api.enqueueLearningEvent(event('seed'));
  await api.flushLearningEvents('course', 'student', { coalesce: true });
  api.enqueueLearningEvent(event('waiting'));
  const waiting = api.flushLearningEvents('course', 'student', { coalesce: true });
  await vi.advanceTimersByTimeAsync(0);
  api.enqueueLearningEvent(event('other-student', { studentId: 'other' }));
  await api.flushLearningEvents('course', 'other', { coalesce: true });
  api.enqueueLearningEvent(event('other-course', { courseId: 'other' }));
  await api.flushLearningEvents('other', 'student');
  expect(send.mock.calls.map(call => call[0].events)).toEqual([[event('seed')], [event('other-student', { studentId: 'other' })], [event('other-course', { courseId: 'other' })]]);
  await vi.advanceTimersByTimeAsync(1500);
  await waiting;
  expect(send.mock.calls[3][0].events).toEqual([event('waiting')]);
});

it('cancels a review wait when the normal flush forces an immediate drain', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const api = await load();
  api.enqueueLearningEvent(event('seed'));
  await api.flushLearningEvents('course', 'student');
  api.enqueueLearningEvent(event('waiting'));
  const flight = api.flushLearningEvents('course', 'student', { coalesce: true });
  await vi.advanceTimersByTimeAsync(200);
  api.enqueueLearningEvent(event('before-unmount'));
  expect(api.flushLearningEvents('course', 'student')).toBe(flight);
  await flight;
  expect(send.mock.calls[1][0].events).toEqual([event('waiting'), event('before-unmount')]);
  await vi.advanceTimersByTimeAsync(1);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['scene-complete', 'stage-goal-complete'] as const)('drains every preceding batch through %s despite later coalescing calls', async (type) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const api = await load();
  api.enqueueLearningEvent(event('seed'));
  await api.flushLearningEvents('course', 'student');
  const preceding = Array.from({ length: 45 }, (_, index) => event(`before-${index}`));
  preceding.forEach(item => api.enqueueLearningEvent(item));
  const critical = event('completion', { type });
  api.enqueueLearningEvent(critical);
  const following = Array.from({ length: 25 }, (_, index) => event(`after-${index}`));
  following.forEach(item => api.enqueueLearningEvent(item));
  send.mockImplementation(async () => { api.flushLearningEvents('course', 'student', { coalesce: true }); });
  const flight = api.flushLearningEvents('course', 'student', { coalesce: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(send.mock.calls.slice(1).map(call => call[0].events.length)).toEqual([20, 20, 20]);
  expect(send.mock.calls[3][0].events).toContainEqual(critical);
  expect(send.mock.calls.slice(1).flatMap(call => call[0].events).slice(0, 46)).toEqual([...preceding, critical]);
  await vi.advanceTimersByTimeAsync(1499);
  expect(send).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1);
  await flight;
  expect(send.mock.calls.slice(1).flatMap(call => call[0].events)).toEqual([...preceding, critical, ...following]);
  expect(send.mock.calls.slice(1).map(call => call[0].events.length)).toEqual([20, 20, 20, 11]);
  expect(localStorage.length).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('wakes a review window when a completion is appended beyond the first batch', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const api = await load();
  api.enqueueLearningEvent(event('seed'));
  await api.flushLearningEvents('course', 'student');
  for (let index = 0; index < 25; index++) api.enqueueLearningEvent(event(`waiting-${index}`));
  const flight = api.flushLearningEvents('course', 'student', { coalesce: true });
  await vi.advanceTimersByTimeAsync(500);
  expect(send).toHaveBeenCalledTimes(1);
  const critical = event('completion', { type: 'scene-complete' });
  api.enqueueLearningEvent(critical);
  api.flushLearningEvents('course', 'student', { coalesce: true });
  await vi.advanceTimersByTimeAsync(0);
  await flight;
  expect(send.mock.calls.slice(1).map(call => call[0].events.length)).toEqual([20, 6]);
  expect(send.mock.calls[2][0].events).toContainEqual(critical);
  expect(performance.now()).toBe(500);
  expect(localStorage.length).toBe(0);
});

it('replays an immutable checkpoint immediately before applying a review window to newer facts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const api = await load();
  api.enqueueLearningEvent(event('seed'));
  await api.flushLearningEvents('course', 'student');
  api.enqueueLearningEvent(event('lost-ack'));
  send.mockRejectedValueOnce(new Error('ACK lost'));
  await expect(api.flushLearningEvents('course', 'student')).rejects.toThrow('ACK lost');
  const original = JSON.stringify(send.mock.calls[1][0]);
  api.enqueueLearningEvent(event('newer'));
  const flight = api.flushLearningEvents('course', 'student', { coalesce: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(send).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(send.mock.calls[2][0])).toBe(original);
  expect(send.mock.calls[2][1]).toEqual({ replay: true });
  await vi.advanceTimersByTimeAsync(1500);
  await flight;
  expect(send.mock.calls[3][0].events).toEqual([event('newer')]);
  expect(localStorage.length).toBe(0);
});
