import { describe, expect, it } from 'vitest';
import { postProcessInteractiveHtml } from './interactive-post-processor';

describe('postProcessInteractiveHtml Python runtime repair', () => {
  it('adds a blocking same-origin loader before a missing loadPyodide call', () => {
    const call = `<script>await loadPyodide({
      indexURL: '/api/openmaic/interactive-runtime/pyodide/'
    });</script>`;
    const processed = postProcessInteractiveHtml(`<html><head></head><body>${call}</body></html>`);

    expect(processed).toContain('data-openpbl-pyodide-loader');
    expect(processed).toContain('/api/openmaic/interactive-runtime/pyodide/pyodide.js');
    expect(processed).toContain(
      "indexURL: new URL('/api/openmaic/interactive-runtime/pyodide/', document.baseURI).href",
    );
    expect(processed.indexOf('data-openpbl-pyodide-loader')).toBeLessThan(
      processed.indexOf('await loadPyodide'),
    );
  });

  it('keeps an existing blocking loader without adding a duplicate', () => {
    const loader =
      '<script src="/api/openmaic/interactive-runtime/pyodide/pyodide.js"></script>';
    const processed = postProcessInteractiveHtml(
      `<html><head>${loader}</head><body><script>loadPyodide();</script></body></html>`,
    );

    expect(processed.match(/pyodide\/pyodide\.js/g)).toHaveLength(1);
    expect(processed).not.toContain('data-openpbl-pyodide-loader');
  });

  it('adds a blocking loader when the generated loader is deferred', () => {
    const processed = postProcessInteractiveHtml(`<html><head>
      <script defer src="https://cdn.example.test/pyodide.js"></script>
    </head><body><script>loadPyodide();</script></body></html>`);

    expect(processed).toContain('data-openpbl-pyodide-loader');
  });

  it('does not add Python assets to a non-Python interaction', () => {
    const processed = postProcessInteractiveHtml(
      '<html><head></head><body><script>window.answer = 42;</script></body></html>',
    );

    expect(processed).not.toContain('pyodide.js');
  });

  it('uses same-origin math assets without rewriting widget source', () => {
    const source = '<p>$x^2$</p><script>window.label = "$x$";</script>';
    const processed = postProcessInteractiveHtml(source);
    expect(processed).toContain(source);
    expect(processed).toContain('src="/api/openmaic/interactive-runtime/katex/katex.min.js"');
    expect(processed).not.toContain('cdn.jsdelivr');
    expect(postProcessInteractiveHtml(processed)).toBe(processed);
  });

});
