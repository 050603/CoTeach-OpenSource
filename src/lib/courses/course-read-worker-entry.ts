import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { collectProgressTimings, type ProgressTimingSpan } from '@/lib/observability/progress-request-timing';
import { courseReadResponseMessage, isCourseReadWorkerRequest,
  type CourseReadWorkerMessage, type CourseReadWorkerRequest } from './course-read-worker-protocol';

type ReadDatabase = {
  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $disconnect(): Promise<void>;
};
type Handlers = {
  getCourses(request: Request): Promise<Response>;
  getCourseState(request: Request, context: { params: Promise<{ courseId: string }> }): Promise<Response>;
  getProjectionState(request: Request, context: { params: Promise<{ courseId: string }> }): Promise<Response>;
  getCourseEvents(request: Request, context: { params: Promise<{ courseId: string }> }): Promise<Response>;
};
type Port = { postMessage(message: CourseReadWorkerMessage, transfer?: ArrayBuffer[]): void;
  on(event: 'message', listener: (message: unknown) => void): unknown; close(): void };
export type CourseReadRoleProof = { ordinaryRole: boolean; readOnlyDefault: boolean;
  noTableWrites: boolean; noColumnWrites: boolean; noSequenceWrites: boolean;
  noSchemaCreate: boolean; noDatabaseCreate: boolean; noMemberships: boolean; noOwnership: boolean };

/** Enforce live permissions; the URL and a read-only startup option alone are not authority. */
export async function assertCourseReadDatabaseRole(db: ReadDatabase): Promise<void> {
  const rows = await db.$queryRaw<unknown>`
    SELECT NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls OR r.rolreplication OR r.rolinherit) AS "ordinaryRole",
      current_setting('default_transaction_read_only') = 'on' AS "readOnlyDefault",
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END) AS "noTableWrites",
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES') ELSE false END) AS "noColumnWrites",
      NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(current_user,c.oid,'USAGE,UPDATE') ELSE false END) AS "noSequenceWrites",
      NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(current_user,n.oid,'CREATE')) AS "noSchemaCreate",
      NOT has_database_privilege(current_user,current_database(),'CREATE') AS "noDatabaseCreate",
      NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS "noMemberships",
      NOT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass
        AND d.refobjid=r.oid AND d.deptype='o') AS "noOwnership"
    FROM pg_roles r WHERE r.rolname=current_user
  `;
  const proof = Array.isArray(rows) ? rows[0] as CourseReadRoleProof | undefined : undefined;
  if (!Array.isArray(rows) || rows.length !== 1 || !proof || !(['ordinaryRole', 'readOnlyDefault', 'noTableWrites',
    'noColumnWrites', 'noSequenceWrites', 'noSchemaCreate', 'noDatabaseCreate', 'noMemberships', 'noOwnership'] as const).every(key => proof[key] === true)) {
    throw new Error('COURSE_READ_DATABASE_NOT_READ_ONLY');
  }
}

async function selfCheck(port: Port) {
  const require = createRequire(path.join(process.cwd(), 'workers/course-read-worker.cjs'));
  const clientPath = await realpath(require.resolve('@prisma/client'));
  const clientRequire = createRequire(clientPath);
  const generatedClientPath = await realpath(clientRequire.resolve('.prisma/client/default'));
  const { Prisma } = require('@prisma/client') as { Prisma: { prismaVersion: { client: string } } };
  const engineDirectory = path.dirname(generatedClientPath);
  const enginePaths = (await readdir(engineDirectory)).filter(name => /^(?:libquery_engine.*\.node|query_engine.*\.exe)$/.test(name))
    .map(name => path.join(engineDirectory, name));
  if (!enginePaths.length) throw new Error('COURSE_READ_ENGINE_MISSING');
  for (const enginePath of enginePaths) {
    const engine = require(enginePath) as { QueryEngine?: unknown };
    if (typeof engine.QueryEngine !== 'function') throw new Error('COURSE_READ_ENGINE_INVALID');
  }
  port.postMessage({ type: 'self-check', protocol: 1, prismaVersion: Prisma.prismaVersion.client,
    clientPath, generatedClientPath, enginePaths });
  port.close();
}

