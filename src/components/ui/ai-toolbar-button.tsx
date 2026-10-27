'use client';

import * as React from 'react';

import { AIChatPlugin } from '@platejs/ai/react';
import { useEditorPlugin } from 'platejs/react';
import { useOpenPblEditorContext } from '@/components/editor/openpbl-editor-context';

import { ToolbarButton } from './toolbar';

export function AIToolbarButton(
  props: React.ComponentProps<typeof ToolbarButton>
) {
  const { api, editor } = useEditorPlugin(AIChatPlugin);
  const { openAiMember } = useOpenPblEditorContext();

  return (
    <ToolbarButton
      {...props}
      onClick={() => {
        if (editor.api.isExpanded()) {
          api.aiChat.show();
          return;
        }
        openAiMember?.();
      }}
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    />
  );
}
