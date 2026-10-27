import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { jwtVerify } from 'jose';
import { verifyReadApiBoundaryHttp } from './prelaunch-read-api-boundary.mjs';
import { READ_API_NATIVE_PROTOCOL_CHECKS, READ_API_NATIVE_ROUTES } from './prelaunch-read-api-contract.mjs';

// Orchestration/protocol fixture only. This cannot replace the real Next/PG run.
function database() {
  const names = ['user', 'courseOffering', 'courseTeacher', 'chapter', 'classroomTemplate', 'classroomTemplateVersion', 'activity',
    'classroomInstance', 'enrollment', 'classroomParticipation', 'studentProjectWorkspace', 'aiConversation', 'aiMessage',
    'aiSupportRecord', 'aiTask', 'learningEvent', 'aiInteractionEvent', 'domainEvent'];
  const tables = Object.fromEntries(names.map(name => [name, new Map()])); const writes = []; let queries = 0;
  const matches = (row, where = {}) => Object.entries(where).every(([key, value]) => {
    if (key === 'participation') return matches(tables.classroomParticipation.get(row.participationId) ?? {}, value);
    if (value && typeof value === 'object' && !Array.isArray(value)) return Array.isArray(value.in) && value.in.includes(row[key]);
    return row[key] === value;
  });
  const remove = (name, id) => {
    const row = tables[name].get(id); if (!row) return false;
    tables[name].delete(id); writes.push({ name, action: 'delete', id });
    const cascades = {
      courseOffering: [['courseTeacher', 'offeringId'], ['chapter', 'offeringId'], ['enrollment', 'offeringId'], ['aiSupportRecord', 'offeringId']],
      chapter: [['activity', 'chapterId']], activity: [['classroomInstance', 'activityId']],
      classroomInstance: [['classroomParticipation', 'instanceId']], enrollment: [['classroomParticipation', 'enrollmentId']],
      classroomParticipation: [['studentProjectWorkspace', 'participationId'], ['aiConversation', 'participationId']],
      aiConversation: [['aiMessage', 'conversationId']], classroomTemplate: [['classroomTemplateVersion', 'templateId']],
    };
    for (const [child, field] of cascades[name] ?? []) for (const item of [...tables[child].values()]) if (item[field] === id) remove(child, item.id);
    return true;
  };
  const db = { tables, writes, queries: () => queries, $queryRawUnsafe: async () => { queries++; return [{ name: 'acceptance_restore' }]; } };
  for (const name of names) db[name] = {
    create: async ({ data }) => { const row = { id: randomUUID(), updatedAt: new Date(), ...structuredClone(data) }; tables[name].set(row.id, row); writes.push({ name, action: 'create', id: row.id }); return structuredClone(row); },
    update: async ({ where, data }) => { const row = [...tables[name].values()].find(row => matches(row, where)); assert.ok(row);
      Object.assign(row, structuredClone(data)); writes.push({ name, action: 'update', id: row.id, data: structuredClone(data) }); return structuredClone(row); },
    findUnique: async ({ where }) => structuredClone([...tables[name].values()].find(row => matches(row, where)) ?? null),
    findMany: async ({ where = {}, include } = {}) => [...tables[name].values()].filter(row => matches(row, where)).sort((a, b) => a.id.localeCompare(b.id)).map(row => ({ ...structuredClone(row),
      ...(include?.messages ? { messages: [...tables.aiMessage.values()].filter(message => message.conversationId === row.id).sort((a, b) => a.id.localeCompare(b.id)) } : {}) })),
    deleteMany: async ({ where }) => { let count = 0; for (const row of [...tables[name].values()]) if (matches(row, where) && remove(name, row.id)) count++; return { count }; },
  };
  db.$transaction = async callback => {
    const before = structuredClone(tables);
    try { return await callback(db); } catch (error) { for (const name of names) { tables[name].clear(); for (const [id, row] of before[name]) tables[name].set(id, row); } throw error; }
  };
  return db;
}

