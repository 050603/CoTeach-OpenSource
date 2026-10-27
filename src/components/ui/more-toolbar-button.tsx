'use client';

import * as React from 'react';

import type { DropdownMenuProps } from '@radix-ui/react-dropdown-menu';

import {
  MoreHorizontalIcon,
  SubscriptIcon,
  SuperscriptIcon,
} from 'lucide-react';
import { KEYS } from 'platejs';
import { useEditorRef } from 'platejs/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { ToolbarButton } from './toolbar';

type MoreToolbarButtonProps = DropdownMenuProps & {
  overflowContent?: React.ReactNode;
  overflowCount?: number;
};

export function MoreToolbarButton({
  overflowContent,
  overflowCount = 0,
  ...props
}: MoreToolbarButtonProps) {
  const editor = useEditorRef();
  const [open, setOpen] = React.useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false} {...props}>
      <DropdownMenuTrigger asChild>
        <ToolbarButton
          className="relative"
          pressed={open}
          tooltip={overflowCount ? `更多工具（已收起 ${overflowCount} 组）` : '更多格式'}
        >
          <MoreHorizontalIcon />
          {overflowCount ? (
            <span className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-sky-600" />
          ) : null}
        </ToolbarButton>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="ignore-click-outside/toolbar flex max-h-[min(500px,calc(100vh-120px))] min-w-[180px] max-w-[min(560px,calc(100vw-24px))] flex-col overflow-y-auto"
        align={overflowContent ? "end" : "start"}
      >
        {overflowContent ? (
          <>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              更多工具
            </DropdownMenuLabel>
            <div className="flex flex-wrap items-center gap-0.5 px-1 pb-1">
              {overflowContent}
            </div>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => {
              editor.tf.toggleMark(KEYS.sup, {
                remove: KEYS.sub,
              });
              editor.tf.focus();
            }}
          >
            <SuperscriptIcon />
            上标
            {/* (⌘+,) */}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              editor.tf.toggleMark(KEYS.sub, {
                remove: KEYS.sup,
              });
              editor.tf.focus();
            }}
          >
            <SubscriptIcon />
            下标
            {/* (⌘+.) */}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
