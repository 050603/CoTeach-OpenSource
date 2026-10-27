import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

test('concurrent production commands fail before mutating build files and the OS releases the lock afterwards', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-task-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(new URL('./run-production-task.mjs', import.meta.url), path.join(root, 'scripts/run-production-task.mjs'));
  await writeFile(path.join(root, 'scripts/run-next-production.mjs'), `
    import { appendFile, access, writeFile } from 'node:fs/promises';
    await writeFile('command-pid', String(process.pid));
    await appendFile('entered', process.argv.slice(2).join(' ') + '\\n');
    await new Promise(resolve => {
      const timer = setInterval(async () => {
        try { await access('release'); clearInterval(timer); resolve(); } catch {}
      }, 10);
    });
  `);
  const args = ['scripts/run-production-task.mjs', 'next', 'typegen'];
  const running = spawn(process.execPath, args, { cwd: root, stdio: 'pipe' });
  const done = new Promise(resolve => running.once('exit', code => resolve(code)));
  t.after(() => { if (running.exitCode === null) running.kill('SIGTERM'); });
  const deadline = Date.now() + 5000;
  while (true) {
    try { await readFile(path.join(root, 'entered')); break; }
    catch (error) { if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const busy = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 3000 });
  assert.equal(busy.status, 75, busy.stderr);
  assert.match(busy.stderr, /Another production build, typecheck or prepare/);
  assert.equal(await readFile(path.join(root, 'entered'), 'utf8'), 'typegen\n');
  await writeFile(path.join(root, 'release'), 'continue');
  assert.equal(await done, 0);
  const next = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 3000 });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(await readFile(path.join(root, 'entered'), 'utf8'), 'typegen\ntypegen\n');
  await rm(path.join(root, 'release'));
  const priorPid = await readFile(path.join(root, 'command-pid'), 'utf8');
  const interrupted = spawn(process.execPath, args, { cwd: root, stdio: 'pipe' });
  const interruptedDone = new Promise(resolve => interrupted.once('exit', code => resolve(code)));
  t.after(() => {
    if (interrupted.exitCode === null) interrupted.kill('SIGTERM');
  });
  let commandPid;
  const interruptionDeadline = Date.now() + 5000;
  while (Date.now() < interruptionDeadline) {
    const candidate = await readFile(path.join(root, 'command-pid'), 'utf8');
    if (/^[1-9]\d*$/.test(candidate) && candidate !== priorPid) { commandPid = Number(candidate); break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(commandPid);
  interrupted.kill('SIGTERM');
  assert.notEqual(await interruptedDone, 0);
  assert.throws(() => process.kill(commandPid, 0), { code: 'ESRCH' });
  await writeFile(path.join(root, 'release'), 'continue');
  const recovered = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 3000 });
  assert.equal(recovered.status, 0, recovered.stderr);
});

test('a failed build step does not run later checks or publish a release', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-task-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(new URL('./run-production-task.mjs', import.meta.url), path.join(root, 'scripts/run-production-task.mjs'));
  await writeFile(path.join(root, 'scripts/build-document-converter-worker.mjs'), 'process.exit(2);');
  const result = spawnSync(process.execPath, ['scripts/run-production-task.mjs', 'build'], { cwd: root, encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 2, result.stderr);
  await assert.rejects(readFile(path.join(root, '.openpbl-runtime/releases')), { code: 'ENOENT' });
});

test('build children receive enough heap while preserving explicit operator limits and other options', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'production-task-heap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await copyFile(new URL('./run-production-task.mjs', import.meta.url), path.join(root, 'scripts/run-production-task.mjs'));
  await writeFile(path.join(root, 'scripts/build-document-converter-worker.mjs'), `
    import { writeFileSync } from 'node:fs';
    writeFileSync('child-options', process.env.NODE_OPTIONS ?? '');
    process.exit(2);
  `);
  for (const [input, expected] of [
    ['', '--max-old-space-size=8192'],
    ['--trace-warnings', '--trace-warnings --max-old-space-size=8192'],
    ['--max-old-space-size=2048', '--max-old-space-size=2048'],
    ['--max_old_space_size=2048', '--max_old_space_size=2048'],
    ['"--max-old-space-size=2048"', '"--max-old-space-size=2048"'],
  ]) {
    const result = spawnSync(process.execPath, ['scripts/run-production-task.mjs', 'build'], {
      cwd: root, encoding: 'utf8', timeout: 3000, env: { ...process.env, NODE_OPTIONS: input },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(await readFile(path.join(root, 'child-options'), 'utf8'), expected);
  }
});
