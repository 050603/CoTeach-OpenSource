import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createAppRequestJournal, createMetadataJournal, diagnosticRoute, selectAppCompletion, readNativeHttpRequestId } from './prelaunch-http-diagnostics.mjs';
import { MONACO_STATIC_DIAGNOSTIC_ROUTE } from './runtime-resource-path.mjs';

const completion = extra => ({ message: 'request completed', requestId: 'acceptance-12abcdef-101-1',
  timestamp: '2026-10-16T06:00:00.123Z', method: 'POST', route: '/api/openmaic/progress',
  status: 200, durationMs: 124, ...extra });
const child = pid => ({ pid, stdout: new PassThrough(), stderr: new PassThrough() });

test('a rewritten static request retains separate handler and native body scopes for one HTTP attempt', () => {
  const httpRequestId = `http-${'a'.repeat(32)}-1`;
  const handler = selectAppCompletion(JSON.stringify(completion({
    method: 'GET', route: '/api/openmaic/interactive-runtime/:runtime/:path', httpRequestId,
    durationScope: 'handler', durationMs: 10, nodeHttpReceivedAtMs: 1000,
    handlerEnteredAtMs: 1005, handlerReturnedAtMs: 1015,
  })));
  const delivery = selectAppCompletion(JSON.stringify(completion({
    method: 'GET', route: MONACO_STATIC_DIAGNOSTIC_ROUTE, httpRequestId,
    durationScope: 'node-parsed-to-response-finish', outcome: 'completed',
    durationMs: 150, nodeHttpReceivedAtMs: 1000, nodeResponseFinishedAtMs: 1150,
  })));
  assert.equal(handler.httpRequestId, delivery.httpRequestId);
  assert.equal(handler.durationScope, 'handler');
  assert.equal(delivery.durationScope, 'node-parsed-to-response-finish');
  assert.equal(handler.handlerReturnedAtMs, 1015);
  assert.equal(delivery.nodeResponseFinishedAtMs, 1150);
  assert.ok(!Object.hasOwn(handler, 'nodeResponseFinishedAtMs'));
  assert.ok(!Object.hasOwn(delivery, 'handlerReturnedAtMs'));
  assert.notEqual(handler.route, delivery.route);
});

test('immutable runtime native completion measures body finish without fabricating a handler or Proxy', () => {
  const path = `/_next/static/openpbl-runtime/monaco/0.56.0/${'a'.repeat(64)}/vs/base/worker/workerMain.js`;
  for (const method of ['GET', 'HEAD']) {
    assert.equal(diagnosticRoute(method, path), MONACO_STATIC_DIAGNOSTIC_ROUTE);
    const input = completion({ method, route: path, durationScope: 'node-parsed-to-response-finish', outcome: 'completed',
      nodeHttpReceivedAtMs: 1000, nodeResponseFinishedAtMs: 1400, nodeSocketAcceptedAtMs: 900,
      nodeHttpLocalPort: 3197, nodeConnectionId: 3, durationMs: 400,
      handlerEnteredAtMs: 1001, handlerReturnedAtMs: 1401, nextProxyStartedAtMs: 1002, nextProxyEndedAtMs: 1003,
      nodeResponseClosedAtMs: 1500, receivedHttpStatus: 499, query: 'private-query', assetPath: 'private-path', cookie: 'private' });
    const output = selectAppCompletion(JSON.stringify(input));
    assert.deepEqual(output, { event: 'request-completed', requestId: input.requestId, timestamp: input.timestamp,
      method, route: MONACO_STATIC_DIAGNOSTIC_ROUTE, status: 200, durationMs: 400,
      durationScope: 'node-parsed-to-response-finish', outcome: 'completed', nodeHttpReceivedAtMs: 1000,
      nodeResponseFinishedAtMs: 1400, nodeSocketAcceptedAtMs: 900, nodeHttpLocalPort: 3197, nodeConnectionId: 3 });
    for (const changes of [{ nodeHttpReceivedAtMs: '1000' }, { nodeResponseFinishedAtMs: 999 },
      { nodeResponseFinishedAtMs: undefined }, { nodeHttpReceivedAtMs: 0 }]) {
      const unknown = selectAppCompletion(JSON.stringify({ ...input, ...changes }));
      assert.equal(unknown.durationMs, 400);
      for (const field of ['nodeHttpReceivedAtMs', 'nodeResponseFinishedAtMs', 'nodeSocketAcceptedAtMs', 'nodeConnectionId', 'nodeHttpLocalPort']) {
        assert.ok(!Object.hasOwn(unknown, field), field);
      }
    }
    const aborted = selectAppCompletion(JSON.stringify({ ...input, status: 0, receivedHttpStatus: 200,
      outcome: 'aborted', nodeResponseClosedAtMs: 1300 }));
    assert.equal(aborted.status, 0); assert.equal(aborted.receivedHttpStatus, 200);
    assert.equal(aborted.nodeResponseClosedAtMs, 1300); assert.ok(!Object.hasOwn(aborted, 'nodeResponseFinishedAtMs'));
    for (const changes of [{ outcome: 'unknown' }, { status: 0 }, { durationScope: undefined },
      { outcome: 'aborted', status: 499 }, { route: '/api/ai-collaboration/document' }]) {
      assert.equal(selectAppCompletion(JSON.stringify({ ...input, ...changes })), null);
    }
  }
  assert.equal(diagnosticRoute('POST', path), null);
  assert.equal(diagnosticRoute('GET', path.replace('a'.repeat(64), 'a'.repeat(63))), null);
  assert.equal(diagnosticRoute('GET', '/_next/static/chunks/app.js'), null);
});

