import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, brotliDecompressSync, constants, gzipSync, gunzipSync } from 'node:zlib';
import { browserBundleManifestPath, publishMonacoBrowserBundle, verifyMonacoBrowserBundle } from './lib/monaco-browser-bundle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const monacoManifestPath = path.join(root, 'src/lib/browser/monaco-runtime-manifest.json');
const artifactDirectory = 'static/openpbl-runtime/monaco';
const algorithm = 'sha256-path-size-content-v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// This is a separate representation manifest: the pinned 151-file source tree
// and its hash never change because of a compressor/Node version change.
async function publishEncodings(directory, manifest) {
  const source = path.join(directory, manifest.version, manifest.treeSha256, 'vs');
  const files = {};
  async function walk(relative = '') {
    for (const entry of (await readdir(path.join(source, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(name); continue; }
      const original = await readFile(path.join(source, name));
      const item = { identity: { bytes: original.length, sha256: digest(original) } };
      for (const encoding of ['gzip', 'br']) {
        const bytes = encoding === 'gzip' ? gzipSync(original, { level: 9 })
          : brotliCompressSync(original, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
        const target = path.join(directory, 'encoded', manifest.treeSha256, encoding, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes, { flag: 'wx' });
        item[encoding] = { bytes: bytes.length, sha256: digest(bytes) };
      }
      files[name] = item;
    }
  }
  await walk();
  await writeFile(path.join(directory, 'encoded-manifest.json'), `${JSON.stringify({ schemaVersion: 1,
    version: manifest.version, sourceTreeSha256: manifest.treeSha256,
    algorithms: { gzip: 'level-9', br: 'quality-9' }, files }, null, 2)}\n`, { flag: 'wx' });
}

async function verifyEncodings(directory, manifest) {
  const encoded = JSON.parse(await readFile(path.join(directory, 'encoded-manifest.json'), 'utf8'));
  if (encoded.schemaVersion !== 1 || encoded.version !== manifest.version || encoded.sourceTreeSha256 !== manifest.treeSha256
    || !encoded.files || Object.keys(encoded.files).length !== manifest.fileCount) throw new Error('Monaco encoded manifest differs from source');
  const expected = [];
  for (const [name, item] of Object.entries(encoded.files)) {
    if (!name.split('/').every(part => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..')) throw new Error('Invalid Monaco encoded path');
    const original = await readFile(path.join(directory, manifest.version, manifest.treeSha256, 'vs', name));
    if (item.identity?.bytes !== original.length || item.identity.sha256 !== digest(original)) throw new Error('Monaco encoded source differs');
    for (const encoding of ['gzip', 'br']) {
      const relative = `${manifest.treeSha256}/${encoding}/${name}`; expected.push(relative);
      const bytes = await readFile(path.join(directory, 'encoded', relative));
      if (item[encoding]?.bytes !== bytes.length || item[encoding].sha256 !== digest(bytes)
        || !(encoding === 'gzip' ? gunzipSync(bytes) : brotliDecompressSync(bytes)).equals(original)) throw new Error('Monaco encoded bytes differ');
    }
  }
  // Detect extra files, links and missing files, not only manifest-listed bytes.
  const actual = await inspectMonacoTree(path.join(directory, 'encoded'));
  const hash = createHash('sha256'); let totalBytes = 0;
  for (const name of expected.sort()) {
    const bytes = await readFile(path.join(directory, 'encoded', name)); totalBytes += bytes.length;
    hash.update(`${name}\0${bytes.length}\0${digest(bytes)}\n`);
  }
  if (actual.fileCount !== expected.length || actual.totalBytes !== totalBytes || actual.treeSha256 !== hash.digest('hex')) throw new Error('Monaco encoded tree differs');
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.package !== 'monaco-editor'
    || manifest.source !== 'min/vs' || manifest.treeHashAlgorithm !== algorithm
    || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || !/^[a-f0-9]{64}$/.test(manifest.treeSha256)
    || !Number.isSafeInteger(manifest.fileCount) || manifest.fileCount < 1
    || !Number.isSafeInteger(manifest.totalBytes) || manifest.totalBytes < 1) {
    throw new Error('Invalid Monaco runtime manifest');
  }
  return manifest;
}

/** Sorted POSIX paths, NUL, decimal byte count, NUL, file SHA-256, LF.
 * Content and names are both bound. Reject links/special files, including root.
 * Keep one file buffer at a time; no package source or runtime data is copied.
 */
export async function inspectMonacoTree(directory) {
  const files = [];
  async function walk(relative = '') {
    const absolute = path.join(directory, relative);
    if (!(await lstat(absolute)).isDirectory()) throw new Error('Monaco tree requires real directories');
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (/[\0\r\n\\]/.test(name)) throw new Error('Invalid Monaco runtime filename');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) files.push(name);
      else throw new Error('Monaco tree cannot contain symbolic links or special files');
    }
  }
  await walk();
  files.sort();
  const hash = createHash('sha256');
  let totalBytes = 0;
  for (const name of files) {
    const bytes = await readFile(path.join(directory, name));
    totalBytes += bytes.length;
    hash.update(`${name}\0${bytes.length}\0${createHash('sha256').update(bytes).digest('hex')}\n`);
  }
  return { treeSha256: hash.digest('hex'), fileCount: files.length, totalBytes };
}

async function assertTree(directory, manifest) {
  const actual = await inspectMonacoTree(directory);
  if (['treeSha256', 'fileCount', 'totalBytes'].some(key => actual[key] !== manifest[key])) {
    throw new Error('Monaco browser tree differs from its pinned manifest; explicitly review and update the manifest when upgrading');
  }
}

export async function verifyMonacoRuntimeArtifact(distDir, expectedManifest) {
  const directory = path.join(distDir, artifactDirectory);
  const manifest = validateManifest(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')));
  if (expectedManifest && ['version', 'treeSha256', 'fileCount', 'totalBytes'].some(key => manifest[key] !== expectedManifest[key])) {
    throw new Error('Monaco release manifest differs from its build');
  }
  await assertTree(path.join(directory, manifest.version, manifest.treeSha256, 'vs'), manifest);
  await verifyEncodings(directory, manifest);
  const bundle = JSON.parse(await readFile(browserBundleManifestPath, 'utf8'));
  // Older/custom trees retain their own byte contract. This application's
  // pinned tree must include its separately verified browser representation.
  if (manifest.treeSha256 === bundle.originalSourceTreeSha256) await verifyMonacoBrowserBundle(directory, manifest);
  return manifest;
}

/** Called only after Next successfully builds. Next discovers dist/static by
 * recursively scanning it at server startup. Nothing writes into a live release.
 */
export async function publishMonacoRuntime({ distDir, packageRoot = path.join(root, 'node_modules/monaco-editor'), manifestPath = monacoManifestPath }) {
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
  const bundleManifest = JSON.parse(await readFile(browserBundleManifestPath, 'utf8'));
  if (path.resolve(manifestPath) === monacoManifestPath && (manifest.treeSha256 !== bundleManifest.originalSourceTreeSha256
    || manifest.version !== bundleManifest.version)) throw new Error('Monaco browser bundle must be reviewed with the installed source manifest');
  const installed = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (installed.name !== manifest.package || installed.version !== manifest.version) throw new Error('Installed Monaco package differs from its pinned manifest');
  const source = path.join(packageRoot, manifest.source);
  await assertTree(source, manifest);
  const destination = path.join(distDir, artifactDirectory);
  const exists = await lstat(destination).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
  // Never overwrite a different or damaged artifact, including an active one.
  if (exists) return verifyMonacoRuntimeArtifact(distDir, manifest);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.monaco-${randomUUID()}`);
  try {
    const target = path.join(staging, manifest.version, manifest.treeSha256, 'vs');
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, dereference: false, errorOnExist: true, force: false });
    await assertTree(target, manifest);
    await publishEncodings(staging, manifest);
    const bundle = JSON.parse(await readFile(browserBundleManifestPath, 'utf8'));
    if (manifest.treeSha256 === bundle.originalSourceTreeSha256) await publishMonacoBrowserBundle(staging, target, manifest);
    await writeFile(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await rename(staging, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return manifest;
}
