import monacoManifest from "./monaco-runtime-manifest.json";
import monacoBundle from "./monaco-browser-bundle-manifest.json";

// The build verifies the installed browser tree against this reviewed manifest.
// Development has no post-build static artifact and keeps the compatible API.
export const MONACO_RUNTIME_VERSION = monacoManifest.version;
export const MONACO_STATIC_RUNTIME_BASE = `/_next/static/openpbl-runtime/monaco/${MONACO_RUNTIME_VERSION}/${monacoManifest.treeSha256}/vs`;
export const MONACO_BUNDLE_RUNTIME_BASE = `/_next/static/openpbl-runtime/monaco/${MONACO_RUNTIME_VERSION}/${monacoBundle.bundleSha256}/vs`;
export const MONACO_RUNTIME_BASE = process.env.NODE_ENV === "production"
  ? MONACO_STATIC_RUNTIME_BASE
  : `/api/openmaic/interactive-runtime/monaco/${MONACO_RUNTIME_VERSION}`;
export const INTERACTIVE_RUNTIME_VERSIONS: Record<string, string> = {
  monaco: MONACO_RUNTIME_VERSION,
  codemirror: "5.65.16",
  katex: "0.18.2",
  pyodide: "0.25.0",
};
