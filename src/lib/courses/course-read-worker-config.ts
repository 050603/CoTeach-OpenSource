/** Pure configuration: importing this module never creates a database client or pool. */
export type CourseReadWorkerConfig = {
  enabled: boolean; count: 0 | 1 | 2; budget: number; perWorkerConnections: number;
  primaryDatabaseUrl: string | undefined; workerDatabaseUrl: string | undefined;
};
function positive(value: string | undefined, field: string): number {
  if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`Invalid course read worker configuration: ${field}`);
  }
  return Number(value);
}
function database(value: string | undefined, field: string): URL {
  try {
    const url = new URL(value ?? '');
    if (!['postgresql:', 'postgres:'].includes(url.protocol) || !url.hostname || !url.username
      || url.pathname === '/' || !url.pathname || url.hash) throw new Error();
    return url;
  } catch { throw new Error(`Invalid course read worker configuration: ${field}`); }
}
export function resolveCourseReadWorkerConfig(env: Record<string, string | undefined> = process.env): CourseReadWorkerConfig {
  const raw = env.OPENPBL_COURSE_READ_WORKERS ?? '0';
  if (!['0', '1', '2'].includes(raw)) throw new Error('Invalid course read worker configuration: workers');
  const count = Number(raw) as 0 | 1 | 2;
  if (!count) return { enabled: false, count, budget: 0, perWorkerConnections: 0,
    primaryDatabaseUrl: env.DATABASE_URL, workerDatabaseUrl: undefined };
  const budget = positive(env.OPENPBL_COURSE_READ_CONNECTION_BUDGET, 'connection budget');
  const perWorkerConnections = positive(env.OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS, 'worker connections');
  const primaryLimit = budget - count * perWorkerConnections;
  if (!Number.isSafeInteger(primaryLimit) || primaryLimit < 1) throw new Error('Course read workers exhaust the primary connection budget');
  const primary = database(env.DATABASE_URL, 'primary database');
  const worker = database(env.OPENPBL_COURSE_READ_DATABASE_URL, 'read database');
  if (primary.hostname.toLowerCase() !== worker.hostname.toLowerCase() || (primary.port || '5432') !== (worker.port || '5432')
    || decodeURIComponent(primary.pathname) !== decodeURIComponent(worker.pathname)
    || (primary.searchParams.get('schema') || 'public') !== (worker.searchParams.get('schema') || 'public')) {
    throw new Error('Course read worker must use the same database and schema');
  }
  if (decodeURIComponent(primary.username) === decodeURIComponent(worker.username)) throw new Error('Course read worker requires a separate database identity');
  primary.searchParams.set('connection_limit', String(primaryLimit));
  worker.searchParams.set('connection_limit', String(perWorkerConnections));
  // Normal readiness separately checks live role privileges and this setting.
  const options = worker.searchParams.get('options')?.trim();
  worker.searchParams.set('options', `${options ? options + ' ' : ''}-c default_transaction_read_only=on`);
  return { enabled: true, count, budget, perWorkerConnections,
    primaryDatabaseUrl: primary.toString(), workerDatabaseUrl: worker.toString() };
}
