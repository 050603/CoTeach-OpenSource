import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retainSubmissionSave, type SubmissionSaveRecord } from './submission-save-outbox';
import { submissionSaveTelemetry } from './submission-save-telemetry';
const pending = (requestId: string, createdAt: number): SubmissionSaveRecord => ({ actorId: 'student', requestId, createdAt, state: 'pending',
  action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', expectedSubmissionVersion: 0,
    submission: { id: requestId, courseId: 'course', studentId: 'student', stageKey: 'make', type: 'document', title: 'private title', content: 'private draft text', createdAt: 'now', updatedAt: 'now' } } } });
beforeEach(() => localStorage.clear());
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
it('reports an explicit empty outbox and keeps one browser-profile identity across module/tab instances', async () => {
  const first = submissionSaveTelemetry('student', 'course');
  expect(first).toEqual({ clientId: expect.any(String), known: true, count: 0, oldestCreatedAt: null });
  vi.resetModules(); const anotherTab = await import('./submission-save-telemetry');
  expect(anotherTab.submissionSaveTelemetry('student', 'course').clientId).toBe(first.clientId);
});
it('summarizes only the owned current classroom pending/conflicting records and excludes resolved history', () => {
  const now = Date.now(); const one = pending('one', now - 90_000); const two = pending('two', now - 100_000);
  retainSubmissionSave(one);
  retainSubmissionSave({ ...two, state: 'conflict', remote: { ...two.action.payload.submission, version: 2 } });
  const resolved = pending('resolved', now - 200_000);
  retainSubmissionSave({ ...resolved, state: 'resolved', remote: { ...resolved.action.payload.submission, version: 2 } });
  const other = pending('other', now - 300_000);
  retainSubmissionSave({ ...other, action: { ...other.action, payload: { ...other.action.payload, courseId: 'other', submission: { ...other.action.payload.submission, courseId: 'other' } } } });
  const summary = submissionSaveTelemetry('student', 'course');
  expect(summary).toMatchObject({ known: true, count: 2, oldestCreatedAt: now - 100_000 });
  expect(JSON.stringify(summary)).not.toMatch(/private|requestId|actorId|student|course/);
});
it('reports unreadable storage and damaged outboxes as unknown rather than empty', () => {
  submissionSaveTelemetry('student', 'course');
  localStorage.setItem('openpbl:submission-save:v1:student:broken', '{');
  expect(submissionSaveTelemetry('student', 'course')).toMatchObject({ clientId: expect.any(String), known: false });
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('storage blocked'); });
  expect(submissionSaveTelemetry('student', 'course')).toEqual({ known: false });
});
