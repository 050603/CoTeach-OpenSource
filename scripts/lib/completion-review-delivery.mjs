/** Observed event delivery on the same host. This is client occurredAt to the
 * database's receivedAt, independently of the browser API-response gate. */
export function summarizeCompletionEventDelivery(events, { fromEpochMs, toEpochMs }) {
  const selected = events.filter(event => event.source === 'legacy-classroom'
    && +new Date(event.occurredAt) >= fromEpochMs && +new Date(event.occurredAt) <= toEpochMs);
  const values = selected.map(event => +new Date(event.receivedAt) - +new Date(event.occurredAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = fraction => values.length ? values[Math.ceil(values.length * fraction) - 1] : null;
  return { semantics: 'database receivedAt minus client occurredAt; not API response latency', clock: 'browser and server on the same Linux host',
    fromEpochMs, toEpochMs, events: selected.length, measuredEvents: values.length, unmeasuredEvents: selected.length - values.length,
    eventTypes: selected.reduce((counts, event) => { const key = event.eventType ?? 'unknown'; counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}),
    p50Ms: quantile(.5), p90Ms: quantile(.9), p95Ms: quantile(.95), p99Ms: quantile(.99), maxMs: values.at(-1) ?? null,
    negativeSamples: values.filter(value => value < 0).length,
    cumulativeBuckets: [...[0, 200, 500, 1000, 2000, 5000, 10000].map(upperMs => ({ upperMs, count: values.filter(value => value <= upperMs).length })),
      { upperMs: 'infinity', count: values.length }],
  };
}

/** Serialized directly into the real page. Read the durable queue without
 * changing facts or depending on bundled application internals. */
export function inspectCompletionLearningQueue({ courseId, studentId, fromEpochMs, toEpochMs }, storage = localStorage) {
  const prefix = 'openpbl.learning-outbox.v1:';
  const tuple = JSON.stringify([courseId, studentId]);
  const current = `learning-events:${tuple}`;
  const batch = `learning-event-batch:${tuple}`;
  const belongs = scope => scope === current || scope === `resource-events:${courseId}:${studentId}` || scope.startsWith(`events:${courseId}:${studentId}:`);
  const pending = new Set(); const windowEvents = new Set();
  let eventEntries = 0; let batchEntries = 0;
  const retain = event => {
    if (!event?.id || event.courseId !== courseId || event.studentId !== studentId) throw new Error('Pending review event ownership is invalid');
    pending.add(event.id);
    const occurredAt = +new Date(event.occurredAt);
    if (!Number.isFinite(occurredAt)) throw new Error('Pending review event occurrence time is invalid');
    if (occurredAt >= fromEpochMs && occurredAt <= toEpochMs) windowEvents.add(event.id);
  };
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const end = key.indexOf(':', prefix.length);
    if (end < 0) continue;
    let scope; try { scope = decodeURIComponent(key.slice(prefix.length, end)); } catch { continue; }
    if (scope !== batch && !belongs(scope)) continue;
    const entry = JSON.parse(storage.getItem(key));
    if (!entry?.id || !Number.isFinite(entry.createdAt)) throw new Error('Pending review outbox entry is invalid');
    if (scope === batch) {
      if (!Array.isArray(entry.value) || !entry.value.length || entry.value.length > 20) throw new Error('Pending review checkpoint is invalid');
      batchEntries++;
      for (const stored of entry.value) {
        if (!belongs(stored.scope)) throw new Error('Pending review checkpoint scope is invalid');
        retain(stored.entry?.value);
      }
    } else { eventEntries++; retain(entry.value); }
  }
  return { eventEntries, batchEntries, pendingEventIds: [...pending], pendingWindowEventIds: [...windowEvents] };
}
