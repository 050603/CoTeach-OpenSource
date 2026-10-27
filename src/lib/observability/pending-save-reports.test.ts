// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
let api: typeof import('./pending-save-reports');
beforeEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('openpbl.pending-save-reports.v1')];
  vi.resetModules(); api = await import('./pending-save-reports');
});
const report = (count = 0, createdAt: number | null = null, clientId = 'browser-profile-123456') => ({ clientId, known: true, count, oldestCreatedAt: createdAt });
it('starts unknown, accepts explicit zero and becomes unknown after zero reports expire', () => {
  expect(api.pendingSaveReportSnapshot(1000)).toMatchObject({ known: false, count: Number.NaN });
  api.recordPendingSaveReport('student', 'course', report(), 1000);
  expect(api.pendingSaveReportSnapshot(1001)).toMatchObject({ known: true, count: 0, oldestCreatedAt: null });
  expect(api.pendingSaveReportSnapshot(61_001)).toMatchObject({ known: false, count: Number.NaN });
});
it('isolates two browsers for the same actor and retains expired pending/unknown reports', () => {
  api.recordPendingSaveReport('student', 'course', report(2, 500), 1000);
  api.recordPendingSaveReport('student', 'course', report(0, null, 'browser-profile-654321'), 1000);
  expect(api.pendingSaveReportSnapshot(1001)).toMatchObject({ known: true, clients: 2, count: 2, oldestCreatedAt: 500 });
  api.recordPendingSaveReport('student', 'course', report(0, null, 'browser-profile-654321'), 61_001);
  expect(api.pendingSaveReportSnapshot(61_001)).toMatchObject({ known: false, count: Number.NaN, unknownClients: 1 });
  api.recordPendingSaveReport('student', 'course', report(), 61_002);
  expect(api.pendingSaveReportSnapshot(61_002)).toMatchObject({ known: true, count: 0 });
  api.recordPendingSaveReport('student', 'other-course', { known: false, clientId: 'browser-profile-123456' }, 61_003);
  expect(api.pendingSaveReportSnapshot(61_003)).toMatchObject({ known: false, unknownClients: 1 });
});
it('keeps known pending lower bounds visible alongside an unreadable browser report', () => {
  api.recordPendingSaveReport('student', 'course', report(2, 500), 1000);
  api.recordPendingSaveReport('student', 'course', { known: false, clientId: 'browser-profile-654321' }, 1000);
  expect(api.pendingSaveReportSnapshot(1001)).toMatchObject({ known: false, count: Number.NaN, oldestCreatedAt: Number.NaN, knownCount: 2, oldestKnownCreatedAt: 500 });
});
it('shares diagnostic state across bundles and does not fabricate empty state after bounded eviction', async () => {
  api.recordPendingSaveReport('student', 'course', report(1, 500), 1000);
  vi.resetModules(); const anotherBundle = await import('./pending-save-reports');
  expect(anotherBundle.pendingSaveReportSnapshot(1001).count).toBe(1);
  for (let i = 0; i < 4096; i++) api.recordPendingSaveReport(`student-${i}`, 'course', report(), 1000);
  const limited = api.pendingSaveReportSnapshot(1001);
  expect(limited.clients).toBeLessThanOrEqual(4096); expect(limited.known).toBe(false); expect(limited.count).toBeNaN();
});
it('never trusts invalid or absent counters as a zero', () => {
  for (const value of [undefined, { known: true, count: 0 }, report(-1), report(1), report(0, 10)]) {
    api.recordPendingSaveReport('student', 'course', value, 1000);
    expect(api.pendingSaveReportSnapshot(1001).known).toBe(false);
  }
});
it('bounds optional JSON metadata and treats malformed/missing/oversized bodies as unknown', async () => {
  const request = (body: string | null) => new Request('http://localhost/presence', { method: 'PUT', body });
  expect(await api.readPresenceSaveTelemetry(request(JSON.stringify({ pendingSaves: report() })))).toEqual(report());
  for (const body of [null, '{', 'x'.repeat(3000)]) expect(await api.readPresenceSaveTelemetry(request(body))).toBeUndefined();
});
