import { postProcessInteractiveHtml as addMathRuntime } from '@openmaic/generation';

/** Preserve widget source and attach the application-hosted math runtime.
 * The Python loader repair remains specific to CoTeach's iframe environment. */
export function postProcessInteractiveHtml(html: string): string {
  return addMathRuntime(normalizePyodideIndexUrl(ensurePyodideLoader(html)), {
    katexBaseUrl: '/api/openmaic/interactive-runtime/katex/',
  });
}

const LOCAL_PYODIDE_LOADER =
  '<script data-openpbl-pyodide-loader src="/api/openmaic/interactive-runtime/pyodide/pyodide.js"></script>';
const LOCAL_PYODIDE_INDEX_URL = '/api/openmaic/interactive-runtime/pyodide/';

function normalizePyodideIndexUrl(html: string): string {
  return html.replace(
    /(\bindexURL\s*:\s*)(["'])\/api\/openmaic\/interactive-runtime\/pyodide\/\2/gi,
    (_match, prefix: string) =>
      `${prefix}new URL('${LOCAL_PYODIDE_INDEX_URL}', document.baseURI).href`,
  );
}

/**
 * Repair generated Python widgets before they are persisted. Prompt compliance
 * alone is not a sufficient runtime contract: models can omit the script, put
 * it below the bootstrap call, or add async/defer. In those cases insert a
 * parser-blocking, same-origin loader at the start of <head>. The render-time
 * iframe shim provides the equivalent compatibility path for older classrooms.
 */
function ensurePyodideLoader(html: string): string {
  const callIndex = html.search(/\bloadPyodide\s*\(/);
  if (callIndex === -1) return html;

  const blockingLoaderPattern = /<script\b([^>]*\bsrc\s*=\s*["'][^"']*pyodide(?:\.min)?\.(?:js|mjs)[^"']*["'][^>]*)><\/script>/gi;
  let loaderMatch: RegExpExecArray | null;
  while ((loaderMatch = blockingLoaderPattern.exec(html)) !== null) {
    const attributes = loaderMatch[1];
    const isDeferred = /\b(?:async|defer)\b/i.test(attributes);
    const isModule = /\btype\s*=\s*["']module["']/i.test(attributes);
    if (!isDeferred && !isModule && loaderMatch.index < callIndex) return html;
  }

  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (headMatch) {
    const insertAt = headMatch.index + headMatch[0].length;
    return html.slice(0, insertAt) + `\n${LOCAL_PYODIDE_LOADER}` + html.slice(insertAt);
  }

  return `${LOCAL_PYODIDE_LOADER}\n${html}`;
}
