// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const families = ['SourceHanSans', 'SourceHanSerif', 'LXGWWenKai', 'ZhuQueFangSong', 'WenDingPLKaiTi', 'ZcoolHappy'];
const root = process.cwd();
const css = readFileSync(path.join(root, 'src/app/openmaic/fonts.css'), 'utf8');
const rules = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1]);

describe('same-origin OpenMAIC font assets', () => {
  it('keeps every renderer font family and resolves every face to a local original asset', () => {
    expect(rules).toHaveLength(families.length);
    expect(rules.map((rule) => rule.match(/font-family:\s*'([^']+)'/)?.[1])).toEqual(families);
    for (const [index, family] of families.entries()) {
      expect(rules[index]).toContain(`src: url('/fonts/openmaic/${family}.woff2') format('woff2')`);
      expect(rules[index]).toContain('font-display: swap');
    }
    expect(css).not.toMatch(/url\(['"]?(?:https?:)?\/\//);
  });

  it.each(families)('ships an intact WOFF2 container for %s', (family) => {
    const bytes = readFileSync(path.join(root, `public/fonts/openmaic/${family}.woff2`));
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('wOF2');
    expect(bytes.readUInt32BE(8), 'WOFF2 header length must match the deployed binary').toBe(bytes.length);
    expect(bytes.readUInt16BE(12), 'Font tables are present').toBeGreaterThan(0);
    expect(bytes.readUInt32BE(20), 'Compressed font data is present').toBeGreaterThan(0);
  });

  it('uses the local font sheet in both student player layouts', () => {
    for (const page of ['ai-learning', 'micro-lesson']) {
      const source = readFileSync(path.join(root, `src/app/student/${page}/[id]/layout.tsx`), 'utf8');
      expect(source).toContain("import '@/app/openmaic/fonts.css'");
      expect(source).not.toContain('@openmaic/renderer/fonts.css');
    }
  });

  it('distributes the original font licenses without changing their text', () => {
    for (const license of ['OFL.txt', 'ARPHIC-PL.txt', 'ZcoolHappy-LICENSE.txt']) {
      expect(readFileSync(path.join(root, 'public/fonts/openmaic/font-licenses', license)))
        .toEqual(readFileSync(path.join(root, 'packages/@openmaic/renderer/font-licenses', license)));
    }
    const notice = readFileSync(path.join(root, 'public/fonts/openmaic/NOTICE.txt'), 'utf8');
    for (const family of families) expect(notice).toContain(`https://file.maic.chat/fonts/${family}.woff2`);
  });
});
