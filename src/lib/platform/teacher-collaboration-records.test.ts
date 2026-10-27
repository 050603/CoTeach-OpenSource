import { describe, expect, it } from 'vitest';
import { collaborationEntries, type CollaborationRecord, type CollaborationMessage } from './teacher-collaboration-records';
const saved = (content: string, role = 'assistant', metadata?: unknown): CollaborationMessage => ({ id: content, role, content, metadata, createdAt: '2026-10-20T03:00:00.000Z' });
const data = (messages: CollaborationMessage[], title = 'ai-collaboration:make'): CollaborationRecord => ({ conversations: [{ id: 'thread', title, metadata: { legacyStageKey: title }, messages }], supportRecords: [] });
const system = (type: string, body: object) => saved(`OPENPBL_DOCUMENT_COMMENT_${type}:${JSON.stringify(body)}`, 'system');

describe('teacher collaboration records', () => {
  it.each([
    ['ai-collaboration:make', '文档讨论'], ['ai-collaboration-comments:make', '文档批注'],
    ['ai-collaboration:external-artifact:make', '附件作品讨论'], ['ai-code-collaboration:make:python', '代码讨论'],
    ['ai-code-comments:make:c', '代码批注'], ['make', '学习交流'],
  ])('labels %s in Chinese using the configured course stage', (key, category) => {
    const [entry] = collaborationEntries(data([saved('原回复')], key), { make: '调查与设计' });
    expect(entry).toMatchObject({ category, stage: '调查与设计' });
    expect(entry.title).not.toContain('ai-');
  });
  it('preserves a human title and splits saved logical conversations', () => {
    const entries = collaborationEntries(data([saved('第一次', 'user', { conversationId: 'one' }), saved('第二次', 'user', { conversationId: 'two' })], '我的项目讨论'), {});
    expect(entries).toHaveLength(2);
    expect(entries[0].title).toContain('我的项目讨论');
    expect(entries.map(entry => entry.messages[0].content)).toEqual(['第一次', '第二次']);
  });
  it('joins late comment metadata, replies and saved lifecycle facts without exposing machine markers', () => {
    const rows = [saved('先核对测量条件', 'assistant', { conversationId: 'comment' }), system('META', { id: 'comment', targetText: '两次观察不同时间', issueType: '证据一致性', severity: 'critical', impact: '结果无法比较' }), system('READ', { id: 'comment' }), system('STATUS', { id: 'comment', status: 'deferred' }), system('REVIEW', { fingerprint: 'private-key' })];
    const entries = collaborationEntries(data(rows, 'ai-collaboration-comments:make'), {});
    expect(entries[0]).toMatchObject({ title: '证据一致性', status: '暂缓处理', notice: '学生已读' });
    expect(entries[0].fields).toContainEqual({ label: '批注原文', content: '两次观察不同时间', code: false });
    expect(entries[0].messages.map(row => row.content)).toEqual(['先核对测量条件']);
    expect(entries[1]).toMatchObject({ category: '协作过程', title: '文档检查记录' });
    expect(JSON.stringify(entries)).not.toContain('private-key');
  });
  it('shows the original and proposed wording in a saved suggestion', () => {
    const [entry] = collaborationEntries(data([system('SUGGESTION', { title: '统一时间', targetText: '下午', replacement: '上午', reason: '保持相同条件' })]), {});
    expect(entry.messages[0]).toMatchObject({ role: 'AI 修改建议', content: '统一时间' });
    expect(entry.messages[0].fields.map(row => row.content)).toEqual(['下午', '上午', '保持相同条件']);
  });
  it('renders a saved JSON answer and code proposal but never parses student text as a system message', () => {
    const body = JSON.stringify({ kind: 'change-proposal', message: '补上输出', changeSet: { changes: [{ filePath: 'main.py', operation: 'modify', proposedContent: 'print(1)', reason: '显示结果' }] } });
    const [entry] = collaborationEntries(data([saved(body), saved(body, 'user')], 'ai-code-collaboration:make:python'), {});
    expect(entry.messages[0].content).toBe('补上输出');
    expect(entry.messages[0].fields).toContainEqual({ label: '建议代码', content: 'print(1)', code: true });
    expect(entry.messages[1].content).toBe(body);
  });
  it('retains malformed system records behind a readable fallback', () => {
    const [entry] = collaborationEntries(data([saved('OPENPBL_DOCUMENT_COMMENT_META:{bad', 'system')]), {});
    expect(entry.messages[0].content).toContain('无法整理');
    expect(entry.messages[0].raw).toBe('OPENPBL_DOCUMENT_COMMENT_META:{bad');
  });
  it('separates contributions, student decisions, process, memory and actual help', () => {
    const record: CollaborationRecord = { conversations: [], supportRecords: [
      { id: 'c', type: 'AICONTRIBUTIONS', summary: '', status: 'decided', structuredPayload: { view: { id: 'contribution', status: 'decided', request: '检查条件', suggestion: '统一时间', stageKey: 'make' } } },
      { id: 'd', type: 'STUDENTAIDECISIONS', summary: '', status: 'OPEN', structuredPayload: { view: { contributionId: 'contribution', decision: 'rejected', reason: '保留原方案' } } },
      { id: 'p', type: 'COMPANION_PROCESS', summary: '已检查文稿', status: 'OPEN', structuredPayload: { title: 'AI 组员参与文档协作' } },
      { id: 'm', type: 'PROJECT_MEMORY', summary: '需要核对时间', status: 'OPEN', structuredPayload: { kind: 'open-question' } },
      { id: 'h', type: 'HELP_REQUEST', summary: '请教师检查', status: 'RESOLVED' },
      { id: 'r', type: 'PBL_PROCESS_REPORT', summary: '单独评价页面展示', status: 'READY' },
    ] };
    const entries = collaborationEntries(record, {});
    expect(entries.map(row => row.category)).toEqual(['AI 建议与采纳', '协作过程', '项目要点', '教师求助']);
    expect(entries[0].status).toBe('未采纳');
    expect(entries[2].title).toBe('待解决问题');
    expect(entries[3].status).toBe('已处理');
    expect(JSON.stringify(entries)).not.toContain('单独评价页面展示');
    expect(record.supportRecords[0].status).toBe('decided');
  });
  it('does not infer adoption from a decided contribution without the saved decision', () => {
    const [entry] = collaborationEntries({ conversations: [], supportRecords: [{ id: 'c', type: 'AICONTRIBUTIONS', summary: '', status: 'decided', structuredPayload: { view: { status: 'decided' } } }] }, {});
    expect(entry.status).toBe('已作决定');
  });
});
