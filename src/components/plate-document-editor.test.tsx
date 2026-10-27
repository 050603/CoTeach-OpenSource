import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { AIChatPlugin, applyAISuggestions, rejectAISuggestions } from "@platejs/ai/react";
import { createPlateEditor } from "platejs/react";
import { createRef, useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EditorKit } from "@/components/editor/editor-kit";
import type { DocumentAiCommentThread } from "@/lib/ai-collaboration/document-comment-types";
import { withoutDocumentBlockIds } from "@/lib/ai-collaboration/document-comment-anchor";
import {
  hasTransientPlateSuggestion,
  insertTransientPlateSuggestion,
  PlateDocumentEditor,
  serializePlateDocument,
  type PlateDocumentEditorHandle,
} from "./plate-document-editor";

// Plate disables NodeId in tests. Exercise the same node identity behavior as
// the production editor, including during partial native suggestion previews.
vi.mock("platejs/react", async original => {
  const actual = await original<typeof import("platejs/react")>();
  return {
    ...actual,
    usePlateEditor: (options: Parameters<typeof actual.usePlateEditor>[0] = {}) =>
      actual.usePlateEditor({ ...options, nodeId: {} }),
  };
});

beforeAll(() => {
  if (!(Range.prototype as Range & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => DOMRect.fromRect({ height: 20, width: 120, x: 0, y: 0 }),
    });
  }
});

