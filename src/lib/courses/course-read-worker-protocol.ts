import type { ProgressTimingSpan } from '@/lib/observability/progress-request-timing';
export const COURSE_READ_WORKER_PROTOCOL = 1;
export type CourseReadOperation = 'courses' | 'state' | 'projection' | 'events';
export type CourseReadExecuteMessage = { type: 'execute'; id: number; operation: CourseReadOperation;
  url: string; headers: [string, string][]; courseId?: string };
export type CourseReadWorkerRequest = CourseReadExecuteMessage | { type: 'stats'; id: number } | { type: 'shutdown' };
export type CourseReadWorkerResult = { type: 'result'; id: number; status: number; statusText: string;
  headers: [string, string][]; cookies: string[]; body: ArrayBuffer | null;
  phaseSpans: ProgressTimingSpan[]; executionMs: number };
export type CourseReadWorkerStats = { type: 'stats'; id: number;
  memory: { heapUsed: number; heapTotal: number; external: number; arrayBuffers: number };
  threadCpu: { user: number; system: number } | null; sampledAtMs: number; monotonicNs: string };
export type CourseReadWorkerMessage = CourseReadWorkerResult | CourseReadWorkerStats
  | { type: 'ready'; protocol: 1 } | { type: 'closed' }
  | { type: 'error'; id: number; code: 'COURSE_READ_FAILED'; message: string }
  | { type: 'fatal'; error: string }
  | { type: 'self-check'; protocol: 1; prismaVersion: string; clientPath: string; generatedClientPath: string; enginePaths: string[] };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const MAX_HEADER_BYTES = 128 * 1024;
const encoder = new TextEncoder();
function oversizedHeaders(headers: unknown): boolean {
  if (!Array.isArray(headers)) return false;
  if (headers.length > 128) return true;
  let bytes = 0;
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(value => typeof value === 'string')) continue;
    if (pair[0].length > 256 || pair[1].length > 65_536) return true;
    // Include each field's colon/space/CRLF; count UTF8, not JS code units.
    bytes += encoder.encode(pair[0]).byteLength + encoder.encode(pair[1]).byteLength + 4;
    if (bytes > MAX_HEADER_BYTES) return true;
  }
  return false;
}

/** User-controlled limits are rejected by the parent before shared worker admission. */
export function courseReadRequestValidationStatus(value: unknown): 400 | 414 | 431 | null {
  if (isCourseReadExecuteMessage(value)) return null;
  if (!record(value)) return 400;
  if (typeof value.url === 'string' && value.url.length > 16_384) return 414;
  if (oversizedHeaders(value.headers)) return 431;
  return 400;
}
export function isCourseReadExecuteMessage(value: unknown): value is CourseReadExecuteMessage {
  if (!record(value) || value.type !== 'execute' || !id(value.id) || !['courses', 'state', 'projection', 'events'].includes(String(value.operation))
    || typeof value.url !== 'string' || value.url.length > 16_384 || !Array.isArray(value.headers) || value.headers.length > 128
    || !value.headers.every(h => Array.isArray(h) && h.length === 2 && h.every(v => typeof v === 'string') && h[0].length <= 256 && h[1].length <= 65_536)
    || oversizedHeaders(value.headers)
    || Object.keys(value).some(k => !['type', 'id', 'operation', 'url', 'headers', 'courseId'].includes(k))) return false;
  try {
    const url = new URL(value.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (value.operation === 'courses') return value.courseId === undefined && /^\/api\/courses\/?$/.test(url.pathname);
    if (typeof value.courseId !== 'string' || !value.courseId || value.courseId.length > 256) return false;
    const match = /^\/api\/courses\/([^/]+)\/(state|projection|events)\/?$/.exec(url.pathname);
    return !!match && match[2] === value.operation && decodeURIComponent(match[1]) === value.courseId;
  } catch { return false; }
}
export function isCourseReadWorkerRequest(value: unknown): value is CourseReadWorkerRequest {
  return isCourseReadExecuteMessage(value) || (record(value) && (
    value.type === 'stats' && id(value.id) && Object.keys(value).every(k => ['type', 'id'].includes(k))
    || value.type === 'shutdown' && Object.keys(value).length === 1));
}
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
// Fixed phases shared by all read cores, including their nested repository scopes.
const readPhases = new Set(['courses-auth', 'courses-scope', 'courses-read']);
export function isCourseReadWorkerResult(value: unknown): value is CourseReadWorkerResult {
  if (!record(value) || value.type !== 'result' || !id(value.id) || !Number.isInteger(value.status)
    || Number(value.status) < 200 || Number(value.status) > 599 || typeof value.statusText !== 'string'
    || value.statusText.length > 1_024 || /[\r\n]/.test(value.statusText)
    || !nonnegative(value.executionMs) || !Array.isArray(value.headers) || value.headers.length > 128
    || !value.headers.every(h => Array.isArray(h) && h.length === 2 && typeof h[0] === 'string' && typeof h[1] === 'string'
      && h[0].length <= 256 && h[1].length <= 65_536 && h[0].toLowerCase() !== 'set-cookie')
    || !Array.isArray(value.cookies) || value.cookies.length > 32 || !value.cookies.every(c => typeof c === 'string' && c.length <= 65_536 && !/[\r\n]/.test(c))
    || !(value.body === null || value.body instanceof ArrayBuffer)
    || [204, 205, 304].includes(Number(value.status)) && value.body !== null
    || !Array.isArray(value.phaseSpans) || value.phaseSpans.length > 64
    || !value.phaseSpans.every(span => record(span) && readPhases.has(String(span.phase))
      && Number.isSafeInteger(span.sequence) && Number(span.sequence) >= 0 && nonnegative(span.startMs)
      && nonnegative(span.endMs) && span.endMs >= span.startMs && span.endMs <= Number(value.executionMs)
      && ['ok', 'error'].includes(String(span.outcome)) && span.origin === undefined)) return false;
  try { new Headers(value.headers); return true; } catch { return false; }
}
export function isCourseReadWorkerStats(value: unknown): value is CourseReadWorkerStats {
  if (!record(value) || !record(value.memory)) return false;
  const memory = value.memory;
  return value.type === 'stats' && id(value.id)
    && ['heapUsed', 'heapTotal', 'external', 'arrayBuffers'].every(key => nonnegative(memory[key]))
    && (value.threadCpu === null || record(value.threadCpu) && nonnegative(value.threadCpu.user) && nonnegative(value.threadCpu.system))
    && nonnegative(value.sampledAtMs) && typeof value.monotonicNs === 'string' && /^\d+$/.test(value.monotonicNs);
}
export async function courseReadResponseMessage(id: number, response: Response,
  phaseSpans: ProgressTimingSpan[], executionMs: number): Promise<CourseReadWorkerResult> {
  return { type: 'result', id, status: response.status, statusText: response.statusText,
    headers: [...response.headers].filter(([name]) => name.toLowerCase() !== 'set-cookie'),
    cookies: response.headers.getSetCookie(),
    body: [204, 205, 304].includes(response.status) || response.body === null ? null : await response.arrayBuffer(),
    phaseSpans, executionMs };
}
export function courseReadResultToResponse(result: CourseReadWorkerResult): Response {
  const headers = new Headers(result.headers);
  for (const cookie of result.cookies) headers.append('Set-Cookie', cookie);
  return new Response(result.body, { status: result.status, statusText: result.statusText, headers });
}
