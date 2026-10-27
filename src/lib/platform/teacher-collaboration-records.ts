/** Read-only presentation of saved collaboration facts. Never changes source records. */
export type CollaborationMessage = { id: string; role: string; content: string; createdAt?: string; metadata?: unknown };
export type CollaborationConversation = { id: string; title?: string | null; metadata?: unknown; messages: CollaborationMessage[] };
export type CollaborationSupport = { id: string; type?: string; summary: string; status: string; structuredPayload?: unknown; createdAt?: string };
export type CollaborationRecord = { conversations: CollaborationConversation[]; supportRecords: CollaborationSupport[]; limits?: { conversations: number; messagesPerConversation: number; supportRecords: number } };
export type ReadableField = { label: string; content: string; code?: boolean };
export type ReadableMessage = { id: string; role: string; content: string; createdAt?: string; fields: ReadableField[]; notice?: string; raw?: string };
export type CollaborationEntry = { id: string; category: string; title: string; stage: string; createdAt?: string; fields: ReadableField[]; messages: ReadableMessage[]; status?: string; notice?: string };

export function collaborationObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (value: unknown) => typeof value === 'string' ? value : '';
const STATUS: Record<string, string> = { open: '待处理', resolved: '已处理', deferred: '暂缓处理', 'not-applicable': '不适用', invalidated: '原文已变更', adopted: '已采纳', modified: '修改后采纳', rejected: '未采纳', revision: '已要求修改', 'pending-decision': '待学生决定', decided: '已作决定', OPEN: '待处理', RESOLVED: '已处理', CLOSED: '已结束' };
const OPERATIONS: Record<string, string> = { create: '新建文件', modify: '修改文件', delete: '删除文件' };
const SEVERITIES: Record<string, string> = { critical: '关键问题', improvement: '改进建议', style: '表达建议', error: '错误', warning: '需注意', notice: '提示' };
const MEMORY: Record<string, string> = { 'project-goal': '项目目标', 'student-decision': '学生决定', 'attempt-result': '尝试与结果', 'open-question': '待解决问题' };
const STAGES: Record<string, string> = { launch: '项目启动', 'ai-learning': '知识讲授', proposal: '方案设计', make: '项目实践', showcase: '成果汇报', reflection: '评价反思', posttest: '后测' };
const field = (label: string, content: unknown, code = false): ReadableField[] => text(content).trim() ? [{ label, content: text(content), code }] : [];
const parse = (content: string) => { try { return collaborationObject(JSON.parse(content)); } catch { return {}; } };
function identity(conversation: CollaborationConversation, stages: Record<string, string>) {
  const meta = collaborationObject(conversation.metadata);
  const key = text(meta.legacyStageKey) || text(meta.stageKey) || conversation.title || '';
  const parts = key.split(':');
  const prefix = parts[0];
  const external = parts[1] === 'external-artifact';
  const stageKey = parts[prefix.startsWith('ai-code-') ? 1 : external ? 2 : parts.length > 1 ? 1 : 0];
  const stage = stages[stageKey] || STAGES[stageKey] || '项目学习';
  const labels: Record<string, string> = { 'ai-collaboration': external ? '附件作品讨论' : '文档讨论', 'ai-collaboration-comments': external ? '附件作品批注' : '文档批注', 'ai-code-collaboration': '代码讨论', 'ai-code-comments': '代码批注' };
  const category = labels[prefix] || '学习交流';
  const language = parts[2] === 'python' ? 'Python 语言' : parts[2] === 'c' ? 'C 语言' : '';
  // A saved human title remains intact; internal routing keys are never headings.
  const title = labels[prefix] || stages[key] || STAGES[key] || (key.includes(':') ? '项目讨论' : conversation.title) || '项目讨论';
  return { category, stage, title: language ? `${title}（${language}）` : title };
}

