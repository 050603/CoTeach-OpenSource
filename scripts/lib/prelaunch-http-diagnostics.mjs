import { createWriteStream } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { isMonacoStaticResourcePath, MONACO_STATIC_DIAGNOSTIC_ROUTE } from './runtime-resource-path.mjs';

const TRACE_ID = /^acceptance-[a-f0-9]{8}-\d+-\d+$/;
// Same bounded wire protocol as observability/action-entry-timing.ts. Node 22
// tooling intentionally does not import application TypeScript modules.
export function readNativeHttpRequestId(value) {
  if (typeof value !== 'string' || !/^http-[a-f0-9]{32}-[1-9][0-9]{0,15}$(?![\s\S])/.test(value)) return undefined;
  return Number.isSafeInteger(Number(value.slice(38))) ? value : undefined;
}
export function diagnosticRoute(method, pathname) {
  if (['GET', 'HEAD'].includes(method) && (pathname === MONACO_STATIC_DIAGNOSTIC_ROUTE
    || isMonacoStaticResourcePath(pathname))) return MONACO_STATIC_DIAGNOSTIC_ROUTE;
  if (method === 'GET' && (pathname === '/api/openmaic/interactive-runtime/:runtime/:path'
    || /^\/api\/openmaic\/interactive-runtime\/(monaco|codemirror|katex|pyodide|three)\/.+/.test(pathname))) {
    return '/api/openmaic/interactive-runtime/:runtime/:path';
  }
  if (method === 'GET' && /^\/api\/openmaic\/classroom-media\/[^/]+\/.+/.test(pathname)) {
    return '/api/openmaic/classroom-media/:classroomId/:path';
  }
  if (['PUT', 'DELETE'].includes(method) && /^\/api\/courses\/[^/]+\/presence\/?$/.test(pathname)) {
    return '/api/courses/:courseId/presence';
  }
  if (pathname === '/api/openmaic/progress' && ['GET', 'POST'].includes(method)) return pathname;
  if (method === 'GET' && ['/api/server-providers', '/api/openmaic/classroom'].includes(pathname)) return pathname;
  if (method === 'GET' && ['/api/courses', '/api/ai-collaboration/document', '/api/ai-collaboration/code', '/api/ai-collaboration/memory'].includes(pathname)) return pathname;
  if (method === 'POST' && ['/api/learning-events', '/api/project-practice/submissions/finalize'].includes(pathname)) return pathname;
  if (method === 'GET') {
    if (/^\/api\/courses\/[^/]+\/showcase\/presentation\/?$/.test(pathname)) return '/api/courses/:courseId/showcase/presentation';
    if (/^\/api\/courses\/[^/]+\/showcase\/artifacts\/export\/?$/.test(pathname)) return '/api/courses/:courseId/showcase/artifacts/export';
    if (/^\/api\/courses\/[^/]+\/showcase\/artifacts\/[^/]+\/?$/.test(pathname)) return '/api/courses/:courseId/showcase/artifacts/:versionId';
  }
  const classroomRead = method === 'GET' && /^\/api\/courses\/[^/]+\/(presence|state|events|projection|public-discussion)\/?$/.exec(pathname);
  if (classroomRead) return `/api/courses/:courseId/${classroomRead[1]}`;
  if (method === 'POST' && /^\/api\/courses\/[^/]+\/actions\/?$/.test(pathname)) return '/api/courses/:courseId/actions';
  return null;
}

/** Only preselected metadata may be passed here. Never pause the HTTP pipe or
 * app stdout on disk backpressure; a bounded journal failure is reported at close. */
export function createMetadataJournal(file) {
  const stream = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  let failure; let closed = false;
  stream.on('error', error => { failure ??= error.code ?? 'JOURNAL_WRITE_ERROR'; });
  return {
    write(row) {
      if (closed || failure) return;
      if (stream.writableLength > 16 * 1024 * 1024) { failure = 'JOURNAL_BUFFER_LIMIT'; return; }
      stream.write(`${JSON.stringify(row)}\n`);
    },
    async close() {
      if (closed) return;
      closed = true;
      // destroyed can precede the asynchronous error/close events. Wait for
      // actual close so a pending disk error cannot be mistaken for success.
      if (!stream.closed) await new Promise(resolve => {
        stream.once('close', resolve); if (!stream.destroyed) stream.end();
      });
      if (failure) throw new Error(`Acceptance diagnostic journal incomplete: ${failure}`);
    },
  };
}

