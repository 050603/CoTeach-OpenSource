"use client";

import { useState } from 'react';
import type { SubmissionSaveConflict } from '@/lib/browser/submission-save-outbox';

/** Adoption is explicit; downloading includes both immutable conflict snapshots. */
export function SubmissionSaveConflictPanel({ conflict, localContent, onResolve }: {
  conflict: SubmissionSaveConflict;
  localContent: string;
  onResolve: (choice: 'local' | 'remote') => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const resolve = async (choice: 'local' | 'remote') => {
    setBusy(true);
    try { await onResolve(choice); } finally { setBusy(false); }
  };
  return <aside role="alert" className="border-b border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3 text-sm">
    <p>其他窗口已更新草稿。两份内容均已保留，请核对后选择要继续编辑的版本。</p>
    <details className="my-2"><summary>对比本机与服务器内容</summary>
      <div className="grid gap-3 md:grid-cols-2"><div><p>当前本机内容</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{localContent}</pre></div>
        <div><p>服务器第 {conflict.remote.version} 版</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{conflict.remote.content}</pre></div></div>
    </details>
    <div className="flex flex-wrap gap-3">
      <button type="button" disabled={busy} className="min-h-11 underline" onClick={() => void resolve('local')}>采用当前本机内容并保存</button>
      <button type="button" disabled={busy} className="min-h-11 underline" onClick={() => void resolve('remote')}>采用服务器版本继续编辑</button>
      <button type="button" className="min-h-11 underline" onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify({ ...conflict, currentLocalContent: localContent }, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a'); anchor.href = url; anchor.download = '草稿冲突副本.json'; anchor.click(); URL.revokeObjectURL(url);
      }}>下载两份内容</button>
    </div>
  </aside>;
}
