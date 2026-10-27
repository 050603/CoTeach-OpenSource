import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassroomSubmission, Course, ProjectDocumentVersion, ProjectPdfVersion } from '@/lib/session/types';
import { StudentProjectReview, hasStudentProjectRecords } from './student-project-review';

const viewer = vi.hoisted(() => vi.fn());
vi.mock('@/components/showcase/showcase-artifact-viewer', () => ({
  ShowcaseArtifactViewer: (props: { artifact: { versionId: string; title: string }; mode: string }) => {
    viewer(props);
    return <div data-testid="archive-preview">归档预览：{props.artifact.title}</div>;
  },
}));

const at = '2026-10-20T00:00:00.000Z';
function submission(patch: Partial<ClassroomSubmission> = {}): ClassroomSubmission {
  return { id: 'draft', courseId: 'course', studentId: 'student', stageKey: 'make', type: 'document', title: '调查方案',
    content: '<h2>课堂原稿</h2><p>统一观察时长，并记录数量。</p>', status: 'draft', createdAt: at, updatedAt: at, ...patch };
}
function documentVersion(patch: Partial<ProjectDocumentVersion> = {}): ProjectDocumentVersion {
  return { id: 'document-v1', courseId: 'course', studentId: 'student', submissionId: 'draft', stageKey: 'make', sequence: 1,
    sourceVersion: 3, title: '正式调查文档', sourceHtml: '<p>归档的原始 HTML 不应作为源码展示。</p>', docxUploadId: 'docx-upload',
    status: 'submitted', submittedAt: at, createdAt: at, ...patch };
}
function fileVersion(patch: Partial<ProjectPdfVersion> = {}): ProjectPdfVersion {
  return { id: 'file-v1', courseId: 'course', studentId: 'student', stageKey: 'make', sequence: 1, title: '观察数据.csv',
    uploadId: 'csv-upload', kind: 'file', mimeType: 'text/csv', status: 'submitted', submittedAt: at, createdAt: at, ...patch };
}
function course(patch: Partial<Course> = {}): Course {
  return { id: 'course', status: 'finished', submissions: [], projectDocumentVersions: [], projectPdfVersions: [], ...patch } as Course;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('student project review', () => {
  it('lets teachers read saved drafts and browse submitted versions without controlling the classroom presentation', () => {
    render(<StudentProjectReview course={course({ submissions: [submission()], projectDocumentVersions: [documentVersion()] })} studentId="student" role="teacher" />);
    expect(screen.getByText('课堂草稿')).toBeVisible();
    expect(screen.getByRole('heading', { name: '课堂原稿' })).toBeVisible();
    expect(viewer.mock.lastCall?.[0]).toMatchObject({ mode: 'teacher', teacherFollowing: false, artifact: { versionId: 'document-v1' } });
    expect(viewer.mock.lastCall?.[0]).not.toHaveProperty('onViewStateChange');
    expect(screen.getByRole('link', { name: '下载 Word' })).toHaveAttribute('href', '/api/uploads/docx-upload?download=1');
  });
  it('does not invent project records from legacy workspace-like fields or empty document markup', () => {
    const value = course({ submissions: [submission({ content: '<p><br /></p><p>&nbsp; &#160; \u200b</p>' })] });
    Object.assign(value, { workspace: { document: '旧工作区', code: '旧代码' } });
    expect(hasStudentProjectRecords(value, 'student')).toBe(false);
    expect(hasStudentProjectRecords(course({ submissions: [submission()] }), '')).toBe(false);
    render(<StudentProjectReview course={value} studentId="student" />);
    expect(screen.getByText('本次课堂没有保存项目记录。')).toBeVisible();
    expect(screen.queryByText('旧工作区')).not.toBeInTheDocument();
    expect(viewer).not.toHaveBeenCalled();
  });

  it('renders the saved draft as a read-only document, with no editing or submission controls', () => {
    const value = course({ submissions: [submission()] });
    const before = JSON.stringify(value);
    expect(hasStudentProjectRecords(value, 'student')).toBe(true);
    const view = render(<StudentProjectReview course={value} studentId="student" />);
    expect(screen.getByText('课堂草稿')).toBeVisible();
    expect(screen.getByRole('heading', { name: '课堂原稿' })).toBeVisible();
    expect(screen.getByText('统一观察时长，并记录数量。')).toBeVisible();
    expect(view.container.querySelector('[data-document-preview]')).toBeTruthy();
    expect(view.container.querySelector('pre')).toBeNull();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /保存|编辑|上传|提交/ })).not.toBeInTheDocument();
    expect(JSON.stringify(value)).toBe(before);
  });

  it('selects classroom records independently and distinguishes submitted work, code and an unfinished submission', () => {
    render(<StudentProjectReview studentId="student" course={course({ submissions: [submission(),
      submission({ id: 'submitted', stageKey: 'proposal', title: '已提交方案', status: 'submitted', content: '<p>原始方案正文</p>' }),
      submission({ id: 'code', type: 'code', title: '观察代码', content: 'print("原始代码")', status: 'failed' })] })} />);
    fireEvent.change(screen.getByRole('combobox', { name: '课堂文档记录' }), { target: { value: 'submitted' } });
    expect(screen.getByText('提交记录', { exact: true })).toBeVisible();
    expect(screen.getByText('原始方案正文')).toBeVisible();
    fireEvent.change(screen.getByRole('combobox', { name: '课堂文档记录' }), { target: { value: 'code' } });
    expect(screen.getByText('课堂草稿 · 提交未完成', { exact: true })).toBeVisible();
    expect(screen.getByLabelText('课堂代码')).toHaveTextContent('print("原始代码")');
    expect(screen.queryByText('原始方案正文')).not.toBeInTheDocument();
  });

  it('filters other students, mismatched courses, unrelated stages and unfinished archive versions', () => {
    const value = course({ submissions: [submission({ studentId: 'other', title: '私密记录' }),
      submission({ courseId: 'other-course' }), submission({ stageKey: 'ai-learning' }), submission({ type: 'reflection' })],
      projectDocumentVersions: [documentVersion({ studentId: 'other' }), documentVersion({ courseId: 'other-course' }),
        documentVersion({ status: 'processing' }), documentVersion({ status: 'failed' }), documentVersion({ stageKey: 'launch' })],
      projectPdfVersions: [fileVersion({ studentId: 'other' }), fileVersion({ courseId: 'other-course' }), fileVersion({ status: 'failed' })] });
    expect(hasStudentProjectRecords(value, 'student')).toBe(false);
    render(<StudentProjectReview course={value} studentId="student" />);
    expect(screen.queryByText('私密记录')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(viewer).not.toHaveBeenCalled();
  });

  it('previews only the selected submitted document or PDF and exposes the authorized download URLs', () => {
    const value = course({ projectDocumentVersions: [documentVersion({ id: 'older', sequence: 1, submittedAt: '2026-10-19T00:00:00.000Z' }),
      documentVersion({ id: 'newer', sequence: 2, title: '第二版调查文档', docxUploadId: 'second-upload' })],
      projectPdfVersions: [fileVersion({ id: 'pdf-version', kind: 'pdf', title: '观察记录.pdf', mimeType: 'application/pdf', submittedAt: '2026-10-18T00:00:00.000Z' })] });
    const before = JSON.stringify(value);
    render(<StudentProjectReview course={value} studentId="student" />);
    expect(screen.getByTestId('archive-preview')).toHaveTextContent('第二版调查文档');
    expect(screen.getByRole('link', { name: '下载 Word' })).toHaveAttribute('href', '/api/uploads/second-upload?download=1');
    expect(viewer.mock.lastCall?.[0]).toMatchObject({ mode: 'self', courseId: 'course', displayMode: 'continuous', artifact: { versionId: 'newer' } });
    expect(viewer.mock.lastCall?.[0]).not.toHaveProperty('onViewStateChange');
    expect(viewer.mock.lastCall?.[0]).not.toHaveProperty('presentation');
    fireEvent.change(screen.getByRole('combobox', { name: '已提交成果版本' }), { target: { value: 'document:older' } });
    expect(viewer.mock.lastCall?.[0].artifact.versionId).toBe('older');
    fireEvent.change(screen.getByRole('combobox', { name: '已提交成果版本' }), { target: { value: 'file:pdf-version' } });
    expect(viewer.mock.lastCall?.[0].artifact).toMatchObject({ kind: 'pdf', versionId: 'pdf-version' });
    expect(screen.getByRole('link', { name: '下载 PDF' })).toHaveAttribute('href', '/api/courses/course/showcase/artifacts/pdf-version?download=1');
    expect(screen.queryByText(/归档的原始 HTML/)).not.toBeInTheDocument();
    expect(JSON.stringify(value)).toBe(before);
  });

  it('shows submitted files even without a document, with downloads and no attempted document/PDF preview', () => {
    const value = course({ projectPdfVersions: [fileVersion()] });
    expect(hasStudentProjectRecords(value, 'student')).toBe(true);
    render(<StudentProjectReview course={value} studentId="student" />);
    expect(screen.getByRole('heading', { name: '观察数据.csv' })).toBeVisible();
    expect(screen.getByRole('link', { name: '下载附件' })).toHaveAttribute('href', '/api/courses/course/showcase/artifacts/file-v1?download=1');
    expect(screen.queryByRole('region', { name: '课堂项目记录' })).not.toBeInTheDocument();
    expect(viewer).not.toHaveBeenCalled();
  });

  it('keeps classroom draft selection separate from immutable submitted-version selection', () => {
    render(<StudentProjectReview studentId="student" course={course({ submissions: [submission(),
      submission({ id: 'earlier-plan', title: '早期方案', stageKey: 'proposal', content: '<p>较早的课堂方案正文。</p>' })],
      projectDocumentVersions: [documentVersion()], projectPdfVersions: [fileVersion()] })} />);
    fireEvent.change(screen.getByRole('combobox', { name: '课堂文档记录' }), { target: { value: 'earlier-plan' } });
    expect(screen.getByText('较早的课堂方案正文。')).toBeVisible();
    expect(screen.getByRole('combobox', { name: '已提交成果版本' })).toHaveValue('document:document-v1');
    fireEvent.change(screen.getByRole('combobox', { name: '已提交成果版本' }), { target: { value: 'file:file-v1' } });
    expect(screen.getByRole('combobox', { name: '课堂文档记录' })).toHaveValue('earlier-plan');
    expect(screen.getByText('较早的课堂方案正文。')).toBeVisible();
    expect(screen.queryByTestId('archive-preview')).not.toBeInTheDocument();
  });

  it('keeps meaningful image documents and attached files while rejecting arbitrary attachment links', () => {
    const value = course({ submissions: [submission({ content: '<p></p>', files: [
      { name: '调查数据.csv', type: 'text/csv', url: '/api/uploads/owned-file?variant=classroom' },
      { name: '不可信链接', type: 'text/plain', url: 'javascript:alert(1)' },
      { name: '外部文件', type: 'text/plain', url: 'https://example.com/private' },
    ] })] });
    expect(hasStudentProjectRecords(value, 'student')).toBe(true);
    render(<StudentProjectReview course={value} studentId="student" />);
    expect(screen.getByRole('link', { name: '下载附件：调查数据.csv' })).toHaveAttribute('href', '/api/uploads/owned-file?download=1');
    expect(screen.queryByText('不可信链接')).not.toBeInTheDocument();
    expect(screen.queryByText('外部文件')).not.toBeInTheDocument();
    expect(hasStudentProjectRecords(course({ submissions: [submission({ content: '<p><img src="/api/uploads/diagram" /></p>' })] }), 'student')).toBe(true);
  });
});
