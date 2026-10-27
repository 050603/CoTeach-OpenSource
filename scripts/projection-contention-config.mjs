import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const required = (env, name) => {
  const value = env[name]?.trim();
  assert.ok(value, `Incremental projection contention requires explicit ${name}`);
  return value;
};
const loopback = hostname => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
const inside = (directory, parent) => {
  const relative = path.relative(parent, directory);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

/** Incremental runs share the disposable harness's database, JWT and classroom
 * directory. Validate every input before reading credentials or opening a socket.
 * The historical full run continues to use its original deployment defaults.
 */
export async function projectionContentionConfiguration({ env = process.env, root = process.cwd(), runId,
  read = readFile } = {}) {
  const mode = env.PROJECTION_CONTENTION_MODE || 'full';
  assert.ok(['full', 'incremental'].includes(mode), 'PROJECTION_CONTENTION_MODE must be full or incremental');
  if (mode === 'full') {
    return { mode, origin: 'https://coteach.cn',
      databaseUrl: (await read(path.join(root, 'deploy/secrets/database_url.txt'), 'utf8')).trim(),
      jwtSecret: (await read(path.join(root, 'deploy/secrets/jwt_secret.txt'), 'utf8')).trim(),
      output: path.resolve(root, 'test-results/capacity', runId),
      classroomDataDir: path.resolve(root, '.openpbl-data/classrooms'),
      verificationMarker: null };
  }

  const target = new URL(required(env, 'CAPACITY_BASE_URL'));
  assert.ok(['http:', 'https:'].includes(target.protocol) && loopback(target.hostname),
    'Incremental projection contention requires a disposable loopback HTTP origin');
  assert.ok(target.port && !['80', '443', '3000', '3002'].includes(target.port),
    'Incremental projection contention cannot target production service ports');
  assert.ok(!target.username && !target.password && target.pathname === '/' && !target.search && !target.hash,
    'CAPACITY_BASE_URL must be an origin without credentials, path, query or fragment');
  const connectHost = env.CAPACITY_CONNECT_HOST?.trim() || (target.hostname === 'localhost' ? '127.0.0.1' : target.hostname.replace(/^\[|\]$/g, ''));
  assert.ok(loopback(connectHost), 'Incremental CAPACITY_CONNECT_HOST must stay on loopback');

  const databaseUrl = required(env, 'CAPACITY_DATABASE_URL');
  const database = new URL(databaseUrl);
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol) && loopback(database.hostname),
    'Incremental projection contention requires disposable loopback PostgreSQL');
  assert.ok(database.port && database.port !== '5432', 'Incremental PostgreSQL must use an explicit disposable port');
  const jwtSecret = required(env, 'JWT_SECRET');
  const output = path.resolve(root, required(env, 'PROJECTION_CONTENTION_OUTPUT_DIR'));
  const classroomDataDir = path.resolve(root, required(env, 'CLASSROOM_DATA_DIR'));
  for (const [name, directory] of [['PROJECTION_CONTENTION_OUTPUT_DIR', output], ['CLASSROOM_DATA_DIR', classroomDataDir]]) {
    assert.ok(directory !== path.resolve(root) && !inside(directory, path.resolve(root, '.openpbl-data'))
      && !inside(directory, path.resolve(root, 'deploy')),
    `${name} must stay outside deployment and production data directories`);
  }
  const verificationMarker = required(env, 'OPENPBL_VERIFICATION_MARKER');
  assert.match(verificationMarker, /^openpbl-[A-Za-z0-9_-]+$/, 'Invalid disposable database verification marker');
  return { mode, origin: target.origin, connectHost, databaseUrl, jwtSecret, output, classroomDataDir, verificationMarker };
}

export async function verifyProjectionDatabase(db, config) {
  if (config.mode !== 'incremental') return;
  const matches = await db.$queryRaw`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${config.verificationMarker}`;
  assert.equal(matches.length, 1, 'Projection contention target is not the expected disposable database');
}

export function projectionWebsocketUrl(origin, role) {
  const url = new URL('/ws', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('role', role);
  return url.href;
}
