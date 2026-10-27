import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { deserializeMd } from '@platejs/markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlateDocumentEditor, type PlateDocumentEditorHandle } from './plate-document-editor';

const state = vi.hoisted(() => ({ editor: undefined as unknown as NonNullable<ReturnType<typeof import('platejs/react')['usePlateEditor']>> }));
vi.mock('platejs/react', async original => {
  const actual = await original<typeof import('platejs/react')>();
  return { ...actual, usePlateEditor: (options: Parameters<typeof actual.usePlateEditor>[0]) => {
    const editor = actual.usePlateEditor(options); if (editor) state.editor = editor; return editor;
  } };
});

afterEach(cleanup);

describe('Plate document paste observations', () => {
  it('observes the real clipboard event without cancelling Plate paste handling', async () => {
    const onPaste = vi.fn();
    const ref = createRef<PlateDocumentEditorHandle>();
    const view = render(<PlateDocumentEditor ref={ref} value="<p>既有内容</p>" onChange={() => undefined} onDocumentPaste={onPaste} />);
    await act(async () => undefined);
    const editor = view.container.querySelector('[data-slate-editor]')!;
    const allowed = fireEvent.paste(editor, { clipboardData: { types: ['text/plain'], files: [], items: [], getData: (type: string) => type === 'text/plain' ? '粘贴的内容' : '' } });
    expect(allowed).toBe(true);
    expect(onPaste).not.toHaveBeenCalled();
    // JSDOM has no native contentEditable paste. Apply the same Slate insert
    // after dispatching the real clipboard event, as the browser does.
    await act(async () => { state.editor!.tf.select({ path: [0, 0], offset: 4 }); state.editor!.tf.insertText('粘贴的内容'); });
    expect(onPaste).toHaveBeenCalledWith(expect.objectContaining({ text: '粘贴的内容', beforeText: '既有内容', internalTransfer: false, documentText: expect.stringContaining('粘贴的内容') }));
  });

  it('waits through selection deletion and only reports the inserted snapshot once', async () => {
    const onPaste = vi.fn();
    const view = render(<PlateDocumentEditor value="<p>被替换的内容</p>" onChange={() => undefined} onDocumentPaste={onPaste} />);
    await act(async () => undefined);
    fireEvent.paste(view.container.querySelector('[data-slate-editor]')!, { clipboardData: { types: ['text/plain'], files: [], items: [], getData: (type: string) => type === 'text/plain' ? '新粘贴的方案' : '' } });
    await act(async () => { state.editor!.tf.setValue([{ type: 'p', children: [{ text: '' }] }]); });
    expect(onPaste).not.toHaveBeenCalled();
    await act(async () => { state.editor!.tf.select({ path: [0, 0], offset: 0 }); state.editor!.tf.insertText('新粘贴的方案'); });
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste).toHaveBeenCalledWith(expect.objectContaining({ documentText: '新粘贴的方案', beforeText: '被替换的内容' }));
    await act(async () => { state.editor!.tf.insertText('继续写作'); });
    expect(onPaste).toHaveBeenCalledTimes(1);
  });

  it('drops an unapplied clipboard attempt before a subsequent programmatic AI edit', async () => {
    const onPaste = vi.fn();
    const ref = createRef<PlateDocumentEditorHandle>();
    const view = render(<PlateDocumentEditor ref={ref} value="<p>初稿</p>" onChange={() => undefined} onDocumentPaste={onPaste} />);
    await act(async () => undefined);
    fireEvent.paste(view.container.querySelector('[data-slate-editor]')!, { clipboardData: { types: ['text/plain'], files: [], items: [], getData: () => '相同的文字' } });
    await act(async () => { state.editor!.tf.select({ path: [0, 0], offset: 2 }); expect(ref.current?.insertAtCursor('相同的文字').ok).toBe(true); });
    expect(onPaste).not.toHaveBeenCalled();
  });

  it.each([
    ['ordered list', '1. 先收集原始数据并说明采样过程。\n2. 再比较方案的效果和适用条件。'],
    ['code block', '```javascript\nconst result = values.filter(item => item > 20).map(item => item * 2);\n```'],
    ['table', '| 阶段 | 任务 |\n| --- | --- |\n| 观察 | 收集原始资料 |\n| 比较 | 分析两个方案 |'],
  ])('recognizes an applied Markdown %s after Plate removes its presentation syntax', async (_kind, text) => {
    const onPaste = vi.fn();
    const view = render(<PlateDocumentEditor value="<p>原稿</p>" onChange={() => undefined} onDocumentPaste={onPaste} />);
    await act(async () => undefined);
    fireEvent.paste(view.container.querySelector('[data-slate-editor]')!, { clipboardData: { types: ['text/plain'], files: [], items: [], getData: (type: string) => type === 'text/plain' ? text : '' } });
    await act(async () => { state.editor.tf.setValue(deserializeMd(state.editor, text)); });
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste.mock.calls[0][0].text).toBe(text);
    expect(onPaste.mock.calls[0][0].documentText).not.toBe('原稿');
  });

  it('does not mistake hydration or programmatic AI inserts for clipboard pastes', async () => {
    const onPaste = vi.fn();
    const ref = createRef<PlateDocumentEditorHandle>();
    const view = render(<PlateDocumentEditor ref={ref} value="<p>初稿</p>" onChange={() => undefined} onDocumentPaste={onPaste} />);
    await act(async () => undefined);
    view.rerender(<PlateDocumentEditor ref={ref} value="<p>恢复草稿</p>" onChange={() => undefined} onDocumentPaste={onPaste} />);
    await act(async () => { state.editor!.tf.select({ path: [0, 0], offset: 4 }); expect(ref.current?.insertAtCursor('系统 AI 插入的内容').ok).toBe(true); });
    expect(onPaste).not.toHaveBeenCalled();
  });
});
