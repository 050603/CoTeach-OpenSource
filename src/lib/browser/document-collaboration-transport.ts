import { DOCUMENT_COLLABORATION_BROWSER_TIMEOUT_MS } from '@/lib/ai-collaboration/request-budget';
import { boundedFetch } from './bounded-fetch';

export const DOCUMENT_RECEIPT_TIMEOUT_MS = 8_000;

export type DocumentTransportReceipt = {
  status?: 'processing' | 'completed' | 'failed' | 'cancelled';
  phase?: 'queued' | 'running';
  retryAfterMs?: number;
  retryable?: boolean;
  error?: string;
};

/** An unknown transport outcome is never permission to execute the work again. */
export class DocumentRequestUnconfirmedError extends Error {
  constructor() {
    super('暂未确认处理结果，你的消息已保留。可以查询结果或取消这次请求。');
    this.name = 'DocumentRequestUnconfirmedError';
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** One browser wait window includes submission, bodies and all receipt reads.
 * Retries read the durable state first; only a confirmed failed/missing request
 * may be posted again, with the original identity and captured input. */
export async function sendOrRecoverDocumentRequest<T extends DocumentTransportReceipt>(input: {
  statusUrl: string;
  submit?: RequestInit;
  retry?: boolean;
  signal?: AbortSignal;
  onProcessing?: (state: { recovering: boolean; phase?: 'queued' | 'running' }) => void;
}): Promise<{ response: Response; payload: T }> {
  const deadline = Date.now() + DOCUMENT_COLLABORATION_BROWSER_TIMEOUT_MS;
  const remaining = () => Math.max(0, deadline - Date.now());
  const read = async (post: boolean) => {
    if (!remaining()) throw new DocumentRequestUnconfirmedError();
    const submitHeaders = new Headers(input.submit?.headers);
    if (!submitHeaders.get('Prefer')?.split(',').some((value) => value.trim().toLowerCase() === 'respond-async')) {
      submitHeaders.append('Prefer', 'respond-async');
    }
    const response = await boundedFetch(post ? '/api/ai-collaboration/document' : input.statusUrl,
      { ...(post ? { ...input.submit, headers: submitHeaders } : { cache: 'no-store' as const }), signal: input.signal },
      Math.min(DOCUMENT_RECEIPT_TIMEOUT_MS, remaining()));
    const payload = await response.json() as T;
    if (!payload || typeof payload !== 'object') throw new DocumentRequestUnconfirmedError();
    return { response, payload };
  };
  let shouldPost = Boolean(input.submit) && !input.retry;
  let retryMayPost = Boolean(input.submit && input.retry);
  let recovering = !shouldPost;
  while (remaining()) {
    input.signal?.throwIfAborted();
    try {
      const posted = shouldPost;
      shouldPost = false;
      const current = await read(posted);
      const { response, payload } = current;
      // A 5xx reply may have been produced after committing a successful result.
      // Always read its receipt before exposing a failure to the student.
      if (posted && response.status >= 500) {
        recovering = true;
        input.onProcessing?.({ recovering });
        continue;
      }
      if (!posted && response.status >= 500) {
        recovering = true;
        input.onProcessing?.({ recovering });
        await pause(Math.min(1_500, remaining()), input.signal);
        continue;
      }
      if (!posted && retryMayPost) {
        retryMayPost = false;
        if ((payload.status === 'failed' && payload.retryable === true)
          || (response.status === 404 && payload.error === 'REQUEST_NOT_FOUND')) {
          shouldPost = true;
          continue;
        }
      }
      if (payload.status === 'completed' || payload.status === 'failed' || payload.status === 'cancelled') return current;
      if (payload.status === 'processing' || response.status === 202) {
        input.onProcessing?.({ recovering, phase: payload.phase });
      } else if (response.status >= 400 && response.status < 500) {
        return current;
      } else if (posted && response.ok && 'result' in payload) {
        // Read old completed responses which predate durable status fields.
        return current;
      } else {
        recovering = true;
        input.onProcessing?.({ recovering });
      }
      await pause(Math.min(remaining(), Math.min(5_000, Math.max(750, payload.retryAfterMs ?? 1_500))), input.signal);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      recovering = true;
      input.onProcessing?.({ recovering });
      if (remaining()) await pause(Math.min(1_500, remaining()), input.signal);
    }
  }
  throw new DocumentRequestUnconfirmedError();
}
