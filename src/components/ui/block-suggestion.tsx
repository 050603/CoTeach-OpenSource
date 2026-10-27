'use client';

import * as React from 'react';

import { acceptSuggestion, rejectSuggestion } from '@platejs/suggestion';
import { SuggestionPlugin } from '@platejs/suggestion/react';
import { CheckIcon, XIcon } from 'lucide-react';
import { useEditorPlugin, usePluginOption } from 'platejs/react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  type AiPendingCommentSuggestion,
  type TDiscussion,
  discussionPlugin,
} from '@/components/editor/plugins/discussion-kit';

import { Comment, CommentCreateForm, formatCommentDate } from './comment';
import {
  BLOCK_SUGGESTION_TOKEN,
  type ResolvedSuggestion,
} from '@/lib/block-discussion-index';

export function PendingAiCommentSuggestionCard({
  onDecision,
  suggestion,
}: {
  onDecision?: (decision: 'accepted' | 'rejected') => void;
  suggestion: AiPendingCommentSuggestion;
}) {
  const userInfo = usePluginOption(discussionPlugin, 'user', 'ai-member');
  const change = React.useMemo(() => {
    if (!suggestion.replacement) {
      return { kind: 'delete' as const, content: suggestion.targetText };
    }
    if (
      suggestion.replacement.startsWith(suggestion.targetText)
      && suggestion.replacement.length > suggestion.targetText.length
    ) {
      return {
        kind: 'insert-after' as const,
        content: suggestion.replacement.slice(suggestion.targetText.length).trim(),
      };
    }
    if (
      suggestion.replacement.endsWith(suggestion.targetText)
      && suggestion.replacement.length > suggestion.targetText.length
    ) {
      return {
        kind: 'insert-before' as const,
        content: suggestion.replacement.slice(0, -suggestion.targetText.length).trim(),
      };
    }
    return { kind: 'replace' as const, content: suggestion.replacement };
  }, [suggestion.replacement, suggestion.targetText]);

  return (
    <div
      className="relative flex flex-col p-4"
      data-ai-comment-suggestion="true"
    >
      <div className="relative flex items-center">
        <Avatar className="size-5">
          <AvatarImage alt={userInfo?.name} src={userInfo?.avatarUrl} />
          <AvatarFallback>{userInfo?.name?.[0]}</AvatarFallback>
        </Avatar>
        <h4 className="mx-2 font-semibold text-sm leading-none">
          {userInfo?.name}
        </h4>
        <span className="text-muted-foreground/80 text-xs leading-none">
          修改建议
        </span>
      </div>

      <div className="relative mt-2 pl-[32px]">
        <p className="font-medium text-sm">{suggestion.title}</p>
        {change.kind === 'replace' ? (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-start gap-2 text-emerald-700">
              <span className="shrink-0 text-sm">替换为：</span>
              <span className="text-sm">{suggestion.replacement}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="shrink-0 text-muted-foreground text-sm">替换：</span>
              <span className="text-sm">{suggestion.targetText}</span>
            </div>
          </div>
        ) : change.kind === 'delete' ? (
          <div className="mt-2 flex items-start gap-2 text-red-700">
            <span className="shrink-0 text-sm">删除：</span>
            <span className="text-sm">{change.content}</span>
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-start gap-2 text-emerald-700">
              <span className="shrink-0 text-sm">新增：</span>
              <span className="text-sm">{change.content}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="shrink-0 text-muted-foreground text-sm">位置：</span>
              <span className="text-sm">
                在“{suggestion.targetText}”{change.kind === 'insert-before' ? '之前' : '之后'}
              </span>
            </div>
          </div>
        )}
        <p className="mt-2 text-muted-foreground text-xs leading-5">
          {suggestion.error ?? suggestion.reason}
        </p>
      </div>

      <div className="absolute top-4 right-4 flex gap-1 rounded-md bg-background/95 shadow-sm ring-1 ring-border">
        {!suggestion.error && (
          <Button
            aria-label="接受修改"
            className="size-7 p-1 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
            onClick={() => onDecision?.('accepted')}
            title="接受 AI 修改"
            variant="ghost"
          >
            <CheckIcon className="size-4" />
          </Button>
        )}
        <Button
          aria-label="拒绝修改"
          className="size-7 p-1 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
          onClick={() => onDecision?.('rejected')}
          title="拒绝 AI 修改"
          variant="ghost"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

export function BlockSuggestionCard({
  idx,
  isLast,
  suggestion,
}: {
  idx: number;
  isLast: boolean;
  suggestion: ResolvedSuggestion;
}) {
  const { api, editor } = useEditorPlugin(SuggestionPlugin);

  const userInfo = usePluginOption(discussionPlugin, 'user', suggestion.userId);

  const accept = (suggestion: ResolvedSuggestion) => {
    api.suggestion.withoutSuggestions(() => {
      acceptSuggestion(editor, suggestion);
    });
  };

  const reject = (suggestion: ResolvedSuggestion) => {
    api.suggestion.withoutSuggestions(() => {
      rejectSuggestion(editor, suggestion);
    });
  };

  const [hovering, setHovering] = React.useState(false);

  const suggestionText2Array = (text: string) => {
    if (text === BLOCK_SUGGESTION_TOKEN) return ['换行'];

    return text.split(BLOCK_SUGGESTION_TOKEN).filter(Boolean);
  };

  const getRemoveSummaryItems = (text: string) => {
    const items = suggestionText2Array(text).map((item) => {
      if (item === 'column_group') return '分栏';
      if (item === 'code_block') return '代码块';

      return item;
    });

    if (items.includes('Table')) return ['表格'];
    if (items.includes('Code Block')) return ['代码块'];
    if (items.includes('Column')) return ['分栏'];

    return items;
  };

  const [editingId, setEditingId] = React.useState<string | null>(null);

  return (
    <div
      key={`${suggestion.suggestionId}-${idx}`}
      className="relative"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div className="flex flex-col p-4">
        <div className="relative flex items-center">
          {/* Replace to your own backend or refer to potion */}
          <Avatar className="size-5">
            <AvatarImage alt={userInfo?.name} src={userInfo?.avatarUrl} />
            <AvatarFallback>{userInfo?.name?.[0]}</AvatarFallback>
          </Avatar>
          <h4 className="mx-2 font-semibold text-sm leading-none">
            {userInfo?.name}
          </h4>
          <div className="text-muted-foreground/80 text-xs leading-none">
            <span className="mr-1">
              {formatCommentDate(new Date(suggestion.createdAt))}
            </span>
          </div>
        </div>

        <div className="relative mt-1 mb-4 pl-[32px]">
          <div className="flex flex-col gap-2">
            {suggestion.type === 'remove' &&
              getRemoveSummaryItems(suggestion.text!).map((text, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">删除：</span>

                  <span key={index} className="text-sm">
                    {text}
                  </span>
                </div>
              ))}

            {suggestion.type === 'insert' &&
              suggestionText2Array(suggestion.newText!).map((text, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">新增：</span>

                  <span key={index} className="text-sm">
                    {text || '换行'}
                  </span>
                </div>
              ))}

            {suggestion.type === 'replace' && (
              <div className="flex flex-col gap-2">
                {suggestionText2Array(suggestion.newText!).map(
                  (text, index) => (
                    <React.Fragment key={index}>
                      <div
                        key={index}
                        className="flex items-start gap-2 text-brand/80"
                      >
                        <span className="text-sm">替换为：</span>
                        <span className="text-sm">{text || '换行'}</span>
                      </div>
                    </React.Fragment>
                  )
                )}

                {suggestionText2Array(suggestion.text!).map((text, index) => (
                  <React.Fragment key={index}>
                    <div key={index} className="flex items-start gap-2">
                      <span className="text-muted-foreground text-sm">
                        {index === 0 ? '替换：' : '删除：'}
                      </span>
                      <span className="text-sm">{text || '换行'}</span>
                    </div>
                  </React.Fragment>
                ))}
              </div>
            )}

            {suggestion.type === 'update' && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">
                  {Object.keys(suggestion.properties).map((key) => (
                    <span key={key}>Un{key}</span>
                  ))}

                  {Object.keys(suggestion.newProperties).map((key) => (
                    <span key={key}>
                      {key.charAt(0).toUpperCase() + key.slice(1)}
                    </span>
                  ))}
                </span>
                <span className="text-sm">{suggestion.newText}</span>
              </div>
            )}
          </div>
        </div>

        {suggestion.comments.map((comment, index) => (
          <Comment
            key={comment.id ?? index}
            comment={comment}
            discussionLength={suggestion.comments.length}
            documentContent="__suggestion__"
            editingId={editingId}
            index={index}
            setEditingId={setEditingId}
          />
        ))}

        {hovering && (
          <div className="absolute top-4 right-4 flex gap-2">
            <Button
              aria-label="接受修改"
              variant="ghost"
              className="size-6 p-1 text-muted-foreground"
              onClick={() => accept(suggestion)}
            >
              <CheckIcon className="size-4" />
            </Button>

            <Button
              aria-label="拒绝修改"
              variant="ghost"
              className="size-6 p-1 text-muted-foreground"
              onClick={() => reject(suggestion)}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
        )}

        <CommentCreateForm discussionId={suggestion.suggestionId} />
      </div>

      {!isLast && <div className="h-px w-full bg-muted" />}
    </div>
  );
}

export const isResolvedSuggestion = (
  suggestion: ResolvedSuggestion | TDiscussion
): suggestion is ResolvedSuggestion => 'suggestionId' in suggestion;