async function fixture(t, defect) {
  const db = database(); const journal = []; const seen = []; const secret = 'native-read-api-proof-at-least-thirty-two-characters';
  const policy = origin => `default-src 'self'; connect-src 'self' data: wss:${origin ? ` ${origin}` : ''}; object-src 'none'; frame-ancestors 'none'`;
  const nonce = randomUUID(); const nativeNonce = randomUUID().replaceAll('-', ''); let nativeSequence = 0;
  const containerName = `openpbl-prelaunch-${nonce}`; const runtimeRoot = path.join(os.tmpdir(), containerName, 'runtime');
  const classroomDataDir = path.join(os.tmpdir(), containerName, 'classrooms');
  let origin;
  const server = createServer(async (incoming, outgoing) => {
    const began = Date.now(); const url = new URL(incoming.url, origin); const method = incoming.method;
    const normal = url.pathname.replace(/^\/api\/courses\/[^/]+\//, '/api/courses/:courseId/');
    const definition = READ_API_NATIVE_ROUTES.find(row => row.route === normal);
    const oldFive = READ_API_NATIVE_ROUTES.slice(0, 5).some(row => row.route === normal);
    const observed = definition && (method === 'GET' && definition.implemented.includes('GET')
      || method === 'POST' && ['/api/learning-events', '/api/openmaic/progress'].includes(normal));
    const nativeId = observed && defect !== 'legacy-baseline' ? `http-${nativeNonce}-${defect === 'reused-native-id' ? 1 : ++nativeSequence}` : undefined;
    const raw = incoming.headers.cookie ?? ''; const cookies = Object.fromEntries(raw.split(';').map(part => part.trim().split('=')));
    const sign = async (value, tolerance) => { try { return (await jwtVerify(value, new TextEncoder().encode(secret), { issuer: 'openpbl', audience: 'openpbl-app', algorithms: ['HS256'], clockTolerance: tolerance })).payload; } catch { return null; } };
    let status = 200; let body = ''; let handler = false;
    const headers = { 'content-security-policy': policy(defect === 'legacy-baseline' && !oldFive ? origin : undefined), ...(nativeId ? { 'x-openpbl-http-request-id': nativeId } : {}) };
    const finish = () => {
      seen.push({ method, path: url.pathname, bodyBytes: Buffer.byteLength(rawBody), body: parsedBody, transferEncoding: incoming.headers['transfer-encoding'], status });
      if (handler && observed && !(defect === 'missing-expanded-clock' && !oldFive)) {
        const row = { ...(String(incoming.headers['x-request-id']).startsWith('acceptance-') ? { requestId: incoming.headers['x-request-id'] } : {}),
          ...(nativeId ? { httpRequestId: nativeId } : {}), pid: process.pid, nodeHttpReceivedAtMs: began,
          handlerEnteredAtMs: Date.now(), nodeHttpLocalPort: server.address().port };
        if (defect === 'clock' || defect === 'legacy-baseline' && !oldFive) row.nextProxyStartedAtMs = Number(incoming.headers['x-openpbl-action-proxy-started']) || began;
        journal.push(row);
      }
      if (outgoing.destroyed) return;
      outgoing.writeHead(status, headers); outgoing.end(body);
    };
    let rawBody = '';
    try { for await (const chunk of incoming) rawBody += chunk.toString('utf8'); }
    catch { seen.push({ method, path: url.pathname, cancelled: true }); return; }
    let parsedBody; try { parsedBody = rawBody ? JSON.parse(rawBody) : undefined; } catch { parsedBody = undefined; }
    if (url.pathname === '/api/auth/login') { status = 410; headers['content-security-policy'] = policy(origin); finish(); return; }
    if (!url.pathname.startsWith('/api/')) { status = 307; headers.location = '/teacher/login'; headers['content-security-policy'] = policy(defect === 'csp-page' ? undefined : origin); finish(); return; }
    const teacher = await sign(cookies.openpbl_teacher, 0); const student = await sign(cookies.openpbl_student, 0);
    if (teacher?.role !== 'teacher' && student?.role !== 'student') { status = 401; finish(); return; }
    if (method === 'OPTIONS') { status = 204; headers.allow = defect === 'options' ? 'GET, POST' : definition.optionsAllow; finish(); return; }
    const implemented = definition.implemented.includes(method) || method === 'HEAD' && definition.implemented.includes('GET');
    if (!implemented) { status = defect === 'method' ? 200 : 405; finish(); return; }
    handler = true;
    const privateApi = normal.startsWith('/api/ai-collaboration/') || normal === '/api/learning-events';
    const selected = privateApi ? 'student' : incoming.headers['x-openpbl-role'] === 'teacher' ? 'teacher' : 'student';
    const first = raw.split(';').map(part => part.trim()).find(part => part.startsWith(`openpbl_${selected}=`))?.split('=').slice(1).join('=');
    let claims;
    try { claims = await sign(decodeURIComponent(first), 5); } catch { status = normal === '/api/ai-collaboration/document' ? 503 : 500;
      headers['content-security-policy'] = policy(defect === 'csp-error' || defect === 'legacy-baseline' && !oldFive ? origin : undefined);
      headers['content-type'] = status === 503 ? 'application/json' : 'text/plain'; body = status === 503 ? JSON.stringify({ error: 'DATABASE_UNAVAILABLE' }) : 'Internal Server Error'; finish(); return; }
    const user = db.tables.user.get(claims?.sub);
    if (!user || user.role.toLowerCase() !== claims.role || user.status !== 'ACTIVE' || user.sessionVersion !== claims.sv) {
      status = defect === 'revocation' && user?.status === 'DISABLED' ? 200 : 401;
      headers['set-cookie'] = `openpbl_${selected}=; Path=/; Max-Age=0`; body = JSON.stringify({ code: 'UNAUTHORIZED', requestId: incoming.headers['x-request-id'] }); finish(); return;
    }
    const instance = [...db.tables.classroomInstance.values()][0];
    const enrollment = [...db.tables.enrollment.values()].find(row => row.userId === claims.sub);
    const teacherAccess = [...db.tables.courseTeacher.values()].some(row => row.userId === claims.sub);
    const access = claims.role === 'teacher' ? teacherAccess : Boolean(enrollment && ['ACTIVE', 'COMPLETED'].includes(enrollment.status));
    const course = { id: instance.id, name: '隔离读取协议', students: [...db.tables.enrollment.values()].filter(row => claims.role === 'teacher' || row.userId === claims.sub).map(row => ({ id: row.userId })) };
    const deny = (code, value) => { status = code; body = JSON.stringify({ error: value }); finish(); };
    if (!['GET', 'HEAD'].includes(method)) {
      if (incoming.headers.origin !== origin) { deny(403, 'FORBIDDEN'); return; }
      if (normal.endsWith('/presence')) { deny(403, 'FORBIDDEN'); return; }
      if (normal === '/api/learning-events') {
        deny(parsedBody?.studentId !== claims.sub && parsedBody?.events?.length ? 403 : 400,
          parsedBody?.studentId !== claims.sub && parsedBody?.events?.length ? 'STUDENT_SCOPE_MISMATCH' : 'INVALID_EVENTS'); return;
      }
      if (defect === 'rejected-fact-write') db.tables.aiTask.set('unexpected-proof-task', { id: 'unexpected-proof-task', offeringId: [...db.tables.courseOffering.keys()][0] });
      if (defect === 'large-body-reset' && rawBody.length > 10 * 1024 * 1024) { outgoing.destroy(); return; }
      if (method === 'DELETE' && ['/api/ai-collaboration/code', '/api/ai-collaboration/document'].includes(normal)) { deny(409, 'CONVERSATION_CHANGED'); return; }
      const error = normal === '/api/ai-collaboration/code' ? 'INVALID_ARTIFACT'
        : normal === '/api/ai-collaboration/document' ? 'INVALID_COMMENT_THREAD'
          : normal === '/api/ai-collaboration/memory' ? method === 'DELETE' ? 'MISSING_PARAMETERS' : 'INVALID_ACTION' : 'INVALID_ACTION';
      deny(defect === 'large-body-413' && rawBody.length > 10 * 1024 * 1024 ? 413 : 400, error); return;
    }
    if (url.pathname === '/api/server-providers') body = JSON.stringify({ providers: [] });
    else if (url.pathname === '/api/courses') {
      if (claims.role === 'teacher' && !access) status = 403;
      else body = JSON.stringify({ courses: access ? [course] : [] });
    } else if (!access) status = 403;
    else if (normal === '/api/courses/:courseId/showcase/presentation') {
      status = 409; body = JSON.stringify({ code: 'SHOWCASE_INACTIVE' });
    }
    else if (url.searchParams.has('studentId') && url.searchParams.get('studentId') !== claims.sub) status = 403;
    else if (normal === '/api/openmaic/classroom') {
      try { body = JSON.stringify({ classroom: JSON.parse(await readFile(path.join(classroomDataDir, `${url.searchParams.get('id')}.json`), 'utf8')) }); }
      catch { status = 404; }
    } else if (normal.startsWith('/api/ai-collaboration/')) {
      const key = normal.endsWith('/code') ? 'ai-code-collaboration:make:python' : 'ai-collaboration:make';
      const conversations = [...db.tables.aiConversation.values()].filter(row => row.userId === claims.sub && row.metadata.legacyStageKey === key);
      const messages = [...db.tables.aiMessage.values()].filter(row => conversations.some(c => c.id === row.conversationId)
        && (defect === 'private-leak' || row.metadata.visibility === 'student-and-teacher'));
      const memories = [...db.tables.aiSupportRecord.values()].filter(row => row.createdById === claims.sub).map(row => row.structuredPayload);
      body = JSON.stringify({ messages: normal.endsWith('/memory') ? [] : messages, memories });
    } else {
      body = JSON.stringify({ course });
      if (url.pathname.endsWith('/state')) {
        headers.etag = 'W/"same-proof-state"'; headers['cache-control'] = 'private, no-cache';
        if (incoming.headers['if-none-match'] === headers.etag) { status = 304; body = ''; }
      }
    }
    if (defect === 'csp') headers['content-security-policy'] = policy(origin);
    finish();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await mkdir(path.join(runtimeRoot, '.next-build'), { recursive: true });
  await writeFile(path.join(runtimeRoot, '.next-build/routes-manifest.json'), JSON.stringify({ headers: [{ source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: policy() }] }] }));
  t.after(() => rm(path.join(os.tmpdir(), containerName), { recursive: true, force: true }));
  const options = { baseURL: origin, jwtSecret: secret, db, readAppJournal: async () => journal,
    protocolMode: defect === 'legacy-baseline' ? 'baseline-observe' : 'candidate',
    isolation: { nonce, containerName, databaseURL: 'postgresql://postgres@127.0.0.1:45678/acceptance_restore?schema=public',
      runtimeRoot, classroomDataDir, appPid: process.pid, appPort: server.address().port, distDir: '.next-build', buildId: 'native-proof-fixture' } };
  let inspections = 0;
  const dependencies = { inspectIsolation: async () => { inspections++; return { pid: process.pid, startTicks: 'fixture-only', buildId: 'native-proof-fixture' }; } };
  return { options, dependencies, db, seen, inspections: () => inspections };
}

for (const [label, change] of [
  ['production port', options => { options.baseURL = 'http://127.0.0.1:3000'; }],
  ['remote HTTP', options => { options.baseURL = 'http://example.invalid:3198'; }],
  ['remote database', options => { options.isolation.databaseURL = 'postgresql://postgres@example.invalid:45678/postgres'; }],
  ['other database', options => { options.isolation.databaseURL = 'postgresql://postgres@127.0.0.1:45678/production'; }],
  ['nonce mismatch', options => { options.isolation.containerName = `openpbl-prelaunch-${randomUUID()}`; }],
  ['runtime mismatch', options => { options.isolation.runtimeRoot = '/tmp/another-runtime'; }],
  ['foreign classroom storage', options => { options.isolation.classroomDataDir = '/tmp/not-this-proof'; }],
]) test(`guard rejects ${label} before HTTP, DB or fixture creation`, async t => {
  const f = await fixture(t); change(f.options);
  await assert.rejects(verifyReadApiBoundaryHttp(f.options, f.dependencies));
  assert.equal(f.inspections(), 0); assert.equal(f.db.queries(), 0); assert.equal(f.db.writes.length, 0); assert.equal(f.seen.length, 0);
});

test('default guard checks actual PID ownership before Docker, DB or HTTP', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyReadApiBoundaryHttp(f.options), /Application PID does not own/);
  assert.equal(f.db.queries(), 0); assert.equal(f.seen.length, 0);
});

