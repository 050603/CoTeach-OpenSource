import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const filename = fileURLToPath(import.meta.url);
const lockFile = path.join(root, '.openpbl-runtime/production-task.lock');
export const hasProductionLock = () => process.env.OPENPBL_PRODUCTION_TASK_LOCK === lockFile;

export async function runCommand(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env: process.env, detached: true, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let stdout = '';
    if (capture) child.stdout.on('data', data => { stdout += data; });
    const forward = signal => {
      // Stop descendant compilers as well: an orphan worker must not keep
      // writing staging after its parent releases the production lock.
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
    };
    const interrupt = () => forward('SIGINT'), terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
      resolve({ code: code ?? (signal ? 1 : 0), stdout });
    });
  });
}

export async function runProductionTask(args, capture = false) {
  await mkdir(path.dirname(lockFile), { recursive: true });
  const result = await runCommand('flock', ['--exclusive', '--nonblock', '--no-fork', '--conflict-exit-code', '75', lockFile, process.execPath, filename, '--held', ...args], capture);
  if (result.code === 75) console.error('Another production build, typecheck or prepare is in progress. No running release was changed; retry after it completes.');
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--held') return (await runProductionTask(args)).code;
  process.env.OPENPBL_PRODUCTION_TASK_LOCK = lockFile;
  const [task, ...extra] = args.slice(1);
  // The full Next.js type-check worker can exceed Node's default 4 GiB heap.
  // This applies only to build children; explicit operator limits still win.
  if (task === 'build' && !/(?:^|[\s"'])--max[-_]old[-_]space[-_]size(?:=|\s)/u.test(process.env.NODE_OPTIONS ?? '')) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=8192`.trim();
  }
  const node = script => [process.execPath, [script]];
  let commands;
  if (task === 'build') commands = [
    node('scripts/build-document-converter-worker.mjs'), node('scripts/build-course-read-worker.mjs'), node('scripts/sync-maic-importer.mjs'),
    [process.execPath, ['scripts/run-next-production.mjs', 'build', '--webpack', ...extra]],
    node('scripts/check-generated-css.mjs'), node('scripts/check-runtime-build-isolation.mjs'),
    [process.execPath, ['scripts/run-next-production.mjs', 'prepare']],
  ];
  else if (task === 'typecheck') commands = [
    [process.execPath, ['scripts/run-next-production.mjs', 'typegen']],
    [process.execPath, [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '-p', 'tsconfig.check.json', '--noEmit', ...extra]],
  ];
  else if (task === 'next' && extra[0] !== 'start') commands = [[process.execPath, ['scripts/run-next-production.mjs', ...extra]]];
  else throw new Error('Usage: run-production-task.mjs <build|typecheck|next>');
  for (const [command, commandArgs] of commands) {
    const result = await runCommand(command, commandArgs);
    if (result.code) return result.code;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
