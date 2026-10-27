import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { postProcessInteractiveHtml } from '../src/interactive-post-processor.js';

describe('math runtime integration', () => {
  it('keeps text, raw code, style and attributes byte-for-byte', () => {
    const authored = '<p title="$a$">$x$ and $$y$$</p><style>.money::before{content:"$5"}</style>'
      + '<script>const literal = "$& $1 $x$ __SCRIPT_BLOCK_0__";</script>';
    const result = postProcessInteractiveHtml(authored);
    expect(result.startsWith(authored)).toBe(true);
    expect(result).toContain('katex@0.18.2/dist/katex.min.js');
    expect(postProcessInteractiveHtml(result)).toBe(result);
  });

  it('recognizes actual existing assets and supports an application-hosted runtime', () => {
    const result = postProcessInteractiveHtml('<html><HEAD><link rel="stylesheet" href="/custom/katex.min.css"></HEAD>'
      + '<body>the word katex alone is not a loaded runtime</body></html>', { katexBaseUrl: '/runtime/math' });
    expect(result.match(/katex\.min\.css/g)).toHaveLength(1);
    expect(result).toContain('src="/runtime/math/katex.min.js"');
    expect(result).not.toContain('cdn.jsdelivr');
    expect(result.indexOf('data-coteach-math-runtime')).toBeLessThan(result.indexOf('</body>'));
  });

  it('keeps existing deferred scripts ahead of new loaders and handles unminified assets', () => {
    const source = '<html><head><script defer src="/custom/katex.js"></script></head><body>'
      + '<p>data-coteach-math-runtime is ordinary text</p></body></html>';
    const result = postProcessInteractiveHtml(source);
    expect(result.match(/katex(?:\.min)?\.js/g)).toHaveLength(1);
    expect(result).toContain('<script defer src="https://cdn.jsdelivr.net/npm/katex@0.18.2/dist/contrib/auto-render.min.js">');
    expect(result.indexOf('/custom/katex.js')).toBeLessThan(result.indexOf('contrib/auto-render.min.js'));
    const asynchronous = postProcessInteractiveHtml('<script async src="/custom/katex.js"></script>');
    expect(asynchronous).toContain('<script defer src="https://cdn.jsdelivr.net/npm/katex@0.18.2/dist/katex.min.js">');
  });

  it('renders all delimiter forms, batches later widget edits and disconnects while rendering', () => {
    const html = postProcessInteractiveHtml('content');
    const code = /<script data-coteach-math-runtime>([\s\S]*?)<\/script>/.exec(html)![1];
    let mutation: () => void = () => undefined;
    const timers: Array<() => void> = [];
    const events: string[] = [];
    const render = vi.fn(() => events.push('render'));
    const body = {};
    runInNewContext(code, {
      document: { body, readyState: 'complete' },
      window: { renderMathInElement: render, setTimeout: (callback: () => void) => timers.push(callback) },
      MutationObserver: class {
        constructor(callback: () => void) { mutation = callback; }
        observe() { events.push('observe'); }
        disconnect() { events.push('disconnect'); }
      },
    });
    expect(events).toEqual(['disconnect', 'render', 'observe']);
    expect(render.mock.calls[0]).toEqual([body, expect.objectContaining({ delimiters: [
      { left: '$$', right: '$$', display: true }, { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false }, { left: '$', right: '$', display: false },
    ] })]);
    mutation(); mutation();
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(render).toHaveBeenCalledTimes(2);
    expect(events.slice(-3)).toEqual(['disconnect', 'render', 'observe']);
  });
});
