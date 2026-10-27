import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import monacoManifest from "./monaco-runtime-manifest.json";
import monacoBundle from "./monaco-browser-bundle-manifest.json";

const mocks = vi.hoisted(() => ({ init: vi.fn(), config: vi.fn() }));
vi.mock("@monaco-editor/react", () => ({ loader: mocks }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.init.mockReset().mockResolvedValue({});
  mocks.config.mockClear();
  vi.stubGlobal("_VSCODE_NLS_LANGUAGE", undefined);
});
afterEach(() => {
  document.querySelectorAll('script[data-openpbl-monaco-locale]').forEach((script) => script.remove());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("code editor runtime loading", () => {
  it("loads production locale and editor from the pinned static browser tree", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { loadCodeEditorRuntime } = await import("./code-editor-runtime");
    const runtime = loadCodeEditorRuntime();
    const base = `/_next/static/openpbl-runtime/monaco/${monacoManifest.version}/${monacoManifest.treeSha256}/vs`;
    expect(monacoManifest.treeSha256).toMatch(/^[a-f0-9]{64}$/);
    const entry = `/_next/static/openpbl-runtime/monaco/${monacoManifest.version}/${monacoBundle.bundleSha256}/vs/editor.main`;
    expect(mocks.config).toHaveBeenCalledWith({ paths: { vs: base,
      "vs/editor/editor.main": entry,
      "vs/editor/editor.main.css": `${base}/editor/editor.main.css`,
    } });
    // The actual SDK chooses the longest startsWith rule, not path segments.
    const paths = mocks.config.mock.calls[0][0].paths as Record<string, string>;
    const resolve = (name: string) => {
      const key = Object.keys(paths).sort((a, b) => b.length - a.length).find(key => name.startsWith(key))!;
      return paths[key] + name.slice(key.length);
    };
    expect(resolve("vs/editor/editor.main")).toBe(entry);
    expect(resolve("vs/editor/editor.main.css")).toBe(`${base}/editor/editor.main.css`);
    expect(resolve("vs/assets/editor.worker-original.js")).toBe(`${base}/assets/editor.worker-original.js`);
    const script = document.querySelector('script[data-openpbl-monaco-locale]')!;
    expect(script.getAttribute("src")).toBe(`${base}/nls/lang/zh-cn.js`);
    expect(loadCodeEditorRuntime()).toBe(runtime);
    script.dispatchEvent(new Event("load"));
    await expect(runtime).resolves.toBeUndefined();
    expect(mocks.init).toHaveBeenCalledOnce();
  });

  it("shares locale loading and waits for the editor itself to initialize", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { loadCodeEditorRuntime } = await import("./code-editor-runtime");
    const runtime = loadCodeEditorRuntime();
    expect(loadCodeEditorRuntime()).toBe(runtime);
    expect(mocks.init).not.toHaveBeenCalled();
    const script = document.querySelector('script[data-openpbl-monaco-locale]')!;
    expect(script.getAttribute("src")).toBe("/api/openmaic/interactive-runtime/monaco/0.56.0/nls/lang/zh-cn.js");
    expect(mocks.config).toHaveBeenCalledWith({ paths: { vs: "/api/openmaic/interactive-runtime/monaco/0.56.0" } });
    script.dispatchEvent(new Event("load"));
    await expect(runtime).resolves.toBeUndefined();
    expect(mocks.init).toHaveBeenCalledOnce();
  });

  it("removes a failed locale script so another visit can retry", async () => {
    const { loadCodeEditorRuntime } = await import("./code-editor-runtime");
    const runtime = loadCodeEditorRuntime();
    const result = expect(runtime).rejects.toThrow("EDITOR_LOCALE_LOAD_FAILED");
    document.querySelector('script[data-openpbl-monaco-locale]')!.dispatchEvent(new Event("error"));
    await result;
    expect(document.querySelector('script[data-openpbl-monaco-locale]')).toBeNull();
    const retry = loadCodeEditorRuntime();
    document.querySelector('script[data-openpbl-monaco-locale]')!.dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBeUndefined();
  });

  it("reports editor bundle failures after localization has loaded", async () => {
    vi.stubGlobal("_VSCODE_NLS_LANGUAGE", "zh-cn");
    mocks.init.mockRejectedValue(new Error("Network error"));
    const { loadCodeEditorRuntime } = await import("./code-editor-runtime");
    await expect(loadCodeEditorRuntime()).rejects.toThrow("EDITOR_LOAD_FAILED");
  });

  it.each([false, true])("times out stalled requests (locale already loaded: %s)", async (localized) => {
    if (localized) vi.stubGlobal("_VSCODE_NLS_LANGUAGE", "zh-cn");
    mocks.init.mockReturnValue(new Promise(() => undefined));
    const { loadCodeEditorRuntime } = await import("./code-editor-runtime");
    const result = expect(loadCodeEditorRuntime()).rejects.toThrow("EDITOR_LOAD_TIMEOUT");
    await vi.advanceTimersByTimeAsync(20_000);
    await result;
  });
});
