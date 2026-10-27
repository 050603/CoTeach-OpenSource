const DOCUMENT_REVIEW_COMPLETED_EVENT = 'openpbl:document-review-completed';
export type DocumentReviewCompletion = { courseId: string; studentId: string; requestId: string };

/** A delivery hint only. No answer, document text, or authority to acknowledge
 * an outbox travels over the browser event; the owned receipt remains decisive. */
export function emitDocumentReviewCompletion(courseId: string, payload: Record<string, unknown>): void {
  if (typeof window === 'undefined' || !courseId || !['ai-interaction-event', 'ai-task-completed'].includes(String(payload.source)) || payload.scope !== 'student'
    || typeof payload.studentId !== 'string' || !payload.studentId || typeof payload.requestId !== 'string' || !payload.requestId) return;
  const detail: DocumentReviewCompletion = { courseId, studentId: payload.studentId, requestId: payload.requestId };
  window.dispatchEvent(new CustomEvent(DOCUMENT_REVIEW_COMPLETED_EVENT, { detail }));
}

export function subscribeDocumentReviewCompletion(scope: { courseId: string; studentId: string },
  listener: (notification: DocumentReviewCompletion) => void): () => void {
  const receive = (event: Event) => {
    const detail = (event as CustomEvent<DocumentReviewCompletion>).detail;
    if (detail?.courseId === scope.courseId && detail.studentId === scope.studentId && typeof detail.requestId === 'string') listener(detail);
  };
  window.addEventListener(DOCUMENT_REVIEW_COMPLETED_EVENT, receive);
  return () => window.removeEventListener(DOCUMENT_REVIEW_COMPLETED_EVENT, receive);
}
