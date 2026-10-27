import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const marker = 'openpbl-course-read-role:v1';
const prefix = 'OPENPBL_COURSE_READ_';
const fields = ['WORKERS', 'CONNECTION_BUDGET', 'PER_WORKER_CONNECTIONS', 'DATABASE_URL'].map(key => prefix + key);
const deny = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };
const code = value => typeof value?.code === 'string' && value.code.startsWith('COURSE_READ_') ? value.code : 'COURSE_READ_ROLE_DATABASE_FAILED';
const safeRole = name => typeof name === 'string' && /^openpbl_course_read(?:er|_[a-z0-9_]+)$/.test(name) && Buffer.byteLength(name) <= 63;
const connection = databaseURL => new PrismaClient({ datasourceUrl: databaseURL, log: [], errorFormat: 'minimal' });

function database(value) {
  try {
    deny(typeof value === 'string' && !/[\r\n\0]/.test(value), 'COURSE_READ_DATABASE_URL_INVALID');
    const url = new URL(value);
    deny(['postgresql:', 'postgres:'].includes(url.protocol) && url.hostname && url.username && url.pathname.length > 1 && !url.hash,
      'COURSE_READ_DATABASE_URL_INVALID');
    for (const key of ['schema', 'options', 'connection_limit']) deny(url.searchParams.getAll(key).length <= 1, 'COURSE_READ_DATABASE_URL_INVALID');
    deny((url.searchParams.get('schema') || 'public') === 'public', 'COURSE_READ_ROLE_PUBLIC_SCHEMA_REQUIRED');
    decodeURIComponent(url.username); decodeURIComponent(url.password); decodeURIComponent(url.pathname);
    return url;
  } catch (error) { throw Object.assign(new Error(code(error) === 'COURSE_READ_ROLE_DATABASE_FAILED' ? 'COURSE_READ_DATABASE_URL_INVALID' : code(error)),
    { code: code(error) === 'COURSE_READ_ROLE_DATABASE_FAILED' ? 'COURSE_READ_DATABASE_URL_INVALID' : code(error) }); }
}

export function courseReadWorkerSettings(env = {}) {
  const workers = env[`${prefix}WORKERS`] ?? '0';
  deny(['0', '1', '2'].includes(workers), 'COURSE_READ_WORKERS_INVALID');
  if (workers === '0') return { enabled: false, workers: 0 };
  const positive = key => {
    const text = env[prefix + key]; const value = Number(text);
    deny(typeof text === 'string' && /^\d+$/.test(text) && Number.isSafeInteger(value) && value > 0, `COURSE_READ_${key}_INVALID`);
    return value;
  };
  const budget = positive('CONNECTION_BUDGET'); const perWorkerConnections = positive('PER_WORKER_CONNECTIONS');
  deny(budget - Number(workers) * perWorkerConnections > 0, 'COURSE_READ_PRIMARY_BUDGET_EXHAUSTED');
  return { enabled: true, workers: Number(workers), budget, perWorkerConnections };
}

/** Disposable A/B fixture only: both arms start with the same explicit budget.
 * Runtime configuration still leaves DATABASE_URL itself unchanged.
 */
export function courseReadExperimentPrimaryURL(databaseURL, env) {
  if (env[`${prefix}CONNECTION_BUDGET`] === undefined) return databaseURL;
  const value = env[`${prefix}CONNECTION_BUDGET`];
  deny(typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0, 'COURSE_READ_CONNECTION_BUDGET_INVALID');
  const url = database(databaseURL);
  deny(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'COURSE_READ_EXPERIMENT_REQUIRES_LOOPBACK');
  url.searchParams.set('connection_limit', value);
  return url.toString();
}

export function assertSameCourseReadDatabase(primaryDatabaseURL, readDatabaseURL) {
  const primary = database(primaryDatabaseURL); const reader = database(readDatabaseURL);
  deny(primary.hostname.toLowerCase() === reader.hostname.toLowerCase() && (primary.port || '5432') === (reader.port || '5432')
    && decodeURIComponent(primary.pathname) === decodeURIComponent(reader.pathname), 'COURSE_READ_DATABASE_TARGET_MISMATCH');
  deny(decodeURIComponent(primary.username) !== decodeURIComponent(reader.username), 'COURSE_READ_SEPARATE_ROLE_REQUIRED');
  return reader;
}

export function retargetCourseReadDatabaseURL(sourcePrimary, sourceReader, targetPrimary) {
  const original = database(sourcePrimary); const reader = assertSameCourseReadDatabase(sourcePrimary, sourceReader); const target = database(targetPrimary);
  deny(original.hostname.toLowerCase() === target.hostname.toLowerCase() && (original.port || '5432') === (target.port || '5432')
    && original.pathname !== target.pathname, 'COURSE_READ_RESTORE_TARGET_INVALID');
  reader.pathname = target.pathname;
  return reader.toString();
}

