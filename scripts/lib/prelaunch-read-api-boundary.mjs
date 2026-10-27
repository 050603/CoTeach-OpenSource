import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readlink, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SignJWT } from 'jose';
import { READ_API_NATIVE_PROTOCOL_CHECKS, READ_API_NATIVE_ROUTES, READ_API_NATIVE_PROTOCOL_VERSION } from './prelaunch-read-api-contract.mjs';

const exec = promisify(execFile);
const methods = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const userSelect = { id: true, username: true, displayName: true, role: true, status: true, sessionVersion: true, updatedAt: true };

function target(baseURL, isolation) {
  const origin = new URL(baseURL); const database = new URL(isolation.databaseURL);
  assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && Number(origin.port) > 1024
    && !['3000', '3002'].includes(origin.port) && origin.pathname === '/' && !origin.search && !origin.hash
    && !origin.username && !origin.password, 'Read API proof requires a disposable loopback HTTP origin');
  assert.ok(database.protocol === 'postgresql:' && database.hostname === '127.0.0.1' && Number(database.port) > 1024
    && ['/postgres', '/acceptance_restore'].includes(database.pathname), 'Read API proof requires a mapped disposable PostgreSQL database');
  assert.match(isolation.nonce ?? '', /^[a-f0-9-]{36}$/);
  assert.equal(isolation.containerName, `openpbl-prelaunch-${isolation.nonce}`, 'Disposable container nonce mismatch');
  assert.equal(isolation.runtimeRoot, path.join(os.tmpdir(), isolation.containerName, 'runtime'), 'Disposable runtime nonce mismatch');
  const fixtureRoot = path.join(os.tmpdir(), isolation.containerName);
  assert.ok(path.isAbsolute(isolation.classroomDataDir ?? '') && isolation.classroomDataDir !== fixtureRoot
    && !path.relative(fixtureRoot, isolation.classroomDataDir).startsWith('..'), 'Classroom fixture directory must belong to the same disposable nonce');
  assert.match(isolation.distDir ?? '', /^\.next(?:-[a-zA-Z0-9_-]+)?$/);
  assert.ok(Number.isSafeInteger(isolation.appPid) && isolation.appPid > 1, 'Missing isolated application PID');
  assert.ok(Number.isSafeInteger(isolation.appPort) && isolation.appPort > 1024 && ![3000, 3002].includes(isolation.appPort), 'Missing isolated application listener');
  assert.ok(typeof isolation.buildId === 'string' && isolation.buildId.length > 0, 'Missing isolated BUILD_ID');
  return { origin: origin.origin, database };
}

async function inspectIsolation({ isolation, database }) {
  assert.equal(await readlink(`/proc/${isolation.appPid}/cwd`), isolation.runtimeRoot, 'Application PID does not own the disposable runtime');
  assert.equal((await readFile(path.join(isolation.runtimeRoot, isolation.distDir, 'BUILD_ID'), 'utf8')).trim(), isolation.buildId, 'Application BUILD_ID mismatch');
  const running = await exec('docker', ['inspect', '--format', '{{.State.Running}}', isolation.containerName], { timeout: 5000 });
  assert.equal(running.stdout.trim(), 'true', 'Disposable PostgreSQL container is not running');
  const mapped = await exec('docker', ['port', isolation.containerName, '5432/tcp'], { timeout: 5000 });
  assert.equal(mapped.stdout.trim(), `127.0.0.1:${database.port}`, 'Database URL does not match the disposable container');
  const stat = await readFile(`/proc/${isolation.appPid}/stat`, 'utf8');
  return { pid: isolation.appPid, startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], buildId: isolation.buildId };
}

async function canonicalPolicies(isolation, origin) {
  const manifest = JSON.parse(await readFile(path.join(isolation.runtimeRoot, isolation.distDir, 'routes-manifest.json'), 'utf8'));
  const entries = manifest.headers.flatMap(rule => rule.headers.filter(header => header.key.toLowerCase() === 'content-security-policy')
    .map(header => ({ source: rule.source, value: header.value })));
  assert.ok(entries.every(entry => ['/:path*', '/internal/resource-player'].includes(entry.source)), 'Unexpected build CSP rule requires explicit protocol review');
  const global = entries.filter(entry => entry.source === '/:path*');
  assert.equal(global.length, 1, 'Build must define exactly one global CSP');
  const policy = global[0].value; assert.ok(typeof policy === 'string' && policy.length > 0, 'Build CSP is missing');
  const directives = policy.split(';').map(value => value.trim());
  for (const expected of ["default-src 'self'", "connect-src 'self' data: wss:", "object-src 'none'", "frame-ancestors 'none'"]) {
    assert.ok(directives.includes(expected), 'Build CSP does not retain the expected production directive');
  }
  assert.equal(new Set(directives.map(value => value.split(' ')[0])).size, directives.length, 'Build CSP contains duplicate directives');
  return { static: policy, dynamic: policy.replace("connect-src 'self' data: wss:", `connect-src 'self' data: wss: ${origin}`) };
}

async function bytes(url, { method = 'GET', headers = {}, body, transfer = 'buffered' }, timeoutMs) {
  assert.ok(methods.has(method), 'Only bounded protocol probes are allowed');
  assert.ok(['buffered', 'chunked', 'cancel-after-prefix'].includes(transfer));
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  assert.ok(!encoded || encoded.length <= 10 * 1024 * 1024 + 4096, 'Protocol request byte limit');
  const outgoing = request(url, { method, headers: { ...headers, ...(encoded ? { 'content-type': 'application/json',
    ...(transfer === 'buffered' ? { 'content-length': String(encoded.length) } : {}) } : {}) },
  agent: false, signal: AbortSignal.timeout(timeoutMs) });
  if (transfer === 'cancel-after-prefix') {
    assert.ok(encoded && encoded.length > 8, 'Cancellation needs an incomplete JSON prefix');
    outgoing.on('error', () => {});
    await new Promise((resolve, reject) => { outgoing.once('error', reject); outgoing.write(encoded.subarray(0, 8), resolve); });
    outgoing.destroy();
    return { cancelled: true, status: null, headers: {}, body: Buffer.alloc(0), bodyBytesSent: 8 };
  }
  const responsePromise = new Promise((resolve, reject) => { outgoing.once('response', resolve); outgoing.once('error', reject); });
  // Attach the rejection handler before writing so a peer close never leaves an
  // unhandled promise while waiting for request backpressure.
  responsePromise.catch(() => {});
  try {
    if (encoded && transfer === 'chunked') {
      const chunkBytes = Math.min(16 * 1024, Math.max(1, Math.floor(encoded.length / 3)));
      for (let offset = 0; offset < encoded.length; offset += chunkBytes) {
        if (!outgoing.write(encoded.subarray(offset, offset + chunkBytes))) {
          await new Promise((resolve, reject) => { const drained = () => { cleanup(); resolve(); }; const failed = error => { cleanup(); reject(error); };
            const cleanup = () => { outgoing.off('drain', drained); outgoing.off('error', failed); };
            outgoing.once('drain', drained); outgoing.once('error', failed); });
        }
      }
      outgoing.end();
    } else outgoing.end(encoded);
    const response = await responsePromise; let size = 0; const chunks = [];
    try {
      for await (const chunk of response) { size += chunk.length; assert.ok(size <= 16 * 1024 * 1024, 'Read API proof response byte limit'); chunks.push(chunk); }
      return { status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks, size), bodyBytesSent: encoded?.length ?? 0 };
    } finally { response.destroy(); }
  } finally { outgoing.destroy(); }
}