test('a mismatched actual database name cannot create fixtures', async t => {
  const f = await fixture(t); f.options.isolation.databaseURL = 'postgresql://postgres@127.0.0.1:45678/postgres';
  await assert.rejects(verifyReadApiBoundaryHttp(f.options, f.dependencies), /client targets another database/);
  assert.equal(f.db.writes.length, 0); assert.equal(f.seen.length, 0);
});

test('real short HTTP protocol covers method/CSP/JWT/cache checks and deletes only invocation-owned fixtures', async t => {
  const f = await fixture(t); const original = { id: 'main-class-sentinel', role: 'STUDENT', status: 'ACTIVE', sessionVersion: 91 };
  f.db.tables.user.set(original.id, structuredClone(original));
  const result = await verifyReadApiBoundaryHttp(f.options, f.dependencies);
  assert.equal(result.status, 'passed'); assert.equal(result.evidence, 'test-orchestration-fixture'); assert.equal(result.restoration, 'passed');
  assert.ok(result.checks.includes('native-clock-is-genuine-and-absent-Proxy-clock-stays-unknown')); assert.equal(f.inspections(), 2);
  assert.ok(result.requests.every(row => Number.isFinite(row.durationMs) && row.bodyBytes >= 0 && /^[a-f0-9]{64}$/.test(row.sha256)));
  assert.ok(!JSON.stringify(result).includes('openpbl_student='));
  assert.equal(result.requests.find(row => row.status === 500)?.csp, 'static');
  assert.equal(result.clockEvidence.nodeHttpLocalPort, f.options.isolation.appPort);
  const oldFive = new Set(['/api/server-providers', '/api/courses', ...['state', 'events', 'projection'].map(name => `/api/courses/${[...f.db.writes].find(row => row.name === 'classroomInstance' && row.action === 'create').id}/${name}`)]);
  assert.equal(f.seen.filter(row => row.method === 'POST' && oldFive.has(row.path)).length, 10);
  assert.ok(f.seen.filter(row => oldFive.has(row.path)).every(row => row.bodyBytes === 0), 'Old read-only paths must never replay business payloads');
  assert.equal(result.checks.length, READ_API_NATIVE_PROTOCOL_CHECKS.length);
  assert.equal(result.coveredRoutes.length, READ_API_NATIVE_ROUTES.length);
  assert.equal(result.httpIdentity.uniqueNativeIds, 4);
  assert.ok(result.coveredRoutes.every(row => row.requestCount >= 14));
  const showcase = result.coveredRoutes.find(row => row.route === '/api/courses/:courseId/showcase/presentation');
  assert.equal(showcase.optionsAllow, 'GET, HEAD, OPTIONS, POST');
  assert.equal(showcase.clockState, 'measured');
  assert.ok(f.seen.some(row => row.path.endsWith('/showcase/presentation') && row.method === 'GET' && row.status === 409));
  assert.ok(f.seen.some(row => row.path.endsWith('/showcase/presentation') && row.method === 'POST' && row.status === 400));
  assert.ok(result.bodyTransferObservations.some(row => row.kind === 'over-default-10MiB-proxy-clone' && row.requestBytes > 10 * 1024 * 1024));
  assert.ok(result.bodyTransferObservations.some(row => row.kind === 'showcase-over-default-10MiB-proxy-clone' && row.requestBytes > 10 * 1024 * 1024));
  assert.ok(f.seen.some(row => row.transferEncoding === 'chunked'), 'Real short HTTP fixture must observe chunked transfer');
  assert.deepEqual(f.db.tables.user.get(original.id), original); assert.equal(f.db.tables.user.size, 1);
  assert.equal(f.db.tables.classroomInstance.size, 0); assert.equal(f.db.tables.courseOffering.size, 0);
  const created = new Set(f.db.writes.filter(row => row.name === 'user' && row.action === 'create').map(row => row.id));
  assert.equal(created.size, 5); assert.ok(f.db.writes.filter(row => row.name === 'user' && row.action !== 'create').every(row => created.has(row.id)));
});

