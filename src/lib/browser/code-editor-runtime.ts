import { loader } from "@monaco-editor/react";
import { MONACO_RUNTIME_BASE, MONACO_BUNDLE_RUNTIME_BASE } from "./runtime-asset-versions";

const LOCALE_URL = `${MONACO_RUNTIME_BASE}/nls/lang/zh-cn.js`;
const LOAD_TIMEOUT_MS = 20_000;
let runtime: Promise<void> | undefined;

loader.config({ paths: { vs: MONACO_RUNTIME_BASE,
  ...(process.env.NODE_ENV === "production" ? {
    "vs/editor/editor.main": `${MONACO_BUNDLE_RUNTIME_BASE}/editor.main`,
    // SDK paths use startsWith rather than a slash boundary. This longer rule
    // keeps require.toUrl('vs/editor/editor.main.css') on the original tree.
    "vs/editor/editor.main.css": `${MONACO_RUNTIME_BASE}/editor/editor.main.css`,
  } : {}),
} });

/** Keep both locale and editor failures out of an endless loading indicator. */
export function loadCodeEditorRuntime(): Promise<void> {
  if (runtime) return runtime;
  runtime = new Promise<void>((resolve, reject) => {
    let settled = false;
    let localeLoaded = false;
    const script = document.createElement("script");
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      script?.removeEventListener("load", loadEditor);
      script?.removeEventListener("error", onScriptError);
      if (error) {
        if (!localeLoaded) script?.remove();
        reject(error);
      } else resolve();
    };
    const loadEditor = () => {
      localeLoaded = true;
      try {
        void loader.init().then(() => finish(), () => finish(new Error("EDITOR_LOAD_FAILED")));
      } catch {
        finish(new Error("EDITOR_LOAD_FAILED"));
      }
    };
    const onScriptError = () => finish(new Error("EDITOR_LOCALE_LOAD_FAILED"));
    const timer = window.setTimeout(() => finish(new Error("EDITOR_LOAD_TIMEOUT")), LOAD_TIMEOUT_MS);
    const localizedGlobal = globalThis as typeof globalThis & { _VSCODE_NLS_LANGUAGE?: string };
    if (localizedGlobal._VSCODE_NLS_LANGUAGE === "zh-cn") {
      loadEditor();
      return;
    }
    script.src = LOCALE_URL;
    script.dataset.openpblMonacoLocale = "zh-cn";
    script.addEventListener("load", loadEditor);
    script.addEventListener("error", onScriptError);
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    runtime = undefined;
    throw error;
  });
  return runtime;
}
