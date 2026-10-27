'use client';

import * as React from 'react';

import {
  BaselineIcon,
  BoldIcon,
  Code2Icon,
  HighlighterIcon,
  ItalicIcon,
  PaintBucketIcon,
  RotateCcwIcon,
  StrikethroughIcon,
  UnderlineIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorReadOnly } from 'platejs/react';
import { useOpenPblEditorContext } from '@/components/editor/openpbl-editor-context';

import { AiMemberLauncher } from '@/components/editor/ai-member-launcher';
import { AlignToolbarButton } from './align-toolbar-button';
import { CommentToolbarButton } from './comment-toolbar-button';
import { FontColorToolbarButton } from './font-color-toolbar-button';
import { FontSizeToolbarButton } from './font-size-toolbar-button';
import { RedoToolbarButton, UndoToolbarButton } from './history-toolbar-button';
import {
  IndentToolbarButton,
  OutdentToolbarButton,
} from './indent-toolbar-button';
import { ImportExportToolbarButton } from './import-export-toolbar-button';
import { InsertToolbarButton } from './insert-toolbar-button';
import { LineHeightToolbarButton } from './line-height-toolbar-button';
import { LinkToolbarButton } from './link-toolbar-button';
import {
  BulletedListToolbarButton,
  NumberedListToolbarButton,
  TodoListToolbarButton,
} from './list-toolbar-button';
import { MarkToolbarButton } from './mark-toolbar-button';
import { MediaToolbarButton } from './media-toolbar-button';
import { ModeToolbarButton } from './mode-toolbar-button';
import { MoreToolbarButton } from './more-toolbar-button';
import { TableToolbarButton } from './table-toolbar-button';
import { ToggleToolbarButton } from './toggle-toolbar-button';
import { ToolbarGroup } from './toolbar';
import { TurnIntoToolbarButton } from './turn-into-toolbar-button';

type ToolbarGroupEntry = {
  id: string;
  content: React.ReactNode;
};

export function getToolbarOverflowIds(
  groupIds: string[],
  groupWidths: number[],
  availableWidth: number,
  moreButtonWidth: number,
) {
  let occupiedWidth = moreButtonWidth + groupWidths.reduce((sum, width) => sum + width, 0);
  const hiddenIds: string[] = [];

  for (let index = groupIds.length - 1; index >= 0 && occupiedWidth > availableWidth; index -= 1) {
    hiddenIds.unshift(groupIds[index]);
    occupiedWidth -= groupWidths[index];
  }

  return hiddenIds;
}