function readUrl(primaryDatabaseURL, roleName, password, perWorkerConnections) {
  const url = database(primaryDatabaseURL);
  deny(safeRole(roleName) && roleName !== decodeURIComponent(url.username), 'COURSE_READ_ROLE_NAME_INVALID');
  deny(typeof password === 'string' && password.length >= 24 && password.length <= 1024 && !/[\r\n\0]/.test(password), 'COURSE_READ_ROLE_PASSWORD_INVALID');
  url.username = roleName; url.password = password;
  url.searchParams.set('connection_limit', String(perWorkerConnections));
  const options = url.searchParams.get('options')?.trim();
  url.searchParams.set('options', `${options ? `${options} ` : ''}-c default_transaction_read_only=on`);
  return url.toString();
}

// All application schemas, not just the current search_path. PUBLIC TEMP is
// intentionally allowed; no global PUBLIC privileges are changed by this tool.
export const COURSE_READ_ROLE_PROOF_SQL = `
 SELECT NOT (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR r.rolinherit) AS "ordinaryRole",
  NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS "noMemberships",
  NOT EXISTS (SELECT 1 FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype='o') AS "ownsNoObjects",
  NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND has_schema_privilege(r.oid,n.oid,'CREATE')) AS "noSchemaCreate",
  NOT has_database_privilege(r.oid,current_database(),'CREATE') AS "noDatabaseCreate",
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END) AS "noTableWrites",
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND CASE WHEN c.relkind IN ('r','p','v','m','f') THEN has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE,REFERENCES') ELSE false END) AS "noColumnWrites",
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
    AND CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,UPDATE') ELSE false END) AS "noSequenceWrites",
  has_database_privilege(r.oid,current_database(),'TEMPORARY') AS "temporaryAllowed"
 FROM pg_roles r WHERE r.rolname=$1`;
const proofKeys = ['ordinaryRole', 'noMemberships', 'ownsNoObjects', 'noSchemaCreate', 'noDatabaseCreate', 'noTableWrites', 'noColumnWrites', 'noSequenceWrites'];

/** The caller owns the administrator connection and the password lifetime.
 * Existing managed roles reuse their password: this never ALTERs a password.
 */
export async function provisionCourseReadRole({ db, primaryDatabaseURL, roleName = 'openpbl_course_reader', password,
  workers, perWorkerConnections, connect = connection }) {
  const primary = database(primaryDatabaseURL);
  deny([1, 2].includes(workers) && Number.isSafeInteger(perWorkerConnections) && perWorkerConnections > 0
    && Number.isSafeInteger(workers * perWorkerConnections), 'COURSE_READ_ROLE_LIMIT_INVALID');
  const readerURL = readUrl(primaryDatabaseURL, roleName, password, perWorkerConnections);
  let created; let proof;
  try {
    await db.$transaction(async tx => {
      const [target] = await tx.$queryRaw`SELECT current_database() AS database, current_user AS owner`;
      deny(target?.database === decodeURIComponent(primary.pathname.slice(1)) && target?.owner === decodeURIComponent(primary.username), 'COURSE_READ_ADMIN_TARGET_MISMATCH');
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`${marker}:${roleName}`}))::text AS locked`;
      const existing = await tx.$queryRaw`SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
        r.rolinherit, shobj_description(r.oid,'pg_authid') AS marker FROM pg_roles r WHERE r.rolname=${roleName}`;
      created = existing.length === 0;
      if (!created) deny(existing.length === 1 && existing[0].marker === marker && ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls', 'rolinherit'].every(key => existing[0][key] === false), 'COURSE_READ_EXISTING_ROLE_UNSAFE');
      await tx.$queryRaw`SELECT set_config('openpbl.course_read_role',${roleName},true), set_config('openpbl.course_read_password',${password},true),
        set_config('openpbl.course_read_limit',${String(workers * perWorkerConnections)},true)`;
      // Dynamic identifiers use PostgreSQL %I; the password is a bound value in
      // a transaction-local setting, never interpolated in a logged SQL string.
      await tx.$executeRawUnsafe(`DO $openpbl_course_read$
       DECLARE reader text := current_setting('openpbl.course_read_role');
       BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=reader) THEN
          EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD %L',reader,current_setting('openpbl.course_read_password'));
          EXECUTE format('COMMENT ON ROLE %I IS %L',reader,'${marker}');
        END IF;
        EXECUTE format('ALTER ROLE %I LOGIN CONNECTION LIMIT %s',reader,current_setting('openpbl.course_read_limit'));
        EXECUTE format('ALTER ROLE %I SET default_transaction_read_only = on',reader);
        EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),reader);
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',reader);
        EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I',reader);
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I',current_user,reader);
       END $openpbl_course_read$`);
      const proofs = await tx.$queryRawUnsafe(COURSE_READ_ROLE_PROOF_SQL, roleName); proof = proofs[0];
      deny(proofs.length === 1 && proofKeys.every(key => proof?.[key] === true), 'COURSE_READ_ROLE_PRIVILEGES_UNSAFE');
    }, { maxWait: 5000, timeout: 30000 });
    const verifyURL = new URL(readerURL); verifyURL.searchParams.set('connection_limit', '1');
    const reader = connect(verifyURL.toString());
    try {
      const rows = await reader.$queryRaw`SELECT current_user AS role, current_database() AS database,
        current_setting('default_transaction_read_only') AS "readOnlyDefault"`;
      deny(rows.length === 1 && rows[0].role === roleName && rows[0].database === decodeURIComponent(primary.pathname.slice(1))
        && rows[0].readOnlyDefault === 'on', 'COURSE_READ_ROLE_LOGIN_VERIFICATION_FAILED');
    } finally { await reader.$disconnect(); }
  } catch (error) { throw Object.assign(new Error(code(error)), { code: code(error), cause: error }); }
  return { readDatabaseURL: readerURL, roleName, created, proof,
    scope: 'Application-table SELECT, no permanent CREATE/DML/ownership/membership; PUBLIC TEMP may remain; read-only default is additional protection' };
}

export async function readCourseReadEnvironmentFile(file) {
  deny(typeof file === 'string' && path.isAbsolute(file), 'COURSE_READ_ENV_PATH_ABSOLUTE_REQUIRED');
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    deny(typeof process.getuid === 'function' && stat.uid === process.getuid() && stat.isFile() && stat.nlink === 1
      && (stat.mode & 0o777) === 0o600 && stat.size <= 65536, 'COURSE_READ_ENV_FILE_NOT_PRIVATE');
    const text = await handle.readFile('utf8'); const result = {};
    deny(text.startsWith(`# ${marker};`), 'COURSE_READ_ENV_FILE_INVALID');
    for (const line of text.split('\n').filter(line => line && !line.startsWith('#'))) {
      const match = /^([A-Z_]+)=(".*")$/.exec(line);
      deny(match && fields.includes(match[1]) && !(match[1] in result), 'COURSE_READ_ENV_FILE_INVALID');
      try { result[match[1]] = JSON.parse(match[2]); } catch { deny(false, 'COURSE_READ_ENV_FILE_INVALID'); }
      deny(typeof result[match[1]] === 'string' && !/[\r\n\0]/.test(result[match[1]]), 'COURSE_READ_ENV_FILE_INVALID');
    }
    deny(fields.every(key => typeof result[key] === 'string'), 'COURSE_READ_ENV_FILE_INVALID');
    return result;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { await handle?.close(); }
}

