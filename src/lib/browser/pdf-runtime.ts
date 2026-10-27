import pdfRuntimeVersion from "./pdf-runtime-version.json";

export const PDF_RUNTIME_VERSION = pdfRuntimeVersion.version;
export const PDF_RUNTIME_BASE = `/vendor/pdfjs/${PDF_RUNTIME_VERSION}`;
export const PDF_RUNTIME_MODULE_URL = `${PDF_RUNTIME_BASE}/pdf.legacy.min.mjs`;
export const PDF_RUNTIME_WORKER_URL = `${PDF_RUNTIME_BASE}/pdf.worker.legacy.min.mjs`;

type PdfModuleImporter = (moduleUrl: string) => Promise<unknown>;
type PdfWorkerConfiguration = { GlobalWorkerOptions: { workerSrc: string } };

function isModuleFetchFailure(error: unknown): boolean {
  return error instanceof Error && /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(error.message);
}

export function createPdfRuntimeLoader(importModule: PdfModuleImporter): () => Promise<unknown> {
  let runtime: Promise<unknown> | undefined;
  let retryNumber = 0;

  return function loadPdfRuntime() {
    if (runtime) return runtime;
    const load = async () => {
      let pdfjs: unknown;
      try {
        pdfjs = await importModule(PDF_RUNTIME_MODULE_URL);
      } catch (error) {
        if (!isModuleFetchFailure(error)) throw error;
        // Browsers can remember a failed module URL. Retry once with a new URL;
        // later explicit attempts also get a fresh URL if this attempt fails.
        pdfjs = await importModule(`${PDF_RUNTIME_MODULE_URL}?retry=${++retryNumber}`);
      }
      (pdfjs as PdfWorkerConfiguration).GlobalWorkerOptions.workerSrc = PDF_RUNTIME_WORKER_URL;
      return pdfjs;
    };
    runtime = load().catch((error: unknown) => {
      runtime = undefined;
      throw error;
    });
    return runtime;
  };
}

export const loadPdfRuntime = createPdfRuntimeLoader((moduleUrl) => import(
  /* webpackIgnore: true */
  /* turbopackIgnore: true */
  /* @vite-ignore */
  moduleUrl
));
