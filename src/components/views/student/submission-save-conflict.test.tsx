import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SubmissionSaveConflictPanel } from './submission-save-conflict';
import type { SubmissionSaveConflict } from '@/lib/browser/submission-save-outbox';
const submission = { id: 'draft', courseId: 'course', studentId: 'student', stageKey: 'make', type: 'document' as const, title: '成果', content: '<p>original</p>', createdAt: 'now', updatedAt: 'now' };
const conflict: SubmissionSaveConflict = { requestId: 'request', actorId: 'student', createdAt: 1, state: 'conflict',
  action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', submission } }, remote: { ...submission, content: '<p>server</p>', version: 2 } };
it('shows both sources as text and never silently chooses a conflict winner', async () => {
  const resolve = vi.fn(async () => undefined);
  render(<SubmissionSaveConflictPanel conflict={conflict} localContent="<p>latest local</p>" onResolve={resolve} />);
  expect(screen.getByText('<p>server</p>')).toBeTruthy(); expect(screen.getByText('<p>latest local</p>')).toBeTruthy();
  expect(resolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '采用当前本机内容并保存' }));
  await waitFor(() => expect(resolve).toHaveBeenCalledWith('local'));
});