test('showcase metadata and artifact diagnostics retain only fixed GET routes', () => {
  for (const [path, expected] of [
    ['/api/courses/private/showcase/presentation', '/api/courses/:courseId/showcase/presentation'],
    ['/api/courses/private/showcase/artifacts/export', '/api/courses/:courseId/showcase/artifacts/export'],
    ['/api/courses/private/showcase/artifacts/private-version', '/api/courses/:courseId/showcase/artifacts/:versionId'],
  ]) {
    assert.equal(diagnosticRoute('GET', path), expected);
    assert.equal(diagnosticRoute('POST', path), null);
    assert.equal(diagnosticRoute('GET', `${path}/extra`), null);
    const input = completion({ method: 'GET', route: path, handlerEnteredAtMs: 1010, handlerReturnedAtMs: 1050,
      nodeHttpReceivedAtMs: 1000, query: 'private', sourceHtml: 'private', versionId: 'private' });
    const selected = selectAppCompletion(JSON.stringify(input));
    assert.equal(selected.route, expected); assert.equal(selected.nodeHttpReceivedAtMs, 1000);
    for (const field of ['query', 'sourceHtml', 'versionId']) assert.ok(!Object.hasOwn(selected, field));
  }
});

test('stability diagnostics cover the measured read and save hotspots without collecting input', () => {
  for (const [method, route] of [['GET', '/api/courses'], ['GET', '/api/ai-collaboration/document'],
    ['GET', '/api/ai-collaboration/code'], ['GET', '/api/ai-collaboration/memory'],
    ['POST', '/api/learning-events'], ['POST', '/api/project-practice/submissions/finalize']]) {
    const row = selectAppCompletion(JSON.stringify(completion({ method, route, requestBody: 'private', query: 'private' })));
    assert.equal(row.route, route); assert.equal(row.requestBody, undefined); assert.equal(row.query, undefined);
    assert.equal(diagnosticRoute(method, `${route}/unexpected`), null);
  }
});

test('polling read correlation retains route clocks without expanding to writes or subpaths', () => {
  for (const route of ['state', 'events', 'projection']) {
    const canonical = `/api/courses/:courseId/${route}`;
    assert.equal(diagnosticRoute('GET', `/api/courses/synthetic/${route}`), canonical);
    assert.equal(diagnosticRoute('POST', `/api/courses/synthetic/${route}`), null);
    assert.equal(diagnosticRoute('GET', `/api/courses/synthetic/${route}/extra`), null);
    const row = selectAppCompletion(JSON.stringify(completion({ method: 'GET', route: canonical,
      nextProxyStartedAtMs: 1000, nextProxyEndedAtMs: 1005,
      handlerEnteredAtMs: 1010, handlerReturnedAtMs: 1050,
      query: '?after=private-cursor', payload: { secret: 'private-document' },
    })));
    assert.equal(row.route, canonical);
    assert.equal(row.handlerEnteredAtMs, 1010);
    assert.equal(row.handlerReturnedAtMs, 1050);
    assert.equal(row.nextProxyStartedAtMs, 1000);
    assert.equal(row.nextProxyEndedAtMs, 1005);
    assert.equal(row.query, undefined); assert.equal(row.payload, undefined);
  }
});
async function directory(t) {
  const folder = await mkdtemp(path.join(tmpdir(), 'acceptance-diagnostic-test-'));
  t.after(() => rm(folder, { recursive: true, force: true })); return folder;
}

