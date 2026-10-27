'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ContentMonitorEvent, ContentMonitorSource } from '@/lib/project-practice/content-monitor-contract';

export function DocumentContentReminder({ event, onDismiss, onExplain }: {
  event: ContentMonitorEvent;
  onDismiss: () => void;
  onExplain: (source: ContentMonitorSource, explanation: string) => Promise<void>;
}) {
  const [source, setSource] = useState<ContentMonitorSource | ''>('');
  const [explanation, setExplanation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function saveExplanation() {
    if (!source) return;
    setBusy(true); setError(null);
    try { await onExplain(source, explanation.trim()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '来源说明暂未保存，请重试。'); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => { if (!open) onDismiss(); }}>
      <DialogContent className="z-[80] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>请规范使用外部内容和 AI</DialogTitle>
          <DialogDescription>疑似核心内容直接粘贴，来源待核实。这是一条提醒，不代表认定违规，也不会自动扣分。</DialogDescription>
        </DialogHeader>
        <p className="text-sm leading-6">{event.reason}</p>
        <p className="text-sm leading-6 text-muted-foreground">请用自己的分析完成核心任务，核对外部资料并说明来源。你可以继续编辑、保存或提交；教师会结合实际情况核实这条记录。</p>
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">查看任务依据与相关内容</summary>
          <p className="mt-3 font-medium">任务要求</p>
          <blockquote className="mt-1 whitespace-pre-wrap border-l-2 pl-3 leading-6">{event.requirementQuote}</blockquote>
          <p className="mt-3 font-medium">粘贴片段</p>
          <blockquote className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l-2 pl-3 leading-6">{event.excerpt}</blockquote>
        </details>
        <label className="grid gap-2 text-sm">
          来源说明（可选）
          <select className="h-10 rounded-md border bg-background px-3" value={source} onChange={change => setSource(change.target.value as ContentMonitorSource | '')}>
            <option value="">暂不补充</option>
            <option value="own-draft">自己的草稿</option>
            <option value="template">模板</option>
            <option value="quotation">引用资料</option>
            <option value="ai-assisted">AI 辅助</option>
            <option value="other">其他来源</option>
          </select>
        </label>
        {source && <label className="grid gap-2 text-sm">
          补充说明（可选）
          <textarea className="min-h-20 rounded-md border p-3" maxLength={2000} placeholder="例如资料出处、模板中自己修改的内容，或 AI 的具体用途。" value={explanation} onChange={change => setExplanation(change.target.value)} />
        </label>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onDismiss}>继续编辑</Button>
          {source && <Button disabled={busy} onClick={() => void saveExplanation()}>{busy ? '保存说明…' : '保存说明并继续'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
