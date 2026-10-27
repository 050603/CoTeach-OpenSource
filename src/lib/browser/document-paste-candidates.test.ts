import { describe, expect, it } from 'vitest';
import { DocumentPasteCandidates, documentHtmlText } from './document-paste-candidates';
import { CONTENT_MONITOR_MAX_TEXT } from '@/lib/project-practice/content-monitor-contract';

describe('document paste candidates', () => {
  it('counts non-whitespace characters and only drains unchecked fragments', () => {
    const candidates = new DocumentPasteCandidates();
    expect(candidates.add({ text: '甲 '.repeat(299), beforeText: '' }, 0)).toEqual([]);
    expect(candidates.add({ text: '乙'.repeat(300), beforeText: '' }, 1)).toEqual([[expect.objectContaining({ text: '甲 '.repeat(299) }), expect.objectContaining({ text: '乙'.repeat(300) })]]);
    expect(candidates.add({ text: '乙'.repeat(300), beforeText: '' }, 2)).toEqual([]);
    expect(candidates.add({ text: '丙'.repeat(250), beforeText: '' }, 3)).toEqual([]);
  });

  it('aggregates small new pastes within thirty seconds and expires old ones', () => {
    const candidates = new DocumentPasteCandidates();
    expect(candidates.add({ text: '甲'.repeat(200), beforeText: '' }, 0)).toEqual([]);
    expect(candidates.add({ text: '乙'.repeat(200), beforeText: '' }, 10_000)).toEqual([]);
    expect(candidates.add({ text: '丙'.repeat(200), beforeText: '' }, 29_999)[0]).toHaveLength(3);
    expect(candidates.add({ text: '丁'.repeat(200), beforeText: '' }, 30_000)).toEqual([]);
    expect(candidates.add({ text: '戊'.repeat(200), beforeText: '' }, 60_000)).toEqual([]);
    expect(candidates.add({ text: '己'.repeat(200), beforeText: '' }, 60_001)).toEqual([]);
  });

  it('ignores repeat copies and cut/paste inside the same document', () => {
    const candidates = new DocumentPasteCandidates();
    const text = '这是已经写好的内容。'.repeat(40);
    expect(candidates.add({ text, beforeText: `标题\n${text}` })).toEqual([]);
    expect(candidates.add({ text, beforeText: '', internalTransfer: true })).toEqual([]);
    expect(candidates.add({ text, beforeText: '' })).toHaveLength(1);
    expect(candidates.add({ text: text.slice(0, 350), beforeText: '' })).toEqual([]);
  });

  it('submits only new portions of overlapping pastes without previously seen answers', () => {
    const candidates = new DocumentPasteCandidates();
    const known = '已完成的自写文稿。'.repeat(40);
    expect(candidates.add({ text: known + '新'.repeat(100), beforeText: known }, 0)).toEqual([]);
    expect(candidates.add({ text: known + '新'.repeat(100) + '增'.repeat(100), beforeText: known }, 1)).toEqual([]);
    expect(candidates.add({ text: '另'.repeat(299), beforeText: '' }, 2)).toEqual([]);
    const batches = candidates.add({ text: '补'.repeat(101), beforeText: '' }, 3);
    expect(batches[0]).toHaveLength(4);
    expect(batches[0].map(fragment => fragment.text)).toEqual(['新'.repeat(100), '增'.repeat(100), '另'.repeat(299), '补'.repeat(101)]);
    expect(batches[0][0].beforeText).toBe(known);
  });

  it('removes existing and already checked core answers from a mixed paste before semantic analysis', () => {
    const candidates = new DocumentPasteCandidates();
    const oldCore = '已有核心答案'.repeat(100);
    const previousCore = '已经检查的方案'.repeat(60);
    const newBackground = '新增背景材料'.repeat(50);
    expect(candidates.add({ text: previousCore, beforeText: '' }, 0)[0][0].text).toBe(previousCore);
    const batches = candidates.add({ text: `${oldCore}\n${newBackground}\n${previousCore}`, beforeText: oldCore }, 1);
    expect(batches[0].map(fragment => fragment.text)).toEqual([newBackground]);
  });

  it('does not split or truncate oversized content into misleading fragments', () => {
    const candidates = new DocumentPasteCandidates();
    expect(candidates.add({ text: '甲'.repeat(CONTENT_MONITOR_MAX_TEXT + 1), beforeText: '' })).toEqual([]);
    expect(candidates.add({ text: '乙'.repeat(300), beforeText: '旧'.repeat(CONTENT_MONITOR_MAX_TEXT + 100) })[0][0].beforeText).toHaveLength(CONTENT_MONITOR_MAX_TEXT);
  });

  it('reads text and table boundaries while excluding scripts and style', () => {
    expect(documentHtmlText('<h2>题目</h2><p>内容 &amp; 依据</p><table><tr><td>甲</td><td>乙</td></tr></table><script>private()</script><style>body{}</style>')).toBe('题目\n内容 & 依据\n甲乙\n');
  });
});
