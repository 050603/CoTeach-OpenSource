import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StudentAiProgress } from '@/lib/session/types';
import { coalesceProgressWrite, progressBodyFingerprint } from './progress-inflight';

const identity = { courseId: 'course', actorId: 'student', sessionVersion: 1, requestId: 'request', bodyFingerprint: 'body' };
const progress: StudentAiProgress = { studentId: 'student', classroomId: 'classroom', currentSceneIndex: 0,
  totalScenes: 2, completedScenes: [], lastActiveAt: '2026-10-16T00:00:00.000Z', masteryLevel: 'not-started' };
function deferred() {
  let resolve!: (value: StudentAiProgress) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<StudentAiProgress>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => { vi.useRealTimers(); });

describe('pending progress replay coordinator', () => {
  it('shares only pending work and returns independent result objects, then consults the DB again', async () => {
    const gate = deferred(); const write = vi.fn(() => gate.promise);
    const first = coalesceProgressWrite(identity, write);
    const second = coalesceProgressWrite(identity, write);
    await Promise.resolve(); expect(write).toHaveBeenCalledOnce();
    gate.resolve(progress);
    const [a, b] = await Promise.all([first, second]);
    a.completedScenes.push('mutated');
    expect(b.completedScenes).toEqual([]); expect(progress.completedScenes).toEqual([]);
    await coalesceProgressWrite(identity, write);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it.each([
    { courseId: 'other' }, { actorId: 'other' }, { sessionVersion: 2 }, { requestId: 'other' }, { bodyFingerprint: 'changed' },
  ])('never shares a different scope or request: %s', async difference => {
    const gate = deferred(); const write = vi.fn(() => gate.promise);
    const first = coalesceProgressWrite(identity, write);
    const second = coalesceProgressWrite({ ...identity, ...difference }, write);
    await Promise.resolve(); expect(write).toHaveBeenCalledTimes(2);
    gate.resolve(progress); await Promise.all([first, second]);
  });

  it('uses the entire parsed original JSON while preserving array order and absent fields', () => {
    const body = { requestId: 'id', completedScenes: ['a', 'b'], metadata: { one: 1, two: null } };
    expect(progressBodyFingerprint(body)).toBe(progressBodyFingerprint({ metadata: { two: null, one: 1 }, completedScenes: ['a', 'b'], requestId: 'id' }));
    for (const changed of [{ ...body, ignoredField: true }, { ...body, completedScenes: ['b', 'a'] },
      { ...body, metadata: { one: 1 } }, { ...body, metadata: { one: '1', two: null } }]) {
      expect(progressBodyFingerprint(changed)).not.toBe(progressBodyFingerprint(body));
    }
  });

  it('cleans up synchronous and asynchronous failures without caching a rejection', async () => {
    const failure = new Error('write failed'); const gate = deferred();
    const first = coalesceProgressWrite(identity, () => gate.promise);
    const second = coalesceProgressWrite(identity, () => { throw new Error('must share'); });
    const outcomes = Promise.allSettled([first, second]); gate.reject(failure);
    expect(await outcomes).toEqual([{ status: 'rejected', reason: failure }, { status: 'rejected', reason: failure }]);
    await expect(coalesceProgressWrite(identity, () => { throw failure; })).rejects.toBe(failure);
    await expect(coalesceProgressWrite(identity, async () => progress)).resolves.toEqual(progress);
  });

  it('expires only the optimization and does not cancel old work or delete its replacement', async () => {
    vi.useFakeTimers(); const old = deferred(); const current = deferred();
    const first = coalesceProgressWrite(identity, () => old.promise);
    await vi.advanceTimersByTimeAsync(30_001);
    const write = vi.fn(() => current.promise);
    const replacement = coalesceProgressWrite(identity, write);
    old.resolve(progress); await first;
    const retry = coalesceProgressWrite(identity, write);
    await Promise.resolve(); expect(write).toHaveBeenCalledOnce();
    current.resolve(progress); await Promise.all([replacement, retry]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds entries and falls back to the existing write instead of rejecting or evicting a pending request', async () => {
    vi.useFakeTimers(); const gate = deferred();
    const entries = Array.from({ length: 512 }, (_, index) => coalesceProgressWrite({ ...identity, requestId: `capacity-${index}` }, () => gate.promise));
    const fallback = vi.fn(() => gate.promise);
    entries.push(coalesceProgressWrite({ ...identity, requestId: 'overflow' }, fallback));
    entries.push(coalesceProgressWrite({ ...identity, requestId: 'overflow' }, fallback));
    expect(fallback).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(512);
    gate.resolve(progress); await Promise.all(entries); expect(vi.getTimerCount()).toBe(0);
  });

  it('shares the same in-flight entry across isolated module evaluations', async () => {
    const gate = deferred(); const write = vi.fn(() => gate.promise);
    const first = coalesceProgressWrite(identity, write);
    vi.resetModules(); const other = await import('./progress-inflight');
    const second = other.coalesceProgressWrite(identity, write);
    await Promise.resolve(); expect(write).toHaveBeenCalledOnce();
    gate.resolve(progress); await Promise.all([first, second]);
  });
});
