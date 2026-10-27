'use client';

import * as React from 'react';
import { KEYS, NodeApi, PathApi, PointApi, RangeApi, TextApi, type TElement, type TRange, type TText, type Value } from 'platejs';
import { Plate, usePlateEditor } from 'platejs/react';
import { withAIBatch } from '@platejs/ai';
import {
  AIChatPlugin,
  acceptAISuggestions,
  applyAISuggestions,
  rejectAISuggestions,
} from '@platejs/ai/react';
import { getCommentKey } from '@platejs/comment';
import { getSuggestionProps, getTransientSuggestionKey } from '@platejs/suggestion';
import { deserializeMd } from '@platejs/markdown';

import { EditorKit } from '@/components/editor/editor-kit';
import {
  OpenPblEditorProvider,
  type OpenPblEditorAiContext,
  type EditorAiMemberControls,
} from '@/components/editor/openpbl-editor-context';
import { aiChatPlugin } from '@/components/editor/plugins/ai-kit';
import {
  type AiPendingCommentSuggestion,
  discussionPlugin,
  type TDiscussion,
} from '@/components/editor/plugins/discussion-kit';
import { suggestionPlugin } from '@/components/editor/plugins/suggestion-kit';
import { Editor, EditorContainer } from '@/components/ui/editor';
import { TooltipProvider } from '@/components/ui/tooltip';
import type {
  DocumentAiCommentThread,
  DocumentBlockCandidate,
} from '@/lib/ai-collaboration/document-comment-types';
import { documentAiCommentStatus } from '@/lib/ai-collaboration/document-comment-types';
import { documentAiCommentBlockCandidates } from '@/lib/block-discussion-index';
import { DOCUMENT_BLOCK_ID_ATTRIBUTE, isDocumentBlockId, resolveDocumentCommentAnchor, withoutDocumentBlockIds } from '@/lib/ai-collaboration/document-comment-anchor';
import type { DelegatedWorkDocumentAction } from '@/lib/ai-collaboration/document-policy';
import { normalizeMonitorText } from '@/lib/project-practice/content-monitor-text';

export type PlateSelectionPoint = { path: number[]; offset: number };

export type PlateDocumentSelection = {
  anchor: PlateSelectionPoint;
  focus: PlateSelectionPoint;
  text: string;
  rect?: { left: number; top: number };
};

/** Observes browser pastes only; editor/AI transforms never emit this event. */
export type PlateDocumentPaste = {
  text: string;
  beforeText: string;
  blockId?: string;
  internalTransfer?: boolean;
  /** Captured from Plate nodes after the native paste has actually applied. */
  documentText?: string;
};

export type PlateAiPreviewResult = {
  ok: boolean;
  reason?: string;
  beforeHtml?: string;
  afterHtml?: string;
  presentation?: 'inline' | 'blocks';
};

export type PlateDocumentEditorHandle = {
  getBlockCandidates: () => DocumentBlockCandidate[];
  resolveCommentSelection: (input: {
    blockId?: string;
    anchorVersion?: 1;
    blockIndex: number;
    expectedBlockText: string;
    targetText: string;
  }) => PlateDocumentSelection | null;
  replaceRange: (input: PlateDocumentSelection & { replacement: string }) => {
    ok: boolean;
    reason?: string;
    beforeHtml?: string;
    afterHtml?: string;
  };
  insertAtCursor: (text: string) => {
    ok: boolean;
    reason?: string;
    beforeHtml?: string;
    afterHtml?: string;
  };
  applyDelegatedWorkPlan: (actions: DelegatedWorkDocumentAction[]) => {
    ok: boolean;
    reason?: string;
    beforeHtml?: string;
    afterHtml?: string;
  };
  previewDelegatedWorkPlan: (actions: DelegatedWorkDocumentAction[]) => PlateAiPreviewResult;
  previewAiSuggestion: (input:
    | ({ operation: 'replace'; replacement: string } & PlateDocumentSelection)
    | { operation: 'insert'; replacement: string }
  ) => PlateAiPreviewResult;
  resolveAiSuggestion: (decision: 'accepted' | 'rejected') => PlateAiPreviewResult;
  focus: () => void;
};

type PlateDocumentEditorProps = {
  value: string;
  onChange: (html: string) => void;
  aiContext?: OpenPblEditorAiContext;
  appliedAiEdit?: {
    title: string;
    onUndo: () => void;
  };
  aiCommentThreads?: DocumentAiCommentThread[];
  pendingAiCommentSuggestion?: AiPendingCommentSuggestion;
  onSelectionChange?: (selection: PlateDocumentSelection | null) => void;
  onDocumentPaste?: (paste: PlateDocumentPaste) => void;
  onOpenAiMember?: () => void;
  aiMemberControls?: EditorAiMemberControls;
  containedWorkspace?: boolean;
  onAiCommentRead?: (input: { threadId: string }) => Promise<void>;
  onAiCommentReply?: (input: { threadId: string; message: string }) => Promise<void>;
  onAiCommentStatusChange?: (input: { threadId: string; status: 'open' | 'resolved' | 'deferred' | 'not-applicable' }) => Promise<void>;
  onAiSuggestionDecision?: (decision: 'accepted' | 'rejected') => void;
  placeholder?: string;
  minHeight?: number;
  stickyToolbarTop?: number;
  onImageUpload?: (file: File) => Promise<string>;
  /** Human-readable name of the editable proxy shown in status/error copy. */
  workspaceLabel?: string;
};

