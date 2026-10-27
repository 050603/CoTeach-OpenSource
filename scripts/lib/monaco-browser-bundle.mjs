import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, readdir, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, gunzipSync, brotliDecompressSync, constants } from 'node:zlib';

const root = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const browserBundleManifestPath = path.join(root, 'src/lib/browser/monaco-browser-bundle-manifest.json');
const modulesPath = path.join(root, 'scripts/lib/monaco-browser-bundle-modules.json');

/** A reviewed, source-hash-bound module list, not a second AMD implementation.
 * No factory runs during publication. The native loader resolves these names.
 */
export async function createMonacoBrowserBundle(source, sourceManifest) {
  // Parsing belongs to the build, not release verification or application boot.
  const { parse } = createRequire(import.meta.url)('next/dist/compiled/acorn/acorn.js');
  const metadata = JSON.parse(await readFile(browserBundleManifestPath, 'utf8'));
  const listBytes = await readFile(modulesPath);
  const list = JSON.parse(listBytes);
  assert.equal(metadata.originalSourceTreeSha256, sourceManifest.treeSha256, 'Monaco bundle source tree differs');
  assert.equal(metadata.version, sourceManifest.version, 'Monaco bundle version differs');
  assert.equal(metadata.algorithm, 'named-amd-topological-concat-v1');
  assert.equal(list.algorithm, metadata.algorithm);
  assert.equal(digest(listBytes), metadata.moduleListSha256, 'Monaco module list differs');
  assert.equal(list.modules.length, metadata.moduleCount);
  const defined = new Set(); const buffers = [];
  for (const item of list.modules) {
    assert.match(item.id, /^vs\/[A-Za-z0-9_./-]+$/);
    assert.ok(item.id.split('/').every(part => part !== '..' && part !== '.' && part));
    assert.ok(!defined.has(item.id), 'Duplicate Monaco bundle module');
    const bytes = await readFile(path.join(source, `${item.id.slice(3)}.js`));
    assert.equal(digest(bytes), item.sha256, `Monaco module changed: ${item.id}`);
    const ast = parse(bytes.toString('utf8'), { ecmaVersion: 'latest' });
    assert.equal(ast.body.length, 1, 'Monaco module has extra top-level effects');
    const call = ast.body[0].expression;
    assert.ok(call?.type === 'CallExpression' && call.callee.type === 'Identifier' && call.callee.name === 'define');
    assert.equal(call.arguments[0]?.value, item.id, 'Monaco module ID differs');
    const dependencies = call.arguments[1];
    assert.equal(dependencies?.type, 'ArrayExpression');
    assert.equal(call.arguments[2]?.type, 'FunctionExpression');
    for (const dependency of dependencies.elements) {
      assert.equal(typeof dependency?.value, 'string');
      const id = dependency.value.split('!')[0];
      if (['require', 'exports', 'module'].includes(id)) continue;
      const resolved = id.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(item.id), id)) : id;
      assert.ok(defined.has(resolved), `Monaco dependency must precede ${item.id}: ${resolved}`);
    }
    defined.add(item.id); buffers.push(bytes, Buffer.from('\n;\n'));
  }
  assert.equal(list.modules.at(-1).id, metadata.entry);
  assert.equal(metadata.entry, 'vs/editor/editor.main');
  const bytes = Buffer.concat(buffers);
  assert.equal(bytes.length, metadata.bytes);
  assert.equal(digest(bytes), metadata.bundleSha256, 'Monaco bundle output differs');
  return { metadata, bytes };
}

export async function publishMonacoBrowserBundle(directory, source, sourceManifest) {
  const { metadata, bytes } = await createMonacoBrowserBundle(source, sourceManifest);
  const target = path.join(directory, 'bundles', metadata.bundleSha256);
  const files = {}; const representations = {};
  for (const encoding of ['identity', 'gzip', 'br']) {
    const encoded = encoding === 'identity' ? bytes : encoding === 'gzip' ? gzipSync(bytes, { level: 9 })
      : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
    const file = path.join(target, ...(encoding === 'identity' ? ['vs'] : ['encoded', encoding]), metadata.file);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, encoded, { flag: 'wx' });
    representations[encoding] = { bytes: encoded.length, sha256: digest(encoded) };
  }
  files[metadata.file] = representations;
  // This compatibility field pins the representation namespace (bundle hash),
  // not the original SDK tree. The separate manifest records both explicitly.
  await writeFile(path.join(target, 'encoded-manifest.json'), JSON.stringify({ schemaVersion: 1,
    version: metadata.version, sourceTreeSha256: metadata.bundleSha256, files }), { flag: 'wx' });
  await writeFile(path.join(directory, 'browser-bundle-manifest.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
}

export async function verifyMonacoBrowserBundle(directory, sourceManifest) {
  const expected = JSON.parse(await readFile(browserBundleManifestPath, 'utf8'));
  assert.ok((await lstat(directory)).isDirectory(), 'Monaco bundle root must not be a link');
  assert.ok((await lstat(path.join(directory, 'bundles'))).isDirectory(), 'Monaco bundles must not be a link');
  assert.ok((await lstat(path.join(directory, 'browser-bundle-manifest.json'))).isFile(), 'Monaco bundle manifest must not be a link');
  assert.equal(expected.originalSourceTreeSha256, sourceManifest.treeSha256, 'Monaco bundle source differs');
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'browser-bundle-manifest.json'), 'utf8')), expected, 'Monaco bundle manifest differs');
  const target = path.join(directory, 'bundles', expected.bundleSha256);
  assert.deepEqual(await readdir(path.join(directory, 'bundles')), [expected.bundleSha256]);
  const data = JSON.parse(await readFile(path.join(target, 'encoded-manifest.json'), 'utf8'));
  assert.equal(data.schemaVersion, 1); assert.equal(data.version, expected.version);
  assert.equal(data.sourceTreeSha256, expected.bundleSha256);
  assert.deepEqual(Object.keys(data.files), [expected.file]);
  const actualPaths = [];
  async function walk(dir, prefix = '') {
    assert.ok((await lstat(dir)).isDirectory(), 'Monaco bundle directory must not be a link');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), name + '/');
      else { assert.ok(entry.isFile(), 'Monaco bundle cannot contain links'); actualPaths.push(name); }
    }
  }
  await walk(target);
  assert.deepEqual(actualPaths.sort(), ['encoded-manifest.json', `encoded/br/${expected.file}`, `encoded/gzip/${expected.file}`, `vs/${expected.file}`].sort());
  for (const encoding of ['identity', 'gzip', 'br']) {
    const file = path.join(target, ...(encoding === 'identity' ? ['vs'] : ['encoded', encoding]), expected.file);
    const bytes = await readFile(file); const info = data.files[expected.file][encoding];
    assert.equal(bytes.length, info.bytes); assert.equal(digest(bytes), info.sha256);
    const decoded = encoding === 'identity' ? bytes : encoding === 'gzip' ? gunzipSync(bytes) : brotliDecompressSync(bytes);
    assert.equal(decoded.length, expected.bytes); assert.equal(digest(decoded), expected.bundleSha256);
  }
  return expected;
}
