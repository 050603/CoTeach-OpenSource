import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { getCommentKey } from '@platejs/comment';
import { KEYS, NodeApi } from 'platejs';
import type { PlateEditor } from 'platejs/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorKit } from '@/components/editor/editor-kit';
import { commentPlugin } from '@/components/editor/plugins/comment-kit';
import { discussionPlugin } from '@/components/editor/plugins/discussion-kit';
import type { DocumentAiCommentThread } from '@/lib/ai-collaboration/document-comment-types';
import { hasTransientPlateSuggestion, PlateDocumentEditor, type PlateDocumentEditorHandle } from './plate-document-editor';

const captured = vi.hoisted(() => ({
  main: null as PlateEditor | null,
  editors: [] as PlateEditor[],
}));

// Keep the real editor, plugins, DOM and history. Plate disables NodeId in tests,
// so explicitly use the production setting, as in the persisted-anchor tests.
vi.mock('platejs/react', async original => {
  const actual = await original<typeof import('platejs/react')>();
  return {
    ...actual,
    usePlateEditor: (options: Parameters<typeof actual.usePlateEditor>[0] = {}) => {
      const editor = actual.usePlateEditor({ ...options, nodeId: {} });
      if (options.plugins === EditorKit) captured.main = editor;
      if (editor && !captured.editors.includes(editor)) captured.editors.push(editor);
      return editor;
    },
  };
});

const original = '原始日志是4只，汇总表却写40只。';
const targetText = '汇总表却写40只';
const thread: DocumentAiCommentThread = {
  id: 'saved-comment',
  blockId: 'saved-block',
  anchorVersion: 1,
  blockIndex: 0,
  blockText: original,
  targetText,
  createdAt: '2026-10-16T05:01:11.391Z',
  comments: [{
    id: 'saved-reply',
    role: 'assistant',
    content: '请核对原始日志与汇总表中的两处数字。',
    createdAt: '2026-10-16T05:01:11.391Z',
  }],
};
const initialThreads = [thread];
const initialHtml = `<p data-openpbl-block-id="saved-block">${original}</p>`;
const markerName = '查看未读批注，共 1 条';

beforeAll(() => {
  if (!Range.prototype.getBoundingClientRect) {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () => DOMRect.fromRect({ height: 20, width: 120, x: 0, y: 0 }),
    });
  }
});
beforeEach(() => { captured.main = null; captured.editors = []; });
afterEach(cleanup);

function mainEditor(): PlateEditor {
  if (!captured.main) throw new Error('The actual document editor did not mount');
  return captured.main;
}
function body() {
  return mainEditor().children.map(node => NodeApi.string(node));
}
function pointAt(offset: number): { path: number[]; offset: number } {
  let consumed = 0;
  for (const [node, path] of NodeApi.texts(mainEditor().children[0])) {
    if (offset <= consumed + node.text.length) return { path: [0, ...path], offset: offset - consumed };
    consumed += node.text.length;
  }
  throw new Error('The requested point lies outside the actual paragraph');
}
function Harness({ threads = initialThreads, onChange = () => undefined }: {
  threads?: DocumentAiCommentThread[];
  onChange?: (html: string) => void;
}) {
  const [value, setValue] = useState(initialHtml);
  return <PlateDocumentEditor value={value} aiCommentThreads={threads} onChange={html => {
    onChange(html);
    setValue(html);
  }} />;
}
async function clickHistory(view: ReturnType<typeof render>, direction: 'undo' | 'redo') {
  const button = view.container.querySelector<HTMLButtonElement>(`button:has(svg.lucide-${direction}-2)`);
  expect(button).not.toBeNull();
  expect(button!.disabled).toBe(false);
  await act(async () => { fireEvent.mouseDown(button!); fireEvent.click(button!); });
}