const EMPTY_VALUE: Value = [{ type: 'p', children: [{ text: '' }] }];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return /^(https?:|mailto:|\/)/i.test(trimmed) ? escapeHtml(trimmed) : '';
}

function serializeText(node: TText & Record<string, unknown>): string {
  let html = escapeHtml(node.text).replace(/\n/g, '<br>');
  if (node.code) html = `<code>${html}</code>`;
  if (node.bold) html = `<strong>${html}</strong>`;
  if (node.italic) html = `<em>${html}</em>`;
  if (node.underline) html = `<u>${html}</u>`;
  if (node.strikethrough) html = `<s>${html}</s>`;
  if (node.highlight) html = `<mark>${html}</mark>`;
  if (node.superscript) html = `<sup>${html}</sup>`;
  if (node.subscript) html = `<sub>${html}</sub>`;

  const styles = [
    typeof node.fontSize === 'string' ? `font-size:${escapeHtml(node.fontSize)}` : '',
    typeof node.color === 'string' ? `color:${escapeHtml(node.color)}` : '',
    typeof node.backgroundColor === 'string'
      ? `background-color:${escapeHtml(node.backgroundColor)}`
      : '',
    typeof node.fontFamily === 'string'
      ? `font-family:${escapeHtml(node.fontFamily)}`
      : '',
  ]
    .filter(Boolean)
    .join(';');

  return styles ? `<span style="${styles}">${html}</span>` : html;
}

function serializeChildren(nodes: (Value[number] | TText)[]): string {
  const parts: string[] = [];
  let pending: (TText & Record<string, unknown>) | undefined;
  let pendingFormat: string | undefined;
  const flush = () => {
    if (pending) parts.push(serializeText(pending));
    pending = undefined;
  };

  for (const node of nodes) {
    if (TextApi.isText(node)) {
      // Comment marks split Slate leaves without changing saved formatting.
      // Compare the actual serialized formats, keeping editor nodes untouched.
      const format = serializeText({ ...node, text: '' });
      if (pending && format === pendingFormat) {
        pending.text += node.text;
      } else {
        flush();
        pending = { ...node };
        pendingFormat = format;
      }
    } else {
      flush();
      parts.push(serializeNode(node));
    }
  }
  flush();
  return parts.join('');
}

function serializeNode(node: Value[number] | TText): string {
  const html = serializeNodeContent(node);
  if (TextApi.isText(node) || !isDocumentBlockId(node.id)) return html;
  const tag = (node as TElement).type === 'img' ? /<img\b/ : /^<(?:p|h[1-6]|blockquote|table|tr|td|th|pre|hr)\b/;
  return html.replace(tag, (opening) => `${opening} ${DOCUMENT_BLOCK_ID_ATTRIBUTE}="${node.id}"`);
}

function serializeNodeContent(node: Value[number] | TText): string {
  if ('text' in node) {
    return serializeText(node as TText & Record<string, unknown>);
  }

  const element = node as TElement & Record<string, unknown>;
  const children = serializeChildren(element.children);
  const styles = [
    typeof element.align === 'string' ? `text-align:${escapeHtml(element.align)}` : '',
    typeof element.lineHeight === 'number' || typeof element.lineHeight === 'string'
      ? `line-height:${escapeHtml(String(element.lineHeight))}`
      : '',
    typeof element.indent === 'number' && element.indent > 0
      ? `margin-left:${element.indent * 24}px`
      : '',
  ]
    .filter(Boolean)
    .join(';');
  const style = styles ? ` style="${styles}"` : '';

  switch (element.type) {
    case 'h1': return `<h1${style}>${children}</h1>`;
    case 'h2': return `<h2${style}>${children}</h2>`;
    case 'h3': return `<h3${style}>${children}</h3>`;
    case 'h4': return `<h4${style}>${children}</h4>`;
    case 'h5': return `<h5${style}>${children}</h5>`;
    case 'h6': return `<h6${style}>${children}</h6>`;
    case 'blockquote': return `<blockquote${style}>${children}</blockquote>`;
    case 'a': {
      const href = safeUrl(element.url);
      return href ? `<a href="${href}" target="_blank" rel="noreferrer">${children}</a>` : children;
    }
    case 'img': {
      const src = safeUrl(element.url);
      return src ? `<figure><img src="${src}" alt="项目文档图片"></figure>` : '';
    }
    case 'table': return `<table><tbody>${children}</tbody></table>`;
    case 'tr': return `<tr>${children}</tr>`;
    case 'td': return `<td>${children}</td>`;
    case 'th': return `<th>${children}</th>`;
    case 'code_block': return `<pre><code>${children}</code></pre>`;
    case 'code_line': return `${children}\n`;
    case 'hr': return '<hr>';
    default: {
      const listType = typeof element.listStyleType === 'string' ? element.listStyleType : '';
      if (listType) return `<p${style} data-list-style="${escapeHtml(listType)}">${children}</p>`;
      return `<p${style}>${children}</p>`;
    }
  }
}

export function serializePlateDocument(value: Value): string {
  return serializeChildren(value);
}