/** Separate bootstrap allows protocol tests without launching Next, tasks or a database. */
export async function startCourseReadWorker(port: Port, data: unknown, dependencies: {
  database(): Promise<ReadDatabase>; handlers(): Promise<Handlers>; env?: Record<string, string | undefined>;
  selfCheck?: (port: Port) => Promise<void>;
}): Promise<void> {
  const options = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  let db: ReadDatabase | undefined;
  try {
    if (options.role !== 'course-read' || options.protocol !== 1
      || Object.keys(options).some(key => !['role', 'protocol', 'selfCheck'].includes(key))
      || options.selfCheck !== undefined && options.selfCheck !== true) throw new Error('COURSE_READ_WORKER_IDENTITY');
    if (options.selfCheck === true) { await (dependencies.selfCheck ?? selfCheck)(port); return; }
    const env = dependencies.env ?? process.env;
    if (env.OPENPBL_INTERNAL_COURSE_READ_THREAD !== '1' || env.OPENPBL_COURSE_READ_WORKERS !== '0') throw new Error('COURSE_READ_WORKER_ENVIRONMENT');
    db = await dependencies.database();
    await assertCourseReadDatabaseRole(db);
    const handlers = await dependencies.handlers();
    const active = new Map<number, Promise<void>>();
    let stopping = false;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      stopping = true;
      await Promise.allSettled([...active.values()]);
      await db!.$disconnect();
      port.postMessage({ type: 'closed' }); port.close();
    })().catch(() => { port.postMessage({ type: 'fatal', error: 'COURSE_READ_SHUTDOWN_FAILED' }); port.close(); });
    const fatal = () => { port.postMessage({ type: 'fatal', error: 'COURSE_READ_PROTOCOL_ERROR' }); void close(); };
    port.on('message', (input: unknown) => {
      if (!isCourseReadWorkerRequest(input)) { fatal(); return; }
      const message: CourseReadWorkerRequest = input;
      if (message.type === 'shutdown') { void close(); return; }
      if (stopping) { fatal(); return; }
      if (message.type === 'stats') {
        const { heapUsed, heapTotal, external, arrayBuffers } = process.memoryUsage();
        let threadCpu: { user: number; system: number } | null = null;
        try { if (typeof process.threadCpuUsage === 'function') threadCpu = process.threadCpuUsage(); } catch { /* Unsupported is unknown. */ }
        port.postMessage({ type: 'stats', id: message.id, memory: { heapUsed, heapTotal, external, arrayBuffers },
          threadCpu, sampledAtMs: Date.now(), monotonicNs: process.hrtime.bigint().toString() }); return;
      }
      if (active.size >= 16 || active.has(message.id)) { fatal(); return; }
      const started = performance.now();
      const spans: ProgressTimingSpan[] = [];
      const execution = (async () => {
        try {
          const request = new Request(message.url, { method: 'GET', headers: message.headers });
          const response = await collectProgressTimings(started, spans, () => {
            const context = { params: Promise.resolve({ courseId: message.courseId! }) };
            switch (message.operation) {
              case 'courses': return handlers.getCourses(request);
              case 'state': return handlers.getCourseState(request, context);
              case 'projection': return handlers.getProjectionState(request, context);
              case 'events': return handlers.getCourseEvents(request, context);
            }
          });
          const result = await courseReadResponseMessage(message.id, response, spans, performance.now() - started);
          // Include response byte materialization in execution, not just handler return.
          result.executionMs = performance.now() - started;
          port.postMessage(result, result.body === null ? [] : [result.body]);
        } catch {
          port.postMessage({ type: 'error', id: message.id, code: 'COURSE_READ_FAILED', message: 'Course read failed' });
        }
      })();
      active.set(message.id, execution);
      void execution.then(() => active.delete(message.id), () => { active.delete(message.id); void close(); });
    });
    port.postMessage({ type: 'ready', protocol: 1 });
  } catch {
    if (db) await db.$disconnect().catch(() => undefined);
    port.postMessage({ type: 'fatal', error: 'COURSE_READ_STARTUP_FAILED' }); port.close();
  }
}

if (parentPort) void startCourseReadWorker(parentPort, workerData, {
  database: async () => (await import('@/lib/db/client')).prisma,
  handlers: () => import('./http-read-handlers'),
});
