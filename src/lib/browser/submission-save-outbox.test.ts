import { beforeEach, expect, it } from 'vitest';
import { acknowledgeSubmissionSave, readSubmissionSaves, retainSubmissionSave, sameSubmissionContent, type SubmissionSaveRecord } from './submission-save-outbox';
const record: SubmissionSaveRecord = { requestId: 'request', actorId: 'student', createdAt: 1, state: 'pending',
  action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', expectedSubmissionVersion: 0,
    submission: { id: 'draft', courseId: 'course', studentId: 'student', stageKey: 'make', type: 'document', title: '成果', content: 'hello', status: 'draft', version: 1, createdAt: 'now', updatedAt: 'now' } } } };
beforeEach(() => localStorage.clear());
it('recovers the original immutable request and isolates actor/course identities', () => {
  retainSubmissionSave(record);
  expect(readSubmissionSaves('student', 'course')).toEqual([record]);
  expect(readSubmissionSaves('other', 'course')).toEqual([]);
  expect(readSubmissionSaves('student', 'other')).toEqual([]);
  expect(() => retainSubmissionSave({ ...record, action: { ...record.action, payload: { ...record.action.payload, expectedSubmissionVersion: 1 } } })).toThrow();
  expect(readSubmissionSaves('student', 'course')).toEqual([record]);
});
it('an old receipt cannot delete a later distinct request', () => {
  const next = { ...record, requestId: 'next', createdAt: 2 };
  retainSubmissionSave(record); retainSubmissionSave(next); acknowledgeSubmissionSave(record);
  expect(readSubmissionSaves('student', 'course')).toEqual([next]);
});
it('compares all business fields while allowing canonical server metadata', () => {
  const original = record.action.payload.submission;
  expect(sameSubmissionContent(original, { ...original, id: 'canonical', version: 4, updatedAt: 'later' })).toBe(true);
  for (const patch of [{ content: 'different' }, { studentId: 'other' }, { groupId: 'other' }, { title: 'other' }, { status: 'submitted' as const }]) {
    expect(sameSubmissionContent(original, { ...original, ...patch })).toBe(false);
  }
});
it('surfaces damaged or invalid records for the current actor without deleting them or inspecting another actor', () => {
  const brokenKey = 'openpbl:submission-save:v1:student:broken';
  localStorage.setItem(brokenKey, '{');
  expect(() => readSubmissionSaves('student', 'course')).toThrow('无法读取');
  expect(localStorage.getItem(brokenKey)).toBe('{');
  expect(readSubmissionSaves('other-student', 'course')).toEqual([]);
  localStorage.setItem(brokenKey, JSON.stringify({ ...record, requestId: 'broken', action: { type: 'UPSERT_SUBMISSION' } }));
  expect(() => readSubmissionSaves('student', 'course')).toThrow('无法读取');
});
it('requires a valid owned server revision and compares identity/display/submission fields', () => {
  const original = record.action.payload.submission;
  for (const patch of [{ version: undefined }, { version: 0 }, { id: '' }, { studentId: undefined }, { studentName: 'changed' }, { submittedAt: 'later' }]) {
    expect(sameSubmissionContent(original, { ...original, ...patch })).toBe(false);
  }
  expect(sameSubmissionContent({ ...original, status: undefined }, { ...original, status: 'submitted' })).toBe(true);
  expect(sameSubmissionContent({ ...original, status: undefined }, { ...original, status: 'draft' })).toBe(false);
});
