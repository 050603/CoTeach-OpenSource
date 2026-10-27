import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const payloadOf = row => row.metadata?.legacy ?? row.metadata?.view;
const millis = value => new Date(value).getTime();
const seconds = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 86_400 ? value : 0;

/** Independent reference calculation over retained rows, without production SQL or summarizer imports. */
function expectedTiming(rows, studentIds) {
  const result = Object.fromEntries(studentIds.map(id => [id, { effectiveDurationMs: 0, expectedDurationMs: 0, hasEvidence: false }]));
  const logical = new Set();
  const latestScenes = new Map();
  const chronological = [...rows].sort((a, b) => millis(a.receivedAt) - millis(b.receivedAt) || a.id.localeCompare(b.id));
  for (const row of chronological) {
    const payload = payloadOf(row);
    const target = result[row.userId];
    if (!target || payload?.stageKey !== 'ai-learning') continue;
    const key = JSON.stringify([row.userId, payload.idempotencyKey || row.idempotencyKey]);
    if (!logical.has(key)) {
      logical.add(key); target.hasEvidence = true;
      if (row.eventType === 'heartbeat' && row.durationMs > 0 && row.durationMs <= 300_000 && payload.visible !== false) {
        target.effectiveDurationMs += row.durationMs;
      }
    }
    if (!payload.sceneId || typeof payload.expectedDurationSec !== 'number') continue;
    const sceneKey = JSON.stringify([row.userId, payload.sceneId]);
    const previous = latestScenes.get(sceneKey);
    if (!previous || millis(row.occurredAt) > millis(previous.occurredAt)
      || (millis(row.occurredAt) === millis(previous.occurredAt) && (millis(row.receivedAt) > millis(previous.receivedAt)
        || (millis(row.receivedAt) === millis(previous.receivedAt) && row.id > previous.id)))) latestScenes.set(sceneKey, row);
  }
  for (const row of latestScenes.values()) {
    const payload = payloadOf(row);
    const designed = seconds(payload.expectedDurationSec);
    if (!designed) continue;
    const narration = seconds(payload.ttsDurationSec);
    const activity = seconds(payload.plannedStudentActivitySec);
    const reference = Math.max(designed, narration + activity);
    // Current published timing contract: 90s minimum, 50% reference allowance,
    // and 35% narration plus 45s; rounded up to whole seconds.
    result[row.userId].expectedDurationMs += Math.ceil(reference + Math.max(90, reference * 0.5, narration * 0.35 + 45)) * 1000;
  }
  return result;
}