for (const [defect, message] of [['options', /method contract/], ['method', /status mismatch/], ['csp', /canonical build CSP/], ['csp-page', /canonical build CSP/], ['csp-error', /canonical build CSP/], ['revocation', /status mismatch/], ['clock', /Expected values/]]) {
  test(`protocol detects ${defect} and restores/deletes its exact fixture on failure`, async t => {
    const f = await fixture(t, defect); f.options.output = path.join(f.options.isolation.runtimeRoot, 'failure-evidence');
    await assert.rejects(verifyReadApiBoundaryHttp(f.options, f.dependencies), message);
    assert.equal(f.db.tables.user.size, 0); assert.equal(f.db.tables.classroomInstance.size, 0); assert.equal(f.db.tables.courseOffering.size, 0);
    const report = JSON.parse(await readFile(path.join(f.options.output, 'read-api-boundary-http.json'), 'utf8'));
    assert.equal(report.status, 'failed'); assert.equal(report.restoration, 'passed'); assert.ok(report.requests.length > 0, 'Failed wire metadata must be retained');
    if (defect === 'csp-error') assert.equal(report.requests.at(-1).headers['content-type'], 'text/plain');
    if (defect === 'revocation') {
      const changes = f.db.writes.filter(row => row.name === 'user' && row.action === 'update');
      const disabled = changes.findIndex(row => row.data.status === 'DISABLED');
      assert.ok(disabled >= 0 && changes.slice(disabled + 1).some(row => row.data.status === 'ACTIVE' && row.data.sessionVersion === 1));
    }
  });
}

