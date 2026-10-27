// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { courseReadRequestValidationStatus, courseReadResponseMessage, courseReadResultToResponse, isCourseReadExecuteMessage, isCourseReadWorkerRequest, isCourseReadWorkerResult, isCourseReadWorkerStats } from './course-read-worker-protocol';
const input = { type: 'execute', id: 1, operation: 'courses', url: 'https://class.test/api/courses?courseId=one', headers: [['cookie', 'private']] };
describe('course read worker wire protocol', () => {
  it('classifies request limits with inclusive boundaries and aggregate UTF8 bytes', () => {
    const validate = (patch: Record<string, unknown>) => courseReadRequestValidationStatus({ ...input, ...patch });
    const base = 'https://class.test/api/courses?x=';
    expect(validate({ url: base + 'a'.repeat(16_384 - base.length) })).toBeNull();
    expect(validate({ url: base + 'a'.repeat(16_385 - base.length) })).toBe(414);
    for (const length of [256, 257]) {
      const courseId = 'a'.repeat(length);
      expect(validate({ operation: 'state', courseId, url: `https://class.test/api/courses/${courseId}/state` })).toBe(length === 256 ? null : 400);
    }
    expect(validate({ operation: 'state', courseId: 'other', url: 'https://class.test/api/courses/one/state' })).toBe(400);
    expect(validate({ headers: Array.from({ length: 128 }, (_, i) => [`x-${i}`, '']) })).toBeNull();
    expect(validate({ headers: Array.from({ length: 129 }, (_, i) => [`x-${i}`, '']) })).toBe(431);
    expect(validate({ headers: [['x', 'a'.repeat(65_536)]] })).toBeNull();
    expect(validate({ headers: [['x', 'a'.repeat(65_537)]] })).toBe(431);
    const exact = [['a', 'é'.repeat(32_765) + 'a'], ['b', 'a'.repeat(65_531)]];
    expect(validate({ headers: exact })).toBeNull();
    const oversized = [exact[0], ['b', exact[1][1] + 'a']];
    expect(validate({ headers: oversized })).toBe(431);
    expect(isCourseReadWorkerRequest({ ...input, headers: oversized })).toBe(false);
  });
  it('allows only fixed GET operations and fixed control messages', () => {
    expect(isCourseReadExecuteMessage(input)).toBe(true);
    expect(isCourseReadExecuteMessage({ ...input, operation: 'state', url: 'https://class.test/api/courses/one/state', courseId: 'one' })).toBe(true);
    for (const value of [{ ...input, operation: 'eval' }, { ...input, method: 'POST' }, { ...input, id: 0 },
      { ...input, url: 'https://class.test/api/courses/one/actions' }, { ...input, url: 'file:///api/courses' },
      { ...input, operation: 'state', url: 'https://class.test/api/courses/one/state', courseId: 'other' },
      { type: 'shutdown', script: 'bad' }, { type: 'stats', id: -1 }, null]) expect(isCourseReadWorkerRequest(value)).toBe(false);
    expect(isCourseReadWorkerRequest({ type: 'shutdown' })).toBe(true);
    expect(isCourseReadWorkerRequest({ type: 'stats', id: 2 })).toBe(true);
  });
  it('preserves UTF8 bytes and distinct clear cookies on 401 without comma folding', async () => {
    const headers = new Headers({ 'content-type': 'application/json', 'x-request-id': 'business-id' });
    headers.append('set-cookie', 'teacher=; Path=/; Max-Age=0; HttpOnly');
    headers.append('set-cookie', 'student=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/');
    const response = new Response('{"message":"登录失效"}', { status: 401, headers });
    const wire = await courseReadResponseMessage(1, response, [], 3);
    expect(wire.headers.some(([key]) => key === 'set-cookie')).toBe(false);
    expect(wire.cookies).toHaveLength(2);
    const transferred = structuredClone(wire, { transfer: [wire.body!] });
    expect(wire.body!.byteLength).toBe(0);
    const decoded = courseReadResultToResponse(transferred);
    expect(decoded.status).toBe(401); expect(decoded.headers.getSetCookie()).toEqual(headers.getSetCookie());
    expect(decoded.headers.get('x-request-id')).toBe('business-id'); expect(await decoded.text()).toBe('{"message":"登录失效"}');
  });
  it.each([204, 205, 304])('preserves null body and validators for %i', async status => {
    const result = await courseReadResponseMessage(2, new Response(null, { status, headers: { etag: 'W/"same"', vary: 'Cookie, X-OpenPBL-Role' } }), [], 1);
    expect(result.body).toBeNull(); const response = courseReadResultToResponse(result);
    expect(response.status).toBe(status); expect(response.body).toBeNull(); expect(response.headers.get('etag')).toBe('W/"same"');
  });
});

