import { useEffect } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionProvider, useSession } from './store';
import { retainSubmissionSave } from '@/lib/browser/submission-save-outbox';
vi.mock('next/navigation', () => ({ usePathname: () => '/student/classroom/course' }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
let api: ReturnType<typeof useSession>;
function Probe() { const value = useSession(); useEffect(() => { api = value; }, [value]); return null; }
beforeEach(() => { localStorage.clear(); window.history.replaceState({}, '', '/student/classroom/course'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
it('keeps diagnostics unknown before authenticated hydration and scopes later reads to that identity/classroom', async () => {
  let complete!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { complete = resolve; })); vi.stubGlobal('fetch', fetcher);
  render(<SessionProvider><Probe /></SessionProvider>);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  expect(api.readPendingSubmissionSaves('course').known).toBe(false);
  await act(async () => { complete(Response.json({ courses: [], user: { role: 'student', name: '学生' }, studentId: 'student', joinedCourseId: 'course' })); });
  await waitFor(() => expect(api.hydrated).toBe(true));
  expect(api.readPendingSubmissionSaves('course')).toMatchObject({ known: true, count: 0 });
  retainSubmissionSave({ actorId: 'student', requestId: 'private-request-id', createdAt: Date.now() - 90_000, state: 'pending',
    action: { type: 'UPSERT_SUBMISSION', payload: { courseId: 'course', expectedSubmissionVersion: 0,
      submission: { id: 'draft', studentId: 'student', courseId: 'course', stageKey: 'make', type: 'document', title: '', content: 'private content', createdAt: 'now', updatedAt: 'now' } } } });
  expect(api.readPendingSubmissionSaves('course')).toMatchObject({ known: true, count: 1 });
  expect(api.readPendingSubmissionSaves('other-course').known).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