for (const [label, headers] of [
  ['missing global', []],
  ['ambiguous global', [1, 2].map(() => ({ source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: "default-src 'self'" }] }))],
  ['unexpected scoped policy', [{ source: '/api/courses', headers: [{ key: 'Content-Security-Policy', value: "default-src 'self'" }] }]],
]) test(`canonical policy guard rejects ${label} before DB/HTTP`, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.options.isolation.runtimeRoot, '.next-build/routes-manifest.json'), JSON.stringify({ headers }));
  await assert.rejects(verifyReadApiBoundaryHttp(f.options, f.dependencies));
  assert.equal(f.db.queries(), 0); assert.equal(f.db.writes.length, 0); assert.equal(f.seen.length, 0);
});


test('baseline wire observations cannot become candidate success and retain missing IDs as unknown', async t => {
  const f = await fixture(t, 'legacy-baseline'); const result = await verifyReadApiBoundaryHttp(f.options, f.dependencies);
  assert.equal(result.status, 'observed'); assert.equal(result.protocolMode, 'baseline-observe');
  assert.equal(result.httpIdentity.stateAnchor, 'unknown'); assert.equal(result.httpIdentity.uniqueNativeIds, 0);
  assert.ok(result.businessIdReuseEvidence.every(row => row.state === 'unknown'));
});

