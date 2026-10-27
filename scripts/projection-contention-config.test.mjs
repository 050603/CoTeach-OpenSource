import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { projectionContentionConfiguration, projectionWebsocketUrl, verifyProjectionDatabase } from './projection-contention-config.mjs';

const root = '/workspace/openpbl';
const isolated = overrides => ({
  PROJECTION_CONTENTION_MODE: 'incremental',
  CAPACITY_BASE_URL: 'http://127.0.0.1:3198',
  CAPACITY_DATABASE_URL: 'postgresql://postgres@127.0.0.1:45123/postgres',
  JWT_SECRET: 'disposable-test-secret',
  PROJECTION_CONTENTION_OUTPUT_DIR: 'test-results/incremental/projection',
  CLASSROOM_DATA_DIR: '/tmp/openpbl-incremental/classrooms',
  OPENPBL_VERIFICATION_MARKER: 'openpbl-incremental-example',
  ...overrides,
});
const configure = env => projectionContentionConfiguration({ env, root, runId: 'capacity-example',
  read: () => assert.fail('An incremental run must never read deployed credentials') });

test('incremental configuration takes explicit harness inputs without loading deployed secrets', async () => {
  const config = await configure(isolated());
  assert.equal(config.origin, 'http://127.0.0.1:3198');
  assert.equal(config.databaseUrl, isolated().CAPACITY_DATABASE_URL);
  assert.equal(config.jwtSecret, isolated().JWT_SECRET);
  assert.equal(config.output, path.join(root, 'test-results/incremental/projection'));
  assert.equal(config.classroomDataDir, '/tmp/openpbl-incremental/classrooms');
  assert.equal(config.connectHost, '127.0.0.1');
});

test('incremental configuration rejects each missing input rather than falling back to deployment', async () => {
  for (const name of ['CAPACITY_BASE_URL', 'CAPACITY_DATABASE_URL', 'JWT_SECRET',
    'PROJECTION_CONTENTION_OUTPUT_DIR', 'CLASSROOM_DATA_DIR', 'OPENPBL_VERIFICATION_MARKER']) {
    await assert.rejects(configure(isolated({ [name]: '  ' })), new RegExp(name));
  }
  await assert.rejects(configure(isolated({ PROJECTION_CONTENTION_MODE: 'incrementall' })), /PROJECTION_CONTENTION_MODE/);
});

test('incremental targets cannot use the deployed domain, LAN route or production service ports', async () => {
  for (const CAPACITY_BASE_URL of ['https://coteach.cn', 'http://192.168.1.2:3198',
    'http://127.0.0.1:3000', 'http://127.0.0.1:3002', 'https://127.0.0.1', 'http://127.0.0.1']) {
    await assert.rejects(configure(isolated({ CAPACITY_BASE_URL })), /loopback|production service ports/);
  }
  await assert.rejects(configure(isolated({ CAPACITY_CONNECT_HOST: '192.168.50.10' })), /loopback/);
  for (const suffix of ['/api', '/?token=credential', '/#fragment']) {
    await assert.rejects(configure(isolated({ CAPACITY_BASE_URL: `http://127.0.0.1:3198${suffix}` })), /must be an origin/);
  }
  await assert.rejects(configure(isolated({ CAPACITY_BASE_URL: 'http://user:password@127.0.0.1:3198' })), /must be an origin/);
});

test('incremental databases and files stay outside deployed resources', async () => {
  for (const CAPACITY_DATABASE_URL of ['postgresql://postgres@192.168.1.2:45123/postgres',
    'postgresql://postgres@127.0.0.1/postgres', 'postgresql://postgres@127.0.0.1:5432/postgres',
    'https://127.0.0.1:45123/postgres']) {
    await assert.rejects(configure(isolated({ CAPACITY_DATABASE_URL })), /PostgreSQL/);
  }
  for (const directory of ['.', '.openpbl-data/classrooms', 'deploy/secrets', '/workspace/openpbl/.openpbl-data/child']) {
    for (const name of ['PROJECTION_CONTENTION_OUTPUT_DIR', 'CLASSROOM_DATA_DIR']) {
      await assert.rejects(configure(isolated({ [name]: directory })), /outside deployment and production data/);
    }
  }
  await assert.rejects(configure(isolated({ OPENPBL_VERIFICATION_MARKER: 'production' })), /verification marker/);
});

test('database marker must match before incremental fixtures may be created', async () => {
  const config = await configure(isolated());
  let query;
  const db = { async $queryRaw(strings, ...values) {
    query = { sql: strings.join('?'), values };
    return [{ marker: config.verificationMarker }];
  } };
  await verifyProjectionDatabase(db, config);
  assert.match(query.sql, /SELECT marker FROM "_OpenpblVerification" WHERE marker = \?/);
  assert.deepEqual(query.values, [config.verificationMarker]);
  await assert.rejects(verifyProjectionDatabase({ $queryRaw: async () => [] }, config), /expected disposable database/);
  await assert.rejects(verifyProjectionDatabase({ $queryRaw: async () => { throw new Error('marker table absent'); } }, config), /marker table absent/);
});

test('websocket target keeps the selected origin and chooses its matching transport', () => {
  assert.equal(projectionWebsocketUrl('http://127.0.0.1:3198', 'student'), 'ws://127.0.0.1:3198/ws?role=student');
  assert.equal(projectionWebsocketUrl('https://localhost:3198', 'teacher'), 'wss://localhost:3198/ws?role=teacher');
  assert.equal(projectionWebsocketUrl('https://coteach.cn', 'teacher'), 'wss://coteach.cn/ws?role=teacher');
});

test('historical full mode preserves its origin, output, classroom directory and secret sources', async () => {
  const paths = [];
  const config = await projectionContentionConfiguration({ env: { CAPACITY_BASE_URL: 'http://127.0.0.1:3198' }, root,
    runId: 'capacity-example', read: async filename => {
      paths.push(filename);
      return filename.endsWith('database_url.txt') ? ' postgres://original@127.0.0.1/original\n' : ' original-secret\n';
    } });
  assert.equal(config.mode, 'full');
  assert.equal(config.origin, 'https://coteach.cn');
  assert.equal(config.databaseUrl, 'postgres://original@127.0.0.1/original');
  assert.equal(config.jwtSecret, 'original-secret');
  assert.equal(config.output, path.join(root, 'test-results/capacity/capacity-example'));
  assert.equal(config.classroomDataDir, path.join(root, '.openpbl-data/classrooms'));
  assert.deepEqual(paths, ['database_url.txt', 'jwt_secret.txt'].map(name => path.join(root, 'deploy/secrets', name)));
  await verifyProjectionDatabase({ $queryRaw: () => assert.fail('Full runs have no new marker requirement') }, config);
});
