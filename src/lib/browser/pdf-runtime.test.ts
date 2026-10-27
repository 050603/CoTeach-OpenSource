import { describe, expect, it, vi } from "vitest";
import {
  createPdfRuntimeLoader,
  PDF_RUNTIME_BASE,
  PDF_RUNTIME_MODULE_URL,
  PDF_RUNTIME_VERSION,
  PDF_RUNTIME_WORKER_URL,
} from "./pdf-runtime";
import pdfRuntimeVersion from "./pdf-runtime-version.json";

function pdfModule() {
  return { GlobalWorkerOptions: { workerSrc: "" }, getDocument: vi.fn() };
}

describe("PDF browser runtime loading", () => {
  it("loads the module and worker from the same pinned version directory", async () => {
    const pdfjs = pdfModule();
    const importModule = vi.fn().mockResolvedValue(pdfjs);
    const load = createPdfRuntimeLoader(importModule);

    await expect(load()).resolves.toBe(pdfjs);

    expect(PDF_RUNTIME_VERSION).toBe(pdfRuntimeVersion.version);
    expect(PDF_RUNTIME_BASE).toBe("/vendor/pdfjs/4.8.69");
    expect(importModule).toHaveBeenCalledExactlyOnceWith(`${PDF_RUNTIME_BASE}/pdf.legacy.min.mjs`);
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe(`${PDF_RUNTIME_BASE}/pdf.worker.legacy.min.mjs`);
    expect(PDF_RUNTIME_WORKER_URL).toBe(pdfjs.GlobalWorkerOptions.workerSrc);
  });

  it("shares in-flight loading and keeps a successful module for later viewers", async () => {
    const pdfjs = pdfModule();
    let resolveImport!: (pdfjs: unknown) => void;
    const importModule = vi.fn().mockReturnValue(new Promise((resolve) => { resolveImport = resolve; }));
    const load = createPdfRuntimeLoader(importModule);

    const runtime = load();
    expect(load()).toBe(runtime);
    expect(importModule).toHaveBeenCalledOnce();

    resolveImport(pdfjs);
    await expect(runtime).resolves.toBe(pdfjs);
    expect(load()).toBe(runtime);
    expect(importModule).toHaveBeenCalledOnce();
  });

  it.each([
    "Failed to fetch dynamically imported module: https://coteach.cn/vendor/pdfjs/pdf.legacy.min.mjs",
    "error loading dynamically imported module: https://coteach.cn/vendor/pdfjs/pdf.legacy.min.mjs",
    "Importing a module script failed.",
  ])("retries a module fetch error once with a different URL: %s", async (message) => {
    const pdfjs = pdfModule();
    const importModule = vi.fn().mockRejectedValueOnce(new TypeError(message)).mockResolvedValue(pdfjs);
    const load = createPdfRuntimeLoader(importModule);

    await expect(load()).resolves.toBe(pdfjs);

    expect(importModule.mock.calls).toEqual([
      [PDF_RUNTIME_MODULE_URL],
      [`${PDF_RUNTIME_MODULE_URL}?retry=1`],
    ]);
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe(PDF_RUNTIME_WORKER_URL);
    await expect(load()).resolves.toBe(pdfjs);
    expect(importModule).toHaveBeenCalledTimes(2);
  });

  it("stops after one retry and lets a later attempt recover from both cached failures", async () => {
    const failure = new TypeError("Failed to fetch dynamically imported module");
    const pdfjs = pdfModule();
    const importModule = vi.fn().mockRejectedValue(failure);
    const load = createPdfRuntimeLoader(importModule);

    const failedRuntime = load();
    expect(load()).toBe(failedRuntime);
    await expect(failedRuntime).rejects.toBe(failure);
    expect(importModule).toHaveBeenCalledTimes(2);

    importModule.mockRejectedValueOnce(failure).mockResolvedValue(pdfjs);
    const recoveredRuntime = load();
    expect(recoveredRuntime).not.toBe(failedRuntime);
    await expect(recoveredRuntime).resolves.toBe(pdfjs);
    expect(importModule.mock.calls).toEqual([
      [PDF_RUNTIME_MODULE_URL],
      [`${PDF_RUNTIME_MODULE_URL}?retry=1`],
      [PDF_RUNTIME_MODULE_URL],
      [`${PDF_RUNTIME_MODULE_URL}?retry=2`],
    ]);
  });

  it("does not retry module execution errors and clears the rejected application promise", async () => {
    const failure = new TypeError("PDF module initialization failed");
    const pdfjs = pdfModule();
    const importModule = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(pdfjs);
    const load = createPdfRuntimeLoader(importModule);

    await expect(load()).rejects.toBe(failure);
    expect(importModule).toHaveBeenCalledExactlyOnceWith(PDF_RUNTIME_MODULE_URL);

    await expect(load()).resolves.toBe(pdfjs);
    expect(importModule).toHaveBeenCalledTimes(2);
  });
});
