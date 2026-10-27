// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { startCourseReadWorker, assertCourseReadDatabaseRole, type CourseReadRoleProof } from './course-read-worker-entry';
import { timeProgress } from '@/lib/observability/progress-request-timing';
const proof: CourseReadRoleProof = { ordinaryRole: true, readOnlyDefault: true, noTableWrites: true,
  noColumnWrites: true, noSequenceWrites: true, noSchemaCreate: true, noDatabaseCreate: true, noMemberships: true, noOwnership: true };
function fixture(row = proof) {
  let receive: (message: unknown) => void = () => { throw Error('not ready'); };
  const port = { postMessage: vi.fn(), on: vi.fn((_event: string, fn: typeof receive) => { receive = fn; }), close: vi.fn() };
  const query = vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => { void _query; void _values; return [row]; });
  const db = { $queryRaw: async <T>(sql: TemplateStringsArray, ...values: unknown[]): Promise<T> => await query(sql, ...values) as T, $disconnect: vi.fn(async () => {}) };
  const handlers = { getCourses: vi.fn(async (request: Request) => timeProgress('courses-auth', async () => new Response(request.headers.get('x-request-id')))),
    getCourseState: vi.fn(async () => new Response(null, { status: 304, headers: { etag: '"current"' } })),
    getProjectionState: vi.fn(async (_request: Request) => { void _request; return Response.json({ projectionVersion: 3 }); }),
    getCourseEvents: vi.fn(async (_request: Request) => { void _request; return Response.json({ events: [], nextCursor: '0' }); }) };
  const dependencies = { database: vi.fn(async () => db), handlers: vi.fn(async () => handlers), env: { OPENPBL_INTERNAL_COURSE_READ_THREAD: '1', OPENPBL_COURSE_READ_WORKERS: '0' } };
  return { port, db, query, handlers, dependencies, receive: (v: unknown) => receive(v) };
}
const identity = { role: 'course-read', protocol: 1 };
const job = { type: 'execute', id: 1, operation: 'courses', url: 'http://localhost/api/courses', headers: [['x-request-id', 'same-business']] };
it.each(['projection', 'events'] as const)('dispatches %s through its own core and preserves complete unauthorized response', async operation => {
  const f = fixture();
  const selected = operation === 'projection' ? f.handlers.getProjectionState : f.handlers.getCourseEvents;
  selected.mockImplementation(async (request: Request) => timeProgress('courses-auth', async () => {
    expect(request.method).toBe('GET');
    expect(request.headers.get('x-request-id')).toBe('same-business');
    const headers = new Headers({ 'Cache-Control': 'no-store', 'x-request-id': 'same-business' });
    headers.append('set-cookie', 'student=; Path=/; Max-Age=0');
    headers.append('set-cookie', 'legacy=; Path=/; Max-Age=0');
    return Response.json({ code: 'UNAUTHORIZED', message: '登录失效' }, { status: 401, headers });
  }));
  await startCourseReadWorker(f.port, identity, f.dependencies);
  f.receive({ ...job, operation, courseId: 'one', url: `http://localhost/api/courses/one/${operation}?after=0` });
  await vi.waitFor(() => expect(f.port.postMessage.mock.calls.some(([m]) => m.type === 'result')).toBe(true));
  const [result, transfer] = f.port.postMessage.mock.calls.find(([m]) => m.type === 'result')!;
  expect(result.status).toBe(401); expect(result.cookies).toEqual(['student=; Path=/; Max-Age=0', 'legacy=; Path=/; Max-Age=0']);
  expect(JSON.parse(new TextDecoder().decode(result.body))).toEqual({ code: 'UNAUTHORIZED', message: '登录失效' });
  expect(result.headers).toContainEqual(['cache-control', 'no-store']);
  expect(result.phaseSpans).toEqual([expect.objectContaining({ phase: 'courses-auth', outcome: 'ok' })]);
  expect(transfer).toEqual([result.body]); expect(selected).toHaveBeenCalledOnce();
  expect(f.handlers.getCourses).not.toHaveBeenCalled(); expect(f.handlers.getCourseState).not.toHaveBeenCalled();
  f.receive({ type: 'shutdown' }); await vi.waitFor(() => expect(f.db.$disconnect).toHaveBeenCalledOnce());
});
describe('isolated course read worker readiness and lifecycle', () => {
  it.each(Object.keys(proof) as (keyof CourseReadRoleProof)[])('rejects unsafe live permission %s before loading core', async key => {
    const f = fixture({ ...proof, [key]: false }); await startCourseReadWorker(f.port, identity, f.dependencies);
    expect(f.dependencies.handlers).not.toHaveBeenCalled(); expect(f.port.postMessage).toHaveBeenCalledWith({ type: 'fatal', error: 'COURSE_READ_STARTUP_FAILED' });
    expect(f.db.$disconnect).toHaveBeenCalledOnce(); expect(f.port.close).toHaveBeenCalledOnce();
  });
  it('does not start DB for bad role/environment or explicit build-only self-check', async () => {
    const f = fixture(); await startCourseReadWorker(f.port, { role: 'other', protocol: 1 }, f.dependencies);
    expect(f.dependencies.database).not.toHaveBeenCalled();
    await startCourseReadWorker(f.port, identity, { ...f.dependencies, env: {} }); expect(f.dependencies.database).not.toHaveBeenCalled();
    const selfCheck = vi.fn(async () => {}); await startCourseReadWorker(f.port, { ...identity, selfCheck: true }, { ...f.dependencies, selfCheck });
    expect(selfCheck).toHaveBeenCalledOnce(); expect(f.dependencies.database).not.toHaveBeenCalled();
    expect(f.port.postMessage.mock.calls.some(([m]) => m.type === 'ready')).toBe(false);
  });
  it('authenticates every execution in core and returns actual phases/body with one transfer', async () => {
    const f = fixture(); await startCourseReadWorker(f.port, identity, f.dependencies);
    expect(f.port.postMessage).toHaveBeenCalledWith({ type: 'ready', protocol: 1 });
    f.receive(job); await vi.waitFor(() => expect(f.port.postMessage.mock.calls.some(([m]) => m.type === 'result')).toBe(true));
    const [result, transfer] = f.port.postMessage.mock.calls.find(([m]) => m.type === 'result')!;
    expect(new TextDecoder().decode(result.body)).toBe('same-business'); expect(transfer).toEqual([result.body]);
    expect(result.phaseSpans[0]).toMatchObject({ phase: 'courses-auth', outcome: 'ok' });
    f.receive({ ...job, id: 2 }); await vi.waitFor(() => expect(f.handlers.getCourses).toHaveBeenCalledTimes(2));
    f.receive({ type: 'shutdown' }); await vi.waitFor(() => expect(f.db.$disconnect).toHaveBeenCalledOnce());
  });
  it('allows 16 independent in-flight reads, rejects overflow and drains all on shutdown', async () => {
    const f = fixture(); const done: ((response: Response) => void)[] = [];
    f.handlers.getCourses.mockImplementation(() => new Promise(resolve => { done.push(resolve); }));
    await startCourseReadWorker(f.port, identity, f.dependencies);
    for (let id = 1; id <= 16; id++) f.receive({ ...job, id });
    expect(f.handlers.getCourses).toHaveBeenCalledTimes(16);
    f.receive({ ...job, id: 17 });
    expect(f.handlers.getCourses).toHaveBeenCalledTimes(16); expect(f.db.$disconnect).not.toHaveBeenCalled();
    expect(f.port.postMessage).toHaveBeenCalledWith({ type: 'fatal', error: 'COURSE_READ_PROTOCOL_ERROR' });
    for (const resolve of done.slice(0, 15)) resolve(new Response('done'));
    await new Promise(resolve => setTimeout(resolve, 0)); expect(f.db.$disconnect).not.toHaveBeenCalled();
    done[15](new Response('last')); await vi.waitFor(() => expect(f.db.$disconnect).toHaveBeenCalledOnce());
  });
  it('keeps concurrent request-local timing contexts separate and accepts shutdown during reads', async () => {
    const f = fixture(); const done: ((response: Response) => void)[] = [];
    f.handlers.getCourses.mockImplementation(() => timeProgress('courses-read', () => new Promise(resolve => { done.push(resolve); })));
    await startCourseReadWorker(f.port, identity, f.dependencies); f.receive(job); f.receive({ ...job, id: 2 });
    f.receive({ type: 'shutdown' }); done[1](new Response('second')); done[0](new Response('first'));
    await vi.waitFor(() => expect(f.port.close).toHaveBeenCalledOnce());
    const results = f.port.postMessage.mock.calls.map(([m]) => m).filter(m => m.type === 'result');
    expect(results).toHaveLength(2); expect(results.every(r => r.phaseSpans.length === 1 && r.phaseSpans[0].sequence === 0)).toBe(true);
  });
  it('keeps failed jobs bounded and sanitizes errors; stats expose no headers or payload', async () => {
    const f = fixture(); f.handlers.getCourses.mockRejectedValueOnce(new Error('secret-cookie-body'));
    await startCourseReadWorker(f.port, identity, f.dependencies); f.receive(job);
    await vi.waitFor(() => expect(f.port.postMessage).toHaveBeenCalledWith({ type: 'error', id: 1, code: 'COURSE_READ_FAILED', message: 'Course read failed' }));
    f.receive({ type: 'stats', id: 3 }); const stats = f.port.postMessage.mock.calls.find(([m]) => m.type === 'stats')![0];
    expect(Object.keys(stats.memory).sort()).toEqual(['arrayBuffers', 'external', 'heapTotal', 'heapUsed']);
    expect(JSON.stringify(stats)).not.toContain('secret');
    f.receive({ type: 'arbitrary' }); await vi.waitFor(() => expect(f.port.close).toHaveBeenCalledOnce());
  });
  it('checks schema/table/column/sequence and database permissions without revoking TEMP', async () => {
    const f = fixture(); await assertCourseReadDatabaseRole(f.db);
    const sql = f.query.mock.calls[0]?.[0] as unknown as string[];
    expect(sql.join('')).toContain('has_any_column_privilege'); expect(sql.join('')).toContain('has_sequence_privilege');
    expect(sql.join('')).not.toContain("'TEMP'");
    // PostgreSQL may reorder WHERE predicates: only CASE protects function argument types.
    for (const name of ['has_table_privilege', 'has_any_column_privilege', 'has_sequence_privilege']) {
      expect(sql.join('')).toMatch(new RegExp(`CASE WHEN c\\.relkind[^;]+?THEN ${name}\\([^;]+?ELSE false END`));
    }
  });
});
