"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Download, FileText, Search } from "lucide-react";
import type { ClassroomSubmission, Course, ProjectDocumentVersion, ProjectPdfVersion } from "@/lib/session/types";
import { parseCodeArtifact } from "@/lib/ai-collaboration/code-artifact";
import { RichDocumentPreview } from "@/components/teacher/rich-document-preview";
import styles from "./student-work-presentation.module.css";

type WorkRow = {
  student: Course["students"][number];
  artifact?: ClassroomSubmission;
  documentVersions: ProjectDocumentVersion[];
  externalVersions: ProjectPdfVersion[];
};

function documentLength(html: string): number {
  if (typeof document === "undefined") return html.replace(/<[^>]*>/g, "").replace(/\s+/g, "").length;
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll("script,style").forEach((node) => node.remove());
  return [...(template.content.textContent ?? "").replace(/\s+/g, "")].length;
}

function workSummary(row: WorkRow) {
  const documents = row.documentVersions.filter((version) => version.status === "submitted");
  const uploads = row.externalVersions.filter((version) => version.status === "submitted");
  const count = new Set(documents.map((version) => version.id)).size
    + new Set(uploads.map((version) => version.id)).size
    + (row.artifact?.status === "submitted" && !documents.some((version) => version.submissionId === row.artifact?.id) ? 1 : 0);
  const code = row.artifact?.type === "code" ? parseCodeArtifact(row.artifact.content) : null;
  const html = row.artifact?.content ?? [...documents].sort((a, b) => b.sequence - a.sequence)[0]?.sourceHtml;
  const size = code
    ? `${code.files.reduce((total, file) => total + (file.content.trim() ? file.content.trimEnd().split("\n").length : 0), 0)} 行代码`
    : html !== undefined ? `${documentLength(html)} 字` : uploads.length || row.artifact?.files?.length ? "文件成果" : "尚未保存";
  return { count, size };
}

export function StudentWorkPresentation({ rows, selectedStudentId, onSelectStudent, active = true }: {
  active?: boolean;
  rows: WorkRow[];
  selectedStudentId?: string;
  onSelectStudent: (studentId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    if (active && selectedStudentId && contentRef.current) contentRef.current.scrollTop = scrollPositions.current.get(selectedStudentId) ?? 0;
  }, [active, selectedStudentId]);
  const summaries = useMemo(() => new Map(rows.map((row) => [row.student.id, workSummary(row)])), [rows]);
  const visibleRows = rows.filter((row) => row.student.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = rows.find((row) => row.student.id === selectedStudentId);
  const artifact = selected?.artifact;
  const code = artifact?.type === "code" ? parseCodeArtifact(artifact.content) : null;
  const documents = [...(selected?.documentVersions ?? [])].filter((version) => version.status === "submitted").sort((a, b) => b.sequence - a.sequence);
  const uploads = [...(selected?.externalVersions ?? [])].filter((version) => version.status === "submitted").sort((a, b) => b.sequence - a.sequence);
  const documentHtml = artifact && (artifact.type === "document" || artifact.type === "artifact-brief") ? artifact.content : !artifact ? documents[0]?.sourceHtml : undefined;
  const title = artifact?.title || documents[0]?.title || uploads[0]?.title || "尚未保存成果";
  const updatedAt = artifact?.updatedAt || documents[0]?.submittedAt || documents[0]?.createdAt || uploads[0]?.submittedAt;

  return <section hidden={!active} aria-label="学生成果展示" className={`teacher-presentation-content ${styles.root}`}>
    <aside aria-label="学生成果列表" className={styles.sidebar}>
      <header className={styles.rosterHeading}><h2>学生成果</h2><span>{rows.length} 人</span></header>
      <label className={styles.search}><Search aria-hidden="true" size={16} /><input aria-label="搜索展示学生" onChange={(event) => setQuery(event.target.value)} placeholder="搜索学生" value={query} /></label>
      <ul className={styles.roster}>
        {visibleRows.map((row) => {
          const summary = summaries.get(row.student.id)!;
          return <li key={row.student.id}><button aria-pressed={selected?.student.id === row.student.id} className={styles.student} onClick={() => onSelectStudent(row.student.id)} type="button">
            <strong>{row.student.name}</strong>
            <span><span>{summary.count ? `已提交 ${summary.count} 次` : "未提交"}</span><span>{summary.size}</span></span>
          </button></li>;
        })}
        {!visibleRows.length ? <li className={styles.rosterEmpty}>{rows.length ? "未找到匹配的学生" : "暂无学生进入本场课堂"}</li> : null}
      </ul>
    </aside>
    <section aria-label="学生成果预览" className={styles.preview}>
      {selected ? <>
        <header className={styles.previewHeading}>
          <div><h2 title={`${selected.student.name} · ${title}`}>{selected.student.name} · {title}</h2><p>{updatedAt ? `最近保存 ${new Date(updatedAt).toLocaleString("zh-CN")}` : "等待学生保存成果"}</p></div>
          <span>{artifact ? "实时成果" : documents.length || uploads.length ? "已提交成果" : "暂无成果"}</span>
        </header>
        <div ref={contentRef} onScroll={event => { if (active) scrollPositions.current.set(selected.student.id, event.currentTarget.scrollTop); }} aria-label={`${selected.student.name}的成果内容`} className={styles.content} key={selected.student.id} role="region" tabIndex={0}>
          {documentHtml !== undefined ? <RichDocumentPreview className={styles.document} html={documentHtml} minHeight={0} /> : code ? <div className={styles.code}>{code.files.map((file) => <section key={file.id}><h3>{file.path}</h3><pre><code>{file.content}</code></pre></section>)}</div> : !uploads.length && !artifact?.files?.length ? <p className={styles.empty}>该学生尚未保存可展示的成果。</p> : null}
          {documents.length || uploads.length || artifact?.files?.length ? <details className={styles.versions}>
            <summary>提交记录与文件 · {summaries.get(selected.student.id)?.count ?? 0} 次提交</summary>
            <ul>
              {documents.map((version) => <li key={version.id}><span>第 {version.sequence} 版 · {version.title}</span>{version.docxUploadId ? <a download href={`/api/uploads/${encodeURIComponent(version.docxUploadId)}?download=1`}><Download aria-hidden="true" size={16} />下载 Word</a> : <span>文件暂不可用</span>}</li>)}
              {uploads.map((version) => <li key={version.id}><span>第 {version.sequence} 版 · {version.title}</span><a download href={`/api/uploads/${encodeURIComponent(version.uploadId)}?download=1`}><Download aria-hidden="true" size={16} />下载文件</a></li>)}
              {artifact?.files?.map((file) => <li key={`${file.name}:${file.url}`}><span>{file.name}</span>{file.url ? <a download href={file.url}><Download aria-hidden="true" size={16} />下载文件</a> : null}</li>)}
            </ul>
          </details> : null}
        </div>
      </> : <div className={styles.empty}><FileText aria-hidden="true" size={32} /><h2>选择学生成果</h2><p>点击左侧学生，展示其最新保存的文档或代码。</p></div>}
    </section>
  </section>;
}
