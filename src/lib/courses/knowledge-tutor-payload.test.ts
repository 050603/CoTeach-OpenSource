import { describe, expect, it } from 'vitest';
import { parseTutorPayload } from './knowledge-tutor-payload';

const now = '2026-10-16T00:00:00.000Z';
const answer = '保持相同观察时长，保留日期、地点和数量；结论仅限本次观察。';
const boardNotes = [
  { title: '公平比较', body: '保持相同观察时长。', kind: 'concept' },
  { title: '结论边界', body: '保留原始记录，结论仅限实际观察条件。', kind: 'evidence' },
];

describe('knowledge tutor structured answer parsing', () => {
  it('preserves an already valid answer without a repair diagnostic', () => {
    const parsed = parseTutorPayload(JSON.stringify({ answer, boardNotes }), now);
    expect(parsed.answer).toBe(answer);
    expect(parsed.notes.map(note => ({ title: note.title, body: note.body, kind: note.kind }))).toEqual(boardNotes);
    expect(parsed.syntaxRepair).toBeUndefined();
  });

  it('accepts a complete fenced JSON response without dropping trailing content', () => {
    expect(parseTutorPayload('```json\n' + JSON.stringify({ answer, boardNotes }) + '\n```', now).answer).toBe(answer);
    expect(() => parseTutorPayload(JSON.stringify({ answer }) + ',"boardNotes":[', now)).toThrow('TUTOR_INVALID_OUTPUT');
  });

  it('recovers only the observed extra root close while preserving the full answer and both notes', () => {
    const raw = `{"answer":${JSON.stringify(answer)}},"boardNotes":${JSON.stringify(boardNotes)}}`;
    const parsed = parseTutorPayload(raw, now);
    expect(parsed.answer).toBe(answer);
    expect(parsed.notes.map(note => ({ title: note.title, body: note.body, kind: note.kind }))).toEqual(boardNotes);
    expect(parsed.syntaxRepair).toBe('removed-extra-object-close-before-board-notes');
  });

  it('does not treat punctuation or escaped quotes inside an answer as structure', () => {
    const text = '例子包含 }、{"answer":"例子"} 和 \"boardNotes\"，这些都是正文。';
    const raw = `{"answer":${JSON.stringify(text)}},"boardNotes":[]}`;
    expect(parseTutorPayload(raw, now)).toMatchObject({ answer: text, notes: [], syntaxRepair: 'removed-extra-object-close-before-board-notes' });
    expect(parseTutorPayload(JSON.stringify({ answer: text, boardNotes: [] }), now).syntaxRepair).toBeUndefined();
  });

  it.each(['\n', ' ', ''])('joins exactly the two complete disjoint roots without changing their contents (%j)', separator => {
    const raw = JSON.stringify({ answer }) + separator + JSON.stringify({ boardNotes });
    const parsed = parseTutorPayload(raw, now);
    expect(parsed.answer).toBe(answer);
    expect(parsed.notes.map(note => ({ title: note.title, body: note.body, kind: note.kind }))).toEqual(boardNotes);
    expect(parsed.syntaxRepair).toBe('joined-complete-answer-and-board-notes-objects');
  });

  it('accepts the exact pair inside a complete fence and preserves punctuation inside string values', () => {
    const text = '完整正文：} {"boardNotes":[]} 与反斜线 \\、换行\n均保留。';
    const notes = [{ title: '含标点 } [ ]', body: '保留 {"answer":"内容"}', kind: 'evidence' }];
    const raw = '```json\n' + JSON.stringify({ answer: text }) + '\n' + JSON.stringify({ boardNotes: notes }) + '\n```';
    const parsed = parseTutorPayload(raw, now);
    expect(parsed.answer).toBe(text);
    expect(parsed.notes.map(note => ({ title: note.title, body: note.body, kind: note.kind }))).toEqual(notes);
  });

  it('inserts only the missing comma and key-opening quote after a complete answer', () => {
    const raw = `{"answer":${JSON.stringify(answer)}boardNotes":${JSON.stringify(boardNotes)}}`;
    const parsed = parseTutorPayload(raw, now);
    expect(parsed.answer).toBe(answer);
    expect(parsed.notes.map(note => ({ title: note.title, body: note.body, kind: note.kind }))).toEqual(boardNotes);
    expect(parsed.syntaxRepair).toBe('inserted-missing-board-notes-key-separator');
  });

  it('anchors the repair outside escaped answer text and keeps valid responses unchanged', () => {
    const text = '完整正文："boardNotes"、{"answer":"例子"}、反斜线 \\ 和换行\n均保留。';
    const raw = `{ "answer" : ${JSON.stringify(text)}  boardNotes" : [] }`;
    expect(parseTutorPayload(raw, now)).toMatchObject({ answer: text, notes: [], syntaxRepair: 'inserted-missing-board-notes-key-separator' });
    expect(parseTutorPayload(JSON.stringify({ answer: text, boardNotes: [] }), now)).toMatchObject({ answer: text, notes: [] });
    expect(parseTutorPayload(JSON.stringify({ answer: text, boardNotes: [] }), now).syntaxRepair).toBeUndefined();
  });

  it.each([
    '{"answer":"完整"boardNotes":[]} {}',
    '{"answer":"完整"boardNotes":[],"other":[]}',
    '{"answer":"完整"boardNotes":[],"boardNotes":[]}',
    '{"answer":"完整","answer":"重复"boardNotes":[]}',
    '{"answer":"正文中 "boardNotes" 不是字段"boardNotes":[]}',
    '{"answer":"完整"boardNotes":[{"title":"原文","t\\u0069tle":"重复","body":"正文","kind":"concept"}]}',
    '{"answer":"完整"boardNotes":null}',
    '{"answer":"完整"boardNotes":[{"title":"不完整"}',
    '{"answer":"未结束 boardNotes":[]}',
    '说明：{"answer":"完整"boardNotes":[]}',
    '{"answer":"完整"boardNotes":[]} 补充说明',
  ])('rejects ambiguous, duplicate, mixed or incomplete missing-separator output: %s', raw => {
    expect(() => parseTutorPayload(raw, now)).toThrow('TUTOR_INVALID_OUTPUT');
  });

  it.each([
    { notes: [null] },
    { notes: [{ title: '标题', body: '正文' }] },
    { notes: [{ title: '标题', body: '正文', kind: 'unknown' }] },
    { notes: [{ title: '标题', body: '正文', kind: 'concept', other: '不得丢弃' }] },
    { notes: [{ title: ' 标题 ', body: '正文', kind: 'concept' }] },
    { notes: [{ title: '标题', body: '正文'.repeat(251), kind: 'concept' }] },
    { notes: [...boardNotes, boardNotes[0]] },
  ])('does not repair notes that would lose or alter content: %j', ({ notes }) => {
    const raw = `{"answer":${JSON.stringify(answer)}boardNotes":${JSON.stringify(notes)}}`;
    expect(() => parseTutorPayload(raw, now)).toThrow('TUTOR_INVALID_OUTPUT');
  });

  it.each([
    '{"answer":"完整"} {"answer":"第二段"}',
    '{"answer":"完整"} {"boardNotes":[]} {"answer":"第三根"}',
    '{"answer":"完整"} {"boardNotes":[]} {}',
    '{"boardNotes":[]} {"answer":"完整"}',
    '{"answer":"完整","answer":"重复"} {"boardNotes":[]}',
    '{"answer":"完整","other":"不得忽略"} {"boardNotes":[]}',
    '{"answer":"完整"} {"boardNotes":[],"boardNotes":[]}',
    '{"answer":"完整"} {"boardNotes":[],"other":"不得忽略"}',
    '{"answer":"完整"} {"boardNotes":[],"other":[]}',
    '{"answer":"完整"} {"boardNotes":[],"other":{"array":[]}}',
    '{"answer":"完整"} {"boardNotes":[{"title":"原文","title":"重复","body":"正文"}]}',
    '{"answer":"完整"} {"boardNotes":[{"title":"原文","t\\u0069tle":"重复","body":"正文"}]}',
    '{"answer":"完整"} {"boardNotes":[{"title":"标题","body":"正文","meta":{"key":1,"key":2}}]}',
    '{"answer":"完整"} {"boardNotes":null}',
    '{"answer":[]} {"boardNotes":[]}',
    '{"answer":""} {"boardNotes":[]}',
    '{"answer":"完整"} {"boardNotes":[',
    '{"answer":"完整"} {"boardNotes":[{"title":"不完整"}',
    '说明：{"answer":"完整"} {"boardNotes":[]}',
    '{"answer":"完整"} {"boardNotes":[]} 补充说明',
    '{"answer":"完整"}, {"boardNotes":[]}',
  ])('keeps other multi-root, duplicate, incomplete or mixed output invalid: %s', raw => {
    expect(() => parseTutorPayload(raw, now)).toThrow('TUTOR_INVALID_OUTPUT');
  });

  it.each([
    '{"answer":"未结束',
    '{"answer":"完整"},"boardNotes":[',
    '{"answer":"完整"},"boardNotes":[{"title":"不完整"}',
    '{"answer":"完整"},"boardNotes":null}',
    '{"answer":[]},"boardNotes":[]}',
    '{"answer":""},"boardNotes":[]}',
    '{"answer":"完整"},"other":"不得忽略","boardNotes":[]}',
  ])('retains the technical failure for ambiguous, truncated or invalid content: %s', raw => {
    expect(() => parseTutorPayload(raw, now)).toThrow('TUTOR_INVALID_OUTPUT');
  });
});
