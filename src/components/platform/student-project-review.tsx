'use client';

import { useState, type CSSProperties } from 'react';
import { Download, FileText } from 'lucide-react';
import { RichDocumentPreview } from '@/components/teacher/rich-document-preview';
import { ShowcaseArtifactViewer } from '@/components/showcase/showcase-artifact-viewer';
import type { ClassroomSubmission, Course, FinalArtifactSummary } from '@/lib/session/types';

const projectStages = new Set(['proposal', 'make']);
const projectTypes = new Set(['document', 'code', 'artifact-brief']);
const control = 'min-h-11 rounded-lg border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2 text-sm text-[var(--pbl-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-student)]';
const download = `${control} inline-flex items-center justify-center gap-2 font-semibold text-[var(--pbl-student)]`;

type Attachment = { name: string; url: string };
type ProjectRecord = { submission: ClassroomSubmission; hasBody: boolean; attachments: Attachment[] };
type ArchiveRecord = FinalArtifactSummary & { selectionId: string };

function hasDocumentContent(html: string) {
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  return /<img\b[^>]*\bsrc\s*=\s*["']?[^\s"'>]+/i.test(body)
    || Boolean(body.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#x0*a0;/gi, ' ').replace(/[\s\u200b\ufeff]/g, ''));
}

function attachmentsFor(submission: ClassroomSubmission): Attachment[] {
  return (submission.files ?? []).flatMap(file => {
    const match = /^\/api\/uploads\/([A-Za-z0-9_-]+)(?:\?[^#]*)?(?:#.*)?$/.exec(file.url ?? '');
    return match ? [{ name: file.name || '课堂附件', url: `/api/uploads/${encodeURIComponent(match[1])}?download=1` }] : [];
  });
}

function recordsFor(course: Course, studentId: string): ProjectRecord[] {
  if (!studentId) return [];
  return (course.submissions ?? []).filter(submission => submission.courseId === course.id
    && submission.studentId === studentId && projectStages.has(submission.stageKey) && projectTypes.has(submission.type))
    .map(submission => ({ submission, attachments: attachmentsFor(submission),
      hasBody: typeof submission.content === 'string' && (submission.type === 'code' ? Boolean(submission.content.trim()) : hasDocumentContent(submission.content)) }))
    .filter(record => record.hasBody || record.attachments.length > 0)
    .sort((left, right) => right.submission.updatedAt.localeCompare(left.submission.updatedAt));
}

function archivesFor(course: Course, studentId: string): ArchiveRecord[] {
  if (!studentId) return [];
  const documents: ArchiveRecord[] = (course.projectDocumentVersions ?? []).filter(version => version.courseId === course.id
    && version.studentId === studentId && version.status === 'submitted' && projectStages.has(version.stageKey))
    .map<ArchiveRecord>(version => ({ selectionId: `document:${version.id}`, kind: 'document', versionId: version.id,
      title: version.title, sequence: version.sequence, submittedAt: version.submittedAt ?? version.createdAt,
      displayModes: ['continuous'], size: version.docxSize,
      downloadUrl: version.docxUploadId ? `/api/uploads/${encodeURIComponent(version.docxUploadId)}?download=1` : undefined }));
  const files: ArchiveRecord[] = (course.projectPdfVersions ?? []).filter(version => version.courseId === course.id
    && version.studentId === studentId && version.status === 'submitted' && projectStages.has(version.stageKey))
    .map<ArchiveRecord>(version => ({ selectionId: `file:${version.id}`, kind: version.kind === 'file' ? 'file' : 'pdf', versionId: version.id,
      title: version.title, sequence: version.sequence, submittedAt: version.submittedAt,
      displayModes: version.kind === 'file' ? [] : ['continuous', 'slides'], mimeType: version.mimeType, size: version.size,
      downloadUrl: `/api/courses/${encodeURIComponent(course.id)}/showcase/artifacts/${encodeURIComponent(version.id)}?download=1` }));
  return [...documents, ...files].sort((left, right) => right.submittedAt.localeCompare(left.submittedAt) || right.sequence - left.sequence);
}

/** Only owned classroom content or submitted archives make this tab available. */
export function hasStudentProjectRecords(course: Course, studentId: string): boolean {
  return recordsFor(course, studentId).length > 0 || archivesFor(course, studentId).length > 0;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(date);
}

function recordStatus(submission: ClassroomSubmission) {
  return submission.status === 'submitted' ? '提交记录' : submission.status === 'failed' ? '课堂草稿 · 提交未完成' : '课堂草稿';
}

function archiveLabel(archive: ArchiveRecord) {
  return archive.kind === 'document' ? '项目文档' : archive.kind === 'pdf' ? 'PDF 成果' : '课堂附件';
}

export function StudentProjectReview({ course, studentId, role = 'student' }: { course: Course; studentId: string; role?: 'student' | 'teacher' }) {
  const records = recordsFor(course, studentId);
  const archives = archivesFor(course, studentId);
  return <ProjectReviewContent archives={archives} courseId={course.id} key={`${course.id}:${studentId}`} records={records} role={role} />;
}

function ProjectReviewContent({ records, archives, courseId, role }: { records: ProjectRecord[]; archives: ArchiveRecord[]; courseId: string; role: 'student' | 'teacher' }) {
  const [recordId, setRecordId] = useState<string>();
  const [archiveId, setArchiveId] = useState<string>();
  const record = records.find(item => item.submission.id === recordId) ?? records[0];
  const archive = archives.find(item => item.selectionId === archiveId) ?? archives[0];
  if (!record && !archive) return <p className="py-6 text-sm text-[var(--pbl-text-muted)]">本次课堂没有保存项目记录。</p>;

  return <div className="min-w-0 space-y-8" aria-label="项目回顾" style={role === 'teacher' ? { '--pbl-student': 'var(--pbl-teacher)', '--pbl-student-soft': 'var(--pbl-teacher-soft)', '--pbl-student-border': 'var(--pbl-border)' } as CSSProperties : undefined}>
    {record ? <section aria-label="课堂项目记录" className="min-w-0 space-y-4">
      <header className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div><h2 className="text-lg font-bold text-[var(--pbl-text)]">课堂文档</h2><p className="mt-1 text-sm leading-6 text-[var(--pbl-text-muted)]">回顾课堂中保存的方案、文档与代码。</p></div>
        {records.length > 1 ? <label className="flex min-w-0 max-w-full flex-col gap-1.5 text-xs font-semibold text-[var(--pbl-text-muted)]">课堂文档记录
          <select aria-label="课堂文档记录" className={`${control} max-w-full sm:max-w-96`} onChange={event => setRecordId(event.target.value)} value={record.submission.id}>
            {records.map(item => <option key={item.submission.id} value={item.submission.id}>{item.submission.title || '项目记录'} · {recordStatus(item.submission)} · {dateLabel(item.submission.updatedAt)}</option>)}
          </select>
        </label> : null}
      </header>
      <article className="min-w-0 rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-4 sm:p-6">
        <header className="mb-5 flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-[var(--pbl-border)] pb-4">
          <div className="min-w-0"><h3 className="break-words font-semibold text-[var(--pbl-text)]">{record.submission.title || (record.submission.type === 'code' ? '课堂代码' : '项目文档')}</h3>
            <p className="mt-1 text-xs leading-6 text-[var(--pbl-text-muted)]">{record.submission.stageKey === 'proposal' ? '方案探究' : '项目实践'}{dateLabel(record.submission.updatedAt) ? ` · ${dateLabel(record.submission.updatedAt)}` : ''}</p></div>
          <span className="rounded-full bg-[var(--pbl-student-soft)] px-3 py-1 text-xs font-semibold text-[var(--pbl-student)]">{recordStatus(record.submission)}</span>
        </header>
        {record.hasBody ? record.submission.type === 'code'
          ? <pre aria-label="课堂代码" className="max-h-[60dvh] overflow-auto rounded-lg bg-[var(--pbl-bg)] p-4 text-sm leading-7 text-[var(--pbl-text)]"><code>{record.submission.content}</code></pre>
          : <div className="min-w-0 overflow-x-auto [overflow-wrap:anywhere]"><RichDocumentPreview html={record.submission.content} key={record.submission.id} /></div> : null}
        {record.attachments.length ? <ul aria-label="课堂文档附件" className="mt-5 space-y-2 border-t border-[var(--pbl-border)] pt-4">
          {record.attachments.map((file, index) => <li className="flex min-w-0 flex-wrap items-center justify-between gap-2" key={`${file.url}:${index}`}>
            <span className="min-w-0 break-all text-sm text-[var(--pbl-text)]">{file.name}</span>
            <a aria-label={`下载附件：${file.name}`} className={download} download href={file.url}><Download aria-hidden size={15} />下载附件</a>
          </li>)}
        </ul> : null}
      </article>
    </section> : null}

    {archive ? <section aria-label="已提交项目成果" className="min-w-0 space-y-4">
      <header className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div><h2 className="text-lg font-bold text-[var(--pbl-text)]">已提交成果</h2><p className="mt-1 text-sm leading-6 text-[var(--pbl-text-muted)]">查看当时提交的版本与附件。</p></div>
        <label className="flex min-w-0 max-w-full flex-col gap-1.5 text-xs font-semibold text-[var(--pbl-text-muted)]">已提交成果版本
          <select aria-label="已提交成果版本" className={`${control} max-w-full sm:max-w-96`} onChange={event => setArchiveId(event.target.value)} value={archive.selectionId}>
            {archives.map(item => <option key={item.selectionId} value={item.selectionId}>{item.title || archiveLabel(item)} · 第 {item.sequence} 版 · {dateLabel(item.submittedAt)}</option>)}
          </select>
        </label>
      </header>
      <div className="min-w-0 overflow-hidden rounded-xl border border-[var(--pbl-border)] bg-[var(--pbl-surface)]">
        <header className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--pbl-border)] p-4">
          <div className="min-w-0"><h3 className="break-words font-semibold text-[var(--pbl-text)]">{archive.title || archiveLabel(archive)}</h3>
            <p className="mt-1 text-xs leading-6 text-[var(--pbl-text-muted)]">{archiveLabel(archive)} · 第 {archive.sequence} 版{dateLabel(archive.submittedAt) ? ` · ${dateLabel(archive.submittedAt)}` : ''}</p></div>
          {archive.downloadUrl ? <a className={download} download href={archive.downloadUrl}><Download aria-hidden size={15} />{archive.kind === 'document' ? '下载 Word' : archive.kind === 'pdf' ? '下载 PDF' : '下载附件'}</a> : null}
        </header>
        {archive.kind === 'file' ? <div className="flex items-start gap-3 p-5 sm:p-6"><FileText aria-hidden className="shrink-0 text-[var(--pbl-student)]" size={22} /><p className="min-w-0 break-words text-sm leading-7 text-[var(--pbl-text-muted)]">{archive.title || '课堂附件'}已提交，可下载查看原文件。</p></div>
          : <div className="h-[min(65dvh,48rem)] min-h-72"><ShowcaseArtifactViewer artifact={archive} courseId={courseId} displayMode="continuous" key={archive.selectionId} mode={role === 'teacher' ? 'teacher' : 'self'} teacherFollowing={false} /></div>}
      </div>
    </section> : null}
  </div>;
}
