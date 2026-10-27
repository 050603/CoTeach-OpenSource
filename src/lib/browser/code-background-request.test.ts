import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { requestBackgroundCodeAi, readPendingBackgroundCodeAi, codeBackgroundScope } from './code-background-request';
import { emitDocumentReviewCompletion } from './document-review-notifications';
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./bounded-fetch', () => ({ boundedFetch: mocks.fetch }));
const body = { courseId: 'course', studentId: 'student', stageKey: 'make', language: 'c', intent: 'proactive-review', artifact: { files: ['immutable'] } };
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); mocks.fetch.mockReset(); });
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });
it('uses a scoped canonical completion only to immediately read the real alias receipt', async () => {
  let requestId = '';
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => {
    if (options.method === 'POST') { requestId = JSON.parse(String(options.body)).requestId; return Response.json({ requestId, canonicalRequestId: 'canonical', status: 'processing' }, { status: 202 }); }
    return Response.json({ requestId, canonicalRequestId: 'canonical', status: 'completed' });
  });
  const pending = requestBackgroundCodeAi(body, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  emitDocumentReviewCompletion('other-course', { scope: 'student', source: 'ai-interaction-event', studentId: 'student', requestId: 'canonical' });
  emitDocumentReviewCompletion('course', { scope: 'student', source: 'ai-interaction-event', studentId: 'other', requestId: 'canonical' });
  emitDocumentReviewCompletion('course', { scope: 'student', source: 'ai-interaction-event', studentId: 'student', requestId: 'different' });
  await vi.advanceTimersByTimeAsync(0); expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(readPendingBackgroundCodeAi(codeBackgroundScope(body))).toHaveLength(1);
  emitDocumentReviewCompletion('course', { scope: 'student', source: 'ai-interaction-event', studentId: 'student', requestId: 'canonical' });
  expect((await pending).status).toBe(200);
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
  expect(new URL(mocks.fetch.mock.calls[1][0], 'https://test').searchParams.get('requestId')).toBe(requestId);
});
it('removes the completion listener when cancelled and preserves the original task', async () => {
  mocks.fetch.mockImplementation(async (_url: string, options: RequestInit) => Response.json({ requestId: JSON.parse(String(options.body)).requestId, canonicalRequestId: 'canonical', status: 'processing' }, { status: 202 }));
  const controller = new AbortController();
  const pending = requestBackgroundCodeAi(body, controller.signal); const failure = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(0); controller.abort(); await failure;
  emitDocumentReviewCompletion('course', { scope: 'student', source: 'ai-interaction-event', studentId: 'student', requestId: 'canonical' });
  await vi.advanceTimersByTimeAsync(15_000); expect(mocks.fetch).toHaveBeenCalledOnce();
  expect(readPendingBackgroundCodeAi(codeBackgroundScope(body))).toHaveLength(1);
});
it('retries a terminal task only explicitly and retains the same command if its acknowledgement is lost', async () => {
  let requestId = '';
  mocks.fetch.mockImplementationOnce(async (_url: string, options: RequestInit) => {
    requestId = JSON.parse(String(options.body)).requestId;
    return Response.json({ requestId, status: 'failed' });
  });
  await expect(requestBackgroundCodeAi(body, new AbortController().signal)).rejects.toThrow('保留');
  const original = readPendingBackgroundCodeAi(codeBackgroundScope(body))[0];
  mocks.fetch.mockRejectedValueOnce(new Error('lost retry acknowledgement'));
  await expect(requestBackgroundCodeAi(body, new AbortController().signal, { resume: true })).rejects.toThrow('lost retry');
  const command = JSON.parse(mocks.fetch.mock.calls[1][1].body);
  expect(command).toMatchObject({ action: 'retry-code-background', targetRequestId: requestId });
  expect(command.requestId).not.toBe(requestId);
  expect(readPendingBackgroundCodeAi(codeBackgroundScope(body))[0].body).toBe(original.body);
  mocks.fetch.mockResolvedValueOnce(Response.json({ requestId, status: 'completed' }));
  await requestBackgroundCodeAi(body, new AbortController().signal, { resume: true });
  expect(mocks.fetch.mock.calls[2][1].body).toBe(mocks.fetch.mock.calls[1][1].body);
  expect(readPendingBackgroundCodeAi(codeBackgroundScope(body))).toEqual([]);
});
it.each(['REVIEW_IDENTITY_CHANGED', 'REVIEW_STAGE_CHANGED'])('preserves the old alias/input and permits a new logical check after %s', async error => {
  let oldId = '';
  mocks.fetch.mockImplementationOnce(async (_url: string, options: RequestInit) => {
    oldId = JSON.parse(String(options.body)).requestId; return Response.json({ requestId: oldId, status: 'failed', error });
  });
  await expect(requestBackgroundCodeAi(body, new AbortController().signal)).rejects.toThrow('保留');
  const original = readPendingBackgroundCodeAi(codeBackgroundScope(body))[0];
  expect(original.terminalScope?.error).toBe(error);
  mocks.fetch.mockImplementationOnce(async (_url: string, options: RequestInit) => {
    const incoming = JSON.parse(String(options.body)); expect(incoming.requestId).not.toBe(oldId);
    expect(incoming.artifact).toEqual(body.artifact); return Response.json({ requestId: incoming.requestId, status: 'completed' });
  });
  await requestBackgroundCodeAi(body, new AbortController().signal);
  expect(mocks.fetch.mock.calls[1][1].method).toBe('POST');
  expect(readPendingBackgroundCodeAi(codeBackgroundScope(body))).toEqual([original]);
});
it('does not count preserved terminal generations against the active local waiting limit', async () => {
  const scope = codeBackgroundScope(body);
  for (let index = 0; index < 80; index += 1) {
    const requestId = `archived-${index}`;
    localStorage.setItem(`openpbl:code-background:v1:${encodeURIComponent(scope)}:${requestId}`, JSON.stringify({
      version: 1, scope, requestId, body: JSON.stringify({ ...body, requestId }), createdAt: index,
      terminalScope: { error: 'REVIEW_IDENTITY_CHANGED', at: index },
    }));
  }
  mocks.fetch.mockImplementationOnce(async (_url: string, options: RequestInit) => Response.json({ requestId: JSON.parse(String(options.body)).requestId, status: 'completed' }));
  await requestBackgroundCodeAi(body, new AbortController().signal);
  expect(mocks.fetch).toHaveBeenCalledOnce(); expect(readPendingBackgroundCodeAi(scope)).toHaveLength(80);
});