function readableMessage(message: CollaborationMessage): ReadableMessage {
  const meta = collaborationObject(message.metadata);
  const student = message.role === 'user' || message.role === 'student';
  const system = message.role === 'system';
  const result: ReadableMessage = { id: message.id, role: student ? '学生' : system ? '系统记录' : message.role === 'teacher' ? '教师' : 'AI 学习助手', content: message.content, createdAt: message.createdAt, fields: [] };
  if (meta.visibility === 'teacher-only') result.notice = '仅教师可见';
  if (meta.hiddenFromStudentAt) result.notice = '学生已从当前对话移除，历史记录保留';
  // Student text (including JSON and code) is evidence, not a response envelope.
  if (student || system) return result;
  const body = parse(message.content.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/, '$1'));
  const kinds = ['discussion', 'edit-suggestion', 'boundary', 'review', 'change-proposal', 'work-delivery', 'task-clarification'];
  if (kinds.includes(text(body.kind)) && text(body.message)) {
    result.content = text(body.message);
    const suggestion = collaborationObject(body.suggestion);
    const delivery = collaborationObject(body.deliverable);
    result.fields = [...field('修改原文', suggestion.targetText), ...field('建议改为', suggestion.replacement), ...field('修改理由', suggestion.reason), ...field('交付内容', delivery.content)];
    const changes = collaborationObject(body.changeSet);
    if (Array.isArray(changes.changes)) for (const edit of changes.changes) {
      const item = collaborationObject(edit);
      result.fields.push(...field('文件', item.filePath), ...field('操作', OPERATIONS[text(item.operation)]), ...field('建议代码', item.proposedContent, true), ...field('修改理由', item.reason));
    }
  }
  return result;
}