/** Pino timestamp is captured at logger.info, after handlerReturnedAtMs and
 * metrics. Legacy records without explicit boundaries remain usable, but their
 * timestamp-duration is only approximate. Never synthesize missing clocks.
 * Discard all body/error/credential/user fields, even if the logger emitted them. */
export function selectAppCompletion(line) {
  let row; try { row = JSON.parse(line); } catch { return null; }
  const httpRequestId = readNativeHttpRequestId(row?.httpRequestId);
  const requestId = typeof row?.requestId === 'string' && TRACE_ID.test(row.requestId) ? row.requestId : undefined;
  const correlation = { ...(requestId ? { requestId } : {}), ...(httpRequestId ? { httpRequestId } : {}) };
  if (row?.message !== 'request completed' || (!requestId && !httpRequestId)
    || typeof row.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.timestamp)
    || !Number.isFinite(Date.parse(row.timestamp)) || !Number.isFinite(row.durationMs) || row.durationMs < 0) return null;
  const route = diagnosticRoute(row.method, row.route);
  if (!route) return null;
  const epochs = {};
  const validEpoch = value => Number.isSafeInteger(value) && value > 0;
  const validStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
  if (route === MONACO_STATIC_DIAGNOSTIC_ROUTE) {
    const completed = row.outcome === 'completed';
    if (row.durationScope !== 'node-parsed-to-response-finish'
      || (!completed && row.outcome !== 'aborted')
      || (completed ? !validStatus(row.status) : row.status !== 0)) return null;
    // Static delivery has no application handler or Next auth Proxy boundary.
    // Its native finish includes the response body. Never infer those clocks
    // from a logger timestamp or accept caller-supplied handler/Proxy fields.
    const endKey = completed ? 'nodeResponseFinishedAtMs' : 'nodeResponseClosedAtMs';
    if (validEpoch(row.nodeHttpReceivedAtMs) && validEpoch(row[endKey]) && row[endKey] >= row.nodeHttpReceivedAtMs) {
      epochs.nodeHttpReceivedAtMs = row.nodeHttpReceivedAtMs;
      epochs[endKey] = row[endKey];
      if (validEpoch(row.nodeSocketAcceptedAtMs) && row.nodeSocketAcceptedAtMs <= row.nodeHttpReceivedAtMs) {
        epochs.nodeSocketAcceptedAtMs = row.nodeSocketAcceptedAtMs;
      }
      if (Number.isSafeInteger(row.nodeHttpLocalPort) && row.nodeHttpLocalPort > 0 && row.nodeHttpLocalPort <= 65535) {
        epochs.nodeHttpLocalPort = row.nodeHttpLocalPort;
      }
      if (Number.isSafeInteger(row.nodeConnectionId) && row.nodeConnectionId > 0) epochs.nodeConnectionId = row.nodeConnectionId;
    }
    return { event: 'request-completed', ...correlation, timestamp: row.timestamp,
      method: row.method, route, status: row.status, durationMs: row.durationMs,
      durationScope: row.durationScope, outcome: row.outcome,
      ...(!completed && validStatus(row.receivedHttpStatus) ? { receivedHttpStatus: row.receivedHttpStatus } : {}), ...epochs };
  }
  if (!validStatus(row.status) || row.durationScope === 'node-parsed-to-response-finish') return null;
  if (validEpoch(row.handlerEnteredAtMs) && validEpoch(row.handlerReturnedAtMs)
    && row.handlerReturnedAtMs >= row.handlerEnteredAtMs) {
    epochs.handlerEnteredAtMs = row.handlerEnteredAtMs;
    epochs.handlerReturnedAtMs = row.handlerReturnedAtMs;
    if (validEpoch(row.nextProxyStartedAtMs) && validEpoch(row.nextProxyEndedAtMs)
      && row.nextProxyEndedAtMs >= row.nextProxyStartedAtMs
      && row.handlerEnteredAtMs >= row.nextProxyEndedAtMs
      && row.handlerEnteredAtMs - row.nextProxyStartedAtMs <= 120000) {
      epochs.nextProxyStartedAtMs = row.nextProxyStartedAtMs;
      epochs.nextProxyEndedAtMs = row.nextProxyEndedAtMs;
    }
    // The native HTTP clock is useful even if the Next Proxy pair is absent.
    // Reject a reversed Node -> Proxy boundary instead of inventing zero time.
    if (validEpoch(row.nodeHttpReceivedAtMs)
      && row.handlerEnteredAtMs >= row.nodeHttpReceivedAtMs
      && row.handlerEnteredAtMs - row.nodeHttpReceivedAtMs <= 120000
      && (epochs.nextProxyStartedAtMs === undefined || row.nodeHttpReceivedAtMs <= epochs.nextProxyStartedAtMs)) {
      epochs.nodeHttpReceivedAtMs = row.nodeHttpReceivedAtMs;
      // Socket age includes earlier keep-alive requests and idle time. Do not
      // apply the per-request 120s age limit or infer a missing accept clock.
      if (validEpoch(row.nodeSocketAcceptedAtMs) && row.nodeSocketAcceptedAtMs <= row.nodeHttpReceivedAtMs) {
        epochs.nodeSocketAcceptedAtMs = row.nodeSocketAcceptedAtMs;
      }
      if (Number.isSafeInteger(row.nodeHttpLocalPort) && row.nodeHttpLocalPort > 0 && row.nodeHttpLocalPort <= 65535) {
        epochs.nodeHttpLocalPort = row.nodeHttpLocalPort;
      }
      if (Number.isSafeInteger(row.nodeConnectionId) && row.nodeConnectionId > 0) epochs.nodeConnectionId = row.nodeConnectionId;
    }
  }
  return { event: 'request-completed', ...correlation, timestamp: row.timestamp,
    method: row.method, route, status: row.status, durationMs: row.durationMs,
    ...(row.durationScope === 'handler' ? { durationScope: 'handler' } : {}), ...epochs };
}

