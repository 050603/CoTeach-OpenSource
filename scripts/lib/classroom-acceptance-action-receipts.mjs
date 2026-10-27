import { createHash, randomUUID } from 'node:crypto';
import * as eventCursorModule from '../../src/lib/realtime/event-cursor.ts';
import { z } from 'zod';

const { encodeEventCursor } = eventCursorModule.default ?? eventCursorModule;

// Format-only browser fixture for POST /api/learning-events. Do not import the
// server ingest module here: these fixtures must never connect to a database.
const eventText = z.string().min(1).max(500);
const eventSeconds = z.number().finite().nonnegative().optional();
const browserEventSchema = z.object({
  id: eventText, idempotencyKey: eventText, courseId: eventText, studentId: eventText, stageKey: eventText,
  sceneId: eventText.optional(),
  type: z.enum(['scene-enter', 'scene-leave', 'scene-complete', 'heartbeat', 'scene-replay',
    'knowledge_explanation_view', 'interaction-result', 'artifact-change', 'stage-enter',
    'stage-goal-complete', 'resource-open', 'resource-progress', 'resource-complete']),
  occurredAt: z.string().datetime(), durationMs: z.number().int().min(0).max(2_147_483_647).optional(),
  expectedDurationSec: eventSeconds, ttsDurationSec: eventSeconds, plannedStudentActivitySec: eventSeconds,
  visible: z.boolean().optional(), progressMarker: z.string().optional(),
  content: z.object({ stageLabel: z.string().optional(), sceneTitle: z.string().optional(), sceneIndex: z.number().optional(),
    sceneType: z.string().optional(), activityId: z.string().optional(), activityTitle: z.string().optional(),
    knowledgePointIds: z.array(z.string()).optional(), knowledgePointLabels: z.array(z.string()).optional() }).optional(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
}).refine(event => JSON.stringify(event).length <= 32_000);
const browserEventBatchSchema = z.object({ courseId: eventText, studentId: eventText,
  events: z.array(browserEventSchema).min(1).max(100) });
const canonicalEvent = value => Array.isArray(value) ? value.map(canonicalEvent)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonicalEvent(child)]))
    : value;

/** Return only IDs actually supplied by a valid batch; no fabricated database
 * receipt, signals or duplicate count. The explicit clock keeps this pure.
 */
export function browserLearningEventReceipt(input, now) {
  if (!Number.isFinite(now)) throw new Error('Learning-event fixture requires an explicit clock');
  let body = input;
  if (typeof input === 'string') {
    try { body = JSON.parse(input); }
    catch { return { status: 400, body: { error: 'INVALID_JSON' } }; }
  }
  const parsed = browserEventBatchSchema.safeParse(body);
  if (!parsed.success || parsed.data.events.some(event => event.courseId !== parsed.data.courseId
    || event.studentId !== parsed.data.studentId || Date.parse(event.occurredAt) > now + 300_000)) {
    return { status: 400, body: { error: 'INVALID_EVENTS' } };
  }
  const fingerprints = new Map();
  for (const event of parsed.data.events) {
    const fingerprint = JSON.stringify(canonicalEvent({ ...event, occurredAt: new Date(event.occurredAt).toISOString() }));
    if (fingerprints.has(event.idempotencyKey) && fingerprints.get(event.idempotencyKey) !== fingerprint) {
      return { status: 409, body: { error: 'LEARNING_EVENT_CONFLICT' } };
    }
    fingerprints.set(event.idempotencyKey, fingerprint);
  }
  return { status: 200, body: { acceptedIds: [...new Set(parsed.data.events.map(event => event.id))] } };
}

/** Browser fixtures use the real cursor codec and the server's immutable
 * [courseId, action] fingerprint. The envelope's changing course version is not
 * part of that fingerprint; the submission's expected version remains part of
 * its action. A replay returns the original complete ACK, including its cursor.
 */
export function createBrowserActionReceipts(courseId, timestamp) {
  const receipts = new Map();
  const key = body => {
    if (!body || typeof body.requestId !== 'string' || !body.requestId || !body.action) throw new Error('Invalid browser action fixture envelope');
    return createHash('sha256').update(JSON.stringify([courseId, body.action])).digest('hex');
  };
  const lookup = body => {
    const fingerprint = key(body); const previous = receipts.get(body.requestId);
    if (!previous) return undefined;
    return previous.fingerprint === fingerprint
      ? { status: 200, body: previous.ack }
      : { status: 409, body: { code: 'IDEMPOTENCY_CONFLICT', message: '请求标识已用于其他内容' } };
  };
  return {
    lookup,
    remember(body, fields) {
      const previous = lookup(body);
      if (previous) {
        if (previous.status !== 200) throw new Error('Cannot commit a conflicting browser fixture request');
        return previous.body;
      }
      if (!Number.isSafeInteger(fields.courseVersion) || fields.courseVersion < 1
        || (fields.submissionVersion !== undefined && (!Number.isSafeInteger(fields.submissionVersion) || fields.submissionVersion < 1))) {
        throw new Error('Browser fixture ACK has invalid versions');
      }
      const ack = Object.freeze({ ...fields, requestId: body.requestId,
        eventCursor: encodeEventCursor({ createdAt: new Date(timestamp), id: randomUUID() }) });
      receipts.set(body.requestId, { fingerprint: key(body), ack });
      return ack;
    },
  };
}