for (const [defect, message] of [['reused-native-id', /identity was reused/], ['private-leak', /Private peer\/teacher-only/],
  ['rejected-fact-write', /persistent business facts/], ['missing-expanded-clock', /expanded anchor lacks/]]) test(`expanded protocol detects ${defect} and cleans only proof fixtures`, async t => {
  const f = await fixture(t, defect); await assert.rejects(verifyReadApiBoundaryHttp(f.options, f.dependencies), message);
  assert.equal(f.db.tables.user.size, 0); assert.equal(f.db.tables.classroomInstance.size, 0);
  assert.equal((await readdir(f.options.isolation.classroomDataDir).catch(() => [])).length, 0);
});

test('large-body status is observed rather than forced to an invented common limit', async t => {
  const f = await fixture(t, 'large-body-413'); const result = await verifyReadApiBoundaryHttp(f.options, f.dependencies);
  assert.equal(result.status, 'passed'); assert.equal(result.bodyTransferObservations.find(row => row.kind === 'over-default-10MiB-proxy-clone').status, 413);
  assert.equal(result.rejectedInputFacts.unchanged, true);
});


test('large-body peer reset is retained as an unknown wire observation without dropping normal protocol checks', async t => {
  const f = await fixture(t, 'large-body-reset'); const result = await verifyReadApiBoundaryHttp(f.options, f.dependencies);
  const observation = result.bodyTransferObservations.find(row => row.kind === 'over-default-10MiB-proxy-clone');
  assert.equal(observation.status, null); assert.equal(observation.networkError, true); assert.equal(observation.canonicalPolicyMatched, null);
  const request = result.requests.find(row => row.observationOnly && row.networkError);
  assert.ok(request.plannedRequestBodyBytes > 10 * 1024 * 1024); assert.equal(request.bodyBytesSent, null);
  assert.equal(result.rejectedInputFacts.unchanged, true); assert.equal(result.status, 'passed');
});