describe('realtime GET operation isolation', () => {
  it.each(['projection', 'events'] as const)('accepts %s only with its matching course and path', operation => {
    const message = { ...input, operation, courseId: 'one', url: `https://class.test/api/courses/one/${operation}?after=0&limit=2` };
    expect(isCourseReadExecuteMessage(message)).toBe(true);
    expect(courseReadRequestValidationStatus(message)).toBeNull();
    for (const patch of [
      { courseId: 'other' }, { courseId: undefined }, { method: 'POST' },
      { operation: 'state' }, { operation: operation === 'events' ? 'projection' : 'events' },
      { url: 'https://class.test/api/courses/one/actions' },
      { url: 'https://class.test/api/courses/one/public-discussion' },
      { url: `https://class.test/api/courses/one/${operation}/extra` },
    ]) expect(isCourseReadWorkerRequest({ ...message, ...patch })).toBe(false);
  });
});

describe('untrusted worker result guards', () => {
  it('accepts a real encoded response and rejects invalid status/body/headers/cookies/timings', async () => {
    const result = await courseReadResponseMessage(1, new Response('ok'), [{ phase: 'courses-read', sequence: 0, startMs: 0, endMs: 1, outcome: 'ok' }], 2);
    expect(isCourseReadWorkerResult(result)).toBe(true);
    for (const patch of [{ id: -1 }, { status: 199 }, { status: 600 }, { status: 304 }, { statusText: 'bad\r\nheader' },
      { body: 'not transferred bytes' }, { executionMs: Infinity }, { executionMs: -1 }, { cookies: ['bad\r\ncookie'] },
      { cookies: Array(33).fill('a=1') }, { headers: [['set-cookie', 'bad=1']] }, { headers: [['bad name', 'value']] },
      { phaseSpans: [{ ...result.phaseSpans[0], phase: 'arbitrary' }] }, { phaseSpans: [{ ...result.phaseSpans[0], endMs: 3 }] },
      { phaseSpans: [{ ...result.phaseSpans[0], outcome: 'unknown' }] }, { phaseSpans: [{ ...result.phaseSpans[0], startMs: NaN }] }]) {
      expect(isCourseReadWorkerResult({ ...result, ...patch })).toBe(false);
    }
  });
  it('retains unavailable native thread CPU as null and rejects nonfinite resource values', () => {
    const stats = { type: 'stats', id: 1, memory: { heapUsed: 1, heapTotal: 2, external: 0, arrayBuffers: 0 }, threadCpu: null, sampledAtMs: 1, monotonicNs: '123456789' };
    expect(isCourseReadWorkerStats(stats)).toBe(true);
    expect(isCourseReadWorkerStats({ ...stats, threadCpu: { user: 0, system: 1 } })).toBe(true);
    for (const patch of [{ id: 0 }, { memory: { ...stats.memory, external: NaN } }, { threadCpu: { user: -1, system: 0 } },
      { threadCpu: { user: 0, system: Infinity } }, { monotonicNs: '-1' }, { sampledAtMs: NaN }]) expect(isCourseReadWorkerStats({ ...stats, ...patch })).toBe(false);
  });
});
