import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DOCUMENT_COLLABORATION_BROWSER_TIMEOUT_MS } from '@/lib/ai-collaboration/request-budget';
import { DocumentRequestUnconfirmedError, sendOrRecoverDocumentRequest } from './document-collaboration-transport';

const statusUrl = '/api/ai-collaboration/document?requestId=request-1';
const submit = { method: 'POST', body: '{"requestId":"request-1","message":"整理已有记录"}' };
const completed = () => Response.json({ status: 'completed', result: { kind: 'discussion', message: '已完成' } });
const pending = () => Response.json({ status: 'processing', retryAfterMs: 1_000 }, { status: 202 });
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { vi.useFakeTimers(); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('bounds an initial hung POST and keeps an unconfirmed outcome instead of resubmitting', async () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const result = sendOrRecoverDocumentRequest({ statusUrl, submit });
  const assertion = expect(result).rejects.toBeInstanceOf(DocumentRequestUnconfirmedError);
  await vi.advanceTimersByTimeAsync(DOCUMENT_COLLABORATION_BROWSER_TIMEOUT_MS);
  await assertion;
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

it('bounds every status read within the same overall window', async () => {
  fetchMock.mockResolvedValueOnce(pending()).mockImplementation(() => new Promise(() => {}));
  const result = sendOrRecoverDocumentRequest({ statusUrl, submit });
  const assertion = expect(result).rejects.toBeInstanceOf(DocumentRequestUnconfirmedError);
  await vi.advanceTimersByTimeAsync(DOCUMENT_COLLABORATION_BROWSER_TIMEOUT_MS);
  await assertion;
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

it('bounds a body that never arrives and recovers the paid result by receipt', async () => {
  fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} }))).mockResolvedValueOnce(completed());
  const result = sendOrRecoverDocumentRequest({ statusUrl, submit });
  await vi.advanceTimersByTimeAsync(9_500);
  expect((await result).payload.status).toBe('completed');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('requests asynchronous processing while preserving caller headers and preferences', async () => {
  fetchMock.mockResolvedValue(completed());
  const headers = new Headers({ 'Content-Type': 'application/json', 'X-Request-Id': 'request-1', Prefer: 'return=representation' });
  await sendOrRecoverDocumentRequest({ statusUrl, submit: { ...submit, headers } });
  const sentHeaders = new Headers(fetchMock.mock.calls[0][1].headers);
  expect(sentHeaders.get('Content-Type')).toBe('application/json');
  expect(sentHeaders.get('X-Request-Id')).toBe('request-1');
  expect(sentHeaders.get('Prefer')).toBe('return=representation, respond-async');
  expect(headers.get('Prefer')).toBe('return=representation');
});

it('keeps polling asynchronous work beyond the old two-minute window without resubmitting', async () => {
  const started = Date.now();
  fetchMock.mockImplementation(async () => Date.now() - started >= 150_000 ? completed() : pending());
  const result = sendOrRecoverDocumentRequest({ statusUrl, submit });
  await vi.advanceTimersByTimeAsync(150_000);
  expect((await result).payload.status).toBe('completed');
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
  expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Prefer')).toBe('respond-async');
  expect(fetchMock.mock.calls.slice(1).every(([url, init]) => url === statusUrl && init.method !== 'POST')).toBe(true);
});

it('recovers a POST that never acknowledges asynchronous processing after eight seconds', async () => {
  fetchMock.mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(completed());
  const result = sendOrRecoverDocumentRequest({ statusUrl, submit });
  await vi.advanceTimersByTimeAsync(9_500);
  expect((await result).payload.status).toBe('completed');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][0]).toBe(statusUrl);
});

it.each(['lost', 'http503', 'invalid-json'])('recovers %s submission without another execution', async failure => {
  if (failure === 'lost') fetchMock.mockRejectedValueOnce(new TypeError('network'));
  if (failure === 'http503') fetchMock.mockResolvedValueOnce(Response.json({ status: 'failed' }, { status: 503 }));
  if (failure === 'invalid-json') fetchMock.mockResolvedValueOnce(new Response('<html>proxy</html>'));
  fetchMock.mockResolvedValueOnce(completed());
  const result = sendOrRecoverDocumentRequest({ statusUrl, submit });
  await vi.advanceTimersByTimeAsync(2_000);
  expect((await result).payload.status).toBe('completed');
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
});

it('does not treat a failed receipt read as proof that execution failed', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ status: 'failed', error: 'DATABASE_UNAVAILABLE' }, { status: 503 }))
    .mockResolvedValueOnce(completed());
  const result = sendOrRecoverDocumentRequest({ statusUrl });
  await vi.advanceTimersByTimeAsync(1_500);
  expect((await result).payload.status).toBe('completed');
  expect(fetchMock.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
});

it('an explicit retry first checks the receipt and never repeats completed work', async () => {
  fetchMock.mockResolvedValue(completed());
  expect((await sendOrRecoverDocumentRequest({ statusUrl, submit, retry: true })).payload.status).toBe('completed');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toBe(statusUrl);
});

it('an explicit retry only reuses original input after a confirmed retryable failure', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ status: 'failed', retryable: true, error: 'AI_COLLABORATION_TIMEOUT' }))
    .mockResolvedValueOnce(completed());
  expect((await sendOrRecoverDocumentRequest({ statusUrl, submit, retry: true })).payload.status).toBe('completed');
  expect(fetchMock.mock.calls[1][1]).toMatchObject(submit);
});

it('a query remains read-only even when the request failed', async () => {
  fetchMock.mockResolvedValue(Response.json({ status: 'failed', retryable: true }));
  expect((await sendOrRecoverDocumentRequest({ statusUrl })).payload.status).toBe('failed');
  expect(fetchMock).toHaveBeenCalledOnce();
});

it('keeps confirmed non-retryable and cancelled outcomes terminal', async () => {
  for (const status of ['failed', 'cancelled']) {
    fetchMock.mockResolvedValueOnce(Response.json({ status, retryable: false }));
    expect((await sendOrRecoverDocumentRequest({ statusUrl, submit, retry: true })).payload.status).toBe(status);
  }
  expect(fetchMock.mock.calls.every(([, init]) => init.method !== 'POST')).toBe(true);
});

it('cancelling aborts a pending wait without waiting for the deadline', async () => {
  fetchMock.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const result = sendOrRecoverDocumentRequest({ statusUrl, submit, signal: controller.signal });
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await assertion;
  expect(fetchMock).toHaveBeenCalledOnce();
});