async function writeEnvironmentFile(file, env) {
  deny(path.isAbsolute(file), 'COURSE_READ_ENV_PATH_ABSOLUTE_REQUIRED');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const parent = await lstat(path.dirname(file));
  deny(typeof process.getuid === 'function' && parent.isDirectory() && parent.uid === process.getuid() && !(parent.mode & 0o022), 'COURSE_READ_ENV_DIRECTORY_UNSAFE');
  await readCourseReadEnvironmentFile(file); // Reject symlinks, insecure files and another owner's existing secret.
  const temporary = `${file}.partial-${randomUUID()}`; let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`# ${marker}; systemd EnvironmentFile, do not publish\n${fields.map(key => `${key}=${JSON.stringify(env[key])}`).join('\n')}\n`);
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, file);
    const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await rm(temporary, { force: true }); }
}

/** CLI operation: persist a new password with workers disabled before creating
 * its role. A failed first attempt is safe to repeat using the same secret.
 */
export async function provisionCourseReadEnvironment({ env, environmentFile, roleName = 'openpbl_course_reader', connect = connection }) {
  const settings = courseReadWorkerSettings(env);
  if (!settings.enabled) return { status: 'disabled', changed: false };
  const primary = database(env.DATABASE_URL); const old = await readCourseReadEnvironmentFile(environmentFile);
  let password = randomBytes(32).toString('base64url');
  if (old) {
    const reader = assertSameCourseReadDatabase(env.DATABASE_URL, old[`${prefix}DATABASE_URL`]);
    deny(decodeURIComponent(reader.username) === roleName, 'COURSE_READ_ENV_ROLE_MISMATCH');
    password = decodeURIComponent(reader.password);
  }
  const readerURL = readUrl(primary.toString(), roleName, password, settings.perWorkerConnections);
  const privateEnv = { [`${prefix}WORKERS`]: String(settings.workers), [`${prefix}CONNECTION_BUDGET`]: String(settings.budget),
    [`${prefix}PER_WORKER_CONNECTIONS`]: String(settings.perWorkerConnections), [`${prefix}DATABASE_URL`]: readerURL };
  if (!old) await writeEnvironmentFile(environmentFile, { ...privateEnv, [`${prefix}WORKERS`]: '0' });
  const admin = connect(primary.toString());
  try {
    const result = await provisionCourseReadRole({ db: admin, primaryDatabaseURL: primary.toString(), roleName, password,
      workers: settings.workers, perWorkerConnections: settings.perWorkerConnections, connect });
    await writeEnvironmentFile(environmentFile, privateEnv);
    return { status: 'ready', roleName, created: result.created, environmentFile, workers: settings.workers,
      connectionBudget: settings.budget, primaryConnections: settings.budget - settings.workers * settings.perWorkerConnections,
      readerConnections: settings.workers * settings.perWorkerConnections, temporaryAllowed: result.proof.temporaryAllowed,
      passwordReused: Boolean(old) };
  } finally { await admin.$disconnect(); }
}
