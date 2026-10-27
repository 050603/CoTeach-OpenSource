import { describe, expect, it } from 'vitest';

import {
  createProactiveReviewCapacity,
  ProactiveReviewCapacityError,
} from './proactive-review-capacity';

describe('proactive document review capacity', () => {
  it('rejects overflow immediately and frees the slot after completion', async () => {
    const capacity = createProactiveReviewCapacity(1, 42_000);
    let release!: () => void;
    const first = capacity.run(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

    await expect(capacity.run(async () => 'overflow')).rejects.toEqual(
      expect.objectContaining<Partial<ProactiveReviewCapacityError>>({
        name: 'ProactiveReviewCapacityError',
        retryAfterMs: 42_000,
      }),
    );
    expect(capacity.snapshot()).toEqual({ active: 1, limit: 1 });

    release();
    await first;
    await expect(capacity.run(async () => 'available')).resolves.toBe('available');
    expect(capacity.snapshot()).toEqual({ active: 0, limit: 1 });
  });
});


// These exercise the actual priority context/pool, with controlled model completion.
import { createClassroomAiCapacity, BackgroundAiCapacityError, withBackgroundAiPriority } from '@/lib/llm/classroom-capacity';
import { LlmRateLimitError } from '@/lib/llm/errors';
import { resolveProactiveReviewConcurrency } from './proactive-review-capacity';
import { vi } from 'vitest';

describe('30-student foreground/background coexistence', () => {
  it('admits at most eight of 30 background calls while all 30 interactive calls start', async () => {
    expect(resolveProactiveReviewConcurrency({ NODE_ENV: 'test' })).toBe(8);
    expect(resolveProactiveReviewConcurrency({ NODE_ENV: 'test', PROACTIVE_REVIEW_LLM_CONCURRENCY: '2' })).toBe(2);
    const pool = createClassroomAiCapacity(40);
    const background = createProactiveReviewCapacity(8);
    const releases: Array<() => void> = [];
    const hold = () => new Promise<void>(resolve => releases.push(resolve));
    const tasks = Array.from({ length: 30 }, () => background.run(() => pool.run(hold)).then(() => 'ok', error => error));
    try {
      await vi.waitFor(() => expect(pool.snapshot().active).toBe(8));
      expect(background.snapshot()).toEqual({ active: 8, limit: 8 });
      const foreground = Array.from({ length: 30 }, () => pool.run(hold));
      await vi.waitFor(() => expect(pool.snapshot().active).toBe(38));
      expect(pool.snapshot().pending).toBe(0);
      releases.forEach(release => release());
      await Promise.all(foreground);
      const outcomes = await Promise.all(tasks);
      expect(outcomes.filter(result => result === 'ok')).toHaveLength(8);
      expect(outcomes.filter(result => result instanceof ProactiveReviewCapacityError)).toHaveLength(22);
    } finally { releases.forEach(release => release()); await Promise.all(tasks); }
    expect(background.snapshot().active).toBe(0);
  });
  it('never overtakes queued foreground work and does not relabel provider throttling', async () => {
    const pool = createClassroomAiCapacity(2);
    const release: Array<() => void> = [];
    const running = [pool.run(() => new Promise<void>(r => release.push(r))), pool.run(() => new Promise<void>(r => release.push(r)))];
    await vi.waitFor(() => expect(pool.snapshot().active).toBe(2));
    const foreground = vi.fn(async () => 'foreground');
    const queued = pool.run(foreground);
    await expect(withBackgroundAiPriority(() => pool.run(async () => 'background'))).rejects.toBeInstanceOf(BackgroundAiCapacityError);
    release[0](); await expect(queued).resolves.toBe('foreground');
    expect(foreground).toHaveBeenCalledOnce();
    release[1](); await Promise.all(running);
    const background = createProactiveReviewCapacity(8);
    const providerFailure = new LlmRateLimitError(42_000, 'upstream');
    await expect(background.run(async () => { throw providerFailure; })).rejects.toBe(providerFailure);
    await expect(background.run(async () => { throw new BackgroundAiCapacityError(10_000); })).rejects.toMatchObject({ name: 'ProactiveReviewCapacityError', retryAfterMs: 10_000 });
  });
});


function deferredReview() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('persistent background retry order', () => {
  it('reserves the released slot for an older retry instead of a fast successor', async () => {
    const gate = createProactiveReviewCapacity(1);
    const work = deferredReview();
    const first = gate.run(() => work.promise, 'student-a:first');
    const older = vi.fn(async () => 'old');
    const successor = vi.fn(async () => 'new');
    await expect(gate.run(older, 'student-b:waiting')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    work.resolve(); await first;
    // A completes and creates another request before B's existing 5s timer fires.
    await expect(gate.run(successor, 'student-a:next')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    expect(successor).not.toHaveBeenCalled();
    await expect(gate.run(older, 'student-b:waiting')).resolves.toBe('old');
    await expect(gate.run(successor, 'student-a:next')).resolves.toBe('new');
  });

  it('serves the 22 waiting student heads before eight newly completed students reenter', async () => {
    const gate = createProactiveReviewCapacity(8);
    const holds = Array.from({ length: 8 }, deferredReview);
    const running = holds.map((hold, index) => gate.run(() => hold.promise, `head:${index}`));
    const entered: number[] = [];
    const waiting = Array.from({ length: 22 }, (_, i) => i + 8);
    for (const index of waiting) {
      await expect(gate.run(async () => { entered.push(index); }, `head:${index}`)).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    }
    holds.forEach(hold => hold.resolve()); await Promise.all(running);
    const newWork = vi.fn(async () => 'new');
    for (let index = 0; index < 8; index++) {
      await expect(gate.run(newWork, `next:${index}`)).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    }
    expect(newWork).not.toHaveBeenCalled();
    const batch = waiting.slice(0, 8).map(index => {
      const hold = deferredReview();
      return { hold, promise: gate.run(async () => { entered.push(index); await hold.promise; }, `head:${index}`) };
    });
    expect(gate.snapshot().active).toBe(8);
    await expect(gate.run(newWork, 'next:0')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    batch.forEach(({ hold }) => hold.resolve()); await Promise.all(batch.map(item => item.promise));
    // Process the remaining existing tickets before replaying any new request.
    for (const index of waiting.slice(8)) await gate.run(async () => { entered.push(index); }, `head:${index}`);
    expect(entered).toEqual(waiting);
    await expect(gate.run(newWork, 'next:0')).resolves.toBe('new');
  });

  it('does not duplicate a ticket or reorder repeated busy attempts, including active IDs', async () => {
    const gate = createProactiveReviewCapacity(1);
    const hold = deferredReview();
    const first = gate.run(() => hold.promise, 'active');
    const never = vi.fn(async () => undefined);
    await expect(gate.run(never, 'active')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    for (const key of ['old', 'young', 'old', 'young', 'old']) {
      await expect(gate.run(never, key)).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    }
    hold.resolve(); await first;
    await expect(gate.run(never, 'young')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    expect(never).not.toHaveBeenCalled();
    await gate.run(async () => undefined, 'old');
    await gate.run(async () => undefined, 'young');
  });

  it('keeps a live retry ahead across lease refresh and expires abandoned tickets only', async () => {
    let now = 0;
    const gate = createProactiveReviewCapacity(1, 5_000, { now: () => now, maxPending: 2 });
    const hold = deferredReview();
    const first = gate.run(() => hold.promise, 'active');
    await expect(gate.run(async () => undefined, 'abandoned')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    await expect(gate.run(async () => undefined, 'live')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    now = 25_000;
    await expect(gate.run(async () => undefined, 'live')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    const overflow = vi.fn(async () => 'overflow');
    await expect(gate.run(overflow, 'overflow')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    // Expiry must never evict a still-running operation, even after 30s.
    now = 31_000;
    await expect(gate.run(overflow, 'active')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    hold.resolve(); await first;
    await expect(gate.run(overflow, 'overflow')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    await expect(gate.run(async () => 'live', 'live')).resolves.toBe('live');
    await expect(gate.run(overflow, 'overflow')).resolves.toBe('overflow');
    expect(overflow).toHaveBeenCalledOnce();
  });

  it('retains order on global busy, preserves foreground priority, and releases real failures', async () => {
    const pool = createClassroomAiCapacity(2);
    const gate = createProactiveReviewCapacity(8);
    const holds = [deferredReview(), deferredReview()];
    const running = holds.map(hold => pool.run(() => hold.promise));
    await vi.waitFor(() => expect(pool.snapshot().active).toBe(2));
    const interactive = vi.fn(async () => 'foreground');
    const foreground = pool.run(interactive);
    const background = vi.fn(async () => 'background');
    await expect(gate.run(() => pool.run(background), 'older')).rejects.toMatchObject({ name: 'ProactiveReviewCapacityError', retryAfterMs: 10_000 });
    expect(pool.snapshot().pending).toBe(1);
    expect(background).not.toHaveBeenCalled();
    holds[0].resolve(); await expect(foreground).resolves.toBe('foreground');
    holds[1].resolve(); await Promise.all(running);
    // A single-slot local gate makes the retained-order assertion unambiguous.
    const one = createProactiveReviewCapacity(1);
    await expect(one.run(async () => { throw new BackgroundAiCapacityError(10_000); }, 'older')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    await expect(one.run(background, 'younger')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    const failure = new LlmRateLimitError(42_000, 'actual provider rate limit');
    await expect(one.run(async () => { throw failure; }, 'older')).rejects.toBe(failure);
    await expect(one.run(background, 'younger')).resolves.toBe('background');
    await expect(gate.run(() => pool.run(background), 'older')).resolves.toBe('background');
    expect(pool.snapshot()).toMatchObject({ active: 0, pending: 0 });
  });

  it('isolates identical request IDs by authenticated scope and prevents anonymous bypass', async () => {
    const gate = createProactiveReviewCapacity(1);
    const hold = deferredReview();
    const first = gate.run(() => hold.promise, JSON.stringify(['course-a', 'student-a', 'request-1']));
    const other = JSON.stringify(['course-b', 'student-b', 'request-1']);
    await expect(gate.run(async () => 'other', other)).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    hold.resolve(); await first;
    const anonymous = vi.fn(async () => undefined);
    await expect(gate.run(anonymous)).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    expect(anonymous).not.toHaveBeenCalled();
    await expect(gate.run(async () => 'other', other)).resolves.toBe('other');
    await gate.run(anonymous);
  });

  it('replays through a fresh gate without automatically running the old rejected operation', async () => {
    const oldGate = createProactiveReviewCapacity(1);
    const hold = deferredReview();
    const running = oldGate.run(() => hold.promise, 'running');
    const waiting = vi.fn(async () => 'persisted request replay');
    await expect(oldGate.run(waiting, 'waiting')).rejects.toBeInstanceOf(ProactiveReviewCapacityError);
    expect(waiting).not.toHaveBeenCalled();
    // A fresh process loses scheduling preference only; the caller still owns
    // its durable request and must perform its existing authenticated claim.
    const restarted = createProactiveReviewCapacity(1);
    await expect(restarted.run(waiting, 'waiting')).resolves.toBe('persisted request replay');
    hold.resolve(); await running;
    expect(waiting).toHaveBeenCalledOnce();
  });
});
