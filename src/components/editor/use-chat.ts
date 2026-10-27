'use client';

import * as React from 'react';
import { type UseChatHelpers, useChat as useBaseChat } from '@ai-sdk/react';
import { AIChatPlugin } from '@platejs/ai/react';
import { type UIMessage, DefaultChatTransport } from 'ai';
import { useEditorRef, usePluginOption } from 'platejs/react';

import { aiChatPlugin } from '@/components/editor/plugins/ai-kit';

export type ToolName = 'comment' | 'edit' | 'generate';

export type TComment = {
  comment: { blockId: string; comment: string; content: string } | null;
  status: 'finished' | 'streaming';
};

export type TTableCellUpdate = {
  cellUpdate: { content: string; id: string } | null;
  status: 'finished' | 'streaming';
};

export type MessageDataPart = {
  toolName: ToolName;
  comment?: TComment;
  table?: TTableCellUpdate;
};

export type ChatMessage = UIMessage<Record<string, never>, MessageDataPart>;
export type Chat = UseChatHelpers<ChatMessage>;

export const useChat = () => {
  const editor = useEditorRef();
  const options = usePluginOption(aiChatPlugin, 'chatOptions');

  const transport = React.useMemo(
    () =>
      new DefaultChatTransport({
        api: options.api || '/api/ai/command',
        fetch: (async (input, init) => {
          const requestBody = JSON.parse(init?.body as string);
          const bodyOptions = editor.getOptions(aiChatPlugin).chatOptions?.body;

          return fetch(input, {
            ...init,
            body: JSON.stringify({ ...requestBody, ...bodyOptions }),
          });
        }) as typeof fetch,
      }),
    [editor, options.api]
  );

  const chat = useBaseChat<ChatMessage>({
    id: `editor-${editor.id}`,
    transport,
    onData(data) {
      if (data.type === 'data-toolName') {
        editor.setOption(AIChatPlugin, 'toolName', data.data as ToolName);
      }
    },
    ...options,
  });

  React.useEffect(() => {
    editor.setOption(AIChatPlugin, 'chat', chat as never);
    // The chat helper object is recreated by the SDK. Updating Plate only when
    // observable chat state changes avoids a store feedback loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.status, chat.messages, chat.error, editor]);

  return chat;
};