function nativeHttpId(value) {
  if (typeof value !== 'string' || !/^http-[a-f0-9]{32}-[1-9][0-9]{0,15}$/.test(value)) return undefined;
  return Number.isSafeInteger(Number(value.slice(value.lastIndexOf('-') + 1))) ? value : undefined;
}

async function createProofFixture(db) {
  const owned = Object.fromEntries(['teacher', 'student', 'offering', 'chapter', 'template', 'version', 'activity', 'instance', 'enrollment', 'participation'].map(key => [key, randomUUID()]));
  const users = [];
  await db.$transaction(async tx => {
    for (const role of ['teacher', 'student']) {
      const username = `read-api-proof-${owned[role]}`;
      users.push(await tx.user.create({ data: { id: owned[role], username, usernameKey: username, displayName: '隔离读取协议验收', role: role.toUpperCase(),
        status: 'ACTIVE', passwordHash: '!non-login-synthetic-proof', sessionVersion: 1 }, select: userSelect }));
    }
    await tx.courseOffering.create({ data: { id: owned.offering, name: '隔离读取协议验收', status: 'OPEN' } });
    await tx.courseTeacher.create({ data: { userId: owned.teacher, offeringId: owned.offering } });
    await tx.chapter.create({ data: { id: owned.chapter, offeringId: owned.offering, title: '隔离读取协议', position: 0, isOpen: true } });
    await tx.classroomTemplate.create({ data: { id: owned.template, ownerId: owned.teacher, title: '隔离读取协议', status: 'ACTIVE' } });
    await tx.classroomTemplateVersion.create({ data: { id: owned.version, templateId: owned.template, version: 1, status: 'PUBLISHED', snapshot: {
      schemaVersion: 2, kind: 'pbl-course', design: { name: '隔离读取协议', subject: '科学', grade: '七年级', hours: 1,
        stages: [{ key: 'launch', label: '项目启动', view: 'launch', description: '读取协议验收' }], content: {}, pblConfig: { makeArtifactMode: 'document' } },
    } } });
    await tx.activity.create({ data: { id: owned.activity, chapterId: owned.chapter, title: '隔离读取协议', type: 'Classroom', position: 0, isOpen: true } });
    await tx.classroomInstance.create({ data: { id: owned.instance, activityId: owned.activity, templateVersionId: owned.version, status: 'READY',
      runtimeConfig: { version: 1, currentStageIndex: 0, uiState: {} } } });
    await tx.enrollment.create({ data: { id: owned.enrollment, userId: owned.student, offeringId: owned.offering, status: 'ACTIVE' } });
    await tx.classroomParticipation.create({ data: { id: owned.participation, instanceId: owned.instance, enrollmentId: owned.enrollment } });
  });
  return { owned, teacher: users[0], student: users[1], enrollment: { id: owned.enrollment, status: 'ACTIVE' }, courseId: owned.instance };
}

async function cleanupProofFixture(db, owned, outsiders) {
  await db.$transaction(async tx => {
    // Exact invocation-owned keys only. Cascades remove this offering's own
    // chapter/activity/enrollment; no main-class or existing user is touched.
    assert.equal((await tx.classroomInstance.deleteMany({ where: { id: owned.instance } })).count, 1, 'Owned proof classroom was not removed');
    assert.equal((await tx.courseOffering.deleteMany({ where: { id: owned.offering } })).count, 1, 'Owned proof offering was not removed');
    assert.equal((await tx.classroomTemplate.deleteMany({ where: { id: owned.template } })).count, 1, 'Owned proof template was not removed');
    assert.equal((await tx.user.deleteMany({ where: { id: { in: [owned.teacher, owned.student, ...outsiders] } } })).count, 2 + outsiders.length, 'Owned proof users were not removed');
  });
}

