// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveCourseReadWorkerConfig } from './course-read-worker-config';
const enabled = { OPENPBL_COURSE_READ_WORKERS: '2', OPENPBL_COURSE_READ_CONNECTION_BUDGET: '57',
  OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS: '16', DATABASE_URL: 'postgresql://writer:secret@localhost:5432/class?schema=public&connection_limit=57',
  OPENPBL_COURSE_READ_DATABASE_URL: 'postgresql://reader:secret2@localhost/class?schema=public' };
describe('course read worker connection contract', () => {
  it('is opt-in and does not require DB or secrets when disabled', () => {
    expect(resolveCourseReadWorkerConfig({})).toMatchObject({ enabled: false, count: 0, primaryDatabaseUrl: undefined });
    expect(resolveCourseReadWorkerConfig({ DATABASE_URL: 'unchanged' }).primaryDatabaseUrl).toBe('unchanged');
  });
  it.each([1, 2])('partitions one explicit budget for %i workers without mutating the environment', count => {
    const env = { ...enabled, OPENPBL_COURSE_READ_WORKERS: String(count) };
    const original = { ...env }; const config = resolveCourseReadWorkerConfig(env);
    expect(config).toMatchObject({ enabled: true, count, budget: 57, perWorkerConnections: 16 });
    expect(new URL(config.primaryDatabaseUrl!).searchParams.get('connection_limit')).toBe(String(57 - count * 16));
    expect(new URL(config.workerDatabaseUrl!).searchParams.get('connection_limit')).toBe('16');
    expect(new URL(config.workerDatabaseUrl!).searchParams.get('options')).toContain('default_transaction_read_only=on');
    expect(env).toEqual(original);
  });
  it.each(['3', '-1', 'NaN', '', '1.0'])('rejects unsupported worker count %s', value => {
    expect(() => resolveCourseReadWorkerConfig({ ...enabled, OPENPBL_COURSE_READ_WORKERS: value })).toThrow();
  });
  it.each(['OPENPBL_COURSE_READ_CONNECTION_BUDGET', 'OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS'])('requires explicit positive %s', key => {
    for (const value of [undefined, '', '0', '-1', '1.2', '9007199254740992']) expect(() => resolveCourseReadWorkerConfig({ ...enabled, [key]: value })).toThrow();
  });
  it('requires a remaining main connection and rejects foreign/same-identity databases without leaking credentials', () => {
    expect(() => resolveCourseReadWorkerConfig({ ...enabled, OPENPBL_COURSE_READ_CONNECTION_BUDGET: '32' })).toThrow();
    for (const url of ['postgresql://reader:secret2@other/class', 'postgresql://reader:secret2@localhost:5433/class',
      'postgresql://reader:secret2@localhost/other', 'postgresql://reader:secret2@localhost/class?schema=other',
      'postgresql://writer:secret2@localhost/class', 'not-a-url-secret2']) {
      try { resolveCourseReadWorkerConfig({ ...enabled, OPENPBL_COURSE_READ_DATABASE_URL: url }); throw new Error('not rejected'); }
      catch (error) { expect(String(error)).not.toContain('secret2'); expect(String(error)).not.toContain('not rejected'); }
    }
  });
});