describe('AI comment decorations preserve real document history', () => {
  it('hydrates production IDs and a visible comment without changing nodes or creating Undo entries', async () => {
    const onChange = vi.fn();
    const view = render(<Harness onChange={onChange} />);
    expect(await view.findByRole('button', { name: markerName })).toBeTruthy();
    expect(view.container.querySelector(`[data-discussion-id="${thread.id}"]`)?.textContent).toBe(targetText);
    expect(mainEditor().children[0].id).toBe('saved-block');
    expect(mainEditor().children[0].children).toEqual([{ text: original }]);
    expect(mainEditor().history.undos).toHaveLength(0);
    expect(mainEditor().history.redos).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses one real toolbar Undo/Redo after typing a separate paragraph, including a comment metadata refresh', async () => {
    const view = render(<Harness />);
    await view.findByRole('button', { name: markerName });
    const editor = mainEditor();
    await act(async () => {
      editor.tf.select(editor.api.end([])!);
      editor.tf.insertBreak();
    });
    await act(async () => { editor.tf.insertText('这段临时内容应当被一次撤销。'); });
    expect(body()).toEqual([original, '这段临时内容应当被一次撤销。']);
    await clickHistory(view, 'undo');
    expect(body()).toEqual([original, '']);
    await clickHistory(view, 'redo');
    expect(body()).toEqual([original, '这段临时内容应当被一次撤销。']);
    await clickHistory(view, 'undo');
    expect(body()).toEqual([original, '']);
    expect(editor.children[0].id).toBe('saved-block');
    const historyBeforeRefresh = structuredClone(editor.history);
    view.rerender(<Harness threads={[{ ...thread, readAt: '2026-10-16T05:02:00.000Z' }]} />);
    await view.findByRole('button', { name: '查看该段批注，共 1 条' });
    expect(editor.history).toEqual(historyBeforeRefresh);
  });

  it('undoes and redoes typing inside the decorated range after its full-block anchor becomes invalid', async () => {
    const view = render(<Harness />);
    await view.findByRole('button', { name: markerName });
    const offset = original.indexOf(targetText) + 2;
    await act(async () => {
      mainEditor().tf.select(pointAt(offset));
      mainEditor().tf.insertText('待核对');
    });
    const edited = original.slice(0, offset) + '待核对' + original.slice(offset);
    expect(body()).toEqual([edited]);
    await waitFor(() => expect(view.queryByRole('button', { name: markerName })).toBeNull());
    expect(view.container.querySelector(`[data-discussion-id="${thread.id}"]`)).toBeNull();
    await clickHistory(view, 'undo');
    expect(body()).toEqual([original]);
    await view.findByRole('button', { name: markerName });
    expect(view.container.querySelector(`[data-discussion-id="${thread.id}"]`)?.textContent).toBe(targetText);
    await clickHistory(view, 'redo');
    expect(body()).toEqual([edited]);
    await waitFor(() => expect(view.queryByRole('button', { name: markerName })).toBeNull());
  });

  it('restores exact text after deleting across a decoration boundary, without stale leaf paths', async () => {
    const view = render(<Harness />);
    await view.findByRole('button', { name: markerName });
    const start = original.indexOf(targetText) - 2;
    const end = original.indexOf(targetText) + 3;
    await act(async () => {
      mainEditor().tf.delete({ at: { anchor: pointAt(start), focus: pointAt(end) } });
    });
    const edited = original.slice(0, start) + original.slice(end);
    expect(body()).toEqual([edited]);
    await waitFor(() => expect(view.queryByRole('button', { name: markerName })).toBeNull());
    await clickHistory(view, 'undo');
    expect(body()).toEqual([original]);
    await view.findByRole('button', { name: markerName });
    await clickHistory(view, 'redo');
    expect(body()).toEqual([edited]);
  });

  it('allows Undo after a comment arrives late and disappears, without adding or erasing edit history', async () => {
    const view = render(<Harness threads={[]} />);
    await act(async () => {
      mainEditor().tf.select(mainEditor().api.end([])!);
      mainEditor().tf.insertBreak();
    });
    await act(async () => { mainEditor().tf.insertText('真实学生输入'); });
    const savedHistory = structuredClone(mainEditor().history);
    view.rerender(<Harness threads={initialThreads} />);
    await view.findByRole('button', { name: markerName });
    expect(mainEditor().history).toEqual(savedHistory);
    view.rerender(<Harness threads={[{ ...thread, status: 'resolved' }]} />);
    await waitFor(() => expect(view.queryByRole('button', { name: markerName })).toBeNull());
    expect(mainEditor().history).toEqual(savedHistory);
    await clickHistory(view, 'undo');
    expect(body()).toEqual([original, '']);
  });

  it('opens the exact thread from highlighted text and from its badge, retaining read/reply/status routing', async () => {
    const onRead = vi.fn(async () => undefined);
    const onReply = vi.fn(async () => undefined);
    const onStatus = vi.fn(async () => undefined);
    const view = render(<PlateDocumentEditor value={initialHtml} onChange={() => undefined}
      aiCommentThreads={initialThreads} onAiCommentRead={onRead}
      onAiCommentReply={onReply} onAiCommentStatusChange={onStatus} />);
    const marker = await view.findByRole('button', { name: markerName });
    const highlight = view.container.querySelector<HTMLElement>(`[data-discussion-id="${thread.id}"]`)!;
    expect(highlight).not.toBeNull();
    fireEvent.click(highlight);
    expect(await view.findByText(thread.comments[0].content)).toBeTruthy();
    await waitFor(() => expect(mainEditor().getOption(commentPlugin, 'activeId')).toBe(thread.id));
    await waitFor(() => expect(onRead).toHaveBeenCalledWith({ threadId: thread.id }));

    const placeholder = [...document.querySelectorAll('[data-slate-placeholder]')]
      .find(node => node.textContent === '回复…');
    const replyElement = placeholder?.closest('[data-slate-editor]');
    expect(replyElement).toBeTruthy();
    const replyEditor = captured.editors.find(editor => {
      try { return editor.api.toDOMNode(editor) === replyElement; } catch { return false; }
    });
    expect(replyEditor).toBeTruthy();
    await act(async () => { replyEditor!.tf.select(replyEditor!.api.end([])!); replyEditor!.tf.insertText('我已核对原始记录。'); });
    fireEvent.click(view.getByRole('button', { name: '发送批注回复' }));
    await waitFor(() => expect(onReply).toHaveBeenCalledWith({ threadId: thread.id, message: '我已核对原始记录。' }));
    fireEvent.click(view.getByRole('button', { name: '已处理' }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith({ threadId: thread.id, status: 'resolved' }));
    fireEvent.click(marker);
    fireEvent.click(marker);
    expect(await view.findByText(thread.comments[0].content)).toBeTruthy();
    expect(body()).toEqual([original]);
    expect(mainEditor().history.undos).toHaveLength(0);
  });

  it('continues to put actual student comment edits into normal Undo/Redo history', async () => {
    const view = render(<Harness />);
    await view.findByRole('button', { name: markerName });
    const editor = mainEditor();
    await act(async () => {
      editor.tf.setNodes({ [KEYS.comment]: true, [getCommentKey('student-comment')]: true }, {
        at: { anchor: pointAt(0), focus: pointAt(4) }, match: node => 'text' in node, split: true,
      });
      editor.setOption(discussionPlugin, 'discussions', [
        ...editor.getOption(discussionPlugin, 'discussions'),
        { id: 'student-comment', comments: [], createdAt: new Date('2026-10-16T05:03:00.000Z'),
          isResolved: false, userId: 'student', source: 'student' },
      ]);
    });
    expect(JSON.stringify(editor.children)).toContain(getCommentKey('student-comment'));
    expect(editor.history.undos.length).toBeGreaterThan(0);
    await clickHistory(view, 'undo');
    expect(JSON.stringify(editor.children)).not.toContain(getCommentKey('student-comment'));
    expect(body()).toEqual([original]);
    await clickHistory(view, 'redo');
    expect(JSON.stringify(editor.children)).toContain(getCommentKey('student-comment'));
    expect(body()).toEqual([original]);
  });

  it('keeps the original comment confirmation card through native preview and rejects or accepts the actual diff', async () => {
    const ref = createRef<PlateDocumentEditorHandle>();
    function PreviewHarness() {
      const [value, setValue] = useState(initialHtml);
      return <PlateDocumentEditor ref={ref} value={value} onChange={setValue}
        aiCommentThreads={initialThreads}
        pendingAiCommentSuggestion={{ threadId: thread.id, title: '核对汇总表',
          targetText, replacement: '汇总表应写4只', reason: '与原始记录一致。' }}
        onAiSuggestionDecision={decision => { ref.current!.resolveAiSuggestion(decision); }} />;
    }
    const view = render(<PreviewHarness />);
    await view.findByRole('button', { name: markerName });
    const preview = async () => {
      const selection = ref.current!.resolveCommentSelection({ ...thread, expectedBlockText: original });
      expect(selection).not.toBeNull();
      await act(async () => {
        expect(ref.current!.previewAiSuggestion({ operation: 'replace', ...selection!,
          replacement: '汇总表应写4只' }).ok).toBe(true);
      });
      expect(hasTransientPlateSuggestion(mainEditor().children)).toBe(true);
      const marker = await view.findByRole('button', { name: markerName });
      if (!view.queryByRole('button', { name: '接受修改' })) fireEvent.click(marker);
      expect(await view.findByRole('button', { name: '接受修改' })).toBeTruthy();
      expect(view.getByRole('button', { name: '拒绝修改' })).toBeTruthy();
    };
    await preview();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '拒绝修改' })); });
    expect(hasTransientPlateSuggestion(mainEditor().children)).toBe(false);
    expect(body()).toEqual([original]);
    await preview();
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '接受修改' })); });
    expect(hasTransientPlateSuggestion(mainEditor().children)).toBe(false);
    expect(body()).toEqual([original.replace(targetText, '汇总表应写4只')]);
    await waitFor(() => expect(view.queryByRole('button', { name: markerName })).toBeNull());
  });

  it('keeps an accepted exact-range AI edit undoable while invalidating the old display anchor', async () => {
    const ref = createRef<PlateDocumentEditorHandle>();
    function AiHarness() {
      const [value, setValue] = useState(initialHtml);
      return <PlateDocumentEditor ref={ref} value={value} onChange={setValue} aiCommentThreads={initialThreads} />;
    }
    const view = render(<AiHarness />);
    await view.findByRole('button', { name: markerName });
    const selection = ref.current!.resolveCommentSelection({ ...thread, expectedBlockText: original });
    expect(selection).not.toBeNull();
    await act(async () => {
      const result = ref.current!.replaceRange({ ...selection!, replacement: '汇总表应写4只' });
      expect(result.ok).toBe(true);
    });
    expect(body()).toEqual([original.replace(targetText, '汇总表应写4只')]);
    await clickHistory(view, 'undo');
    expect(body()).toEqual([original]);
    await view.findByRole('button', { name: markerName });
    await clickHistory(view, 'redo');
    expect(body()).toEqual([original.replace(targetText, '汇总表应写4只')]);
  });

  it('keeps a legacy whole-sentence comment card during a native replacement of only its opening phrase', async () => {
    const ref = createRef<PlateDocumentEditorHandle>();
    const onDecision = vi.fn();
    const view = render(<PlateDocumentEditor ref={ref} value="<p>需要修改的句子。</p>" onChange={() => undefined}
      aiCommentThreads={[{ id: 'legacy-pending', blockIndex: 0, targetText: '需要修改的句子。',
        createdAt: thread.createdAt, comments: [{ id: 'legacy-reply', role: 'assistant', content: '请确认是否接受。', createdAt: thread.createdAt }] }]}
      pendingAiCommentSuggestion={{ threadId: 'legacy-pending', assistantCommentId: 'legacy-reply',
        title: '调整表述', targetText: '需要修改', replacement: '建议调整', reason: '使动作明确。' }}
      onAiSuggestionDecision={onDecision} />);
    const selection = ref.current!.resolveCommentSelection({ blockIndex: 0, expectedBlockText: '需要修改的句子。', targetText: '需要修改' });
    expect(selection).not.toBeNull();
    await act(async () => { expect(ref.current!.previewAiSuggestion({ operation: 'replace', ...selection!, replacement: '建议调整' }).ok).toBe(true); });
    const marker = await view.findByRole('button', { name: markerName });
    expect(marker.isConnected).toBe(true);
    fireEvent.click(marker);
    expect(await view.findByRole('button', { name: '接受修改' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '接受修改' }));
    expect(onDecision).toHaveBeenCalledWith('accepted');
  });
});
