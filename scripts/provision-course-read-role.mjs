// Explicit operations entry; never imported by an application or migration.
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { provisionCourseReadEnvironment } from './lib/course-read-role.mjs';

try {
  const { values } = parseArgs({ options: { 'environment-file': { type: 'string' }, 'database-url-file': { type: 'string' },
    'role-name': { type: 'string' }, workers: { type: 'string' }, 'connection-budget': { type: 'string' }, 'per-worker-connections': { type: 'string' } }, strict: true });
  const env = { ...process.env };
  for (const [argument, key] of [['workers', 'WORKERS'], ['connection-budget', 'CONNECTION_BUDGET'], ['per-worker-connections', 'PER_WORKER_CONNECTIONS']]) {
    if (values[argument] !== undefined) env[`OPENPBL_COURSE_READ_${key}`] = values[argument];
  }
  if (values['database-url-file']) env.DATABASE_URL = (await readFile(values['database-url-file'], 'utf8')).trim();
  const report = await provisionCourseReadEnvironment({ env, environmentFile: values['environment-file'], roleName: values['role-name'] });
  console.log(JSON.stringify(report));
} catch (error) {
  // Connection errors can include sensitive options. Emit only a controlled code.
  const code = typeof error.code === 'string' && /^COURSE_READ_[A-Z_]+$/.test(error.code) ? error.code : 'COURSE_READ_ROLE_PROVISION_FAILED';
  console.error(code); process.exitCode = 1;
}
