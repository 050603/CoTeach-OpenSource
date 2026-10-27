import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { NodeApi } from 'platejs';
import { createPlateEditor } from 'platejs/react';
import { EditorKit } from '@/components/editor/editor-kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { DocumentAiCommentThread } from '@/lib/ai-collaboration/document-comment-types';
import { persistedDocumentBlockIds } from '@/lib/ai-collaboration/document-comment-anchor';
// Plate disables NodeId implicitly under NODE_ENV=test. This one file restores
// the production option while retaining the actual editor, parsers and UI.
vi.mock('platejs/react', async original => {
  const actual = await original<typeof import('platejs/react')>();
  return { ...actual, usePlateEditor: (options: Record<string, unknown>) => actual.usePlateEditor({ ...options, nodeId: {} }) };
});
import { PlateDocumentEditor, type PlateDocumentEditorHandle } from './plate-document-editor';

beforeAll(() => {
  if (!Range.prototype.getBoundingClientRect) Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true, value: () => DOMRect.fromRect({ height: 20, width: 120, x: 0, y: 0 }),
  });
});
const text = '原始日志是4只，汇总表却写40只。';
const legacy: DocumentAiCommentThread = { id: 'old-comment', blockId: 'old-random-id', blockIndex: 0,
  blockText: text, targetText: '汇总表却写40只', createdAt: '2026-10-16T05:01:11.391Z',
  comments: [{ id: 'answer', role: 'assistant', content: '请核对原始日志与汇总表中的两处数字。', createdAt: '2026-10-16T05:01:11.391Z' }] };
const markerName = '查看未读批注，共 1 条';