test('completion allowlist retains measured metadata without leaking nested fields or inventing correlation', () => {
  const input = completion({ authorization: 'private-auth', apiKey: 'private-key',
    payload: { body: 'private-document', token: 'private-token' }, userId: 'private-user',
    error: { message: 'private-provider-body' }, traceId: 'unrelated-trace' });
  assert.deepEqual(selectAppCompletion(JSON.stringify(input)), {
    event: 'request-completed', requestId: input.requestId, timestamp: input.timestamp,
    method: input.method, route: input.route, status: 200, durationMs: 124,
  });
  assert.equal(selectAppCompletion('unstructured private-provider-body'), null);
  assert.equal(selectAppCompletion(JSON.stringify(completion({ requestId: 'existing-client-id' }))), null);
  assert.equal(selectAppCompletion(JSON.stringify(completion({ requestId: [input.requestId] }))), null);
  assert.equal(selectAppCompletion(JSON.stringify(completion({ durationMs: undefined }))), null);
  assert.equal(selectAppCompletion(JSON.stringify(completion({ timestamp: 'not-an-epoch' }))), null);
  // Missing/malformed evidence must remain absent, never become a zero-ms measurement.
  assert.equal(selectAppCompletion('{}'), null);
});

test('continuous log capture handles split UTF8, oversized lines, both streams and replacement app PIDs', async t => {
  const folder = await directory(t); const file = path.join(folder, 'app.ndjson');
  const journal = createAppRequestJournal(file); const first = child(101); const second = child(202);
  const rawChunks = []; journal.attach(first, chunk => rawChunks.push(chunk)); journal.attach(second, chunk => rawChunks.push(chunk));
  const record = Buffer.from(`${JSON.stringify(completion({ hidden: '中文私密原文' }))}\n`);
  const split = record.indexOf(Buffer.from('中')) + 1;
  first.stdout.write(record.subarray(0, split)); first.stdout.write(record.subarray(split));
  first.stdout.write('secret-oversized-' + 'x'.repeat(20000));
  first.stdout.write('more-private-text\n');
  first.stdout.end(`${JSON.stringify(completion({ requestId: 'acceptance-12abcdef-101-2', durationMs: 345 }))}\n`);
  first.stderr.end(`${JSON.stringify(completion({ requestId: 'acceptance-12abcdef-101-4', durationMs: 567 }))}\nprivate-token-in-freeform-error\n`);
  second.stdout.end(`${JSON.stringify(completion({ requestId: 'acceptance-12abcdef-101-3', durationMs: 456 }))}\n`);
  second.stderr.end();
  await journal.close();
  const saved = await readFile(file, 'utf8'); const rows = saved.trim().split('\n').map(line => JSON.parse(line));
  const measured = rows.filter(row => row.event === 'request-completed');
  assert.deepEqual(measured.map(row => [row.requestId, row.pid, row.durationMs]), [
    ['acceptance-12abcdef-101-1', 101, 124], ['acceptance-12abcdef-101-2', 101, 345],
    ['acceptance-12abcdef-101-4', 101, 567], ['acceptance-12abcdef-101-3', 202, 456],
  ]);
  assert.equal(rows.filter(row => row.event === 'app-start').length, 2);
  assert.equal(rows.filter(row => row.event === 'app-stream-end').length, 4);
  assert.equal(rows.find(row => row.event === 'app-stream-end' && row.pid === 101 && row.source === 'stdout').omittedLines, 1);
  assert.equal(rows.find(row => row.event === 'app-stream-end' && row.pid === 101 && row.source === 'stderr').omittedLines, 1);
  for (const value of ['中文私密原文', 'secret-oversized', 'more-private-text', 'private-token']) assert.ok(!saved.includes(value));
  assert.ok(Buffer.concat(rawChunks).includes(Buffer.from('中文私密原文')), 'Existing in-memory tail callback must still receive original chunks');
});

