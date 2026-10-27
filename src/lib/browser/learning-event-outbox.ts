import type { LearningEvent } from '@/lib/session/types';
import { postLearningEvents } from '@/lib/learning-analytics/telemetry';
import { acknowledgeLearningWrites, enqueueLearningWrite, learningWriteScopes, readLearningWrites, type OutboxEntry } from './learning-outbox';

type Lane = {
  pending: Map<string, LearningEvent>; revision: number; flight?: Promise<void>;
  coalesceMs: number; lastAckAt?: number; wake?: () => void;
};
const REVIEW_COALESCE_MS = 1500;
const lanes = new Map<string, Lane>();
const scopeFor = (courseId: string, studentId: string) => `learning-events:${JSON.stringify([courseId, studentId])}`;
const storageMessage = '浏览器无法暂存学习记录，请保持页面打开；恢复存储后会重试。';

function laneFor(scope: string): Lane {
  let lane = lanes.get(scope);
  if (!lane) { lane = { pending: new Map(), revision: 0, coalesceMs: 0 }; lanes.set(scope, lane); }
  return lane;
}

function persistPending(scope: string, lane: Lane) {
  try {
    for (const [id, event] of lane.pending) {
      const old = readLearningWrites<LearningEvent>(scope).find(entry => entry.id === id);
      if (old && JSON.stringify(old.value) !== JSON.stringify(event)) throw new Error('学习事件标识已用于其他内容，请保留原记录。');
      if (!old) enqueueLearningWrite(scope, event, id);
      lane.pending.delete(id);
    }
  } catch (error) {
    // The original serialized event remains in this scope's memory until it
    // can be made durable. Callers must surface the storage failure to users.
    throw new Error(storageMessage, { cause: error });
  }
}

/** Persist before sending. Storage failures retain the original body in memory
 * across component unmounts; a reload cannot promise durability until storage recovers. */
export function enqueueLearningEvent(event: LearningEvent): void {
  if (!event.courseId || !event.studentId || !event.id || !event.idempotencyKey) throw new Error('学习记录缺少归属或标识。');
  const scope = scopeFor(event.courseId, event.studentId);
  const lane = laneFor(scope);
  lane.revision++;
  const snapshot = JSON.parse(JSON.stringify(event)) as LearningEvent;
  const pending = lane.pending.get(event.id);
  if (pending && JSON.stringify(pending) !== JSON.stringify(snapshot)) throw new Error('学习事件标识已用于其他内容，请保留原记录。');
  let old: OutboxEntry<LearningEvent> | undefined;
  try { old = readLearningWrites<LearningEvent>(scope).find(entry => entry.id === event.id); }
  catch (error) {
    lane.pending.set(event.id, snapshot);
    throw new Error(storageMessage, { cause: error });
  }
  if (old && JSON.stringify(old.value) !== JSON.stringify(snapshot)) throw new Error('学习事件标识已用于其他内容，请保留原记录。');
  lane.pending.set(event.id, snapshot);
  persistPending(scope, lane);
  if (isCompletion(snapshot)) lane.wake?.();
}

type StoredEvent = { scope: string; entry: OutboxEntry<LearningEvent> };
function belongsToScope(scope: string, courseId: string, studentId: string) {
  return scope === scopeFor(courseId, studentId) || scope === `resource-events:${courseId}:${studentId}`
    || scope.startsWith(`events:${courseId}:${studentId}:`);
}
function validateEvents(entries: StoredEvent[], courseId: string, studentId: string) {
  for (const item of entries) {
    const event = item?.entry?.value;
    if (!belongsToScope(item.scope, courseId, studentId) || event?.courseId !== courseId || event?.studentId !== studentId || !event.id || !event.idempotencyKey) {
      throw new Error('暂存学习记录归属不一致，请保留记录并联系教师。');
    }
  }
}
function pendingEvents(courseId: string, studentId: string): StoredEvent[] {
  const current = scopeFor(courseId, studentId);
  const scopes = new Set([current, ...learningWriteScopes().filter(scope => belongsToScope(scope, courseId, studentId))]);
  const entries = [...scopes].flatMap(scope => readLearningWrites<LearningEvent>(scope).map(entry => ({ scope, entry })));
  validateEvents(entries, courseId, studentId);
  // Legacy sources did not share a sequence. Their persisted order is retained;
  // ties between sources use a stable scope order without altering event bodies.
  return entries.sort((a, b) => a.entry.createdAt - b.entry.createdAt || a.scope.localeCompare(b.scope) || a.entry.id.localeCompare(b.entry.id));
}

