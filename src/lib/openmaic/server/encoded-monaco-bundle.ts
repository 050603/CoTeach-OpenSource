import path from 'node:path';
import bundle from '@/lib/browser/monaco-browser-bundle-manifest.json';
import { createEncodedMonacoRuntime } from './encoded-monaco-runtime';

/** Both the directory and representation pin come from reviewed source, never
 * from an arbitrary request fingerprint. Original SDK assets remain separate.
 */
export function createEncodedMonacoBundle(directory: string) {
  return createEncodedMonacoRuntime(directory, {
    version: bundle.version, treeSha256: bundle.bundleSha256, fileCount: 1,
    sourceDirectory: 'vs', encodedDirectory: 'encoded',
  });
}

export const encodedMonacoBundle = createEncodedMonacoBundle(path.join(process.cwd(),
  process.env.NEXT_DIST_DIR?.trim() || '.next', 'static/openpbl-runtime/monaco/bundles', bundle.bundleSha256));