describe('production-ID document comment reload', () => {
  it('adds identity after the original HTML parsers without changing their node properties', () => {
    const html = '<p data-openpbl-block-id="paragraph" style="text-align:center;line-height:2">格式段落</p>'
      + '<table><tbody><tr><td data-openpbl-block-id="cell" colspan="2" rowspan="2"><p>合并格</p></td></tr><tr></tr></tbody></table>'
      + '<img data-openpbl-block-id="image" src="/api/uploads/synthetic-image" alt="原图" width="80" height="60">'
      + '<pre class="slate-code_block" data-slate-lang="python" data-openpbl-block-id="code">print(1)\nprint(2)</pre>';
    const baseline = createPlateEditor({ plugins: EditorKit.filter(plugin => plugin.key !== 'openpblDocumentBlockIdentity'), nodeId: {}, value: html });
    const restored = createPlateEditor({ plugins: EditorKit, nodeId: {}, value: html });
    const withoutIds = (value: unknown): unknown => Array.isArray(value) ? value.map(withoutIds)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'id')
        .map(([key, child]) => [key, withoutIds(child)])) : value;
    expect(withoutIds(restored.children)).toEqual(withoutIds(baseline.children));
    const nodes = [...NodeApi.elements(restored)].map(([node]) => node);
    expect(nodes.find(node => node.id === 'paragraph')).toMatchObject({ type: 'p', align: 'center', lineHeight: '2' });
    expect(nodes.find(node => node.id === 'cell')).toMatchObject({ type: 'td', attributes: { colspan: '2', rowspan: '2' } });
    expect(nodes.find(node => node.id === 'image')).toMatchObject({ type: 'img', url: '/api/uploads/synthetic-image' });
    expect(nodes.find(node => node.id === 'code')).toMatchObject({ type: 'code_block', lang: 'python' });
  });
  it('restores a persisted v1 anchor and reply UI after a new editor mounts, without emitting an edit', async () => {
    const value = `<p data-openpbl-block-id="saved-block">${text}</p>`;
    const thread = { ...legacy, blockId: 'saved-block', anchorVersion: 1 as const };
    const onChange = vi.fn(); const ref = createRef<PlateDocumentEditorHandle>();
    const first = render(<PlateDocumentEditor value={value} onChange={onChange} aiCommentThreads={[thread]} ref={ref} />);
    expect(await first.findByRole('button', { name: markerName })).toBeTruthy();
    expect(ref.current?.getBlockCandidates()[0].blockId).toBe('saved-block');
    first.unmount();
    const second = render(<PlateDocumentEditor value={value} onChange={onChange} aiCommentThreads={[thread]} ref={ref} />);
    fireEvent.click(await second.findByRole('button', { name: markerName }));
    expect(await second.findByText(legacy.comments[0].content)).toBeTruthy();
    expect(ref.current?.resolveCommentSelection({ blockId: thread.blockId, anchorVersion: 1,
      blockIndex: 0, expectedBlockText: text, targetText: thread.targetText })).not.toBeNull();
    await act(async () => {}); expect(onChange).not.toHaveBeenCalled();
  });
  it('keeps a legacy random-ID comment after reload, then after a real edit/save introduces durable IDs', async () => {
    const value = `<p>${text}</p><p>另一个段落供编辑。</p>`;
    const saved: string[] = []; const onChange = vi.fn((html: string) => saved.push(html));
    const ref = createRef<PlateDocumentEditorHandle>();
    const first = render(<PlateDocumentEditor value={value} onChange={onChange} aiCommentThreads={[legacy]} ref={ref} />);
    expect(await first.findByRole('button', { name: markerName })).toBeTruthy();
    expect(ref.current?.getBlockCandidates()[0].blockId).not.toBe(legacy.blockId);
    await act(async () => {}); expect(onChange).not.toHaveBeenCalled();
    const selection = ref.current!.resolveCommentSelection({ blockIndex: 1,
      expectedBlockText: '另一个段落供编辑。', targetText: '另一个段落供编辑。' });
    expect(selection).not.toBeNull();
    await act(async () => { expect(ref.current!.replaceRange({ ...selection!, replacement: '另一个段落由学生编辑。' }).ok).toBe(true); });
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const html = saved.at(-1)!; expect(persistedDocumentBlockIds(html).size).toBe(2);
    const originalId = ref.current?.getBlockCandidates()[0].blockId;
    first.unmount();
    const second = render(<PlateDocumentEditor value={html} onChange={onChange} aiCommentThreads={[legacy]} ref={ref} />);
    expect(await second.findByRole('button', { name: markerName })).toBeTruthy();
    expect(ref.current?.getBlockCandidates()[0].blockId).toBe(originalId);
    await act(async () => {}); expect(onChange).toHaveBeenCalledTimes(1);
  });
  it('treats identity hydration and AI mark split/removal as no edit of a submitted legacy body', async () => {
    const html = `<p><strong>原始日志是4只，</strong><strong>汇总表却写40只。</strong></p>`;
    const onChange = vi.fn(); const first = render(<PlateDocumentEditor value={html} onChange={onChange} />);
    first.rerender(<PlateDocumentEditor value={html} onChange={onChange} aiCommentThreads={[legacy]} />);
    expect(await first.findByRole('button', { name: markerName })).toBeTruthy();
    first.rerender(<PlateDocumentEditor value={html} onChange={onChange} aiCommentThreads={[{ ...legacy, status: 'resolved' }]} />);
    await waitFor(() => expect(first.queryByRole('button', { name: markerName })).toBeNull());
    first.unmount();
    const second = render(<PlateDocumentEditor value={html} onChange={onChange} aiCommentThreads={[legacy]} />);
    expect(await second.findByRole('button', { name: markerName })).toBeTruthy();
    await act(async () => {}); expect(onChange).not.toHaveBeenCalled();
  });
  it.each(['deleted', 'changed', 'ambiguous'] as const)('never renders or selects an unsafe %s anchor', async kind => {
    const thread = kind === 'ambiguous' ? legacy : { ...legacy, blockId: 'saved', anchorVersion: 1 as const };
    const html = kind === 'deleted' ? `<p data-openpbl-block-id="new">${text}</p>`
      : kind === 'changed' ? '<p data-openpbl-block-id="saved">原始数据已经核验并改正。</p>' : `<p>${text}</p><p>${text}</p>`;
    const ref = createRef<PlateDocumentEditorHandle>();
    const view = render(<PlateDocumentEditor value={html} onChange={() => undefined} aiCommentThreads={[thread]} ref={ref} />);
    await act(async () => {}); expect(view.queryByRole('button', { name: markerName })).toBeNull();
    expect(ref.current?.resolveCommentSelection({ ...thread, expectedBlockText: text })).toBeNull();
  });
});
