import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { verifyMonacoRuntimeArtifact } from './monaco-static-runtime.mjs';
import { verifyCourseReadWorkerRuntime } from './check-course-read-worker.mjs';
import { verifyBuildAssetSnapshot } from './lib/production-assets.mjs';

const standalone = path.resolve(process.env.NEXT_DIST_DIR || '.next-build', 'standalone');
const forbidden = ['.openpbl-data', '.openpbl-runtime', '.cache', 'data/classrooms', 'deploy/secrets', 'deploy/.deploy.env', 'test-results'];
const included = [];
for (const entry of forbidden) {
  try { await access(path.join(standalone, entry)); included.push(entry); } catch { /* correctly excluded */ }
}
if (included.length) {
  console.error(`Production build contains private runtime data: ${included.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('Production build excludes classroom data, backups and deployment credentials.');
}

const workerPath = path.join(standalone, 'workers/docx-converter.cjs');
const manifest = JSON.parse(await readFile(path.join(standalone, 'workers/docx-converter-manifest.json'), 'utf8'));
if (manifest.protocol !== 1 || manifest.externalDependencies !== 'node-builtins-only' || manifest.sha256 !== createHash('sha256').update(await readFile(workerPath)).digest('hex')) throw new Error('Standalone DOCX worker artifact is missing or mismatched');
console.log('Standalone DOCX worker integrity and build manifest verified.');
await verifyMonacoRuntimeArtifact(path.resolve(process.env.NEXT_DIST_DIR || '.next-build'));
console.log('Monaco static browser runtime integrity and build manifest verified.');

await verifyCourseReadWorkerRuntime(standalone);
console.log('Standalone course read worker integrity and isolated Prisma runtime verified.');
await verifyBuildAssetSnapshot(process.cwd(), process.env.NEXT_DIST_DIR || '.next-build');
console.log('Public assets, browser chunks and workers match the production build snapshot.');