/** Group paragraph metadata, replies and lifecycle facts by their saved thread ID. */
export function collaborationEntries(data: CollaborationRecord, stages: Record<string, string>): CollaborationEntry[] {
  const entries: CollaborationEntry[] = [];
  for (const conversation of data.conversations) {
    const info = identity(conversation, stages);
    const turns = new Map<string, CollaborationEntry>();
    const get = (id: string): CollaborationEntry => {
      let entry = turns.get(id);
      if (!entry) { entry = { id: `${conversation.id}:${id}`, ...info, fields: [], messages: [] }; turns.set(id, entry); }
      return entry;
    };
    let checks = 0;
    for (const message of conversation.messages) {
      const meta = collaborationObject(message.metadata);
      const match = message.role === 'system' ? /^OPENPBL_(DOCUMENT|CODE)_COMMENT_(META|READ|STATUS|RESOLVED|SUGGESTION|REVIEW):([\s\S]*)$/.exec(message.content) : null;
      if (match) {
        const payload = parse(match[3]);
        if (!Object.keys(payload).length) {
          get('unparsed').messages.push({ ...readableMessage(message), content: '这条历史记录格式不完整，无法整理。', raw: message.content });
          continue;
        }
        if (match[2] === 'REVIEW') { checks++; continue; }
        const id = text(payload.id) || text(meta.conversationId) || message.id;
        const entry = get(id);
        if (match[2] === 'META') {
          entry.title = text(payload.title) || text(payload.issueKey) || text(payload.issueType) || info.title;
          entry.fields.push(...field('批注原文', payload.targetText), ...field('批注代码', payload.quotedCode, true), ...field('影响说明', payload.impact), ...field('依据原文', payload.evidenceQuote));
          if (text(payload.filePath)) entry.fields.push({ label: '代码位置', content: `${payload.filePath} · 第 ${payload.startLine}–${payload.endLine} 行` });
          const severity = SEVERITIES[text(payload.severity)];
          if (severity) entry.fields.push({ label: '问题程度', content: severity });
          entry.createdAt = text(payload.createdAt) || message.createdAt;
        } else if (match[2] === 'READ') entry.notice = '学生已读';
        else if (match[2] === 'RESOLVED') entry.status = '已处理';
        else if (match[2] === 'STATUS') entry.status = STATUS[text(payload.status)] || '处理状态未识别';
        else if (match[2] === 'SUGGESTION') entry.messages.push({ id: message.id, role: 'AI 修改建议', content: text(payload.title) || '文档修改建议', createdAt: message.createdAt, fields: [...field('修改原文', payload.targetText), ...field('建议改为', payload.replacement), ...field('修改理由', payload.reason)] });
        continue;
      }
      if (message.role === 'system' && meta.triggerKind === 'conversation-reset') continue;
      const id = text(meta.conversationId) || 'main';
      const entry = get(id);
      const readable = readableMessage(message);
      if (message.role === 'system' && /^OPENPBL_/.test(message.content)) {
        readable.content = '这条历史系统记录暂不支持整理。'; readable.raw = message.content;
      }
      if (readable.content.trim()) entry.messages.push(readable);
      entry.createdAt ||= message.createdAt;
    }
    const visible = [...turns.values()].filter(entry => entry.messages.length || entry.fields.length);
    visible.forEach((entry, index) => { if (entry.title === info.title) entry.title += ` · 对话 ${index + 1}`; });
    entries.push(...visible);
    if (checks) entries.push({ id: `${conversation.id}:checks`, category: '协作过程', title: '文档检查记录', stage: info.stage, fields: [{ label: '检查情况', content: `已保存 ${checks} 次段落检查记录。检查次数不代表发现问题数。` }], messages: [] });
  }
  const decisions = data.supportRecords.filter(item => item.type === 'STUDENTAIDECISIONS').map(item => ({ item, view: collaborationObject(collaborationObject(item.structuredPayload).view) }));
  for (const item of data.supportRecords) {
    if (item.type === 'PBL_PROCESS_REPORT') continue;
    const payload = collaborationObject(item.structuredPayload);
    const view = collaborationObject(payload.view);
    const stageKey = text(view.stageKey) || text(payload.stageKey);
    const base = { id: item.id, stage: stages[stageKey] || STAGES[stageKey] || '项目学习', createdAt: text(view.decidedAt) || text(view.createdAt) || item.createdAt, messages: [] };
    if (item.type === 'AICONTRIBUTIONS') {
      const decision = decisions.find(row => row.view.contributionId === view.id)?.view;
      entries.push({ ...base, category: 'AI 建议与采纳', title: 'AI 建议', status: STATUS[text(decision?.decision)] || STATUS[text(view.status)] || '决定状态未记录', fields: [...field('学生请求', view.request), ...field('AI 建议', view.suggestion), ...field('拟修改内容', view.proposedChange), ...field('学生决定理由', decision?.reason), ...field('实际改动说明', decision?.appliedChangeSummary)] });
    } else if (item.type === 'STUDENTAIDECISIONS') {
      if (data.supportRecords.some(row => row.type === 'AICONTRIBUTIONS' && collaborationObject(collaborationObject(row.structuredPayload).view).id === view.contributionId)) continue;
      entries.push({ ...base, category: 'AI 建议与采纳', title: '学生采纳决定', status: STATUS[text(view.decision)] || '决定状态未识别', fields: [...field('决定理由', view.reason), ...field('实际改动说明', view.appliedChangeSummary)] });
    } else if (item.type === 'PROJECT_MEMORY') {
      entries.push({ ...base, category: '项目要点', title: MEMORY[text(payload.kind)] || '项目要点', fields: [...field('记录内容', payload.content || item.summary), ...field('记录依据', payload.rationale)] });
    } else if (item.type === 'COMPANION_PROCESS') {
      entries.push({ ...base, category: '协作过程', title: text(payload.title) || '协作过程记录', fields: field('过程内容', item.summary) });
    } else if (!item.type || item.type === 'HELP_REQUEST') {
      entries.push({ ...base, category: '教师求助', title: '向教师求助', status: STATUS[item.status] || '处理状态未记录', fields: field('求助内容', item.summary) });
    } else {
      entries.push({ ...base, category: '其他记录', title: '其他协作记录', fields: field('记录内容', item.summary) });
    }
  }
  return entries;
}
