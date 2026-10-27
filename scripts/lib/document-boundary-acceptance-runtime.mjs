import path from 'node:path';
import { resolvePreparedRuntimeBuild } from './production-runtime-release.mjs';

// Acceptance may select an immutable prepared release, never an arbitrary path.
// Reuse the production selector's ready marker, identity and symlink checks.
export async function resolveDocumentAcceptanceRuntime(projectRoot, { releaseId, buildDir = '.next-build' } = {}) {
  if (releaseId !== undefined) {
    const server = await resolvePreparedRuntimeBuild(projectRoot, releaseId);
    return { source: path.dirname(server), buildDir: '.next-build', buildId: releaseId, sourceKind: 'prepared-release' };
  }
  if (path.isAbsolute(buildDir) || buildDir.includes('..')) throw new Error('Build directory must remain within the repository');
  return { source: path.join(projectRoot, buildDir, 'standalone'), buildDir, buildId: null, sourceKind: 'build-standalone' };
}
