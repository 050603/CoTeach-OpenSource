import { describe, expect, it } from 'vitest';
import { extractInteractiveElements } from './interactive-element-inventory';

describe('interactive element inventory', () => {
  it('collects real ids, semantic classes, and useful attributes', () => {
    const inventory = extractInteractiveElements(`
      <main id="game-root">
        <button id="reset-btn" aria-label="Reset the game">Reset</button>
        <div id="active-zone" class="dropzone p-4" role="region"></div>
        <input id="angle-slider" type="range" name="angle" />
      </main>
    `);

    expect(inventory).toContain('#reset-btn');
    expect(inventory).toContain('aria-label="Reset the game"');
    expect(inventory).toContain('#angle-slider');
    expect(inventory).toContain('type=range');
    expect(inventory).toContain('.dropzone');
    expect(inventory).not.toContain('.p-4');
  });

  it('surfaces id-less stable data selectors and ignores scripts and comments', () => {
    const inventory = extractInteractiveElements(`
      <!-- <button id="old">Old</button> -->
      <li data-step-id="step-1">Inspect</li>
      <button data-action="check">Check</button>
      <script>const template = '<div id="ghost"></div>';</script>
    `);

    expect(inventory).toContain('[data-step-id="step-1"] <li>');
    expect(inventory).toContain('[data-action="check"] <button>');
    expect(inventory).not.toContain('#old');
    expect(inventory).not.toContain('#ghost');
  });

  it('keeps authored semantic classes that resemble utility classes', () => {
    const inventory = extractInteractiveElements(`
      <style>.grid-cell { padding: 4px; } .fill-blank { border: 1px solid; }</style>
      <div class="grid-cell fill-blank"></div>
    `);

    expect(inventory).toContain('.grid-cell');
    expect(inventory).toContain('.fill-blank');
  });

  it('does not forge attributes from quoted labels', () => {
    const inventory = extractInteractiveElements(
      '<button id="go" aria-label="try name=alpha or id=fake"></button>',
    );

    expect(inventory).toContain('#go');
    expect(inventory.split('\n')).not.toContain('#fake <button>');
    expect(inventory.split('\n').find((line) => line.startsWith('#go'))).toMatch(
      /aria-label="[^"]*"$/,
    );
  });
});