function normalizedApiPath(route) {
  return new URL(route, 'http://127.0.0.1').pathname.replace(/^\/api\/courses\/[^/]+\//, '/api/courses/:courseId/');
}

async function ownedFacts(db, fixture) {
  const { owned } = fixture;
  const [instance, participations, workspaces, conversations, support, tasks, learning, interactions, events] = await Promise.all([
    db.classroomInstance.findUnique({ where: { id: owned.instance } }),
    db.classroomParticipation.findMany({ where: { instanceId: owned.instance }, orderBy: { id: 'asc' } }),
    db.studentProjectWorkspace.findMany({ where: { participation: { instanceId: owned.instance } }, orderBy: { id: 'asc' } }),
    db.aiConversation.findMany({ where: { offeringId: owned.offering }, include: { messages: { orderBy: { id: 'asc' } } }, orderBy: { id: 'asc' } }),
    db.aiSupportRecord.findMany({ where: { offeringId: owned.offering }, orderBy: { id: 'asc' } }),
    db.aiTask.findMany({ where: { offeringId: owned.offering }, orderBy: { id: 'asc' } }),
    db.learningEvent.findMany({ where: { offeringId: owned.offering }, orderBy: { id: 'asc' } }),
    db.aiInteractionEvent.findMany({ where: { offeringId: owned.offering }, orderBy: { id: 'asc' } }),
    db.domainEvent.findMany({ where: { offeringId: owned.offering }, orderBy: { id: 'asc' } }),
  ]);
  return { digest: sha256(Buffer.from(JSON.stringify({ instance, participations, workspaces, conversations, support, tasks, learning, interactions, events },
    (_key, value) => typeof value === 'bigint' ? String(value) : value))),
  counts: { workspaces: workspaces.length, conversations: conversations.length,
    messages: conversations.reduce((n, row) => n + row.messages.length, 0), support: support.length,
    tasks: tasks.length, learning: learning.length, interactions: interactions.length, events: events.length } };
}

/** Exact proof-owned rows only. No AI output, receipt, grade or real event is fabricated. */
async function prepareExpandedFixture(db, fixture, created) {
  const { owned } = fixture; const peerId = randomUUID(); const username = `read-api-proof-${peerId}`;
  const peer = await db.user.create({ data: { id: peerId, username, usernameKey: username, displayName: '隔离私有范围验收',
    role: 'STUDENT', status: 'ACTIVE', sessionVersion: 1, passwordHash: '!non-login-synthetic-proof' }, select: userSelect });
  created.push(peer.id);
  const enrollment = await db.enrollment.create({ data: { userId: peer.id, offeringId: owned.offering, status: 'ACTIVE' } });
  const participation = await db.classroomParticipation.create({ data: { instanceId: owned.instance, enrollmentId: enrollment.id } });
  const classroomId = `native-proof-${randomUUID()}`; const version = await db.classroomTemplateVersion.create({ data: {
    templateId: owned.template, version: 2, status: 'PUBLISHED', snapshot: { schemaVersion: 2, kind: 'pbl-course', design: {
      name: '隔离读取协议', subject: '科学', grade: '七年级', hours: 1,
      stages: [{ key: 'make', label: '项目制作', view: 'make', description: '隔离范围验收' }],
      aiLearningClassroomId: classroomId, content: { _openmaicClassroomId: classroomId }, pblConfig: { makeArtifactMode: 'document' },
    } },
  } });
  await db.classroomInstance.update({ where: { id: owned.instance }, data: { templateVersionId: version.id,
    status: 'TEACHING', runtimeConfig: { version: 2, currentStageIndex: 0, uiState: {} } } });
  const markers = { own: `own-private-${randomUUID()}`, peer: `peer-private-${randomUUID()}`, hidden: `teacher-only-${randomUUID()}` };
  for (const [actor, participationId, marker] of [[fixture.student, owned.participation, markers.own], [peer, participation.id, markers.peer]]) {
    for (const stageKey of ['ai-collaboration:make', 'ai-code-collaboration:make:python']) {
      // This is the persisted companionThreadId contract, also checked by the real GET's positive marker.
      const id = `companion:${sha256(Buffer.from(JSON.stringify([owned.instance, actor.id, stageKey])))}`;
      await db.aiConversation.create({ data: { id, userId: actor.id, offeringId: owned.offering, participationId,
        title: 'Synthetic native-protocol fixture', metadata: { legacyStageKey: stageKey } } });
      for (const [content, visibility] of [[marker, 'student-and-teacher'], [markers.hidden, 'teacher-only']]) {
        await db.aiMessage.create({ data: { conversationId: id, userId: actor.id, role: 'user', content,
          metadata: { legacyRole: 'student', visibility } } });
      }
    }
    await db.aiSupportRecord.create({ data: { offeringId: owned.offering, participationId, createdById: actor.id,
      type: 'PROJECT_MEMORY', status: 'OPEN', summary: marker, structuredPayload: { schemaVersion: 1, kind: 'student-decision',
        content: marker, stageKey: 'make', sourceMessageIds: [] } } });
  }
  return { peer, classroomId, markers, absentCourseId: randomUUID() };
}

async function verifyExpandedApiBoundary({ db, fixture, created, send, token, teacherToken, studentToken, report,
  isolation, status, json, readAppJournal, protocolMode }) {
  const directory = isolation.classroomDataDir; const containerRoot = path.join(os.tmpdir(), isolation.containerName);
  assert.ok(path.isAbsolute(directory ?? '') && !path.relative(containerRoot, directory).startsWith('..')
    && directory !== containerRoot, 'Classroom fixture directory must belong to the same disposable nonce');
  await mkdir(directory, { recursive: true });
  const actualDirectory = await realpath(directory);
  assert.ok(!path.relative(await realpath(containerRoot), actualDirectory).startsWith('..'), 'Classroom directory escapes disposable root through a symlink');
  const extra = await prepareExpandedFixture(db, fixture, created);
  const file = path.join(actualDirectory, `${extra.classroomId}.json`); let fileCreated = false;
  try {
    await writeFile(file, JSON.stringify({ id: extra.classroomId, stage: { id: extra.classroomId, name: 'Native protocol fixture' },
      scenes: [{ id: 'native-proof-scene', title: 'Synthetic native protocol content', type: 'slide', stageKey: 'ai-learning', actions: [] }],
      createdAt: new Date().toISOString(), revision: 1 }), { flag: 'wx', mode: 0o600 }); fileCreated = true;
    const query = new URLSearchParams({ courseId: fixture.courseId, studentId: fixture.student.id, stageKey: 'make' });
    const privateRoute = name => `/api/ai-collaboration/${name}?${query}${name === 'code' ? '&language=python' : ''}`;
    const course = name => `/api/courses/${fixture.courseId}/${name}`;
    const scopeBody = { courseId: fixture.courseId, studentId: fixture.student.id, stageKey: 'make' };
    const entries = [
      // This proof-owned course is deliberately in make: retain its real stage
      // denial rather than changing business state to make a GET appear valid.
      // Active showcase success is exercised by the original classroom flow.
      { route: course('showcase/presentation'), readStatus: 409, readError: 'SHOWCASE_INACTIVE',
        write: { POST: { body: {}, expected: [400], errors: ['INVALID_ACTION'] } } },
      { route: course('public-discussion'), write: { POST: { body: {}, expected: [400, 404], errors: ['INVALID_ACTION', 'FEATURE_DISABLED'] } } },
      { route: course('presence'), write: Object.fromEntries(['PUT', 'DELETE'].map(method => [method, {
        route: `/api/courses/${extra.absentCourseId}/presence`, expected: [403], body: undefined }])) },
      { route: `/api/openmaic/classroom?id=${extra.classroomId}`, write: {} },
      { route: `/api/openmaic/progress?courseId=${fixture.courseId}&studentId=${fixture.student.id}`,
        write: { POST: { body: { ...scopeBody, classroomId: extra.classroomId }, expected: [400] } } },
      { route: '/api/learning-events', write: { POST: { body: { ...scopeBody, events: [] }, expected: [400], errors: ['INVALID_EVENTS'] } } },
      { route: privateRoute('code'), write: { POST: { body: { ...scopeBody, language: 'python', action: 'native-proof-invalid-action', artifact: null }, expected: [400], errors: ['INVALID_ARTIFACT'] },
        DELETE: { route: `${privateRoute('code')}&messageId=${randomUUID()}&conversationId=native-proof-never-current`, expected: [409], errors: ['CONVERSATION_CHANGED'] } } },
      { route: privateRoute('document'), write: { POST: { body: { ...scopeBody, action: 'read-document-comment' }, expected: [400], errors: ['INVALID_COMMENT_THREAD'] },
        DELETE: { route: `${privateRoute('document')}&messageId=${randomUUID()}&conversationId=native-proof-never-current`, expected: [409], errors: ['CONVERSATION_CHANGED'] } } },
      { route: privateRoute('memory'), write: { PATCH: { body: { ...scopeBody, action: 'native-proof-invalid-action' }, expected: [400], errors: ['INVALID_ACTION'] },
        DELETE: { expected: [400], errors: ['MISSING_PARAMETERS'] } } },
    ].map(entry => ({ ...entry, definition: READ_API_NATIVE_ROUTES.find(row => row.route === normalizedApiPath(entry.route)) }));
    const before = await ownedFacts(db, fixture); const forgedRequests = [];
    const csp = protocolMode === 'baseline-observe' ? 'dynamic' : 'static';
    const invoke = (entry, options = {}) => send(options.route ?? entry.route, { csp, ...options });
    for (const entry of entries) {
      assert.ok(entry.definition, 'Expanded route is outside the shared contract');
      for (const method of methods) {
        status(await invoke(entry, { method, body: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : {} }), 401);
        const implemented = entry.definition.implemented.includes(method) || method === 'HEAD' && entry.definition.implemented.includes('GET');
        if (method === 'OPTIONS') {
          const options = await invoke(entry, { method, studentToken }); status(options, 204);
          assert.equal(options.headers.allow, entry.definition.optionsAllow, 'Expanded OPTIONS changed the method contract');
        } else if (!implemented) {
          const unsupported = await invoke(entry, { method, studentToken }); status(unsupported, 405);
          assert.equal(unsupported.headers.allow, undefined, 'Next unsupported-method Allow contract changed'); assert.equal(unsupported.body.length, 0);
        } else if (method === 'GET' || method === 'HEAD') {
          const read = await invoke(entry, { method, studentToken }); status(read, entry.readStatus ?? 200);
          if (method === 'HEAD') assert.equal(read.body.length, 0, 'Expanded HEAD returned bytes');
          if (method === 'GET' && entry.readError) assert.equal(json(read).code, entry.readError, 'Expanded GET lost its real stage boundary');
          if (method === 'GET' && normalizedApiPath(entry.route) === '/api/openmaic/classroom') assert.equal(json(read).classroom.id, extra.classroomId);
          if (method === 'GET' && /ai-collaboration\/(?:code|document|memory)$/.test(normalizedApiPath(entry.route))) {
            const content = read.body.toString('utf8'); assert.ok(content.includes(extra.markers.own), 'Owned synthetic private content was not read');
            assert.ok(!content.includes(extra.markers.peer) && !content.includes(extra.markers.hidden), 'Private peer/teacher-only content leaked');
          }
        } else {
          const probe = entry.write[method]; assert.ok(probe, 'Every valid mutation method needs an explicit no-write rejection probe');
          const rejected = await invoke(entry, { ...probe, method, studentToken });
          assert.ok(probe.expected.includes(rejected.status), 'Valid method did not retain its side-effect-free rejection');
          if (probe.errors) assert.ok(probe.errors.includes(json(rejected).error ?? json(rejected).code), 'Unexpected schema/feature rejection');
          const csrf = await invoke(entry, { ...probe, method, studentToken, extra: { origin: 'http://cross-origin.invalid' } }); status(csrf, 403);
        }
      }
      const method = entry.definition.implemented.includes('GET') ? 'GET' : 'POST';
      const probe = entry.write[method] ?? {}; const expected = method === 'GET' ? entry.readStatus ?? 200 : 400;
      for (const field of ['exp', 'nbf']) {
        const at = Math.floor(Date.now() / 1000); const changed = await token(fixture.student, { [field]: at + (field === 'exp' ? -1 : 3) });
        const began = Date.now(); status(await invoke(entry, { ...probe, method, studentToken: changed }), 401);
        status(await invoke(entry, { ...probe, method, studentToken: changed, teacherToken }), expected);
        assert.ok(Date.now() - began < 2000, 'Expanded JWT proof crossed its real-clock uncertainty window');
      }
      status(await invoke(entry, { ...probe, method, teacherToken, role: 'student' }), 401);
      status(await invoke(entry, { ...probe, method, teacherToken: studentToken, studentToken: teacherToken }), 401);
      for (const [field, value] of [['sessionVersion', fixture.student.sessionVersion + 1], ['status', 'DISABLED'], ['role', 'TEACHER']]) {
        try {
          await db.user.update({ where: { id: fixture.student.id }, data: { [field]: value } });
          status(await invoke(entry, { ...probe, method, studentToken, teacherToken }), 401);
        } finally { await db.user.update({ where: { id: fixture.student.id }, data: { role: fixture.student.role,
          status: fixture.student.status, sessionVersion: fixture.student.sessionVersion, updatedAt: fixture.student.updatedAt } }); }
      }
      if (method === 'GET') {
        try {
          await db.enrollment.update({ where: { id: fixture.enrollment.id }, data: { status: 'WITHDRAWN' } });
          status(await invoke(entry, { studentToken }), 403);
        } finally { await db.enrollment.update({ where: { id: fixture.enrollment.id }, data: { status: fixture.enrollment.status } }); }
        if (new URL(entry.route, 'http://127.0.0.1').searchParams.has('studentId')) {
          const mismatch = new URL(entry.route, 'http://127.0.0.1'); mismatch.searchParams.set('studentId', extra.peer.id);
          status(await invoke(entry, { route: mismatch.pathname + mismatch.search, studentToken }), 403);
        }
      } else {
        // A foreign-actor, otherwise valid event fails before creating any fact.
        const event = { id: randomUUID(), idempotencyKey: randomUUID(), courseId: fixture.courseId, studentId: extra.peer.id,
          stageKey: 'make', type: 'scene-enter', occurredAt: new Date().toISOString() };
        status(await invoke(entry, { method: 'POST', studentToken, body: { courseId: fixture.courseId, studentId: extra.peer.id, events: [event] } }), 403);
      }
      const fake = String(Date.now() - 10);
      const measured = await invoke(entry, { ...probe, method, studentToken, extra: { 'x-openpbl-http-received-at': '1',
        'x-openpbl-socket-accepted-at': '1', 'x-openpbl-http-local-port': '3000', 'x-openpbl-connection-id': '9999999999999',
        'x-openpbl-action-proxy-started': fake, 'x-openpbl-action-proxy-ended': fake,
        'x-openpbl-http-request-id': `http-${'a'.repeat(32)}-1` } }); status(measured, expected);
      if (protocolMode === 'candidate') assert.ok(measured.httpRequestId, 'Observed expanded API lacks native HTTP identity');
      forgedRequests.push({ route: entry.definition.route, method, requestId: measured.requestId, httpRequestId: measured.httpRequestId ?? null });
      const malformed = await invoke(entry, { ...probe, method, extra: {
        cookie: `openpbl_student=%E0%A4%A; openpbl_student=${studentToken}` } });
      const expectedError = entry.definition.route === '/api/ai-collaboration/document' ? 503 : 500;
      status(malformed, expectedError);
      report.expandedErrorEvidence ??= []; report.expandedErrorEvidence.push({ route: entry.definition.route,
        method, expectedStatus: expectedError, status: malformed.status, requestId: malformed.requestId,
        contentType: malformed.headers['content-type'] ?? null, csp });
    }
    // The large-body observation is bounded and cannot reach a memory mutation branch.
    const memory = entries.at(-1); const invalidMemory = memory.write.PATCH.body;
    for (const transfer of ['buffered', 'chunked']) {
      const response = await invoke(memory, { method: 'PATCH', studentToken, body: invalidMemory, transfer }); status(response, 400);
      report.bodyTransferObservations ??= []; report.bodyTransferObservations.push({ kind: `small-${transfer}`, requestId: response.requestId });
    }
    const large = await invoke(memory, { method: 'PATCH', studentToken, body: { ...invalidMemory, padding: 'x'.repeat(10 * 1024 * 1024 + 2048) }, observationOnly: true });
    report.bodyTransferObservations.push({ kind: 'over-default-10MiB-proxy-clone', requestId: large.requestId,
      requestBytes: report.requests.at(-1).bodyBytesSent, plannedRequestBytes: report.requests.at(-1).plannedRequestBodyBytes ?? report.requests.at(-1).bodyBytesSent,
      status: large.status, networkError: large.networkError === true,
      canonicalPolicyMatched: large.headers['content-security-policy'] === undefined ? null : large.headers['content-security-policy'] === report.cspPolicies[csp], error: (() => { try { return json(large).error ?? json(large).code ?? null; } catch { return null; } })(),
      note: 'Wire observation, not a new body-size/error contract or model-success assertion.' });
    const cancelled = await send(memory.route, { csp, method: 'PATCH', studentToken, body: invalidMemory, transfer: 'cancel-after-prefix' });
    assert.equal(cancelled.cancelled, true, 'Cancellation probe must abort its own request');
    report.bodyTransferObservations.push({ kind: 'client-cancelled-json-prefix', requestId: cancelled.requestId, status: null,
      note: 'No complete HTTP response observed: CSP/status/handler duration remain unknown.' });
    const presentation = entries.find(entry => entry.definition.route === '/api/courses/:courseId/showcase/presentation');
    const largePresentation = await invoke(presentation, { method: 'POST', studentToken,
      body: { action: 'native-proof-invalid-action', padding: 'x'.repeat(10 * 1024 * 1024 + 2048) }, observationOnly: true });
    report.bodyTransferObservations.push({ kind: 'showcase-over-default-10MiB-proxy-clone', requestId: largePresentation.requestId,
      requestBytes: report.requests.at(-1).bodyBytesSent,
      plannedRequestBytes: report.requests.at(-1).plannedRequestBodyBytes ?? report.requests.at(-1).bodyBytesSent,
      status: largePresentation.status, networkError: largePresentation.networkError === true,
      canonicalPolicyMatched: largePresentation.headers['content-security-policy'] === undefined ? null
        : largePresentation.headers['content-security-policy'] === report.cspPolicies[csp],
      note: 'Rejected command only; observe the changed adapter body path without treating its clone limit as a new business limit.' });
    // Live-session rejection echoes the original business header. This avoids
    // requiring the privacy-filtered app journal to retain that header's text.
    const reusedBusinessId = `native-proof-business-${randomUUID()}`;
    const repeated = [];
    try {
      await db.user.update({ where: { id: fixture.student.id }, data: { sessionVersion: fixture.student.sessionVersion + 1 } });
      const repeatedGet = async () => {
        const response = await send(`/api/courses/${fixture.courseId}/state`, { studentToken,
          extra: { 'x-request-id': reusedBusinessId, 'x-openpbl-http-request-id': `http-${'a'.repeat(32)}-1` } });
        status(response, 401); assert.equal(json(response).requestId, reusedBusinessId, 'Native ID changed business X-Request-Id');
        return response;
      };
      repeated.push(await repeatedGet(), await repeatedGet());
      repeated.push(...await Promise.all([repeatedGet(), repeatedGet()]));
    } finally { await db.user.update({ where: { id: fixture.student.id }, data: { role: fixture.student.role,
      status: fixture.student.status, sessionVersion: fixture.student.sessionVersion, updatedAt: fixture.student.updatedAt } }); }
    if (protocolMode === 'candidate') {
      assert.ok(repeated.every(row => row.httpRequestId), 'Repeated business requests need real native identities');
      assert.equal(new Set(repeated.map(row => row.httpRequestId)).size, 4, 'Native identity was reused across business-ID retries');
    }
    const after = await ownedFacts(db, fixture); assert.deepEqual(after, before, 'Rejected probes changed proof-owned persistent business facts');
    report.rejectedInputFacts = { before, after, unchanged: true, scope: 'Only this invocation-owned classroom/offering; no provider/model execution is attempted.' };
    const journal = await readAppJournal();
    report.expandedClockEvidence = forgedRequests.map(probe => {
      const rows = journal.filter(row => probe.httpRequestId ? row.httpRequestId === probe.httpRequestId : row.requestId === probe.requestId); assert.ok(rows.length <= 1, 'Expanded completion trace is not unique');
      const completion = rows[0];
      if (!completion) {
        assert.equal(protocolMode, 'baseline-observe', 'Candidate expanded anchor lacks a unique native application completion');
        return { ...probe, state: 'unknown', reason: 'No application completion observation; never inferred as zero.' };
      }
      assert.equal(completion.pid, isolation.appPid, 'Expanded completion came from another app process');
      if (protocolMode !== 'baseline-observe') {
        assert.equal(completion.nextProxyStartedAtMs, undefined, 'Expanded route accepted a Proxy start clock');
        assert.equal(completion.nextProxyEndedAtMs, undefined, 'Expanded route accepted a Proxy end clock');
      }
      if (completion.nodeHttpReceivedAtMs === undefined) {
        assert.equal(protocolMode, 'baseline-observe', 'Candidate expanded anchor lacks native ingress timing');
        return { ...probe, state: 'unknown', reason: 'Completion lacks native ingress timing.' };
      }
      assert.ok(completion.nodeHttpReceivedAtMs > 1 && completion.nodeHttpReceivedAtMs <= completion.handlerEnteredAtMs);
      assert.equal(completion.nodeHttpLocalPort, isolation.appPort); assert.notEqual(completion.nodeConnectionId, 9999999999999);
      if (completion.nodeSocketAcceptedAtMs !== undefined) assert.ok(completion.nodeSocketAcceptedAtMs > 1);
      return { ...probe, state: 'measured', pid: completion.pid, nodeHttpReceivedAtMs: completion.nodeHttpReceivedAtMs,
        nodeHttpLocalPort: completion.nodeHttpLocalPort, nextProxy: completion.nextProxyStartedAtMs === undefined ? 'absent' : 'observed' };
    });
    report.businessIdReuseEvidence = repeated.map(response => {
      if (!response.httpRequestId) return { state: 'unknown', reason: 'Legacy baseline has no native identity' };
      const rows = journal.filter(row => row.httpRequestId === response.httpRequestId);
      assert.equal(rows.length, 1, 'Repeated business ID needs one unique native completion');
      assert.equal(rows[0].pid, isolation.appPid); assert.ok(rows[0].nodeHttpReceivedAtMs > 1);
      return { state: 'measured', httpRequestId: response.httpRequestId, pid: rows[0].pid,
        businessIdPreservedIn401: true, nodeHttpReceivedAtMs: rows[0].nodeHttpReceivedAtMs };
    });
    report.checks.push(READ_API_NATIVE_PROTOCOL_CHECKS.at(-1));
  } finally { if (fileCreated) await unlink(file); }
}

/** Run once after classroom load, against an invocation-owned READY classroom.
 * Mutation APIs receive only explicit rejected probe inputs; no valid business write is retried. Changed fields are restored and
 * only this invocation's fixture rows are deleted. The optional second argument
 * is test-only dependency injection, explicitly identified in report evidence. */
export async function verifyReadApiBoundaryHttp({ baseURL, jwtSecret, db, isolation, output,
  readAppJournal, timeoutMs = 15000, protocolMode = 'candidate' }, dependencies = {}) {
  assert.ok(['candidate', 'baseline-observe'].includes(protocolMode), 'Unknown native protocol mode');
  const { origin, database } = target(baseURL, isolation);
  assert.ok(typeof jwtSecret === 'string' && jwtSecret.length >= 32, 'Missing isolated JWT secret');
  assert.ok(typeof readAppJournal === 'function', 'A real application completion journal is required');
  const inspect = dependencies.inspectIsolation ?? inspectIsolation;
  const initialIdentity = await inspect({ isolation, database });
  const policies = await canonicalPolicies(isolation, origin);
  const [databaseIdentity] = await db.$queryRawUnsafe('SELECT current_database() AS name');
  assert.equal(databaseIdentity.name, database.pathname.slice(1), 'Provided client targets another database');
  const fixture = await createProofFixture(db);
  const { teacher, student, enrollment } = fixture;
  const report = { schemaVersion: 1, status: 'running', evidence: inspect === inspectIsolation ? 'production-next-http' : 'test-orchestration-fixture',
    contractVersion: READ_API_NATIVE_PROTOCOL_VERSION, protocolMode, coveredRoutes: [], buildId: isolation.buildId, appPid: isolation.appPid, requests: [], checks: [], identity: initialIdentity, cspPolicies: policies,
    limitations: ['Protocol proof after classroom load; not a latency or browser/worker execution result.',
      'HTTP requests use agent:false. The two sequential plus two concurrent business-ID probes establish per-request identity, not Next keepalive reuse.',
      'Valid mutative business success and model execution are not exercised. Only schema/scope/CSRF rejections and unchanged proof-owned facts are verified.',
      'Candidate JSON/empty APIs intentionally use canonical static CSP; baseline-observe expects the prior dynamic CSP on the additional paths. Protected pages stay dynamic.',
      'A deliberate pre-existing malformed duplicate-cookie error probes the unchanged uncaught500 path; its wire Content-Type is recorded, not assumed.'] };
  const created = []; let sequence = 0; const prefix = `acceptance-${randomUUID().slice(0, 8)}-${process.pid}`;
  const routes = ['/api/server-providers', `/api/courses?courseId=${encodeURIComponent(fixture.courseId)}`,
    ...['state', 'events', 'projection'].map(operation => `/api/courses/${encodeURIComponent(fixture.courseId)}/${operation}`)];
  const token = async (user, changes = {}) => new SignJWT({ sub: user.id, role: user.role.toLowerCase(), sv: user.sessionVersion,
    ...(user.role.toLowerCase() === 'teacher' ? { username: user.username, displayName: user.displayName } : { userId: user.id, studentName: user.displayName }),
    exp: Math.floor(Date.now() / 1000) + 300, ...changes }).setProtectedHeader({ alg: 'HS256' }).setIssuer('openpbl').setAudience('openpbl-app')
    .sign(new TextEncoder().encode(jwtSecret));
  const cookie = (teacherToken, studentToken) => [teacherToken && `openpbl_teacher=${teacherToken}`, studentToken && `openpbl_student=${studentToken}`].filter(Boolean).join('; ');
  const send = async (route, { method = 'GET', teacherToken, studentToken, role = 'student', body, transfer = 'buffered', observationOnly = false, extra = {}, csp = READ_API_NATIVE_ROUTES.some(row => row.route === normalizedApiPath(route)) ? 'static' : 'dynamic' } = {}) => {
    assert.ok(READ_API_NATIVE_ROUTES.some(row => row.route === normalizedApiPath(route)) || route === '/api/auth/login' || route === '/teacher' || route === '/student/classroom/proof-guard', 'Probe path outside the fixed allowlist');
    const requestId = extra['x-request-id'] ?? `${prefix}-${++sequence}`;
    const started = performance.now();
    let response;
    try {
      response = await bytes(`${origin}${route}`, { method, body, transfer, headers: { origin, cookie: cookie(teacherToken, studentToken), 'x-openpbl-role': role,
        'x-request-id': requestId, ...extra } }, timeoutMs);
    } catch (error) {
      report.requests.push({ requestId: requestId.startsWith('acceptance-') ? requestId : undefined,
        businessRequestIdSha256: sha256(Buffer.from(requestId)), method, path: normalizedApiPath(route),
        route: route.replace(encodeURIComponent(fixture.courseId), ':courseId'), status: null,
        durationMs: performance.now() - started, bodyBytes: null, bodyBytesSent: null,
        plannedRequestBodyBytes: body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body)),
        headers: null, csp: 'unknown', nativeHttpRequestId: null, observationOnly,
        networkError: { name: error.name, code: error.code ?? null, message: String(error.message).slice(0, 300) } });
      if (!observationOnly) throw error;
      return { status: null, headers: {}, body: Buffer.alloc(0), requestId, networkError: true };
    }
    report.requests.push({ requestId: requestId.startsWith('acceptance-') ? requestId : undefined,
      businessRequestIdSha256: sha256(Buffer.from(requestId)), method, route: route.replace(encodeURIComponent(fixture.courseId), ':courseId'), status: response.status,
      path: normalizedApiPath(route), durationMs: performance.now() - started, bodyBytes: response.body.length, bodyBytesSent: response.bodyBytesSent ?? 0, sha256: sha256(response.body), csp: response.cancelled ? 'unknown' : csp,
      nativeHttpRequestId: nativeHttpId(response.headers['x-openpbl-http-request-id']) ?? null, transfer, observationOnly, cancelled: response.cancelled === true,
      headers: Object.fromEntries(['etag', 'cache-control', 'allow', 'content-type', 'content-security-policy', 'server-timing', 'location', 'x-openpbl-http-request-id']
        .map(key => [key, response.headers[key] ?? null])) });
    if (response.cancelled || observationOnly) return { ...response, requestId, httpRequestId: nativeHttpId(response.headers['x-openpbl-http-request-id']) };
    const rawId = response.headers['x-openpbl-http-request-id'];
    if (rawId !== undefined) {
      assert.ok(nativeHttpId(rawId), 'Invalid native HTTP identity');
      assert.equal(report.requests.filter(row => row.nativeHttpRequestId === rawId).length, 1, 'Native HTTP identity was reused');
      assert.notEqual(rawId, extra['x-openpbl-http-request-id'], 'Caller supplied the native HTTP identity');
    }
    assert.equal(response.headers['content-security-policy'], policies[csp], 'Response does not match the canonical build CSP');
    return { ...response, requestId, httpRequestId: nativeHttpId(response.headers['x-openpbl-http-request-id']) };
  };
  const status = (response, expected) => assert.equal(response.status, expected, 'Read API native HTTP status mismatch');
  const json = response => JSON.parse(response.body.toString('utf8'));
  const check = name => report.checks.push(name);
  const savedUser = user => ({ role: user.role, status: user.status, sessionVersion: user.sessionVersion, updatedAt: user.updatedAt });
  let primaryError;
  try {
    const teacherToken = await token(teacher); const studentToken = await token(student);
    for (const route of routes) {
      status(await send(route), 401);
      const deniedHead = await send(route, { method: 'HEAD' }); status(deniedHead, 401); assert.equal(deniedHead.body.length, 0);
      const own = await send(route, { studentToken }); status(own, 200);
      const head = await send(route, { method: 'HEAD', studentToken }); status(head, 200); assert.equal(head.body.length, 0, 'HEAD returned body bytes');
      if (own.headers.etag) assert.equal(head.headers.etag, own.headers.etag, 'HEAD changed the scoped ETag');
      for (const authenticated of [false, true]) {
        const options = await send(route, { method: 'OPTIONS', studentToken: authenticated ? studentToken : undefined });
        status(options, authenticated ? 204 : 401);
        assert.equal(options.headers.allow, authenticated ? 'GET, HEAD, OPTIONS' : undefined, 'OPTIONS changed the method contract');
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
          const rejection = await send(route, { method, studentToken: authenticated ? studentToken : undefined });
          status(rejection, authenticated ? 405 : 401); if (authenticated) assert.equal(rejection.body.length, 0);
        }
      }
    }
    check('all-five-real-GET-HEAD-OPTIONS-and-write-rejection-shapes');
    const state = await send(routes[2], { studentToken }); const etag = state.headers.etag;
    assert.ok(etag, 'Scoped state lacks ETag');
    const conditional = await send(routes[2], { studentToken, extra: { 'if-none-match': etag } }); status(conditional, 304); assert.equal(conditional.body.length, 0);
    for (const actor of [teacher, student]) for (const field of ['exp', 'nbf']) {
      const at = Math.floor(Date.now() / 1000); const changed = await token(actor, { [field]: at + (field === 'exp' ? -1 : 3) });
      const began = Date.now(); const role = actor.role.toLowerCase();
      const selected = role === 'teacher' ? { teacherToken: changed } : { studentToken: changed };
      status(await send(routes[0], { ...selected, role }), 401);
      status(await send(routes[0], { teacherToken, studentToken, ...selected, role }), 200);
      assert.ok(Date.now() - began < 2000, 'JWT boundary proof crossed its explicit real-clock uncertainty window');
    }
    status(await send(routes[0], { teacherToken, role: 'student' }), 401);
    check('strict-gate-and-selected-grace-role-with-dual-real-JWTs');
    for (const [field, value] of [['sessionVersion', student.sessionVersion + 1], ['status', 'DISABLED'], ['role', 'TEACHER']]) {
      try {
        await db.user.update({ where: { id: student.id }, data: { [field]: value } });
        const revoked = await send(routes[2], { studentToken, extra: { 'if-none-match': etag } }); status(revoked, 401);
        assert.match(String(revoked.headers['set-cookie']), /openpbl_student=;/, 'Selected revoked cookie was not cleared');
      } finally { await db.user.update({ where: { id: student.id }, data: savedUser(student) }); }
      status(await send(routes[2], { studentToken }), 200);
    }
    check('live-session-version-status-role-before-conditional-cache-hit');
    try {
      await db.enrollment.update({ where: { id: enrollment.id }, data: { status: 'WITHDRAWN' } });
      for (const route of routes.slice(2)) status(await send(route, { studentToken, extra: { 'if-none-match': etag } }), 403);
      assert.deepEqual(json(await send(routes[1], { studentToken })).courses, [], 'Withdrawn student received the scoped course');
    } finally { await db.enrollment.update({ where: { id: enrollment.id }, data: { status: enrollment.status } }); }
    for (const role of ['TEACHER', 'STUDENT']) {
      const id = randomUUID(); const username = `read-api-proof-${id}`;
      const outside = await db.user.create({ data: { id, username, usernameKey: username, displayName: '隔离读取协议验收', role, status: 'ACTIVE',
        passwordHash: '!non-login-synthetic-proof', sessionVersion: 1 }, select: userSelect }); created.push(id);
      const signed = await token(outside); const auth = role === 'TEACHER' ? { teacherToken: signed, role: 'teacher' } : { studentToken: signed };
      for (const route of routes.slice(2)) status(await send(route, auth), 403);
      const list = await send(routes[1], auth); status(list, role === 'TEACHER' ? 403 : 200);
      if (role === 'STUDENT') assert.deepEqual(json(list).courses, [], 'Outsider received the classroom');
    }
    check('fresh-enrollment-and-outsider-scope-denials-without-changing-history');
    const ownCourse = json(await send(routes[2], { studentToken })).course;
    assert.equal(ownCourse.id, fixture.courseId); assert.equal(ownCourse.name, '隔离读取协议', 'Published proof design was not decoded');
    assert.ok((ownCourse.students ?? []).every(member => member.id === student.id), 'Student state exposed a peer identity');
    status(await send(routes[2], { teacherToken, role: 'teacher' }), 200);
    const malformed = await send(routes[0], { extra: { cookie: `openpbl_student=%E0%A4%A; openpbl_student=${studentToken}` }, csp: 'static' });
    status(malformed, 500); check('uncaught-error-keeps-framework500-and-static-CSP');
    const forged = String(Date.now() - 10);
    const measured = await send(routes[2], { studentToken, extra: { 'x-openpbl-http-received-at': '1', 'x-openpbl-socket-accepted-at': '1',
      'x-openpbl-http-local-port': '3000', 'x-openpbl-connection-id': '9999999999999',
      'x-openpbl-action-proxy-started': forged, 'x-openpbl-action-proxy-ended': forged } }); status(measured, 200);
    assert.ok(!/(?:^|,)\s*(?:proxy|dispatch|node-dispatch);/.test(measured.headers['server-timing'] ?? ''), 'A bypassed route accepted caller Proxy clocks');
    let completion;
    for (let attempt = 0; attempt < 20; attempt++) {
      const rows = (await readAppJournal()).filter(row => (measured.httpRequestId ? row.httpRequestId === measured.httpRequestId : row.requestId === measured.requestId) && row.pid === isolation.appPid);
      assert.ok(rows.length <= 1, 'Native proof completion trace is not unique'); completion = rows[0]; if (completion) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (protocolMode === 'candidate') assert.ok(measured.httpRequestId, 'Candidate state GET lacks native HTTP identity');
    assert.ok(completion && completion.nodeHttpReceivedAtMs > 1 && completion.nodeHttpReceivedAtMs <= completion.handlerEnteredAtMs, 'Genuine native receipt clock missing');
    assert.equal(completion.nodeHttpLocalPort, isolation.appPort, 'Native clock came from another listener');
    assert.equal(completion.nextProxyStartedAtMs, undefined); assert.equal(completion.nextProxyEndedAtMs, undefined);
    report.clockEvidence = { requestId: measured.requestId, httpRequestId: measured.httpRequestId ?? null, nodeHttpReceivedAtMs: completion.nodeHttpReceivedAtMs,
      handlerEnteredAtMs: completion.handlerEnteredAtMs, nodeHttpLocalPort: completion.nodeHttpLocalPort, nextProxy: 'absent' };
    check('native-clock-is-genuine-and-absent-Proxy-clock-stays-unknown');
    status(await send('/api/auth/login'), 410);
    for (const route of ['/teacher', '/student/classroom/proof-guard']) {
      const guarded = await send(route); assert.ok([307, 308].includes(guarded.status), 'Protected page lost its Proxy redirect');
    }
    check('retired-and-page-Proxy-guards-retained');
    await verifyExpandedApiBoundary({ db, fixture, created, send, token, teacherToken, studentToken, report,
      isolation, status, json, readAppJournal, protocolMode });
    report.coveredRoutes = READ_API_NATIVE_ROUTES.map(definition => {
      const observed = report.requests.filter(row => row.path === definition.route && row.status !== null);
      return { route: definition.route, requestCount: observed.length,
        testedMethods: [...new Set(observed.map(row => row.method))].sort(), optionsAllow: definition.optionsAllow,
        clockState: report.expandedClockEvidence?.find(row => row.route === definition.route)?.state
          ?? (definition.route.endsWith('/state') ? 'measured' : 'unknown') };
    });
    report.httpIdentity = { stateAnchor: report.clockEvidence.httpRequestId ? 'measured' : 'unknown',
      repeatedBusinessRequests: report.businessIdReuseEvidence.length,
      uniqueNativeIds: new Set(report.businessIdReuseEvidence.filter(row => row.state === 'measured').map(row => row.httpRequestId)).size,
      sameAppPid: report.businessIdReuseEvidence.every(row => row.state === 'measured' && row.pid === isolation.appPid),
      businessIdPreserved: report.businessIdReuseEvidence.every(row => row.businessIdPreservedIn401 === true) };
    report.status = protocolMode === 'candidate' ? 'passed' : 'observed';
  } catch (error) { primaryError = error; report.status = 'failed'; throw error; }
  finally {
    const cleanup = await Promise.allSettled([
      db.user.update({ where: { id: student.id }, data: savedUser(student) }),
      db.enrollment.update({ where: { id: enrollment.id }, data: { status: enrollment.status } }),
    ]);
    const failures = cleanup.filter(result => result.status === 'rejected');
    try { await cleanupProofFixture(db, fixture.owned, created); } catch (error) { failures.push({ reason: error }); }
    try { assert.deepEqual(await inspect({ isolation, database }), initialIdentity, 'Isolated app/build identity changed during protocol proof'); }
    catch (error) { failures.push({ reason: error }); }
    report.restoration = failures.length ? 'failed' : 'passed'; if (failures.length) report.status = 'failed';
    if (output) { await mkdir(output, { recursive: true }); await writeFile(path.join(output, 'read-api-boundary-http.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
    if (failures.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures.map(result => result.reason)], 'Read API proof restoration/identity check failed');
  }
  return report;
}
