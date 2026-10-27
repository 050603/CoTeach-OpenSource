/** Add a math runtime without rewriting authored HTML, attributes, or scripts.
 * KaTeX's own delimiter parser handles both dollar and backslash notation. */
export function postProcessInteractiveHtml(
  html: string,
  options: { katexBaseUrl?: string } = {},
): string {
  if (/<script\b[^>]*\bdata-coteach-math-runtime(?:\s|=|>)/i.test(html)) return html;
  const base = (options.katexBaseUrl ?? 'https://cdn.jsdelivr.net/npm/katex@0.18.2/dist/').replace(/\/?$/, '/');
  const tags = html.match(/<(?:script|link)\b[^>]*>/gi) ?? [];
  const present = (name: string) => tags.some(tag => {
    // Async script order is not guaranteed. Supply our own deferred runtime
    // when the authored page only has an async copy.
    if (/^<script\b/i.test(tag) && /\sasync(?:\s|=|>)/i.test(tag)) return false;
    const url = /\b(?:href|src)\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
    return url?.split(/[?#]/, 1)[0].replace(/\.min(?=\.)/, '').endsWith('/' + name.replace('.min', ''));
  });
  const attribute = (value: string) => value.replace(/[&"<>]/g, character =>
    ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[character]!);
  const resources: string[] = [];
  const hasCore = present('katex.min.js');
  if (!present('katex.min.css')) resources.push(`<link rel="stylesheet" href="${attribute(base)}katex.min.css">`);
  if (!hasCore) resources.push(`<script defer src="${attribute(base)}katex.min.js"></script>`);
  if (!hasCore || !present('auto-render.min.js')) resources.push(`<script defer src="${attribute(base)}contrib/auto-render.min.js"></script>`);
  resources.push(MATH_INITIALIZER);
  const insertion = resources.join('\n');
  // Append after existing loaders so both authored blocking/deferred scripts
  // and the added deferred scripts have executed by DOMContentLoaded.
  const offset = /<\/body\s*>/i.exec(html)?.index ?? /<\/html\s*>/i.exec(html)?.index ?? html.length;
  return html.slice(0, offset) + '\n' + insertion + '\n' + html.slice(offset);
}

// Rendering disconnects observation temporarily, preventing the renderer's own
// DOM writes from scheduling more work. Later widget updates are batched once.
const MATH_INITIALIZER = String.raw`<script data-coteach-math-runtime>
(() => {
  const start = () => {
    if (!document.body || typeof window.renderMathInElement !== 'function') return;
    let scheduled = false;
    const observe = () => observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const render = () => {
      scheduled = false;
      observer.disconnect();
      try {
        window.renderMathInElement(document.body, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '\\[', right: '\\]', display: true },
            { left: '\\(', right: '\\)', display: false },
            { left: '$', right: '$', display: false }
          ],
          throwOnError: false, strict: false, trust: true
        });
      } finally { observe(); }
    };
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      window.setTimeout(render, 80);
    });
    render();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
</script>`;