describe("PlateDocumentEditor collaboration edits", () => {
  it.each(['accepted', 'rejected'] as const)("previews a multi-step delivery without saving, then resolves it as %s", async decision => {
    const ref = createRef<PlateDocumentEditorHandle>();
    const onChange = vi.fn();
    const original = '<h2>观察记录</h2><p><strong>周一记录 3.5 升。</strong></p><p>删除这条重复说明。</p><p>保留学生原有结论。</p>';
    const view = render(<PlateDocumentEditor ref={ref} value={original} onChange={onChange} />);
    await act(async () => {});
    await act(async () => {
      expect(ref.current?.previewDelegatedWorkPlan([
        { operation: 'replace', targetText: '周一记录 3.5 升。', content: '| 日期 | 记录 |\n| --- | --- |\n| 周一 | 3.5 升 |', description: '整理为表格' },
        { operation: 'delete', targetText: '删除这条重复说明。', content: '', description: '删除重复' },
        { operation: 'insert-before', targetText: '保留学生原有结论。', content: '表格说明。', description: '新增说明' },
        { operation: 'append', targetText: '', content: '补充记录。', description: '追加记录' },
      ])).toMatchObject({ ok: true, presentation: 'blocks' });
    });
    expect(onChange).not.toHaveBeenCalled();
    const editor = view.container.querySelector('[data-slate-editor]')!;
    expect(editor.textContent).toContain('周一记录 3.5 升。');
    expect(editor.textContent).toContain('表格说明。');
    expect(editor.querySelector('.bg-red-100')).toBeTruthy();
    expect(editor.querySelector('.bg-emerald-100')).toBeTruthy();
    await act(async () => {
      const result = ref.current?.resolveAiSuggestion(decision);
      expect(result?.ok).toBe(true);
      const html = withoutDocumentBlockIds(result!.afterHtml!);
      if (decision === 'accepted') {
        expect(html).toContain('<table>');
        expect(html).toContain('3.5 升');
        expect(html).toContain('表格说明。');
        expect(html).toContain('补充记录。');
        expect(html).not.toContain('删除这条重复说明');
        expect(html).not.toContain('周一记录 3.5 升');
      } else expect(html).toBe(original);
    });
    expect(editor.querySelector('.bg-red-100')).toBeNull();
    expect(editor.querySelector('.bg-emerald-100')).toBeNull();
    if (decision === 'rejected') expect(onChange).not.toHaveBeenCalled();
  });

  it("leaves the whole document intact when a later delivery action has an ambiguous anchor", async () => {
    const ref = createRef<PlateDocumentEditorHandle>();
    const onChange = vi.fn();
    const view = render(<PlateDocumentEditor ref={ref} value="<p>首段。</p><p>重复。</p><p>重复。</p>" onChange={onChange} />);
    await act(async () => {});
    await act(async () => {
      expect(ref.current?.previewDelegatedWorkPlan([
        { operation: 'replace', targetText: '首段。', content: '修改首段。', description: '修改' },
        { operation: 'delete', targetText: '重复。', content: '', description: '删除' },
      ])).toMatchObject({ ok: false, reason: expect.stringContaining('多个相同') });
    });
    expect(view.container.querySelector('[data-slate-editor]')?.textContent).toBe('首段。重复。重复。');
    expect(onChange).not.toHaveBeenCalled();
  });
  it("serializes comment-split leaves as one run without changing any saved text format", () => {
    const formats = {
      bold: true, italic: true, underline: true, strikethrough: true,
      code: true, highlight: true, superscript: true, subscript: true,
      fontSize: "18px", color: "#123456", backgroundColor: "#abcdef", fontFamily: "A&B",
    };
    const nodes = [{ type: "p", children: [
      { text: "前缀", ...formats },
      { text: "目标", ...formats, comment_thread: true },
      { text: "后缀", ...formats, comment_other: true },
    ] }];
    const before = structuredClone(nodes);
    expect(serializePlateDocument(nodes)).toBe(serializePlateDocument([
      { type: "p", children: [{ text: "前缀目标后缀", ...formats }] },
    ]));
    expect(nodes).toEqual(before);
    for (const [key, value] of Object.entries(formats)) {
      const changed = typeof value === "boolean" ? false : `${value}-changed`;
      const actual = serializePlateDocument([{ type: "p", children: [
        { text: "甲", ...formats }, { text: "乙", ...formats, [key]: changed },
      ] }]);
      expect(actual, key).not.toBe(serializePlateDocument([
        { type: "p", children: [{ text: "甲乙", ...formats }] },
      ]));
      expect(actual, key).toContain("甲");
      expect(actual, key).toContain("乙");
    }
    expect(serializePlateDocument([{ type: "p", children: [
      { text: "左", bold: true },
      { type: "a", url: "/evidence", children: [{ text: "引用", bold: true }] },
      { text: "右", bold: true },
    ] }])).toBe('<p><strong>左</strong><a href="/evidence" target="_blank" rel="noreferrer"><strong>引用</strong></a><strong>右</strong></p>');
  });

  it.each([false, true])("does not reopen submitted HTML when a late AI comment splits a formatted run (legacy=%s)", async (legacy) => {
    const canonical = "<p><em><strong>编辑验收：公平比较须记录日期。</strong></em></p>";
    const value = legacy
      ? "<p><em><strong>编辑验收：</strong></em><em><strong>公平比较须记录日期</strong></em><em><strong>。</strong></em></p>"
      : canonical;
    const onChange = vi.fn();
    const editorRef = createRef<PlateDocumentEditorHandle>();
    const thread: DocumentAiCommentThread = {
      id: "late-review", blockIndex: 0,
      blockText: "编辑验收：公平比较须记录日期。", targetText: "公平比较须记录日期",
      createdAt: "2026-10-16T01:49:46.151Z",
      comments: [{ id: "late-comment", role: "assistant", content: "还需要核对两个地点的观察时长。", createdAt: "2026-10-16T01:49:46.151Z" }],
    };
    const view = render(<PlateDocumentEditor value={value} onChange={onChange} ref={editorRef} />);
    await act(async () => {});
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(<PlateDocumentEditor value={value} onChange={onChange} ref={editorRef} aiCommentThreads={[thread]} />);
    expect(await view.findByRole("button", { name: "查看未读批注，共 1 条" })).toBeTruthy();
    await act(async () => {});
    expect(onChange).not.toHaveBeenCalled();

    view.rerender(<PlateDocumentEditor value={value} onChange={onChange} ref={editorRef} aiCommentThreads={[{ ...thread, status: "resolved" }]} />);
    await waitFor(() => expect(view.queryByRole("button", { name: /查看未读批注/ })).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
    const selection = editorRef.current?.resolveCommentSelection({
      blockIndex: 0, expectedBlockText: thread.blockText!, targetText: thread.targetText,
    });
    expect(selection).not.toBeNull();
    await act(async () => {
      expect(editorRef.current?.replaceRange({ ...selection!, replacement: "公平比较须记录日期与时长" }).ok).toBe(true);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(withoutDocumentBlockIds(onChange.mock.calls.at(-1)![0])).toBe("<p><em><strong>编辑验收：公平比较须记录日期与时长。</strong></em></p>");
  });

  it("treats asynchronously hydrated legacy HTML as the baseline, then reports a real formatting edit", async () => {
    const onChange = vi.fn();
    const editorRef = createRef<PlateDocumentEditorHandle>();
    const view = render(<PlateDocumentEditor value="" onChange={onChange} ref={editorRef} />);
    view.rerender(<PlateDocumentEditor value="<p><strong>第一句</strong><strong>第二句</strong></p>" onChange={onChange} ref={editorRef} />);
    await waitFor(() => expect(view.container.querySelector("[data-slate-editor]")?.textContent).toBe("第一句第二句"));
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      expect(editorRef.current?.applyDelegatedWorkPlan([{
        operation: "replace", targetText: "第一句第二句", content: "第一句**第二句**", description: "调整第一句格式",
      }]).ok).toBe(true);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(withoutDocumentBlockIds(onChange.mock.calls.at(-1)![0])).toBe("<p>第一句<strong>第二句</strong></p><p></p>");
  });

  it("uses a concise Chinese version of Plate's default empty placeholder", async () => {
    const view = render(
      <PlateDocumentEditor onChange={() => undefined} value="" />,
    );

    await waitFor(() => {
      const placeholder = view.container.querySelector("[data-slate-placeholder]");
      expect(placeholder?.textContent).toBe("在这里输入内容…");
    });
    expect(view.queryByText(/从你的问题|开始编写|Type something/i)).toBeNull();
  });

  it("keeps the applied AI edit undo action inside the document toolbar", async () => {
    const onUndo = vi.fn();
    const view = render(
      <PlateDocumentEditor
        appliedAiEdit={{ title: "整理方案依据", onUndo }}
        onChange={() => undefined}
        value="<p>修改后的方案依据。</p>"
      />,
    );

    const undoButton = await view.findByRole("button", {
      name: "撤销 AI 修改“整理方案依据”",
    });
    expect(undoButton.closest("[role=toolbar]")).toBeTruthy();
    fireEvent.click(undoButton);
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("exposes concrete Plate blocks for paragraph-level AI review", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();
    render(
      <PlateDocumentEditor
        onChange={() => undefined}
        ref={editorRef}
        value="<h2>方案依据</h2><p>我们准备先采访使用者，再比较两个方案。</p>"
      />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    expect(editorRef.current?.getBlockCandidates().map((block) => ({
      text: block.text,
      type: block.type,
    }))).toEqual([
      { text: "方案依据", type: "h2" },
      { text: "我们准备先采访使用者，再比较两个方案。", type: "p" },
    ]);
  });

  it("renders a persisted AI paragraph thread through Plate's native comment UI", async () => {
    const changes: string[] = [];
    const view = render(
      <PlateDocumentEditor
        aiCommentThreads={[{
          id: "thread-1",
          blockIndex: 0,
          targetText: "我们选择这个方案，因为它最好。",
          createdAt: "2026-08-27T08:00:00.000Z",
          comments: [{
            id: "comment-1",
            role: "assistant",
            content: "这里的“最好”具体是指效果、成本还是实施难度？这个依据会影响方案是否可信。",
            createdAt: "2026-08-27T08:00:00.000Z",
          }],
        }]}
        onChange={(html) => changes.push(html)}
        value="<p>我们选择这个方案，因为它最好。</p>"
      />,
    );

    const marker = await view.findByRole("button", { name: "查看未读批注，共 1 条" });
    expect(marker.getAttribute("data-unread")).toBe("true");
    fireEvent.click(marker);
    expect(await view.findByText(/这里的“最好”具体是指效果/)).toBeTruthy();
    expect((await view.findAllByText("AI 组员")).length).toBeGreaterThan(0);
    expect(changes.every((html) => html === "<p>我们选择这个方案，因为它最好。</p>")).toBe(true);
  });

  it("changes an unread paragraph marker to the muted read state after opening it", async () => {
    function Harness() {
      const [threads, setThreads] = useState<DocumentAiCommentThread[]>([{
        id: "thread-unread",
        blockIndex: 0,
        targetText: "需要学生查看的段落。",
        createdAt: "2026-08-27T01:00:00.000Z",
        comments: [{
          id: "comment-unread",
          role: "assistant" as const,
          content: "这条建议尚未查看。",
          createdAt: "2026-08-27T01:00:00.000Z",
        }],
      }]);
      return (
        <PlateDocumentEditor
          aiCommentThreads={threads}
          onAiCommentRead={async ({ threadId }) => {
            setThreads((current) => current.map((thread) =>
              thread.id === threadId
                ? { ...thread, readAt: "2026-08-27T02:00:00.000Z" }
                : thread
            ));
          }}
          onChange={() => undefined}
          value="<p>需要学生查看的段落。</p>"
        />
      );
    }

    const view = render(<Harness />);
    const unreadMarker = await view.findByRole("button", { name: "查看未读批注，共 1 条" });
    fireEvent.click(unreadMarker);
    const readMarker = await view.findByRole("button", { name: "查看该段批注，共 1 条" });
    expect(readMarker.getAttribute("data-unread")).toBe("false");
  });

  it("keeps a read AI comment open until the student changes its status", async () => {
    const onStatusChange = vi.fn();
    function Harness() {
      const [threads, setThreads] = useState<DocumentAiCommentThread[]>([{
        id: "thread-status",
        blockIndex: 0,
        blockText: "结论与数据还需要核对。",
        targetText: "结论与数据还需要核对。",
        status: "open",
        createdAt: "2026-08-27T01:00:00.000Z",
        comments: [{ id: "comment-status", role: "assistant", content: "请核对这里的数据依据。", createdAt: "2026-08-27T01:00:00.000Z" }],
      }]);
      return <PlateDocumentEditor
        aiCommentThreads={threads}
        onAiCommentRead={async ({ threadId }) => {
          setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, readAt: "2026-08-27T02:00:00.000Z" } : thread));
        }}
        onAiCommentStatusChange={async ({ threadId, status }) => {
          onStatusChange(threadId, status);
          setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, status } : thread));
        }}
        onChange={() => undefined}
        value="<p>结论与数据还需要核对。</p>"
      />;
    }
    const view = render(<Harness />);
    fireEvent.click(await view.findByRole("button", { name: "查看未读批注，共 1 条" }));
    expect(await view.findByRole("button", { name: "查看该段批注，共 1 条" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "已处理" }));
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith("thread-status", "resolved"));
    await waitFor(() => expect(view.queryByRole("button", { name: /查看该段批注/ })).toBeNull());
  });

  it("does not reattach an old AI comment to a different paragraph with the same phrase", async () => {
    const view = render(<PlateDocumentEditor
      aiCommentThreads={[{
        id: "thread-old",
        blockIndex: 0,
        blockText: "原段落中的数据还需要核对。",
        targetText: "数据还需要核对",
        createdAt: "2026-08-27T01:00:00.000Z",
        comments: [{ id: "comment-old", role: "assistant", content: "旧依据", createdAt: "2026-08-27T01:00:00.000Z" }],
      }]}
      onChange={() => undefined}
      value="<p>另一段的数据还需要核对，但依据不同。</p>"
    />);
    await waitFor(() => expect(view.queryByRole("button", { name: /查看未读批注/ })).toBeNull());
  });

  it("shows independent AI issue threads together on the same paragraph", async () => {
    const blockText = "这个方案最好，而且一次测试已经足以证明它适合所有同学。";
    const view = render(
      <PlateDocumentEditor
        aiCommentThreads={[
          {
            id: "thread-standard",
            blockIndex: 0,
            blockText,
            targetText: "这个方案最好",
            createdAt: "2026-08-27T01:00:00.000Z",
            reviewVersion: 2,
            comments: [{
              id: "comment-standard",
              role: "assistant",
              content: "这里的“最好”具体是在比较效果、成本，还是实施难度？",
              createdAt: "2026-08-27T01:00:00.000Z",
            }],
          },
          {
            id: "thread-evidence",
            blockIndex: 0,
            blockText,
            targetText: "一次测试已经足以证明它适合所有同学",
            createdAt: "2026-08-27T01:00:01.000Z",
            reviewVersion: 2,
            comments: [{
              id: "comment-evidence",
              role: "assistant",
              content: "一次测试就能代表所有同学吗？我们可能还需要看看测试对象和条件。",
              createdAt: "2026-08-27T01:00:01.000Z",
            }],
          },
        ]}
        onChange={() => undefined}
        value={`<p>${blockText}</p>`}
      />,
    );

    fireEvent.click(await view.findByRole("button", { name: "查看未读批注，共 2 条" }));
    expect(await view.findByText(/“最好”具体是在比较效果/)).toBeTruthy();
    expect(await view.findByText(/一次测试就能代表所有同学吗/)).toBeTruthy();
    const popover = document.querySelector("[data-radix-popper-content-wrapper]");
    expect(popover?.textContent).toContain("这个方案最好");
    expect(popover?.textContent).toContain("一次测试已经足以证明它适合所有同学");
    expect(popover?.textContent).not.toContain(blockText);
    expect(await view.findAllByText("回复…")).toHaveLength(2);
  });

  it("marks an AI-requested deletion from a comment as a confirmable Plate suggestion", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();
    const view = render(
      <PlateDocumentEditor
        onChange={() => undefined}
        ref={editorRef}
        value="<p>核心依据。这句话与当前论证无关。下一项依据。</p>"
      />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    const selection = editorRef.current?.resolveCommentSelection({
      blockIndex: 0,
      expectedBlockText: "核心依据。这句话与当前论证无关。下一项依据。",
      targetText: "这句话与当前论证无关。",
    });
    expect(selection?.text).toBe("这句话与当前论证无关。");

    let preview: ReturnType<PlateDocumentEditorHandle["previewAiSuggestion"]> | undefined;
    act(() => {
      preview = selection
        ? editorRef.current?.previewAiSuggestion({
            operation: "replace",
            ...selection,
            replacement: "",
          })
        : undefined;
    });
    expect(preview).toEqual(expect.objectContaining({ ok: true }));
    expect(view.container.textContent).toContain("这句话与当前论证无关。");

    act(() => {
      editorRef.current?.resolveAiSuggestion("accepted");
    });
    await waitFor(() => {
      expect(view.container.querySelector("[data-slate-editor]")?.textContent)
        .toBe("核心依据。下一项依据。");
    });
  });

  it("routes the Plate-style comment suggestion card back to student confirmation", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();
    const onDecision = vi.fn();
    const view = render(
      <PlateDocumentEditor
        aiCommentThreads={[{
          id: "thread-pending",
          blockIndex: 0,
          targetText: "需要修改的句子。",
          createdAt: "2026-08-27T01:00:00.000Z",
          comments: [{
            id: "comment-pending",
            role: "assistant",
            content: "我准备了修改，请确认是否接受。",
            createdAt: "2026-08-27T01:00:00.000Z",
          }],
        }]}
        onAiSuggestionDecision={onDecision}
        onChange={() => undefined}
        pendingAiCommentSuggestion={{
          threadId: "thread-pending",
          assistantCommentId: "comment-pending",
          title: "调整表述",
          targetText: "需要修改",
          replacement: "建议调整",
          reason: "使动作更加明确。",
        }}
        ref={editorRef}
        value="<p>需要修改的句子。</p>"
      />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());
    const selection = editorRef.current?.resolveCommentSelection({
      blockIndex: 0,
      expectedBlockText: "需要修改的句子。",
      targetText: "需要修改",
    });
    let preview: ReturnType<PlateDocumentEditorHandle["previewAiSuggestion"]> | undefined;
    act(() => {
      if (!selection) return;
      preview = editorRef.current?.previewAiSuggestion({
        operation: "replace",
        ...selection,
        replacement: "建议调整",
      });
    });
    expect(preview).toEqual(expect.objectContaining({ ok: true }));

    const marker = await view.findByRole("button", { name: "查看未读批注，共 1 条" });
    fireEvent.click(marker);
    expect(view.queryByText("我准备了修改，请确认是否接受。")).toBeNull();
    expect((await view.findAllByText("建议调整")).length).toBeGreaterThan(0);
    expect(view.queryByText("刚刚")).toBeNull();
    expect(view.queryByPlaceholderText("回复…")).toBeNull();
    const suggestionCard = document.querySelector("[data-ai-comment-suggestion]");
    expect(suggestionCard).not.toBeNull();
    const accept = await view.findByRole("button", { name: "接受修改" });
    expect(view.getByRole("button", { name: "拒绝修改" })).toBeTruthy();
    fireEvent.click(accept);
    expect(onDecision).toHaveBeenCalledWith("accepted");
  });

  it("shows a local addition as one unified confirmation card", async () => {
    const view = render(
      <PlateDocumentEditor
        aiCommentThreads={[{
          id: "thread-insert",
          blockIndex: 0,
          targetText: "第一项依据。",
          createdAt: "2026-08-27T01:00:00.000Z",
          comments: [{
            id: "comment-insert",
            role: "assistant",
            content: "可以补上资料来源，让这项依据更容易核验。",
            createdAt: "2026-08-27T01:00:00.000Z",
          }],
        }]}
        onChange={() => undefined}
        pendingAiCommentSuggestion={{
          threadId: "thread-insert",
          assistantCommentId: "comment-insert",
          title: "补充资料来源",
          targetText: "第一项依据。",
          replacement: "第一项依据。资料来源为校园广播站本周节目记录。",
          reason: "补上来源后，这项依据更容易核验。",
        }}
        value="<p>第一项依据。</p>"
      />,
    );

    fireEvent.click(await view.findByRole("button", { name: "查看未读批注，共 1 条" }));
    expect(await view.findByText("新增：")).toBeTruthy();
    expect(view.getByText("资料来源为校园广播站本周节目记录。")).toBeTruthy();
    expect(view.getByText("在“第一项依据。”之后")).toBeTruthy();
    expect(view.queryByText("替换为：")).toBeNull();
    expect(view.queryByPlaceholderText("回复…")).toBeNull();
  });

  it("keeps Plate AI red/green diff nodes transient until confirmation", () => {
    expect(hasTransientPlateSuggestion([
      {
        type: "p",
        children: [
          { text: "原文", suggestionTransient: true },
          { text: "建议文本" },
        ],
      },
    ])).toBe(true);
    expect(hasTransientPlateSuggestion([
      { type: "p", children: [{ text: "已确认文本" }] },
    ])).toBe(false);
  });

  it("uses Plate native remove and insert suggestions for an AI rewrite", () => {
    const editor = createPlateEditor({
      plugins: EditorKit,
      value: [
        { id: "paragraph-1", type: "p", children: [{ text: "这个方案非常非常好。" }] },
      ],
    });
    editor.tf.select({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 10 },
    });
    editor.setOption(AIChatPlugin, "chatNodes", editor.api.fragment());

    applyAISuggestions(editor, "这个方案很好。");

    const diff = JSON.stringify(editor.children);
    expect(hasTransientPlateSuggestion(editor.children)).toBe(true);
    expect(diff).toContain('"type":"remove"');
    expect(diff).toContain('"type":"insert"');
  });

  it("marks a local AI cursor insertion as a transient green suggestion", () => {
    const editor = createPlateEditor({
      plugins: EditorKit,
      value: [
        { id: "paragraph-1", type: "p", children: [{ text: "已有内容" }] },
      ],
    });
    editor.tf.select({
      anchor: { path: [0, 0], offset: 4 },
      focus: { path: [0, 0], offset: 4 },
    });
    insertTransientPlateSuggestion(editor, "新增的辅助说明");

    const diff = JSON.stringify(editor.children);
    expect(hasTransientPlateSuggestion(editor.children)).toBe(true);
    expect(diff).toContain('"type":"insert"');
    expect(diff).toContain("新增的辅助说明");

    rejectAISuggestions(editor);
    expect(JSON.stringify(editor.children)).not.toContain("新增的辅助说明");
    expect(hasTransientPlateSuggestion(editor.children)).toBe(false);
  });

  it("applies an exact-range replacement and keeps model markup as text", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();

    function Harness() {
      const [value, setValue] = useState("<p>学生原文</p>");
      return <PlateDocumentEditor onChange={setValue} ref={editorRef} value={value} />;
    }

    const view = render(<Harness />);
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    let result: ReturnType<PlateDocumentEditorHandle["replaceRange"]> | undefined;
    act(() => {
      result = editorRef.current?.replaceRange({
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 4 },
        text: "学生原文",
        replacement: "AI <script>建议",
      });
    });

    expect(result?.ok).toBe(true);
    await waitFor(() => {
      expect(view.container.querySelector("[data-slate-editor]")?.textContent).toBe("AI <script>建议");
    });
    expect(view.container.querySelector("script")).toBeNull();
  });

  it("refuses to overwrite a range that changed after the suggestion was generated", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();
    render(<PlateDocumentEditor onChange={() => undefined} ref={editorRef} value="<p>新原文</p>" />);
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    const result = editorRef.current?.replaceRange({
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 0], offset: 3 },
      text: "旧原文",
      replacement: "AI 建议",
    });
    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain("发生了变化");
  });

  it("previews a local edit with transient Plate suggestions before accepting it", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();
    const changes: string[] = [];
    const view = render(
      <PlateDocumentEditor
        onChange={(html) => changes.push(html)}
        ref={editorRef}
        value="<p>学生原文</p>"
      />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    let preview: ReturnType<PlateDocumentEditorHandle["previewAiSuggestion"]> | undefined;
    act(() => {
      preview = editorRef.current?.previewAiSuggestion({
        operation: "replace",
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 4 },
        text: "学生原文",
        replacement: "更清楚的学生原文",
      });
    });

    expect(preview?.ok).toBe(true);
    expect(preview?.presentation).toBe("inline");
    expect(changes).toHaveLength(0);

    let accepted: ReturnType<PlateDocumentEditorHandle["resolveAiSuggestion"]> | undefined;
    act(() => {
      accepted = editorRef.current?.resolveAiSuggestion("accepted");
    });

    expect(accepted?.ok).toBe(true);
    expect(accepted?.afterHtml).toContain("更清楚的学生原文");
    await waitFor(() => {
      expect(view.container.querySelector("[data-slate-editor]")?.textContent).toBe("更清楚的学生原文");
    });
  });

  it("uses paragraph-level presentation for a multi-block edit and can reject it", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();
    const view = render(
      <PlateDocumentEditor
        onChange={() => undefined}
        ref={editorRef}
        value="<p>第一段</p><p>第二段</p>"
      />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    let preview: ReturnType<PlateDocumentEditorHandle["previewAiSuggestion"]> | undefined;
    act(() => {
      preview = editorRef.current?.previewAiSuggestion({
        operation: "replace",
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [1, 0], offset: 3 },
        text: "第一段\n\n第二段",
        replacement: "整理后的第一段\n\n整理后的第二段",
      });
    });
    expect(preview?.ok).toBe(true);
    expect(preview?.presentation).toBe("blocks");
    await waitFor(() => {
      expect(view.container.querySelectorAll('[data-block-suggestion="true"]').length).toBeGreaterThanOrEqual(4);
    });

    let rejected: ReturnType<PlateDocumentEditorHandle["resolveAiSuggestion"]> | undefined;
    act(() => {
      rejected = editorRef.current?.resolveAiSuggestion("rejected");
    });
    expect(rejected?.ok).toBe(true);
    await waitFor(() => {
      expect(view.container.querySelector("[data-slate-editor]")?.textContent).toBe("第一段第二段");
      expect(view.container.querySelector('[data-block-suggestion="true"]')).toBeNull();
    });
  });

  it("applies an approved teammate plan at the AI-selected paragraph", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();
    const view = render(
      <PlateDocumentEditor
        onChange={() => undefined}
        ref={editorRef}
        value="<p>已有项目内容</p>"
      />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    let result: ReturnType<PlateDocumentEditorHandle["applyDelegatedWorkPlan"]> | undefined;
    act(() => {
      result = editorRef.current?.applyDelegatedWorkPlan([{
        operation: "insert-after",
        targetText: "已有项目内容",
        content: "## 组员交付\n\n| 指标 | 数值 |\n|---|---|\n| 示例 | 待核验 |",
        description: "在已有项目内容后加入资料表",
      }]);
    });

    expect(result?.ok).toBe(true);
    expect(result?.afterHtml).toContain("组员交付");
    expect(result?.afterHtml).toContain("待核验");
    expect(result?.afterHtml).not.toContain("suggestionTransient");
    await waitFor(() => {
      expect(view.container.querySelector("[data-slate-editor]")?.textContent).toContain("组员交付");
    });
  });

  it("atomically replaces and deletes AI-selected paragraphs without a cursor", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();
    const view = render(
      <PlateDocumentEditor
        onChange={() => undefined}
        ref={editorRef}
        value="<p>旧的辅助说明</p><p>重复内容</p><p>核心内容保持不变</p>"
      />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    let result: ReturnType<PlateDocumentEditorHandle["applyDelegatedWorkPlan"]> | undefined;
    act(() => {
      result = editorRef.current?.applyDelegatedWorkPlan([
        {
          operation: "replace",
          targetText: "旧的辅助说明",
          content: "更新后的辅助说明",
          description: "更新辅助说明",
        },
        {
          operation: "delete",
          targetText: "重复内容",
          content: "",
          description: "删除重复段落",
        },
      ]);
    });

    expect(result?.ok).toBe(true);
    expect(result?.afterHtml).toContain("更新后的辅助说明");
    expect(result?.afterHtml).not.toContain("重复内容");
    await waitFor(() => {
      const text = view.container.querySelector("[data-slate-editor]")?.textContent ?? "";
      expect(text).toContain("更新后的辅助说明");
      expect(text).toContain("核心内容保持不变");
      expect(text).not.toContain("重复内容");
    });
  });

  it("restores the full document when an AI-selected target is stale", async () => {
    const editorRef = createRef<PlateDocumentEditorHandle>();
    const view = render(
      <PlateDocumentEditor onChange={() => undefined} ref={editorRef} value="<p>当前段落</p>" />,
    );
    await waitFor(() => expect(editorRef.current).not.toBeNull());

    const result = editorRef.current?.applyDelegatedWorkPlan([
      {
        operation: "append",
        targetText: "",
        content: "不应保留的新增内容",
        description: "先新增",
      },
      {
        operation: "replace",
        targetText: "已经变化的段落",
        content: "替换内容",
        description: "再替换",
      },
    ]);

    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain("已经发生变化");
    await waitFor(() => {
      expect(view.container.querySelector("[data-slate-editor]")?.textContent).toBe("当前段落");
    });
  });
});