test('journal open/close failures are surfaced and never replace prior evidence with an empty success', async t => {
  const folder = await directory(t); const file = path.join(folder, 'existing.ndjson');
  await writeFile(file, 'prior-evidence\n');
  const journal = createAppRequestJournal(file); const app = child(303);
  journal.attach(app, () => {}); app.stdout.end(`${JSON.stringify(completion())}\n`); app.stderr.end();
  await assert.rejects(journal.close(), /diagnostic journal incomplete: EEXIST/);
  assert.equal(await readFile(file, 'utf8'), 'prior-evidence\n');
  const missing = createMetadataJournal(path.join(folder, 'absent', 'trace.ndjson'));
  missing.write({ event: 'not-a-success' });
  await assert.rejects(missing.close(), /diagnostic journal incomplete: ENOENT/);
});

test('a stream end after the shutdown deadline cannot change a timed-out close into success', async t => {
  const folder = await directory(t); const file = path.join(folder, 'late-end.ndjson');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const journal = createAppRequestJournal(file); const app = child(404);
  journal.attach(app, () => {});
  app.stdout.write(`${JSON.stringify(completion())}\n`);
  const closing = journal.close();
  const rejected = assert.rejects(closing, /app diagnostic streams did not finish/);
  // Advance only the real helper's existing 3-second deadline. File I/O and
  // PassThrough events remain real; no production timeout override is added.
  t.mock.timers.tick(3000);
  // Drain Promise.race's continuation so it starts closing the file. No I/O
  // turn occurs yet, so EOF below arrives while that real close is pending.
  await new Promise(resolve => queueMicrotask(resolve));
  app.stdout.end(`${JSON.stringify(completion({ requestId: 'acceptance-12abcdef-101-99' }))}\n`);
  app.stderr.end();
  await rejected;
  const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(rows.some(row => row.requestId === 'acceptance-12abcdef-101-1'), 'Rows captured before the deadline remain available');
  assert.ok(!rows.some(row => row.requestId === 'acceptance-12abcdef-101-99'), 'Late rows were discarded after close began, so success would be incorrect');
});


