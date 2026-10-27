import { expect, it, vi } from 'vitest';
import { emitDocumentReviewCompletion, subscribeDocumentReviewCompletion } from './document-review-notifications';

it('fans out only an owned course/student completion hint and carries no document or response', () => {
  const listener = vi.fn();
  const stop = subscribeDocumentReviewCompletion({ courseId: 'current', studentId: 'me' }, listener);
  const payload = { source: 'ai-interaction-event', scope: 'student', studentId: 'me', requestId: 'review-1', documentHtml: 'private', response: 'private' };
  try {
    emitDocumentReviewCompletion('old-course', payload);
    emitDocumentReviewCompletion('current', { ...payload, studentId: 'someone-else' });
    emitDocumentReviewCompletion('current', { ...payload, source: 'unconfirmed-message' });
    emitDocumentReviewCompletion('current', { ...payload, scope: 'teacher' });
    expect(listener).not.toHaveBeenCalled();
    emitDocumentReviewCompletion('current', payload);
    expect(listener).toHaveBeenCalledExactlyOnceWith({ courseId: 'current', studentId: 'me', requestId: 'review-1' });
  } finally { stop(); }
  emitDocumentReviewCompletion('current', payload);
  expect(listener).toHaveBeenCalledOnce();
});
it('accepts a real queued task completion without inventing an interaction audit', () => {
  const listener = vi.fn(); const stop = subscribeDocumentReviewCompletion({ courseId: 'course', studentId: 'me' }, listener);
  try {
    emitDocumentReviewCompletion('course', { source: 'ai-task-completed', scope: 'student', studentId: 'me', requestId: 'starter', response: 'private' });
    expect(listener).toHaveBeenCalledExactlyOnceWith({ courseId: 'course', studentId: 'me', requestId: 'starter' });
  } finally { stop(); }
});