function isCompletion(event: LearningEvent) {
  return event.type === 'scene-complete' || event.type === 'stage-goal-complete';
}
function batchCheckpoint(batchScope: string) {
  const saved = readLearningWrites<StoredEvent[]>(batchScope);
  if (saved.length > 1) throw new Error('学习记录发送批次异常，请保留原记录。');
  return saved[0];
}
function waitForBatch(lane: Lane, milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      if (lane.wake === finish) lane.wake = undefined;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    lane.wake = finish;
  });
}

/** All event producers for one actor/course share one flight. Progress and AI
 * interaction queues deliberately have different protocols and stay separate.
 * Review may gather facts for a fixed window after an ACK; normal calls force
 * pending work through immediately, including an existing review wait. */
export function flushLearningEvents(courseId: string, studentId: string, options?: { coalesce?: boolean }): Promise<void> {
  const scope = scopeFor(courseId, studentId);
  const lane = laneFor(scope);
  lane.revision++;
  lane.coalesceMs = options?.coalesce ? REVIEW_COALESCE_MS : 0;
  if (!lane.coalesceMs) lane.wake?.();
  else if (lane.wake) {
    try { if (pendingEvents(courseId, studentId).some(item => isCompletion(item.entry.value))) lane.wake?.(); }
    catch { lane.wake?.(); } // Surface storage/ownership errors from the existing flight.
  }
  if (lane.flight) return lane.flight;
  const sendBatches = async () => {
    const batchScope = `learning-event-batch:${JSON.stringify([courseId, studentId])}`;
    for (;;) {
      persistPending(scope, lane);
      let checkpoint = batchCheckpoint(batchScope);
      let replay = Boolean(checkpoint);
      if (!checkpoint) {
        let available = pendingEvents(courseId, studentId);
        if (!available.length) return;
        const delay = lane.coalesceMs && lane.lastAckAt !== undefined
          ? Math.max(0, lane.lastAckAt + lane.coalesceMs - performance.now()) : 0;
        // Scan the whole queue: a completion beyond the first 20 requires all
        // preceding batches to drain immediately until that fact is ACKed.
        if (delay && !available.some(item => isCompletion(item.entry.value))) {
          await waitForBatch(lane, delay);
          persistPending(scope, lane);
          checkpoint = batchCheckpoint(batchScope);
          replay = Boolean(checkpoint);
          available = pendingEvents(courseId, studentId);
        }
        // Persist the selected batch before sending: lost ACK + reload retries
        // the identical payload before incorporating any subsequently added fact.
        if (!checkpoint) {
          const batch = available.slice(0, 20);
          if (!batch.length) return;
          checkpoint = enqueueLearningWrite(batchScope, batch, 'flight');
        }
      }
      if (!Array.isArray(checkpoint.value) || !checkpoint.value.length || checkpoint.value.length > 20) throw new Error('学习记录发送批次异常，请保留原记录。');
      validateEvents(checkpoint.value, courseId, studentId);
      const input = { courseId, studentId, events: checkpoint.value.map(item => item.entry.value) };
      // A previous immutable checkpoint may have committed without an ACK.
      // This hint grants no authority: the server verifies every stored fact.
      if (replay) await postLearningEvents(input, { replay: true });
      else await postLearningEvents(input);
      lane.lastAckAt = performance.now();
      for (const item of checkpoint.value) acknowledgeLearningWrites(item.scope, [item.entry]);
      acknowledgeLearningWrites(batchScope, [checkpoint]);
    }
  };
  const flight = (async () => {
    // Let synchronous scene/resource callbacks join the first batch in this
    // microtask. Only the opt-in review window after an ACK uses a timer.
    await Promise.resolve();
    try {
      // Web Locks serialize tabs as well as producers within this JS realm.
      // Browsers without Web Locks retain the original per-realm guarantee.
      for (;;) {
        const revision = lane.revision;
        if (typeof navigator !== 'undefined' && navigator.locks?.request) await navigator.locks.request(scope, sendBatches);
        else await sendBatches();
        if (revision === lane.revision) return;
      }
    } finally {
      // Clear in the same continuation as the empty check. A completion-time
      // enqueue must start a new flight rather than join an already-ended loop.
      lane.flight = undefined;
    }
  })();
  lane.flight = flight;
  return flight;
}