/** Continuously retain safe completion metadata from stdout AND stderr. Other
 * output is counted, never copied: arbitrary console output can contain model
 * text or credentials. The verifier's existing 12KiB in-memory tail is separate. */
export function createAppRequestJournal(file) {
  const journal = createMetadataJournal(file); const endings = [];
  return {
    attach(child, onChunk) {
      journal.write({ event: 'app-start', pid: child.pid, capturedAt: new Date().toISOString() });
      for (const source of ['stdout', 'stderr']) {
        const stream = child[source]; const decoder = new StringDecoder('utf8');
        let pending = ''; let discarding = false; let omittedLines = 0; let ended = false;
        const line = value => {
          const selected = selectAppCompletion(value);
          if (selected) journal.write({ ...selected, pid: child.pid, source, capturedAt: new Date().toISOString() });
          else omittedLines++;
        };
        const consume = text => {
          for (;;) {
            const newline = text.indexOf('\n');
            if (newline < 0) {
              if (!discarding) pending += text;
              if (pending.length > 16384) { pending = ''; discarding = true; }
              return;
            }
            const part = text.slice(0, newline); text = text.slice(newline + 1);
            if (discarding || pending.length + part.length > 16384) omittedLines++;
            else line(pending + part);
            pending = ''; discarding = false;
          }
        };
        stream.on('data', chunk => { onChunk(chunk); consume(decoder.write(chunk)); });
        endings.push(new Promise(resolve => {
          const finish = () => {
            if (ended) return; ended = true; consume(decoder.end());
            if (pending || discarding) omittedLines++;
            journal.write({ event: 'app-stream-end', pid: child.pid, source, omittedLines }); resolve();
          };
          stream.once('end', finish); stream.once('close', finish);
        }));
      }
    },
    async close() {
      let timer;
      // Keep the race winner immutable: a late stream end while the file drains
      // must not turn a deadline miss (and discarded final rows) into success.
      const complete = await Promise.race([
        Promise.all(endings).then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); }),
      ]).finally(async () => { clearTimeout(timer); await journal.close(); });
      if (!complete) throw new Error('Acceptance app diagnostic streams did not finish');
    },
  };
}
