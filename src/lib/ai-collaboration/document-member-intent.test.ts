import { expect, it } from 'vitest';
import { inferDocumentMemberIntent } from './document-member-intent';

it.each(['这份资料是否可靠？', '你怎么看这些来源？', '怎么整理已有的记录？', '怎样写结论？', '列出比较维度可以吗？', '帮我列出方案比较维度', '帮我解释调查方法'])('keeps questions out of delegation: %s', request => {
  expect(['discuss', 'check']).toContain(inferDocumentMemberIntent(request));
});
it.each(['把我提供的观察记录排成附录表格，缺失项留空', '统一报告末尾这三条参考文献的格式', '按已确定的问题制作空白记录表', '只修正错别字，不改变观点', '替我写最终结论', '你帮我做点辅助工作', '请修改这份交付：记录表。需要调整的地方：只保留原有列', '能不能帮我整理这些原始记录', '是否可以替我们统一参考文献', '把“支池”改为“支持”，其他内容不动'])('routes an explicit task to boundary assessment: %s', request => {
  expect(inferDocumentMemberIntent(request)).toBe('delegate');
});
it('preserves checks and summaries without creating document changes', () => {
  expect(inferDocumentMemberIntent('检查我的结论有没有夸大范围')).toBe('check');
  expect(inferDocumentMemberIntent('总结目前完成和未完成的工作')).toBe('summarize');
  expect(inferDocumentMemberIntent('只修正这段错别字', '原段落')).toBe('edit');
});
it.each([
  '替我修正错别字，其他内容逐字保留，请交付可审阅的段落替换',
  '请统一三条参考文献，完成后我会审阅',
  '把观察记录排成表格，留给我检查后再应用',
])('keeps explicit work in delegation when review is ancillary: %s', request => {
  expect(inferDocumentMemberIntent(request)).toBe('delegate');
});
it.each(['请检查哪些地方需要修正', '帮我检查哪些地方需要修正', '只检查逻辑，不修改文档', '怎样修正这段内容才能通过审阅？'])('does not turn review or method questions into edit permission: %s', request => {
  expect(['check', 'discuss']).toContain(inferDocumentMemberIntent(request));
});
it.each(['帮我看看文档还有什么地方可以修改', '看看这篇文章有哪些问题', '哪些地方需要完善？'])('treats feedback requests as checks: %s', request => {
  expect(inferDocumentMemberIntent(request)).toBe('check');
});
it.each(['我想做一个好滴项目', '我们准备做一个校园调查项目', '我希望写一份好报告'])('treats a student goal as discussion: %s', request => {
  expect(inferDocumentMemberIntent(request)).toBe('discuss');
});
