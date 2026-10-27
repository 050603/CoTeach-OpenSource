import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyDocumentBrowserAssets, verifyProductionAssets, verifyReleaseReady } from './production-assets.mjs';

// Select only an existing prepared release. Do not prepare, migrate or start it.
export async function resolvePreparedRuntimeBuild(projectRoot, buildId) {
  if (typeof buildId !== 'string' || !buildId || /[^A-Za-z0-9_-]/.test(buildId)) {
    throw new Error('OPENPBL_RUNTIME_BUILD_ID 只允许非空的字母、数字、下划线和连字符');
  }
  const root = await realpath(projectRoot);
  const release = path.join(root, '.openpbl-runtime', 'releases', buildId);
  // Reject symlinked ancestors or aliases, including a valid-looking ID whose
  // directory escapes releases. Prepared releases are immutable directories.
  if (await realpath(release) !== release) throw new Error('指定运行版本不在固定 releases 子目录');
  async function readableFile(name) {
    const file = path.join(release, name);
    if (await realpath(file) !== file) throw new Error('指定运行版本包含符号链接文件');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('指定运行版本缺少普通文件');
    await access(file, constants.R_OK);
    return { file, size: info.size };
  }
  for (const name of ['.release-ready', '.next-build/BUILD_ID']) {
    const { file, size } = await readableFile(name);
    if (size > 1024) throw new Error('指定运行版本的身份文件过大');
    const value = await readFile(file, 'utf8');
    if (name !== '.release-ready' && value !== buildId && value !== `${buildId}\n` && value !== `${buildId}\r\n`) {
      throw new Error('指定运行版本的 ready 标记或 BUILD_ID 不一致');
    }
  }
  const ready = await verifyReleaseReady(release, '.next-build', buildId);
  // Explicit pins bypass the normal staging launcher. Check their dependencies
  // here too, before secrets, migrations or a service restart are attempted.
  try {
    await stat(path.join(release, '.next-build/runtime-assets.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!ready.legacy) throw error;
    await verifyDocumentBrowserAssets(release);
    return (await readableFile('server.js')).file;
  }
  await verifyProductionAssets(release, '.next-build');
  return (await readableFile('server.js')).file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error('用法：production-runtime-release.mjs 项目绝对路径 BUILD_ID');
    console.log(await resolvePreparedRuntimeBuild(process.argv[2], process.argv[3]));
  } catch (error) {
    console.error(`无法选择指定生产版本：${error.message}`);
    process.exitCode = 1;
  }
}
