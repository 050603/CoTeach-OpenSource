#!/usr/bin/env node
/**
 * Copy browser-only document parsers to public/vendor/ so the app can
 * load them at runtime via URL-based dynamic imports.
 *
 * Why: the bundle contains dynamic `require()` patterns (from pdfjs-dist)
 * that Turbopack rejects as a hard "Module not found: Can't resolve <dynamic>"
 * error. By serving it as a static asset and importing it via a runtime URL,
 * we bypass the bundler entirely while keeping types via the workspace package.
 */
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'packages/@openmaic/importer/dist');
const destDir = path.join(root, 'public/vendor/maic-importer');
// The modern bundle requires newer APIs (including Promise.withResolvers)
// than our desktop browser baseline. Both realms need the legacy polyfills.
const pdfJsSrcDir = path.join(root, 'packages/@openmaic/importer/node_modules/pdfjs-dist/legacy/build');
const pdfJsDestDir = path.join(root, 'public/vendor/pdfjs');
const { version: pdfJsVersion } = JSON.parse(await readFile(path.join(root, 'src/lib/browser/pdf-runtime-version.json'), 'utf8'));
const installedPdfJs = JSON.parse(await readFile(path.join(pdfJsSrcDir, '../../package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pdfJsVersion) || installedPdfJs.version !== pdfJsVersion) {
  throw new Error('PDF.js browser version must match the installed main module and worker; update pdf-runtime-version.json with the dependency.');
}

try {
  await stat(srcDir);
} catch {
  console.error(`[sync-maic-importer] missing dist: ${srcDir}`);
  console.error('Run `cd packages/@openmaic/importer && pnpm run build` first.');
  process.exit(1);
}

await rm(destDir, { recursive: true, force: true });
await mkdir(destDir, { recursive: true });
await cp(srcDir, destDir, { recursive: true });

// Configure only the hosted browser entry. The published package and its Node
// entry retain their defaults; embedded EMF/PDF images need no external CDN.
await rename(path.join(destDir, 'index.js'), path.join(destDir, 'index.runtime.js'));
await writeFile(path.join(destDir, 'index.js'), [
  "import { configurePdfWorker } from './index.runtime.js';",
  `configurePdfWorker(new URL('../pdfjs/${pdfJsVersion}/pdf.worker.legacy.min.mjs', import.meta.url).href);`,
  "export * from './index.runtime.js';",
  '',
].join('\n'));

await mkdir(pdfJsDestDir, { recursive: true });
const versionedPdfJsDestDir = path.join(pdfJsDestDir, pdfJsVersion);
await mkdir(versionedPdfJsDestDir, { recursive: true });
await Promise.all([
  cp(path.join(pdfJsSrcDir, 'pdf.min.mjs'), path.join(pdfJsDestDir, 'pdf.legacy.min.mjs')),
  cp(path.join(pdfJsSrcDir, 'pdf.worker.min.mjs'), path.join(pdfJsDestDir, 'pdf.worker.legacy.min.mjs')),
  cp(path.join(pdfJsSrcDir, 'pdf.min.mjs'), path.join(versionedPdfJsDestDir, 'pdf.legacy.min.mjs')),
  cp(path.join(pdfJsSrcDir, 'pdf.worker.min.mjs'), path.join(versionedPdfJsDestDir, 'pdf.worker.legacy.min.mjs')),
]);

console.log(
  `[sync-maic-importer] copied document parsers → public/vendor`,
);
