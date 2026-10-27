"use client";

import { useState } from 'react';
import { AiMemberMarkdown } from '@/components/views/student/ai-member-markdown';
import { collaborationEntries, type CollaborationRecord, type ReadableField } from '@/lib/platform/teacher-collaboration-records';
import styles from './teacher-classroom-review.module.css';

const EXPLANATIONS: Record<string, string> = {
  '文档讨论': '学生在文档工作区与 AI 的讨论，每次重新开始的对话分别保存。',
  '文档批注': '按批注对应的原文整理，查看问题说明、后续追问及处理状态。',
  '附件作品讨论': '学生围绕上传的附件作品与 AI 进行的讨论。',
  '附件作品批注': 'AI 对附件作品的批注及学生的后续追问。',
  '代码讨论': '学生与 AI 围绕程序设计、调试和代码修改进行的讨论。',
  '代码批注': '按文件和代码位置整理的批注、追问及处理状态。',
  '学习交流': '按课程阶段保存的学习对话。',
  'AI 建议与采纳': '区分 AI 提出的建议与学生实际作出的采纳决定；已作决定不等于已采纳。',
  '协作过程': '已保存的协作活动与检查摘要。',
  '项目要点': '协作中保存的项目目标、学生决定、尝试结果和待解决问题。',
  '教师求助': '学生或教师发起的求助及其处理状态。',
  '其他记录': '尚未归入以上分类的历史协作记录。',
};
function date(value?: string) {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
}
function Fields({ fields }: { fields: ReadableField[] }) {
  return fields.length ? <dl className={styles.collaborationFields}>{fields.map((item, index) => <div key={`${item.label}-${index}`}><dt>{item.label}</dt><dd>{item.code ? <pre>{item.content}</pre> : <AiMemberMarkdown content={item.content} />}</dd></div>)}</dl> : null;
}
export function TeacherProjectCollaboration({ data, stages, loading, refresh }: { data: CollaborationRecord; stages: Record<string, string>; loading: boolean; refresh: () => void }) {
  const [category, setCategory] = useState('');
  const [selection, setSelection] = useState('');
  const entries = collaborationEntries(data, stages);
  const categories = [...new Set(entries.map(entry => entry.category))];
  const selectedCategory = categories.includes(category) ? category : categories[0];
  const filtered = entries.filter(entry => entry.category === selectedCategory);
  const active = filtered.find(entry => entry.id === selection) ?? filtered[0];
  const limited = data.limits && (data.conversations.length >= data.limits.conversations || data.supportRecords.length >= data.limits.supportRecords || data.conversations.some(item => item.messages.length >= data.limits!.messagesPerConversation));
  return <>
    <div className={styles.sectionHeading}><p>按记录用途分类，选择后查看对话或过程详情。</p><button className={styles.button} type="button" disabled={loading} onClick={refresh}>刷新协作记录</button></div>
    {categories.length ? <>
      <nav className={styles.collaborationCategories} aria-label="项目协作记录分类">{categories.map(label => <button key={label} type="button" aria-pressed={selectedCategory === label} onClick={() => { setCategory(label); setSelection(''); }}>{label}<span>{entries.filter(entry => entry.category === label).length}</span></button>)}</nav>
      <p className={styles.note}>{EXPLANATIONS[selectedCategory]}</p>
      <label className={`${styles.field} ${styles.collaborationSelect}`}>选择记录（共 {filtered.length} 条）<select value={active?.id ?? ''} onChange={event => setSelection(event.target.value)}>{filtered.map((entry, index) => <option key={entry.id} value={entry.id}>{index + 1}. {entry.stage} · {entry.title.length > 50 ? `${entry.title.slice(0, 50)}…` : entry.title}{date(entry.createdAt) ? ` · ${date(entry.createdAt)}` : ''}</option>)}</select></label>
      {active ? <section className={styles.collaborationDetail} aria-label="协作记录详情" key={active.id}>
        <header className={styles.sectionHeading}><div><p className={styles.context}>{active.stage}</p><h3>{active.title}</h3></div>{active.status ? <span className={styles.status}>{active.status}</span> : null}</header>
        <p className={styles.note}>{[date(active.createdAt), active.notice, active.messages.length ? `${active.messages.length} 条消息 · 按保存顺序展示` : ''].filter(Boolean).join(' · ')}</p>
        <Fields fields={active.fields} />
        {active.messages.map(message => <article className={styles.collaborationMessage} data-speaker={message.role === '学生' ? 'student' : 'other'} key={message.id}>
          <header><h4>{message.role}</h4>{message.createdAt ? <time dateTime={message.createdAt}>{date(message.createdAt)}</time> : null}</header>
          {message.notice ? <p className={styles.note}>{message.notice}</p> : null}
          <AiMemberMarkdown content={message.content} />
          <Fields fields={message.fields} />
          {message.raw ? <details className={styles.collaborationRaw}><summary>查看未能解析的原记录</summary><pre>{message.raw}</pre></details> : null}
        </article>)}
        {!active.messages.length && !active.fields.length ? <p className={styles.note}>此条记录未保存可展示的正文。</p> : null}
      </section> : null}
    </> : <p className={styles.note}>没有保存项目讨论、批注或求助记录。</p>}
    {limited ? <p className={styles.note}>当前展示接口返回的最近记录，较早的内容可能未包含在内；完整数据可在学生档案中选择完整 ZIP 导出。</p> : null}
  </>;
}