export function hasTransientPlateSuggestion(value: Value): boolean {
  const transientKey = getTransientSuggestionKey();

  const visit = (node: Value[number] | TText): boolean => {
    const record = node as (Value[number] | TText) & Record<string, unknown>;
    if (record[transientKey]) return true;
    if (!('children' in record) || !Array.isArray(record.children)) return false;
    return record.children.some((child) => visit(child as Value[number] | TText));
  };

  return value.some((node) => visit(node));
}

export function insertTransientPlateSuggestion(
  editor: Parameters<typeof deserializeMd>[0],
  markdown: string,
): void {
  const suggestionId = `ai-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const transientKey = getTransientSuggestionKey();
  const markNode = (node: Value[number] | TText): Value[number] | TText => {
    if ('text' in node) {
      return {
        ...node,
        ...getSuggestionProps(editor, node, { id: suggestionId, transient: true }),
      } as TText;
    }

    return {
      ...node,
      ...getSuggestionProps(editor, node, { id: suggestionId, transient: true }),
      [transientKey]: true,
      children: node.children.map((child) => markNode(child as Value[number] | TText)),
    } as Value[number];
  };

  const nodes = deserializeMd(editor, markdown).map((node) => markNode(node)) as Value;
  editor.tf.insertFragment(nodes);
}

// Plan against a detached array so a later invalid anchor cannot partially edit
// the live document. Unchanged nodes retain their identity for the preview.
function planDelegatedDocumentValue(
  editor: Parameters<typeof deserializeMd>[0],
  beforeValue: Value,
  actions: DelegatedWorkDocumentAction[],
  workspaceNoun: string,
): Value {
  const next = [...beforeValue];
  for (const action of actions) {
    if (action.operation === 'none') continue;
    const target = action.targetText.replace(/\s+/g, ' ').trim();
    const matches = next.flatMap((node, index) =>
      target && NodeApi.string(node).replace(/\s+/g, ' ').trim() === target ? [index] : []);
    if (action.operation !== 'append' && matches.length !== 1) {
      throw new Error(matches.length > 1
        ? `${workspaceNoun}中存在多个相同的目标段落：“${action.targetText.slice(0, 80)}”`
        : `AI 计划定位的段落已经发生变化：“${action.targetText.slice(0, 80)}”`);
    }
    const nodes = action.content ? deserializeMd(editor, action.content) : [];
    if (action.operation !== 'delete' && !nodes.length) {
      throw new Error('AI 计划中有一项操作缺少可写入的内容。');
    }
    const index = matches[0];
    if (action.operation === 'append') next.push(...nodes);
    else if (action.operation === 'insert-before') next.splice(index, 0, ...nodes);
    else if (action.operation === 'insert-after') next.splice(index + 1, 0, ...nodes);
    else if (action.operation === 'replace') next.splice(index, 1, ...nodes);
    else next.splice(index, 1);
  }
  return next;
}

function cloneSelection(selection: TRange, text: string): PlateDocumentSelection {
  return {
    anchor: { path: [...selection.anchor.path], offset: selection.anchor.offset },
    focus: { path: [...selection.focus.path], offset: selection.focus.offset },
    text,
  };
}

function findUniqueTextRange(
  block: Value[number],
  blockIndex: number,
  targetText: string,
): TRange | null {
  const blockText = NodeApi.string(block);
  const startOffset = blockText.indexOf(targetText);
  if (
    startOffset < 0
    || blockText.indexOf(targetText, startOffset + targetText.length) >= 0
  ) return null;

  const entries = [...NodeApi.texts(block)];
  const pointAtOffset = (offset: number): PlateSelectionPoint | null => {
    let consumed = 0;
    for (const [textNode, relativePath] of entries) {
      const next = consumed + textNode.text.length;
      if (offset <= next) {
        return {
          path: [blockIndex, ...relativePath],
          offset: Math.max(0, offset - consumed),
        };
      }
      consumed = next;
    }
    return null;
  };
  const anchor = pointAtOffset(startOffset);
  const focus = pointAtOffset(startOffset + targetText.length);
  return anchor && focus ? { anchor, focus } : null;
}

function documentBlockCandidates(value: Value): DocumentBlockCandidate[] {
  return value.map((node, blockIndex) => ({
    blockId: typeof (node as TElement).id === 'string' ? (node as TElement).id as string : undefined,
    blockIndex,
    text: NodeApi.string(node).trim(),
    type: String((node as TElement).type ?? ''),
  })).filter(candidate => candidate.text.length > 0);
}

function hasMeaningfulAiComment(value: string): boolean {
  return value.replace(/[\p{P}\p{S}\s]/gu, '').length >= 2;
}

export const PlateDocumentEditor = React.forwardRef<PlateDocumentEditorHandle, PlateDocumentEditorProps>(
  function PlateDocumentEditor({
    aiContext,
    appliedAiEdit,
    aiCommentThreads = [],
    minHeight = 650,
    onChange,
    onImageUpload,
    onOpenAiMember,
    aiMemberControls,
    containedWorkspace = false,
    onAiCommentRead,
    onAiCommentReply,
    onAiCommentStatusChange,
    onAiSuggestionDecision,
    onSelectionChange,
    onDocumentPaste,
    pendingAiCommentSuggestion,
    placeholder = '在这里输入内容…',
    stickyToolbarTop = 0,
    value,
    workspaceLabel = '文档',
  }, ref) {
    const workspaceNoun = workspaceLabel;
    const editor = usePlateEditor({ plugins: EditorKit, value: value || EMPTY_VALUE });
    const unifiedEditorStyle = React.useMemo<React.CSSProperties>(
      () => ({ minHeight: containedWorkspace ? `${minHeight}px` : `max(${minHeight}px, calc(100vh - 210px))` }),
      [minHeight, containedWorkspace]
    );
    const shellRef = React.useRef<HTMLDivElement>(null);
    const editorRef = React.useRef<HTMLDivElement>(null);
    const copiedDocumentTextRef = React.useRef('');
    const pendingPastesRef = React.useRef<Array<{ paste: PlateDocumentPaste; expiresAt: number }>>([]);
    const lastControlledValueRef = React.useRef(value);
    const lastEmittedRef = React.useRef<string | null>(null);
    if (lastEmittedRef.current === null) {
      // Hydrated/legacy HTML may contain redundant adjacent format wrappers.
      // Normalizing that baseline must not count as a student edit.
      lastEmittedRef.current = serializePlateDocument(editor.children);
    }
    const aiPreviewRef = React.useRef<{
      beforeHtml: string;
      beforeValue: Value;
      presentation: 'inline' | 'blocks';
    } | null>(null);

    React.useEffect(() => {
      document.body.classList.add('plate-default-theme');

      return () => {
        document.body.classList.remove('plate-default-theme');
      };
    }, []);

    React.useEffect(() => {
      if (!onDocumentPaste) pendingPastesRef.current = [];
    }, [onDocumentPaste]);

    React.useEffect(() => {
      if (value === lastControlledValueRef.current) return;
      lastControlledValueRef.current = value;
      if (value === lastEmittedRef.current) return;
      pendingPastesRef.current = [];
      const nextValue = (value ? editor.api.html.deserialize({ element: value }) : EMPTY_VALUE) as Value;
      lastEmittedRef.current = serializePlateDocument(nextValue);
      editor.tf.setValue(nextValue);
      lastEmittedRef.current = serializePlateDocument(editor.children);
    }, [editor, value]);

    React.useEffect(() => {
      editor.setOption(aiChatPlugin, 'chatOptions', {
        api: '/api/ai/command',
        body: aiContext ?? {},
      });
    }, [aiContext, editor]);

    React.useEffect(() => {
      editor.setOption(
        discussionPlugin,
        'onAiRead',
        onAiCommentRead
          ? ({ discussionId }) => onAiCommentRead({ threadId: discussionId })
          : undefined,
      );
      editor.setOption(
        discussionPlugin,
        'onAiReply',
        onAiCommentReply
          ? ({ discussionId, message }) => onAiCommentReply({ threadId: discussionId, message })
          : undefined,
      );
      editor.setOption(
        discussionPlugin,
        'onAiStatusChange',
        onAiCommentStatusChange
          ? ({ discussionId, status }) => onAiCommentStatusChange({ threadId: discussionId, status })
          : undefined,
      );
      editor.setOption(
        discussionPlugin,
        'onAiSuggestionDecision',
        onAiSuggestionDecision,
      );
      editor.setOption(
        discussionPlugin,
        'pendingAiCommentSuggestion',
        pendingAiCommentSuggestion,
      );
    }, [editor, onAiCommentRead, onAiCommentReply, onAiCommentStatusChange, onAiSuggestionDecision, pendingAiCommentSuggestion]);

    React.useEffect(() => {
      const existingDiscussions = editor
        .getOption(discussionPlugin, 'discussions')
        .filter((discussion) => discussion.source !== 'ai-proactive');
      const candidates = documentAiCommentBlockCandidates(editor);
      const activeThreads = aiCommentThreads
        .filter((thread) => documentAiCommentStatus(thread) === 'open')
        .map((thread) => ({ thread, index: resolveDocumentCommentAnchor(thread, candidates) }))
        .filter((entry) => entry.index >= 0);
      const aiDiscussions: TDiscussion[] = activeThreads.map(({ thread }) => ({
        id: thread.id,
        comments: thread.comments
          .filter((comment) =>
            comment.role === 'student' || hasMeaningfulAiComment(comment.content)
          )
          .map((comment) => ({
          id: comment.id,
          contentRich: [{ type: 'p', children: [{ text: comment.content }] }],
          createdAt: new Date(comment.createdAt),
          discussionId: thread.id,
          isEdited: false,
          userId: comment.role === 'student' ? 'student' : 'ai-member',
          })),
        createdAt: new Date(thread.createdAt),
        documentContent: thread.targetText,
        aiAnchor: {
          blockId: thread.blockId,
          anchorVersion: thread.anchorVersion,
          blockIndex: thread.blockIndex,
          blockText: thread.blockText,
          targetText: thread.targetText,
        },
        isResolved: false,
        aiStatus: documentAiCommentStatus(thread),
        isUnread: (() => {
          const latestAssistantAt = thread.comments
            .filter((comment) => comment.role === 'assistant')
            .map((comment) => Date.parse(comment.createdAt))
            .sort((left, right) => right - left)[0];
          return Boolean(
            latestAssistantAt
            && (!thread.readAt || Date.parse(thread.readAt) < latestAssistantAt)
          );
        })(),
        source: 'ai-proactive',
        userId: 'ai-member',
      }));
      editor.setOption(discussionPlugin, 'discussions', [
        ...existingDiscussions,
        ...aiDiscussions,
      ]);

    }, [aiCommentThreads, editor, value]);

    // Server-owned AI comments are a view of the current document. Applying
    // split/set/unset transforms here would enter Undo history; skipping their
    // history instead would leave earlier text operations with stale leaf paths.
    // Decorations keep both the document tree and its real edit history intact.
    const decorateAiComments = React.useCallback<
      NonNullable<React.ComponentProps<typeof Editor>['decorate']>
    >(({ entry: [node, path] }) => {
      if (path.length !== 1 || TextApi.isText(node)) return [];
      const candidates = documentAiCommentBlockCandidates(editor);
      return aiCommentThreads.flatMap((thread) => {
        if (documentAiCommentStatus(thread) !== 'open'
          || resolveDocumentCommentAnchor(thread, candidates) !== path[0]) return [];
        const range = findUniqueTextRange(node as Value[number], path[0], thread.targetText);
        return range ? [{ ...range, [KEYS.comment]: true, [getCommentKey(thread.id)]: true }] : [];
      });
    }, [aiCommentThreads, editor]);

    React.useImperativeHandle(ref, () => ({
      focus: () => editorRef.current?.focus(),
      getBlockCandidates: () => documentBlockCandidates(editor.children),
      resolveCommentSelection: (input) => {
        const resolvedIndex = resolveDocumentCommentAnchor({ ...input, blockText: input.expectedBlockText },
          documentBlockCandidates(editor.children));
        if (resolvedIndex < 0) return null;

        const block = editor.children[resolvedIndex];
        const blockText = NodeApi.string(block);
        const startOffset = blockText.indexOf(input.targetText);
        if (
          startOffset < 0
          || blockText.indexOf(input.targetText, startOffset + input.targetText.length) >= 0
        ) return null;

        const entries = [...NodeApi.texts(block)];
        const pointAtOffset = (offset: number): PlateSelectionPoint | null => {
          let consumed = 0;
          for (const [textNode, relativePath] of entries) {
            const next = consumed + textNode.text.length;
            if (offset <= next) {
              return {
                path: [resolvedIndex, ...relativePath],
                offset: Math.max(0, offset - consumed),
              };
            }
            consumed = next;
          }
          return null;
        };
        const anchor = pointAtOffset(startOffset);
        const focus = pointAtOffset(startOffset + input.targetText.length);
        return anchor && focus
          ? { anchor, focus, text: input.targetText }
          : null;
      },
      insertAtCursor: (text) => {
        pendingPastesRef.current = [];
        try {
          const beforeHtml = serializePlateDocument(editor.children);
          editor.getApi(suggestionPlugin).suggestion.withoutSuggestions(() => {
            if (editor.selection && editor.api.isExpanded()) {
              editor.tf.collapse({ edge: 'end' });
            }
            editor.tf.insertText(text);
          });
          const afterHtml = serializePlateDocument(editor.children);
          if (beforeHtml === afterHtml) return { ok: false, reason: '内容未能写入，请将光标放到希望插入的位置后重试。' };
          return { ok: true, beforeHtml, afterHtml };
        } catch {
          return { ok: false, reason: `当前插入位置已经失效，请将光标放到${workspaceNoun}中后重试。` };
        }
      },
      applyDelegatedWorkPlan: (actions) => {
        pendingPastesRef.current = [];
        const beforeValue = structuredClone(editor.children) as Value;
        try {
          const beforeHtml = serializePlateDocument(editor.children);
          editor.getApi(suggestionPlugin).suggestion.withoutSuggestions(() => {
            actions.filter((action) => action.operation !== 'none').forEach((action) => {
              const target = action.targetText.replace(/\s+/g, ' ').trim();
              const matchingPaths = editor.children
                .map((node, index) => ({
                  path: [index],
                  text: NodeApi.string(node).replace(/\s+/g, ' ').trim(),
                }))
                .filter((entry) => target && entry.text === target)
                .map((entry) => entry.path);
              const needsTarget = action.operation !== 'append';
              if (needsTarget && matchingPaths.length !== 1) {
                throw new Error(matchingPaths.length > 1
                  ? `${workspaceNoun}中存在多个相同的目标段落：“${action.targetText.slice(0, 80)}”`
                  : `AI 计划定位的段落已经发生变化：“${action.targetText.slice(0, 80)}”`);
              }
              const targetPath = matchingPaths[0];
              const nodes = action.content ? deserializeMd(editor, action.content) : [];
              if (action.operation !== 'delete' && !nodes.length) {
                throw new Error('AI 计划中有一项操作缺少可写入的内容。');
              }
              if (action.operation === 'append') {
                editor.tf.insertNodes(nodes, { at: [editor.children.length] });
                return;
              }
              if (action.operation === 'insert-before') {
                editor.tf.insertNodes(nodes, { at: targetPath });
                return;
              }
              if (action.operation === 'insert-after') {
                editor.tf.insertNodes(nodes, { at: PathApi.next(targetPath) });
                return;
              }
              if (action.operation === 'replace') {
                editor.tf.removeNodes({ at: targetPath });
                editor.tf.insertNodes(nodes, { at: targetPath });
                return;
              }
              editor.tf.removeNodes({ at: targetPath });
            });
          });
          const afterHtml = serializePlateDocument(editor.children);
          if (beforeHtml === afterHtml) {
            return { ok: false, reason: `这份交付不包含需要写入${workspaceNoun}的变化。` };
          }
          return { ok: true, beforeHtml, afterHtml };
        } catch (error) {
          editor.tf.setValue(beforeValue);
          return {
            ok: false,
            reason: error instanceof Error
              ? `${error.message} 请退回交付，让 AI 根据最新文档重新规划。`
              : `${workspaceNoun}操作计划无法应用，已恢复原文。请退回交付后重新规划。`,
          };
        }
      },
      previewDelegatedWorkPlan: (actions) => {
        pendingPastesRef.current = [];
        if (aiPreviewRef.current || hasTransientPlateSuggestion(editor.children)) {
          return { ok: false, reason: `${workspaceNoun}中已有一项待确认的修改，请先接受或拒绝后再继续。` };
        }
        const beforeValue = structuredClone(editor.children) as Value;
        const beforeHtml = serializePlateDocument(beforeValue);
        const previousUserId = editor.getOption(suggestionPlugin, 'currentUserId');
        try {
          const afterValue = planDelegatedDocumentValue(editor, beforeValue, actions, workspaceNoun);
          if (serializePlateDocument(afterValue) === beforeHtml) {
            return { ok: false, reason: `这份交付不包含需要写入${workspaceNoun}的变化。` };
          }
          editor.setOption(suggestionPlugin, 'currentUserId', 'ai-member');
          const transientKey = getTransientSuggestionKey();
          const id = `ai-plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          let markIndex = 0;
          const mark = (node: Value[number], deletion: boolean): Value[number] => ({
            ...node,
            ...getSuggestionProps(editor, node, {
              id: `${id}-${markIndex++}`,
              suggestionDeletion: deletion,
              transient: true,
            }),
            [transientKey]: true,
          });
          const preview: Value = [];
          let beforeIndex = 0;
          let afterIndex = 0;
          // The plan only inserts/removes/replaces; surviving original blocks
          // stay in order. Emit removed blocks before their green replacements.
          for (let index = 0; index < afterValue.length; index++) {
            const originalIndex = beforeValue.indexOf(afterValue[index]);
            if (originalIndex < 0) continue;
            while (beforeIndex < originalIndex) preview.push(mark(beforeValue[beforeIndex++], true));
            while (afterIndex < index) preview.push(mark(afterValue[afterIndex++], false));
            preview.push(afterValue[index]);
            beforeIndex++;
            afterIndex++;
          }
          while (beforeIndex < beforeValue.length) preview.push(mark(beforeValue[beforeIndex++], true));
          while (afterIndex < afterValue.length) preview.push(mark(afterValue[afterIndex++], false));
          aiPreviewRef.current = { beforeHtml, beforeValue, presentation: 'blocks' };
          withAIBatch(editor, () => editor.tf.setValue(preview));
          return { ok: true, beforeHtml, presentation: 'blocks' };
        } catch (error) {
          editor.tf.setValue(beforeValue);
          aiPreviewRef.current = null;
          return { ok: false, reason: error instanceof Error ? error.message : '无法生成段落修改预览，请退回交付后重新规划。' };
        } finally {
          editor.setOption(suggestionPlugin, 'currentUserId', previousUserId);
        }
      },
      replaceRange: (input) => {
        pendingPastesRef.current = [];
        try {
          const range: TRange = {
            anchor: { path: [...input.anchor.path], offset: input.anchor.offset },
            focus: { path: [...input.focus.path], offset: input.focus.offset },
          };
          if (editor.api.string(range) !== input.text) {
            return { ok: false, reason: '这段文字在 AI 思考期间发生了变化，请重新选择后再试。' };
          }
          const beforeHtml = serializePlateDocument(editor.children);
          editor.getApi(suggestionPlugin).suggestion.withoutSuggestions(() => {
            editor.tf.select(range);
            editor.tf.insertText(input.replacement);
          });
          const afterHtml = serializePlateDocument(editor.children);
          if (beforeHtml === afterHtml) return { ok: false, reason: '修改未能写入，请重新选择后再试。' };
          return { ok: true, beforeHtml, afterHtml };
        } catch {
          return { ok: false, reason: '原选区已经失效，请重新选择文字并生成建议。' };
        }
      },
      previewAiSuggestion: (input) => {
        pendingPastesRef.current = [];
        try {
          if (aiPreviewRef.current || hasTransientPlateSuggestion(editor.children)) {
            return { ok: false, reason: `${workspaceNoun}中已有一项待确认的修改，请先接受或拒绝后再继续。` };
          }

          const beforeValue = structuredClone(editor.children) as Value;
          const beforeHtml = serializePlateDocument(beforeValue);
          let presentation: 'inline' | 'blocks' = 'inline';
          let blockReplacementEntries: ReturnType<typeof editor.api.blocks> | null = null;

          editor.setOption(AIChatPlugin, '_replaceIds', []);
          editor.setOption(AIChatPlugin, 'mode', 'chat');
          editor.setOption(AIChatPlugin, 'toolName', 'edit');

          if (input.operation === 'replace') {
            const range: TRange = {
              anchor: { path: [...input.anchor.path], offset: input.anchor.offset },
              focus: { path: [...input.focus.path], offset: input.focus.offset },
            };
            const selectedFragment = editor.api.fragment(range);
            const selectedText = selectedFragment.map((node) => NodeApi.string(node)).join('\n\n');
            if (selectedText !== input.text) {
              return { ok: false, reason: '这段文字在 AI 思考期间发生了变化，请重新选择后再试。' };
            }

            editor.tf.select(range);
            const blocks = editor.api.blocks({ at: range, mode: 'highest' });
            const [rangeStart, rangeEnd] = RangeApi.edges(range);
            const firstBlockStart = blocks[0] ? editor.api.start(blocks[0][1]) : undefined;
            const lastBlockEnd = blocks.at(-1) ? editor.api.end(blocks.at(-1)![1]) : undefined;
            const selectsWholeBlocks = Boolean(
              blocks.length > 1
              && firstBlockStart
              && lastBlockEnd
              && PointApi.equals(rangeStart, firstBlockStart)
              && PointApi.equals(rangeEnd, lastBlockEnd),
            );
            const isIdElement = (node: TElement | TText): node is TElement & { id: string } =>
              'children' in node && typeof (node as TElement & { id?: unknown }).id === 'string';
            const selectedElements = selectedFragment.filter(isIdElement);
            const blockElements = blocks
              .map(([node]) => node)
              .filter(isIdElement);
            const useBlockReplacement = selectsWholeBlocks
              && (blocks.length > 1 || input.text.length >= 220);

            presentation = useBlockReplacement ? 'blocks' : 'inline';
            blockReplacementEntries = useBlockReplacement ? blocks : null;
            editor.setOption(
              AIChatPlugin,
              'chatNodes',
              selectsWholeBlocks
                ? blockElements
                : blocks.length > 1
                  ? [{
                      id: 'ai-selected-fragment',
                      type: 'p',
                      children: [{ text: input.text }],
                    }]
                  : selectedElements,
            );
            editor.setOption(AIChatPlugin, 'chatSelection', range);
          } else {
            if (!editor.selection) {
              return { ok: false, reason: '请先把光标放到希望新增内容的位置。' };
            }
            if (editor.api.isExpanded()) editor.tf.collapse({ edge: 'end' });
            editor.setOption(AIChatPlugin, 'chatNodes', []);
            editor.setOption(AIChatPlugin, 'chatSelection', editor.selection);
            presentation = input.replacement.includes('\n\n') || input.replacement.length >= 220
              ? 'blocks'
              : 'inline';
          }

          const previousSuggestionUserId = editor.getOption(suggestionPlugin, 'currentUserId');
          editor.setOption(suggestionPlugin, 'currentUserId', 'ai-member');
          try {
            withAIBatch(editor, () => {
              if (input.operation === 'insert') {
                insertTransientPlateSuggestion(editor, input.replacement);
              } else if (blockReplacementEntries?.length) {
                const transientKey = getTransientSuggestionKey();
                const lastPath = blockReplacementEntries.at(-1)![1];
                const insertedBlocks = deserializeMd(editor, input.replacement).map((node, index) => ({
                  ...node,
                  ...getSuggestionProps(editor, node, {
                    id: `ai-task-insert-${Date.now().toString(36)}-${index}`,
                    transient: true,
                  }),
                  [transientKey]: true,
                }));

                editor.tf.withoutNormalizing(() => {
                  blockReplacementEntries?.forEach(([node, path], index) => {
                    editor.tf.setNodes({
                      ...getSuggestionProps(editor, node, {
                        id: `ai-task-remove-${Date.now().toString(36)}-${index}`,
                        suggestionDeletion: true,
                        transient: true,
                      }),
                      [transientKey]: true,
                    }, { at: path });
                  });
                  editor.tf.insertNodes(insertedBlocks, { at: PathApi.next(lastPath) });
                });
              } else if (input.replacement.length === 0 && editor.selection) {
                editor.tf.setNodes(
                  getSuggestionProps(editor, { text: '' }, {
                    id: `ai-task-remove-${Date.now().toString(36)}`,
                    suggestionDeletion: true,
                    transient: true,
                  }),
                  {
                    at: editor.selection,
                    match: (node) => TextApi.isText(node),
                    split: true,
                  },
                );
              } else {
                applyAISuggestions(editor, input.replacement);
              }
            });
          } finally {
            editor.setOption(suggestionPlugin, 'currentUserId', previousSuggestionUserId);
          }

          if (!hasTransientPlateSuggestion(editor.children)) {
            editor.tf.setValue(beforeValue);
            return { ok: false, reason: 'AI 建议与当前内容相同，没有需要确认的修改。' };
          }

          aiPreviewRef.current = { beforeHtml, beforeValue, presentation };
          return { ok: true, beforeHtml, presentation };
        } catch {
          return { ok: false, reason: '无法在当前选区生成修改标记，请重新选择目标内容后再试。' };
        }
      },
      resolveAiSuggestion: (decision) => {
        pendingPastesRef.current = [];
        const preview = aiPreviewRef.current;
        if (!preview) return { ok: false, reason: '当前没有待确认的 AI 修改。' };
        try {
          withAIBatch(editor, () => {
            if (decision === 'accepted') acceptAISuggestions(editor);
            else rejectAISuggestions(editor);
          });
          editor.setOption(AIChatPlugin, '_replaceIds', []);
          editor.setOption(AIChatPlugin, 'chatNodes', []);
          editor.setOption(AIChatPlugin, 'chatSelection', null);
          const afterHtml = serializePlateDocument(editor.children);
          aiPreviewRef.current = null;
          return {
            ok: true,
            beforeHtml: preview.beforeHtml,
            afterHtml,
            presentation: preview.presentation,
          };
        } catch {
          editor.tf.setValue(preview.beforeValue);
          aiPreviewRef.current = null;
          return { ok: false, reason: `修改确认失败，已恢复生成建议前的${workspaceNoun}。` };
        }
      },
    }), [editor, workspaceNoun]);

    const updateSelection = React.useCallback((selection: PlateDocumentSelection) => {
      window.requestAnimationFrame(() => {
        const domSelection = window.getSelection();
        const shell = shellRef.current;
        if (!domSelection?.rangeCount || !shell) return onSelectionChange?.(selection);
        const range = domSelection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        const shellRect = shell.getBoundingClientRect();
        const nextSelection = {
          ...selection,
          rect: {
            left: Math.min(shellRect.width - 28, Math.max(28, rect.left - shellRect.left + rect.width / 2)),
            top: Math.max(54, rect.bottom - shellRect.top),
          },
        };
        onSelectionChange?.(nextSelection);
      });
    }, [onSelectionChange]);

    return (
      <OpenPblEditorProvider value={{
        ai: aiContext,
        appliedAiEdit,
        openAiMember: onOpenAiMember,
        aiMember: aiMemberControls,
        uploadImage: onImageUpload,
      }}>
        <TooltipProvider>
        <div
          className="pbl-document-editor relative box-border w-full min-w-0 overflow-visible bg-white"
          ref={shellRef}
          style={{
            ...unifiedEditorStyle,
            '--plate-toolbar-sticky-top': `${stickyToolbarTop}px`,
          } as React.CSSProperties}
        >
          <Plate
            editor={editor}
            onSelectionChange={({ editor: activeEditor, selection }) => {
              if (!selection) return onSelectionChange?.(null);
              const text = activeEditor.api.fragment(selection)
                .map((node) => NodeApi.string(node))
                .join('\n\n');
              if (!text.trim()) {
                onSelectionChange?.(null);
                return;
              }
              updateSelection(cloneSelection(selection, text));
            }}
            onValueChange={({ value: nextValue }) => {
              // Plate's native AI edit flow writes transient red/green diff
              // nodes into the editor. Keep those changes local until the
              // student accepts or rejects the suggestion.
              if (hasTransientPlateSuggestion(nextValue)) return;
              const html = serializePlateDocument(nextValue);
              const previous = lastEmittedRef.current;
              lastEmittedRef.current = html;
              if (previous !== null && withoutDocumentBlockIds(html) === withoutDocumentBlockIds(previous)) return;
              onChange(html);
              if (!onDocumentPaste) { pendingPastesRef.current = []; return; }
              if (pendingPastesRef.current.length) {
                const documentText = nextValue.map(node => NodeApi.string(node)).join('\n');
                const normalized = normalizeMonitorText(documentText);
                const pending = pendingPastesRef.current;
                pendingPastesRef.current = [];
                for (const captured of pending) {
                  if (captured.expiresAt < Date.now()) continue;
                  const pastedText = normalizeMonitorText(captured.paste.text);
                  if (pastedText && normalized.includes(pastedText)) {
                    try { onDocumentPaste({ ...captured.paste, documentText }); } catch { /* Monitoring cannot disrupt saving. */ }
                  } else pendingPastesRef.current.push(captured);
                }
              }
            }}
          >
            <EditorContainer
              className="overflow-y-visible bg-white"
              style={unifiedEditorStyle}
              onCopyCapture={() => {
                copiedDocumentTextRef.current = editor.selection
                  ? editor.api.fragment(editor.selection).map(node => NodeApi.string(node)).join('\n')
                  : '';
              }}
              onCutCapture={() => {
                copiedDocumentTextRef.current = editor.selection
                  ? editor.api.fragment(editor.selection).map(node => NodeApi.string(node)).join('\n')
                  : '';
              }}
              onPasteCapture={(event) => {
                if (!onDocumentPaste) return;
                // Do not preventDefault or return true: Plate must retain its
                // native rich-text, table, and image paste behaviour.
                try {
                  let text = event.clipboardData.getData('text/plain');
                  if (!text) {
                    const document = new DOMParser().parseFromString(event.clipboardData.getData('text/html'), 'text/html');
                    document.querySelectorAll('script,style').forEach(node => node.remove());
                    document.querySelectorAll('p,li,tr,br').forEach(node => node.append('\n'));
                    text = document.body.textContent ?? '';
                  }
                  if (!text.trim()) return;
                  const block = editor.selection ? editor.children[editor.selection.anchor.path[0]] : undefined;
                  pendingPastesRef.current.push({ paste: {
                    text,
                    beforeText: editor.children.map(node => NodeApi.string(node)).join('\n'),
                    ...(block && isDocumentBlockId(block.id) ? { blockId: block.id } : {}),
                    internalTransfer: Boolean(copiedDocumentTextRef.current)
                      && copiedDocumentTextRef.current.replace(/\s/gu, '') === text.replace(/\s/gu, ''),
                  }, expiresAt: Date.now() + 5_000 });
                } catch {
                  // Optional monitoring must never break the paste itself.
                }
              }}
            >
              <Editor
                decorate={decorateAiComments}
                className="bg-white pb-16"
                placeholder={placeholder}
                ref={editorRef}
                style={unifiedEditorStyle}
                variant="default"
              />
            </EditorContainer>
          </Plate>
        </div>
        </TooltipProvider>
      </OpenPblEditorProvider>
    );
  }
);
