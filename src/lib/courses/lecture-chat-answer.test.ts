import { describe, expect, it } from 'vitest';
import { createLectureChatTextFilter, lectureChatAnswer } from './lecture-chat-answer';

const source = { id: 'source-1234abcdef', textbookTitle: '科学观察教材', revisionId: 'revision-1',
  sectionPath: ['公平比较'], quote: '比较时应保持相同的观察时长。' };

describe('lecture chat Chinese citation markers', () => {
  it('retains both actual numbered sources for lowercase provider markers', () => {
    const second = { ...source, id: 'source-abcdef1234', quote: '观察条件也需要保持一致。' };
    expect(lectureChatAnswer('保持相同时长[s1]。同时记录观察条件[s2]。', [source, second]))
      .toEqual({ content: '保持相同时长。同时记录观察条件。', citations: [source, second], unknownReferences: false });
  });

  it('deduplicates lowercase, uppercase and fullwidth-digit markers without changing source identity', () => {
    expect(lectureChatAnswer('甲[s1]乙[S1]丙［s１］丁[source-1234abcdef]', [source]))
      .toEqual({ content: '甲乙丙丁', citations: [source], unknownReferences: false });
  });

  it('never invents a source for an unavailable lowercase marker', () => {
    expect(lectureChatAnswer('甲[s2]乙[source-deadbeef]丙[s1]', [source]))
      .toEqual({ content: '甲乙丙', citations: [source], unknownReferences: true });
    expect(lectureChatAnswer('一般解释[s1]', []))
      .toEqual({ content: '一般解释', citations: [], unknownReferences: true });
  });

  it('filters lowercase markers split across transport chunks with the same final text', () => {
    const filter = createLectureChatTextFilter();
    const chunks = ['保持时长[', 's', '1', ']；记录条件［', 's', '２', '］。'];
    const pieces = chunks.map(chunk => filter.push(chunk));
    expect(pieces).toEqual(['保持时长', '', '', '；记录条件', '', '', '。']);
    expect(pieces.join('') + filter.flush()).toBe(lectureChatAnswer(chunks.join(''), [source]).content);
  });

  it('retains real sources when the provider uses fullwidth punctuation or digits', () => {
    expect(lectureChatAnswer('应保持相同时长［S1］。保留记录［S１］。', [source]))
      .toEqual({ content: '应保持相同时长。保留记录。', citations: [source], unknownReferences: false });
  });

  it('removes unverified fullwidth source markers without creating a citation', () => {
    expect(lectureChatAnswer('无法验证的出处［S２］。', [source]))
      .toEqual({ content: '无法验证的出处。', citations: [], unknownReferences: true });
  });

  it('buffers a fullwidth citation split across transport chunks', () => {
    const filter = createLectureChatTextFilter();
    expect(filter.push('保持相同时长［')).toBe('保持相同时长');
    expect(filter.push('S')).toBe('');
    expect(filter.push('１')).toBe('');
    expect(filter.push('］，再比较数量。')).toBe('，再比较数量。');
    expect(filter.flush()).toBe('');
  });

  it('preserves ordinary Chinese brackets and the rest of the answer verbatim', () => {
    const filter = createLectureChatTextFilter();
    const text = '［观察记录］中的数量是 ３，不应改写正文。';
    expect(filter.push(text) + filter.flush()).toBe(text);
    expect(lectureChatAnswer(text, [source]).content).toBe(text);
  });
});