export function FixedToolbarButtons() {
  const readOnly = useEditorReadOnly();
  const { appliedAiEdit } = useOpenPblEditorContext();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const widthCacheRef = React.useRef(new Map<string, number>());
  const [hiddenGroupIds, setHiddenGroupIds] = React.useState<string[]>([]);

  const groups: ToolbarGroupEntry[] = [];

  if (!readOnly) {
    groups.push(
      {
        id: 'history',
        content: <><UndoToolbarButton /><RedoToolbarButton /></>,
      },
      {
        id: 'insert-and-style',
        content: <><InsertToolbarButton /><TurnIntoToolbarButton /><FontSizeToolbarButton /></>,
      },
      {
        id: 'text-format',
        content: (
          <>
            <MarkToolbarButton nodeType={KEYS.bold} tooltip="加粗 (⌘+B)"><BoldIcon /></MarkToolbarButton>
            <MarkToolbarButton nodeType={KEYS.italic} tooltip="斜体 (⌘+I)"><ItalicIcon /></MarkToolbarButton>
            <MarkToolbarButton nodeType={KEYS.underline} tooltip="下划线 (⌘+U)"><UnderlineIcon /></MarkToolbarButton>
            <MarkToolbarButton nodeType={KEYS.strikethrough} tooltip="删除线 (⌘+⇧+M)"><StrikethroughIcon /></MarkToolbarButton>
            <MarkToolbarButton nodeType={KEYS.code} tooltip="行内代码 (⌘+E)"><Code2Icon /></MarkToolbarButton>
            <FontColorToolbarButton nodeType={KEYS.color} tooltip="文字颜色"><BaselineIcon /></FontColorToolbarButton>
            <FontColorToolbarButton nodeType={KEYS.backgroundColor} tooltip="背景颜色"><PaintBucketIcon /></FontColorToolbarButton>
          </>
        ),
      },
      {
        id: 'paragraph-format',
        content: <><AlignToolbarButton /><NumberedListToolbarButton /><BulletedListToolbarButton /><TodoListToolbarButton /><ToggleToolbarButton /></>,
      },
      {
        id: 'link-and-table',
        content: <><LinkToolbarButton /><TableToolbarButton /></>,
      },
      {
        id: 'media',
        content: <MediaToolbarButton nodeType={KEYS.img} />,
      },
      {
        id: 'layout',
        content: <><LineHeightToolbarButton /><OutdentToolbarButton /><IndentToolbarButton /></>,
      },
    );
  }

  if (appliedAiEdit) {
    groups.push({
      id: 'applied-ai-edit',
      content: (
        <button
          aria-label={`撤销 AI 修改“${appliedAiEdit.title}”`}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-emerald-50 px-2 text-[10px] font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200 transition hover:bg-emerald-100"
          onClick={appliedAiEdit.onUndo}
          onMouseDown={(event) => event.preventDefault()}
          title={`已应用 AI 修改“${appliedAiEdit.title}”，点击撤销`}
          type="button"
        >
          <span className="hidden xl:inline">已应用修改</span>
          <span className="inline-flex items-center gap-1 font-semibold text-emerald-900"><RotateCcwIcon className="size-3" />撤销</span>
        </button>
      ),
    });
  }

  groups.push(
    { id: 'import-export', content: <ImportExportToolbarButton /> },
    {
      id: 'review',
      content: <><MarkToolbarButton nodeType={KEYS.highlight} tooltip="高亮"><HighlighterIcon /></MarkToolbarButton><CommentToolbarButton /></>,
    },
    { id: 'mode', content: <ModeToolbarButton /> },
  );

  const groupIdsKey = groups.map((group) => group.id).join('|');

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const groupIds = groupIdsKey.split('|').filter(Boolean);

    const measure = () => {
      container.querySelectorAll<HTMLElement>('[data-toolbar-overflow-group]').forEach((element) => {
        const id = element.dataset.toolbarOverflowGroup;
        const width = element.getBoundingClientRect().width;
        if (id && width > 0) widthCacheRef.current.set(id, width);
      });

      const widths = groupIds.map((id) => widthCacheRef.current.get(id) ?? 0);
      if (widths.some((width) => width <= 0)) return;
      const moreButton = container.querySelector<HTMLElement>('[data-toolbar-overflow-more]');
      const moreButtonWidth = moreButton?.getBoundingClientRect().width ?? 40;
      const nextHiddenIds = getToolbarOverflowIds(
        groupIds,
        widths,
        Math.max(0, container.clientWidth - 4),
        moreButtonWidth,
      );
      setHiddenGroupIds((current) => current.join('|') === nextHiddenIds.join('|') ? current : nextHiddenIds);
    };

    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [groupIdsKey]);

  const hiddenIdSet = new Set(hiddenGroupIds);
  const renderGroup = (group: ToolbarGroupEntry, overflow = false) => (
    <ToolbarGroup
      className={overflow ? '[&>div:last-child]:hidden!' : undefined}
      data-toolbar-overflow-group={overflow ? undefined : group.id}
      key={`${overflow ? 'overflow' : 'toolbar'}-${group.id}`}
    >
      {group.content}
    </ToolbarGroup>
  );

  return (
    <div className="flex min-w-0 w-full overflow-hidden">
      {!readOnly ? <AiMemberLauncher /> : null}
      <div className="flex min-w-0 flex-1 overflow-hidden" ref={containerRef}>
      {groups.filter((group) => !hiddenIdSet.has(group.id)).map((group) => renderGroup(group))}
      <div className="grow" />
      <ToolbarGroup data-toolbar-overflow-more>
        <MoreToolbarButton
          overflowContent={hiddenGroupIds.length
            ? groups.filter((group) => hiddenIdSet.has(group.id)).map((group) => renderGroup(group, true))
            : undefined}
          overflowCount={hiddenGroupIds.length}
        />
      </ToolbarGroup>
      </div>
    </div>
  );
}
