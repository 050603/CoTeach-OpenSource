import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const documentBrowserAssets = [
  'vendor/maic-importer/index.js',
  'vendor/maic-importer/index.runtime.js',
  'vendor/pdfjs/pdf.legacy.min.mjs',
  'vendor/pdfjs/pdf.worker.legacy.min.mjs',
];
const workerFiles = ['docx-converter.cjs', 'docx-converter-manifest.json', 'course-read-worker.cjs', 'course-read-worker-manifest.json'];
export const runtimeAssetManifest = 'runtime-assets.json';

async function fileIdentity(file) {
  const info = await lstat(file);
  if (!info.isFile() || !info.size) throw new Error(`Missing or invalid runtime asset: ${file}`);
  const bytes = await readFile(file);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

async function inventory(directory) {
  const files = {};
  async function visit(relative = '') {
    if (!(await lstat(path.join(directory, relative))).isDirectory()) throw new Error(`Invalid runtime directory: ${directory}`);
    for (const item of (await readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await visit(name);
      else files[name] = await fileIdentity(path.join(directory, name));
    }
  }
  await visit();
  return files;
}

export async function verifyDocumentBrowserAssets(root, pdfVersion) {
  const required = [...documentBrowserAssets];
  if (pdfVersion) required.push(`vendor/pdfjs/${pdfVersion}/pdf.legacy.min.mjs`, `vendor/pdfjs/${pdfVersion}/pdf.worker.legacy.min.mjs`);
  for (const asset of required) {
    try { await fileIdentity(path.join(root, 'public', asset)); }
    catch (cause) { throw new Error(`Missing document browser asset: ${path.join(root, 'public', asset)}. Run pnpm build before preparing the release.`, { cause }); }
  }
}

async function describeAssets(root, distDir, publicDirectory = path.join(root, 'public'), workersDirectory = path.join(root, 'workers'), pdfVersion) {
  const buildId = (await readFile(path.join(root, distDir, 'BUILD_ID'), 'utf8')).trim();
  const workers = {};
  for (const name of workerFiles) workers[name] = await fileIdentity(path.join(workersDirectory, name));
  return { schemaVersion: 1, buildId, pdfVersion, public: await inventory(publicDirectory), static: await inventory(path.join(root, distDir, 'static')), workers };
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || !/^[A-Za-z0-9_-]+$/.test(manifest.buildId)
    || !manifest.public || !Object.keys(manifest.public).length || !manifest.static || !Object.keys(manifest.static).length
    || !/^\d+\.\d+\.\d+$/.test(manifest.pdfVersion) || !manifest.workers) throw new Error('Invalid production runtime asset manifest');
  return manifest;
}

export async function readRuntimeAssetManifest(root, distDir) {
  return validateManifest(JSON.parse(await readFile(path.join(root, distDir, runtimeAssetManifest), 'utf8')));
}

export async function snapshotProductionAssets(root, distDir) {
  const { version } = JSON.parse(await readFile(path.join(root, 'src/lib/browser/pdf-runtime-version.json'), 'utf8'));
  await verifyDocumentBrowserAssets(root, version);
  const snapshot = path.join(root, distDir, 'public');
  await rm(snapshot, { recursive: true, force: true });
  await cp(path.join(root, 'public'), snapshot, { recursive: true });
  const standalone = path.join(root, distDir, 'standalone');
  // The snapshot belongs to this build. A later checkout or parser sync must
  // not change the public files that prepare pairs with compiled JavaScript.
  const manifest = await describeAssets(root, distDir, snapshot, undefined, version);
  for (const name of workerFiles) {
    assert.deepEqual(await fileIdentity(path.join(standalone, 'workers', name)), manifest.workers[name], `Standalone worker differs: ${name}`);
  }
  await writeFile(path.join(root, distDir, runtimeAssetManifest), `${JSON.stringify(manifest)}\n`);
  return manifest;
}

export async function verifyBuildAssetSnapshot(root, distDir) {
  const manifest = await readRuntimeAssetManifest(root, distDir);
  const actual = await describeAssets(root, distDir, path.join(root, distDir, 'public'), path.join(root, distDir, 'standalone/workers'), manifest.pdfVersion);
  assert.deepEqual(actual, manifest, 'Build runtime snapshot is missing, corrupt or incomplete');
  return manifest;
}

export async function verifyProductionAssets(root, distDir, expected) {
  const manifest = await readRuntimeAssetManifest(root, distDir);
  await verifyDocumentBrowserAssets(root, manifest.pdfVersion);
  const actual = await describeAssets(root, distDir, undefined, undefined, manifest.pdfVersion);
  assert.deepEqual(actual, manifest, 'Production runtime assets are missing, corrupt or from another build');
  if (expected) {
    assert.equal(manifest.buildId, expected.buildId, 'Release BUILD_ID differs from its build');
    assert.deepEqual(manifest.static, expected.static, 'Release browser chunks differ from their build');
    assert.deepEqual(manifest.workers, expected.workers, 'Release workers differ from their build');
    for (const [name, identity] of Object.entries(expected.public)) {
      assert.deepEqual(manifest.public[name], identity, `Release public asset differs from its build: ${name}`);
    }
  }
  return manifest;
}

// Only immutable, versioned PDF module/worker pairs are carried forward.
// They keep an already-open browser's module and a newly-created worker on
// the same library version when a dependency is upgraded during a lesson.
export async function retainPdfRuntimeVersions(root, release) {
  const releases = path.join(root, '.openpbl-runtime/releases');
  const destination = path.join(release, 'public/vendor/pdfjs');
  const entries = await readdir(releases, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    const previous = path.join(releases, entry.name);
    if (!entry.isDirectory() || previous === release) continue;
    let manifest;
    try {
      await readFile(path.join(previous, '.release-ready'));
      manifest = await readRuntimeAssetManifest(previous, '.next-build');
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    const prefix = 'vendor/pdfjs/';
    const versions = new Set(Object.keys(manifest.public).map(name => name.startsWith(prefix) ? name.slice(prefix.length).split('/')[0] : '').filter(name => /^\d+\.\d+\.\d+$/.test(name)));
    for (const version of versions) {
      const pair = ['pdf.legacy.min.mjs', 'pdf.worker.legacy.min.mjs'];
      for (const name of pair) {
        const relative = `${prefix}${version}/${name}`;
        const source = path.join(previous, 'public', relative);
        assert.deepEqual(await fileIdentity(source), manifest.public[relative], `Historical PDF runtime differs: ${version}/${name}`);
        const target = path.join(destination, version, name);
        try { assert.deepEqual(await fileIdentity(target), manifest.public[relative], `Conflicting PDF runtime version: ${version}`); }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          await mkdir(path.dirname(target), { recursive: true });
          await cp(source, target);
        }
      }
    }
  }
}

export async function writeReleaseAssetManifest(root, distDir, expected) {
  const manifest = await describeAssets(root, distDir, undefined, undefined, expected.pdfVersion);
  await writeFile(path.join(root, distDir, runtimeAssetManifest), `${JSON.stringify(manifest)}\n`);
  await verifyProductionAssets(root, distDir, expected);
}

export async function writeReleaseReady(root, distDir) {
  const manifest = await readRuntimeAssetManifest(root, distDir);
  const identity = await fileIdentity(path.join(root, distDir, runtimeAssetManifest));
  await writeFile(path.join(root, '.release-ready'), `${JSON.stringify({ schemaVersion: 1, buildId: manifest.buildId, runtimeAssetsSha256: identity.sha256 })}\n`);
}

export async function verifyReleaseReady(root, distDir, buildId) {
  const value = await readFile(path.join(root, '.release-ready'), 'utf8');
  if ([buildId, `${buildId}\n`, `${buildId}\r\n`].includes(value)) return { legacy: true };
  let ready;
  try { ready = JSON.parse(value); } catch { throw new Error('Production release ready marker is invalid'); }
  if (ready?.schemaVersion !== 1 || ready.buildId !== buildId || !/^[a-f0-9]{64}$/.test(ready.runtimeAssetsSha256)) {
    throw new Error('Production release ready marker does not match BUILD_ID');
  }
  const identity = await fileIdentity(path.join(root, distDir, runtimeAssetManifest));
  assert.equal(identity.sha256, ready.runtimeAssetsSha256, 'Production runtime manifest differs from its ready marker');
  return { legacy: false };
}
