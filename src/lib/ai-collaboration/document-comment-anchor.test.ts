import { describe, expect, it } from 'vitest';
import { persistedDocumentBlockIds, resolveDocumentCommentAnchor, withoutDocumentBlockIds } from './document-comment-anchor';
import type { DocumentAiCommentThread, DocumentBlockCandidate } from './document-comment-types';

const thread: DocumentAiCommentThread = { id: 'old-comment', blockId: 'old-random-id', blockIndex: 0,
  blockText: '原始日志是4只，汇总表却写40只。', targetText: '汇总表却写40只',
  createdAt: '2026-10-16T05:01:11.391Z', comments: [] };
const candidate = (blockId: string, blockIndex = 0, text = thread.blockText!): DocumentBlockCandidate => ({ blockId, blockIndex, text, type: 'p' });

describe('document comment anchor identity', () => {
  it('accepts only unique bounded block ID attributes, never a title/string or duplicate', () => {
    expect([...persistedDocumentBlockIds('<p data-openpbl-block-id="one">正文</p><h2 data-openpbl-block-id="two">标题</h2>')]).toEqual(['one', 'two']);
    expect([...persistedDocumentBlockIds(`<p title='data-openpbl-block-id="pretend"'>正文</p>`)]).toEqual([]);
    expect([...persistedDocumentBlockIds('<p data-openpbl-block-id="same"></p><p data-openpbl-block-id="same"></p>')]).toEqual([]);
    expect([...persistedDocumentBlockIds('<p data-openpbl-block-id="one" data-openpbl-block-id="two"></p>')]).toEqual([]);
    expect([...persistedDocumentBlockIds('<p data-openpbl-block-id="bad id"></p>')]).toEqual([]);
  });
  it.each([
    '<!-- <p data-openpbl-block-id="same">伪段落</p> -->',
    `<script>const source = '<p data-openpbl-block-id="same">伪段落</p>';</script>`,
    '<textarea><p data-openpbl-block-id="same">伪段落</p></textarea>',
    '<style>.x::before{content:\'<p data-openpbl-block-id="same">伪段落</p>\'}</style>',
    `<div title='<p data-openpbl-block-id="same">伪段落</p>'>外层</div>`,
    '<title><p data-openpbl-block-id="same">伪段落</p></title>',
    '<template><template></template><p data-openpbl-block-id="same">惰性段落</p></template>',
  ])('ignores pseudo tags in opaque input while preserving a real following identity: %s', opaque => {
    const actual = `${opaque}<p data-openpbl-block-id="same">真实段落</p>`;
    expect([...persistedDocumentBlockIds(actual)]).toEqual(['same']);
    expect(withoutDocumentBlockIds(actual)).toBe(`${opaque}<p>真实段落</p>`);
  });
  it('consumes a full outer block tag before reading its actual attributes', () => {
    const html = `<p title='<p data-openpbl-block-id="fake">伪段落</p>' data-openpbl-block-id="real">正文</p>`;
    expect([...persistedDocumentBlockIds(html)]).toEqual(['real']);
    expect(withoutDocumentBlockIds(html)).toBe(`<p title='<p data-openpbl-block-id="fake">伪段落</p>'>正文</p>`);
    for (const html of ['<!-- <p data-openpbl-block-id="fake">', '<script><p data-openpbl-block-id="fake">',
      '<textarea><p data-openpbl-block-id="fake">', `<div title='<p data-openpbl-block-id="fake">`,
      '<plaintext><p data-openpbl-block-id="fake">']) expect([...persistedDocumentBlockIds(html)]).toEqual([]);
  });
  it('recovers a legacy RANDOM block ID by one complete paragraph after reload and later metadata save', () => {
    expect(resolveDocumentCommentAnchor(thread, [candidate('regenerated-id', 3)])).toBe(3);
    expect(resolveDocumentCommentAnchor(thread, [candidate('later-persisted-id', 4)])).toBe(4);
  });
  it('does not confuse identical legacy blocks, a short repeated phrase, or an existing but edited original ID', () => {
    expect(resolveDocumentCommentAnchor(thread, [candidate('a'), candidate('b', 1)])).toBe(-1);
    expect(resolveDocumentCommentAnchor(thread, [candidate('a', 0, '另一份报告也说汇总表却写40只，但依据不同。')])).toBe(-1);
    expect(resolveDocumentCommentAnchor(thread, [candidate('old-random-id', 0, '原段落已经修改。'), candidate('a', 1)])).toBe(-1);
    expect(resolveDocumentCommentAnchor({ ...thread, blockText: undefined }, [candidate('a', 0, thread.targetText)])).toBe(-1);
  });
  it('keeps a persisted v1 ID authoritative across moves and refuses deletion/replacement or duplicate IDs', () => {
    const current = { ...thread, anchorVersion: 1 as const };
    expect(resolveDocumentCommentAnchor(current, [candidate('old-random-id', 2)])).toBe(2);
    expect(resolveDocumentCommentAnchor(current, [candidate('new-identical-paragraph')])).toBe(-1);
    expect(resolveDocumentCommentAnchor(current, [candidate('old-random-id'), candidate('old-random-id', 1)])).toBe(-1);
    expect(resolveDocumentCommentAnchor(current, [candidate('old-random-id', 0, '数字已核验并改正。')])).toBe(-1);
  });
  it('excludes only identity attributes from semantic dirty comparisons', () => {
    expect(withoutDocumentBlockIds('<p data-openpbl-block-id="id"><strong>原文</strong></p>')).toBe('<p><strong>原文</strong></p>');
    expect(withoutDocumentBlockIds('<p data-openpbl-block-id="id"><em>原文</em></p>')).not.toBe('<p><strong>原文</strong></p>');
  });
});