test('completion allowlist retains only measured boundary pairs and drops unrelated clock/header fields', () => {
  const entered = Date.parse('2026-10-16T06:00:00.000Z');
  const boundaries = { handlerEnteredAtMs: entered, handlerReturnedAtMs: entered + 100,
    nextProxyStartedAtMs: entered - 80, nextProxyEndedAtMs: entered - 20 };
  const input = completion({ ...boundaries, headers: { authorization: 'private-header' },
    sourceClock: { cookie: 'private-cookie' }, nextProxyExtraAtMs: entered - 90 });
  const output = selectAppCompletion(JSON.stringify(input));
  assert.deepEqual(output, { event: 'request-completed', requestId: input.requestId,
    timestamp: input.timestamp, method: input.method, route: input.route, status: input.status,
    durationMs: input.durationMs, ...boundaries });
  for (const changes of [
    { nextProxyStartedAtMs: undefined }, { nextProxyStartedAtMs: String(entered - 80) },
    { nextProxyStartedAtMs: 0 }, { nextProxyStartedAtMs: -1 },
    { nextProxyEndedAtMs: entered - 100 }, { nextProxyEndedAtMs: entered + 1 },
    { nextProxyStartedAtMs: entered - 120001 }, { nextProxyStartedAtMs: entered - 80.5 },
  ]) {
    const filtered = selectAppCompletion(JSON.stringify(completion({ ...boundaries, ...changes })));
    assert.equal(filtered.handlerEnteredAtMs, entered);
    assert.equal(filtered.handlerReturnedAtMs, entered + 100);
    assert.ok(!Object.hasOwn(filtered, 'nextProxyStartedAtMs'));
    assert.ok(!Object.hasOwn(filtered, 'nextProxyEndedAtMs'));
  }
  for (const changes of [
    { handlerEnteredAtMs: undefined }, { handlerReturnedAtMs: String(entered + 100) },
    { handlerReturnedAtMs: entered - 1 }, { handlerEnteredAtMs: 0 },
    { handlerReturnedAtMs: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const filtered = selectAppCompletion(JSON.stringify(completion({ ...boundaries, ...changes })));
    for (const key of Object.keys(boundaries)) assert.ok(!Object.hasOwn(filtered, key));
  }
  assert.equal(selectAppCompletion(JSON.stringify(completion({ ...boundaries, route: '/api/auth/me' }))), null);
});


test('Node receipt metadata remains measured, ordered and independent of missing Next clocks', () => {
  const entered = Date.parse('2026-10-16T06:00:00.000Z');
  const boundaries = { handlerEnteredAtMs: entered, handlerReturnedAtMs: entered + 100,
    nextProxyStartedAtMs: entered - 80, nextProxyEndedAtMs: entered - 20 };
  const input = completion({ ...boundaries, nodeHttpReceivedAtMs: entered - 150,
    rawHeaders: ['authorization', 'private'], body: 'private', studentId: 'private' });
  const output = selectAppCompletion(JSON.stringify(input));
  assert.equal(output.nodeHttpReceivedAtMs, entered - 150);
  assert.equal(output.nextProxyStartedAtMs, entered - 80);
  for (const key of ['rawHeaders', 'body', 'studentId']) assert.ok(!Object.hasOwn(output, key));
  for (const node of [undefined, null, '', 0, -1, NaN, Infinity, entered - 150.5, String(entered - 150), entered - 120001, entered - 79, entered + 1]) {
    const selected = selectAppCompletion(JSON.stringify(completion({ ...boundaries, nodeHttpReceivedAtMs: node })));
    assert.ok(!Object.hasOwn(selected, 'nodeHttpReceivedAtMs'));
    assert.equal(selected.nextProxyStartedAtMs, entered - 80);
  }
  const nodeOnly = selectAppCompletion(JSON.stringify(completion({ handlerEnteredAtMs: entered,
    handlerReturnedAtMs: entered + 100, nodeHttpReceivedAtMs: entered - 50 })));
  assert.equal(nodeOnly.nodeHttpReceivedAtMs, entered - 50);
  assert.ok(!Object.hasOwn(nodeOnly, 'nextProxyStartedAtMs'));
  assert.ok(!Object.hasOwn(nodeOnly, 'nextProxyEndedAtMs'));
  const noHandler = selectAppCompletion(JSON.stringify(completion({ nodeHttpReceivedAtMs: entered - 50 })));
  assert.ok(!Object.hasOwn(noHandler, 'nodeHttpReceivedAtMs'));
});

test('socket callback and actual listener metadata remain bounded, independent and safe for reused connections', () => {
  const boundary = { handlerEnteredAtMs: 200050, handlerReturnedAtMs: 200100, nodeHttpReceivedAtMs: 200000,
    nodeSocketAcceptedAtMs: 1000, nodeHttpLocalPort: 3197, nodeConnectionId: 12 };
  const row = selectAppCompletion(JSON.stringify(completion({ ...boundary, socket: { cookie: 'private' }, remoteAddress: 'private' })));
  for (const [name, value] of Object.entries(boundary)) assert.equal(row[name], value);
  assert.ok(!Object.hasOwn(row, 'socket')); assert.ok(!Object.hasOwn(row, 'remoteAddress'));
  for (const [name, values] of [
    ['nodeSocketAcceptedAtMs', [undefined, null, 0, -1, 200001, 1.5, '1000']],
    ['nodeHttpLocalPort', [undefined, null, 0, -1, 65536, 3197.5, '3197']],
    ['nodeConnectionId', [undefined, null, 0, -1, 12.5, Number.MAX_SAFE_INTEGER + 1, '12']],
  ]) for (const value of values) {
    const selected = selectAppCompletion(JSON.stringify(completion({ ...boundary, [name]: value })));
    assert.ok(!Object.hasOwn(selected, name)); assert.equal(selected.nodeHttpReceivedAtMs, 200000);
  }
  const noNative = selectAppCompletion(JSON.stringify(completion({ ...boundary, nodeHttpReceivedAtMs: undefined })));
  for (const name of ['nodeHttpReceivedAtMs', 'nodeSocketAcceptedAtMs', 'nodeHttpLocalPort', 'nodeConnectionId']) {
    assert.ok(!Object.hasOwn(noNative, name));
  }
});


test('public runtime clock diagnostics normalize every asset to the existing fixed wrapper route', () => {
  const canonical='/api/openmaic/interactive-runtime/:runtime/:path';
  for (const asset of ['monaco/0.56.0/loader.js','codemirror/5.65.16/lib/codemirror.js','katex/0.18.2/katex.min.js','pyodide/0.25.0/pyodide.asm.wasm','three/0.160.0/build/three.module.js']) {
    assert.equal(diagnosticRoute('GET', `/api/openmaic/interactive-runtime/${asset}`),canonical);
    assert.equal(diagnosticRoute('POST', `/api/openmaic/interactive-runtime/${asset}`),null);
  }
  const row=selectAppCompletion(JSON.stringify(completion({ method:'GET',route:canonical,nodeHttpReceivedAtMs:9900,
    nextProxyStartedAtMs:9950,nextProxyEndedAtMs:9990,handlerEnteredAtMs:10000,handlerReturnedAtMs:10050,
    assetPath:'private',runtime:'private',query:'private' })));
  assert.equal(row.route,canonical);assert.equal(row.nodeHttpReceivedAtMs,9900);
  for (const key of ['assetPath','runtime','query']) assert.ok(!Object.hasOwn(row,key));
});


test('hot discussion reads, presence writes and private media normalize without leaking resource identity or content', () => {
  const entries = [
    ['GET', '/api/courses/private-course/public-discussion', '/api/courses/:courseId/public-discussion'],
    ['PUT', '/api/courses/private-course/presence', '/api/courses/:courseId/presence'],
    ['DELETE', '/api/courses/private-course/presence', '/api/courses/:courseId/presence'],
    ['GET', '/api/openmaic/classroom-media/private-classroom/audio/private-voice.wav', '/api/openmaic/classroom-media/:classroomId/:path'],
  ];
  for (const [method, path, route] of entries) {
    assert.equal(diagnosticRoute(method, path), route);
    const row = selectAppCompletion(JSON.stringify(completion({ method, route, nodeHttpReceivedAtMs: 9900,
      nextProxyStartedAtMs: 9950, nextProxyEndedAtMs: 9990, handlerEnteredAtMs: 10000, handlerReturnedAtMs: 10050,
      soundClientId: 'private', path, body: 'private', query: 'private', pendingSaves: { count: 2 } })));
    assert.equal(row.route, route); assert.equal(row.nodeHttpReceivedAtMs, 9900);
    for (const key of ['soundClientId', 'path', 'body', 'query', 'pendingSaves']) assert.ok(!Object.hasOwn(row, key));
  }
  for (const [method, path] of [['POST', '/api/courses/course/public-discussion'], ['POST', '/api/courses/course/presence'],
    ['GET', '/api/courses/course/presence/extra'], ['GET', '/api/courses/course/public-discussion/extra'],
    ['POST', '/api/openmaic/classroom-media/private-classroom/audio/private.wav']]) assert.equal(diagnosticRoute(method, path), null);
});

test('native attempt correlation accepts business retries without retaining private IDs or inventing clocks', () => {
  for (const suffix of ['1', String(Number.MAX_SAFE_INTEGER)]) {
    const httpRequestId = `http-${'a'.repeat(32)}-${suffix}`;
    assert.equal(readNativeHttpRequestId(httpRequestId), httpRequestId);
    const row = selectAppCompletion(JSON.stringify(completion({ method: 'GET', route: '/api/ai-collaboration/document',
      requestId: 'private-business-id', httpRequestId, body: 'private-body', cookie: 'private-cookie',
      authorization: 'private-key', traceId: 'private-context' })));
    assert.equal(row.httpRequestId, httpRequestId); assert.ok(!Object.hasOwn(row, 'requestId'));
    assert.ok(!Object.hasOwn(row, 'nodeHttpReceivedAtMs'));
    assert.ok(!JSON.stringify(row).includes('private-'));
  }
  for (const httpRequestId of [undefined, null, [], 'private-key', `http-${'a'.repeat(32)}-0`,
    `http-${'a'.repeat(32)}-01`, `http-${'a'.repeat(32)}-9007199254740992`, `http-${'a'.repeat(32)}-1\n`]) {
    assert.equal(readNativeHttpRequestId(httpRequestId), undefined);
    assert.equal(selectAppCompletion(JSON.stringify(completion({ requestId: 'private-id', httpRequestId }))), null);
    const legacy = selectAppCompletion(JSON.stringify(completion({ httpRequestId })));
    assert.equal(legacy.requestId, completion({}).requestId); assert.ok(!Object.hasOwn(legacy, 'httpRequestId'));
  }
});