/** Explicit synthetic fixture after the main lesson, not a browser-throughput or elapsed-time claim. */
export async function runEventVolumeAcceptance({ teacher, students, instance, offering, origin, db, request, record, output }) {
  const runId = randomUUID();
  const name = 'event-volume-reconciliation';
  const evidence = { scope: 'supplementary-synthetic-event-volume', fixtureSource: 'direct-db', runId,
    instanceId: instance.id, endpoint: `${origin}/api/courses/${instance.id}/state`,
    limitations: ['本专项验证超过一万条持久化事件的统计正确性，不表示浏览器实际产生了这些事件或完成了同等学习时长。'] };
  await mkdir(output, { recursive: true });
  try {
    const ids = students.map(student => student.user.id);
    assert.ok(ids.length > 0); assert.equal(new Set(ids).size, ids.length);
    const savedInstance = await db.classroomInstance.findUniqueOrThrow({ where: { id: instance.id },
      include: { activity: { include: { chapter: true } }, participations: { include: { enrollment: true } } } });
    assert.equal(savedInstance.status.toUpperCase(), 'FINISHED', 'Run volume fixtures only after the main classroom has finished');
    assert.equal(savedInstance.activity.chapter.offeringId, offering.id);
    const own = new Map(savedInstance.participations.map(item => [item.enrollment.userId, item]));
    for (const id of ids) assert.ok(own.has(id), `Student ${id} must own a participation in the finished classroom`);
    const where = { classroomInstanceId: instance.id };
    const baselineRows = await db.learningEvent.findMany({ where });
    const baseline = expectedTiming(baselineRows, ids);
    const originalState = (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
    for (const id of ids) assert.deepEqual(originalState.aiLearningTimingByStudent?.[id], baseline[id], 'Baseline teacher timing differs from complete event history');
    const countPerStudent = Math.max(420, Math.ceil(12_030 / ids.length));
    const createdAt = Date.now();
    const rows = [];
    const expectedDeltas = {};
    const categories = { foreground: 0, hidden: 0, overFiveMinutes: 0, otherStage: 0, nonHeartbeat: 0, duplicate: 0, zero: 0, boundaryFiveMinutes: 0 };
    const append = (id, sequence, patch = {}, databaseSuffix = '') => {
      const participation = own.get(id);
      const idempotencyKey = `acceptance-volume:${runId}:${id}:${sequence}`;
      const occurredAt = new Date(createdAt - (countPerStudent + 10 - sequence) * 10_000);
      const legacy = { id: idempotencyKey, idempotencyKey, studentId: id, courseId: instance.id,
        stageKey: 'ai-learning', sceneId: `acceptance-volume-scene-${runId}-${id}`, type: 'heartbeat',
        occurredAt: occurredAt.toISOString(), durationMs: 10_000, visible: true, ...patch };
      rows.push({ id: randomUUID(), idempotencyKey: `${idempotencyKey}${databaseSuffix}`, researchKey: participation.enrollment.researchKey,
        userId: id, offeringId: offering.id, enrollmentId: participation.enrollmentId,
        chapterId: savedInstance.activity.chapterId, activityId: savedInstance.activityId,
        classroomInstanceId: instance.id, participationId: participation.id, eventType: legacy.type,
        occurredAt, durationMs: legacy.durationMs, source: 'acceptance-event-volume-fixture',
        metadata: { legacy, acceptanceFixture: { runId, source: 'synthetic-direct-db', originalDatabaseKey: idempotencyKey } } });
      return legacy;
    };
    for (const [studentIndex, id] of ids.entries()) {
      let effectiveDurationMs = 0;
      for (let i = 0; i < countPerStudent; i++) {
        const kind = i % 10;
        const patch = { durationMs: 10_000 + studentIndex * 100 + (i % 3) * 100 };
        if (kind < 6) { categories.foreground++; effectiveDurationMs += patch.durationMs; }
        else if (kind === 6) { categories.hidden++; patch.visible = false; patch.durationMs = 60_000; }
        else if (kind === 7) { categories.overFiveMinutes++; patch.durationMs = 300_001; }
        else if (kind === 8) { categories.otherStage++; patch.stageKey = 'make'; }
        else { categories.nonHeartbeat++; patch.type = 'scene-progress'; }
        if (i === 0) Object.assign(patch, { expectedDurationSec: 60, ttsDurationSec: 10, plannedStudentActivitySec: 0 });
        append(id, i, patch);
      }
      append(id, countPerStudent, { type: 'scene-progress', durationMs: 0,
        expectedDurationSec: 120, ttsDurationSec: 140, plannedStudentActivitySec: 30 });
      categories.nonHeartbeat++;
      append(id, countPerStudent + 1, { durationMs: 0 }); categories.zero++;
      append(id, countPerStudent + 2, { durationMs: 300_000 }); categories.boundaryFiveMinutes++; effectiveDurationMs += 300_000;
      // Different physical key, same logical event. The first durable event must win.
      append(id, 0, { durationMs: 200_000 }, ':logical-retry'); categories.duplicate++;
      expectedDeltas[id] = { effectiveDurationMs, expectedDurationMs: 264_000, rows: countPerStudent + 4 };
    }
    assert.ok(rows.length > 10_000);
    // Unique receipt timestamps make the 10,000-row detail cutoff deterministic.
    for (const [index, row] of rows.entries()) row.receivedAt = new Date(createdAt - rows.length + index);
    evidence.fixture = { rows: rows.length, countPerStudent, categories, expectedDeltas,
      sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    for (let offset = 0; offset < rows.length; offset += 500) {
      const batch = rows.slice(offset, offset + 500);
      assert.equal((await db.learningEvent.createMany({ data: batch })).count, batch.length);
    }
    const retained = await db.learningEvent.findMany({ where });
    assert.equal(retained.length, baselineRows.length + rows.length, 'Finished classroom event set changed unexpectedly');
    const expected = expectedTiming(retained, ids);
    for (const id of ids) {
      assert.equal(expected[id].effectiveDurationMs, baseline[id].effectiveDurationMs + expectedDeltas[id].effectiveDurationMs);
      assert.equal(expected[id].expectedDurationMs, baseline[id].expectedDurationMs + expectedDeltas[id].expectedDurationMs);
    }
    const started = performance.now();
    const state = (await request(teacher.context, 'GET', `/api/courses/${instance.id}/state`)).course;
    evidence.httpElapsedMs = Math.round(performance.now() - started);
    assert.equal(state.id, instance.id);
    assert.equal(state.learningEvents.length, 10_000, 'Teacher trajectory should retain its 10,000-row detail limit');
    for (const id of ids) assert.deepEqual(state.aiLearningTimingByStudent?.[id], expected[id], `Full teacher timing mismatch for ${id}`);
    const detailRows = [...retained].sort((a, b) => millis(b.receivedAt) - millis(a.receivedAt)).slice(0, 10_000);
    assert.deepEqual(state.learningEvents, [...detailRows].reverse().map(payloadOf).filter(Boolean),
      'The actual trajectory must match the latest retained event details');
    const displayed = expectedTiming(detailRows, ids);
    const totalEffectiveMs = ids.reduce((sum, id) => sum + expected[id].effectiveDurationMs, 0);
    const detailEffectiveMs = ids.reduce((sum, id) => sum + displayed[id].effectiveDurationMs, 0);
    assert.ok(totalEffectiveMs > detailEffectiveMs, 'Fixture must demonstrate useful timing evidence beyond the detail cutoff');
    const ownState = (await request(students[0].context, 'GET', `/api/courses/${instance.id}/state`)).course;
    assert.deepEqual(Object.keys(ownState.aiLearningTimingByStudent), [ids[0]], 'Student timing must not expose classmates');
    assert.deepEqual(ownState.aiLearningTimingByStudent[ids[0]], expected[ids[0]]);
    evidence.baseline = { rawRows: baselineRows.length, timing: baseline };
    evidence.result = { rawRows: retained.length, fixtureRows: rows.length, trajectoryRows: state.learningEvents.length,
      students: ids.length, totalEffectiveMs, detailEffectiveMs, independentlyCalculated: expected,
      actualTeacherTiming: Object.fromEntries(ids.map(id => [id, state.aiLearningTimingByStudent[id]])), studentScopeVerified: true };
    evidence.status = '通过';
    record(name, '通过', { scope: evidence.scope, fixtureSource: evidence.fixtureSource,
      rawRows: retained.length, fixtureRows: rows.length, trajectoryRows: state.learningEvents.length,
      students: ids.length, totalEffectiveMs, detailEffectiveMs, exclusions: categories,
      endpoint: `/api/courses/${instance.id}/state`, studentScopeVerified: true }, 'isolated-backend');
  } catch (error) {
    evidence.status = '失败'; evidence.error = String(error?.stack || error).slice(0, 3500);
    record(name, '失败', { scope: evidence.scope, error: evidence.error }, 'isolated-backend');
  } finally {
    await writeFile(path.join(output, 'event-volume-reconciliation.json'), JSON.stringify(evidence, null, 2));
  }
  return evidence;
}
