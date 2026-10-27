import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { COURSE_READ_WORKER_FILE, inspectCourseReadPrismaRuntime, verifyCourseReadWorkerArtifact } from './lib/course-read-worker-artifact.mjs';

/** This boots only the artifact's explicit selfCheck branch: no database URL, HTTP or instrumentation. */
export async function selfCheckCourseReadWorker(runtimeRoot, timeoutMs = 20_000) {
  const root = await realpath(runtimeRoot);
  assert.equal(await realpath(process.cwd()), root, 'Course read worker self-check must run with runtime cwd');
  const expected = await inspectCourseReadPrismaRuntime(root);
  const worker = new Worker(path.join(root, 'workers', COURSE_READ_WORKER_FILE), {
    execArgv: [], workerData: { role: 'course-read', protocol: 1, selfCheck: true },
    env: { NODE_ENV: 'production', TZ: 'UTC', NODE_PATH: '', DATABASE_URL: '', PROVIDER_CONFIG_DATABASE_URL: '', REDIS_URL: '' },
  });
  try {
    return await new Promise((resolve, reject) => {
      let message;
      const timer = setTimeout(() => reject(new Error('Course read worker self-check timeout')), timeoutMs);
      const fail = error => { clearTimeout(timer); reject(error); };
      worker.once('error', fail);
      worker.on('message', value => {
        try {
          assert.equal(message, undefined, 'Unexpected duplicate self-check response');
          assert.equal(value.type, 'self-check'); assert.equal(value.protocol, 1);
          assert.equal(value.prismaVersion, expected.prismaVersion);
          assert.equal(value.clientPath, expected.clientPath);
          assert.equal(value.generatedClientPath, expected.generatedClientPath);
          assert.deepEqual([...value.enginePaths].sort(), [...expected.enginePaths].sort());
          message = value;
        } catch (error) { fail(error); }
      });
      worker.once('exit', code => {
        clearTimeout(timer);
        if (code !== 0 || !message) reject(new Error(`Course read worker self-check exited without valid proof: ${code}`));
        else resolve({ protocol: message.protocol, prismaVersion: message.prismaVersion, engineCount: message.enginePaths.length });
      });
    });
  } finally { await worker.terminate(); }
}

/** Build/prepare check: the copied runtime itself must boot, not the workspace. */
export async function verifyCourseReadWorkerRuntime(runtimeRoot, expectedManifest) {
  const manifest = await verifyCourseReadWorkerArtifact(runtimeRoot, expectedManifest);
  const root = await realpath(runtimeRoot);
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--self-check', root], {
    cwd: root, env: { NODE_ENV: 'production', TZ: 'UTC', NODE_PATH: '' }, encoding: 'utf8', timeout: 25_000,
  });
  assert.equal(result.error, undefined, `Course read worker runtime self-check failed: ${result.error?.message}`);
  assert.equal(result.status, 0, `Course read worker runtime cannot boot: ${result.stderr}`);
  const proof = JSON.parse(result.stdout.trim());
  assert.equal(proof.protocol, 1); assert.equal(proof.prismaVersion, manifest.prismaVersion); assert.ok(proof.engineCount > 0);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[2], '--self-check');
  console.log(JSON.stringify(await selfCheckCourseReadWorker(path.resolve(process.argv[3]))));
}
