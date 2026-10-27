import { HumanMessage } from '@langchain/core/messages';
import type { LanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';

const { streamLLMMock } = vi.hoisted(() => ({ streamLLMMock: vi.fn() }));

vi.mock('@openmaic/lib/ai/llm', () => ({
  callLLM: vi.fn(),
  streamLLM: streamLLMMock,
}));

import { AISdkLangGraphAdapter } from './ai-sdk-adapter';
import { createNativeTeachingTools } from './native-teaching-tools';

describe('AI SDK adapter native tools', () => {
  it('preserves interleaved text and tool calls from the AI SDK full stream', async () => {
    async function* fullStream() {
      yield { type: 'text-delta', text: 'Look here. ' };
      yield {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'wb_draw_text',
        input: { content: 'Step 1', x: 100, y: 80 },
      };
      yield { type: 'tool-result', toolCallId: 'call-1', output: { ok: true } };
      yield { type: 'text-delta', text: 'What changes next?' };
    }
    streamLLMMock.mockReturnValue({ fullStream: fullStream() });
    const adapter = new AISdkLangGraphAdapter({} as LanguageModel);
    const tools = createNativeTeachingTools(['wb_draw_text']);
    const chunks = [];

    for await (const chunk of adapter.streamGenerate([new HumanMessage('Teach')], { tools })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { type: 'delta', content: 'Look here. ' },
      {
        type: 'tool_calls',
        toolCalls: [
          {
            id: 'call-1',
            index: 0,
            type: 'function',
            function: {
              name: 'wb_draw_text',
              arguments: JSON.stringify({ content: 'Step 1', x: 100, y: 80 }),
            },
          },
        ],
      },
      { type: 'delta', content: 'What changes next?' },
      { type: 'done', content: 'Look here. What changes next?' },
    ]);
    expect(streamLLMMock).toHaveBeenCalledWith(
      expect.objectContaining({ tools, toolChoice: 'auto' }),
      'chat-adapter-stream',
      undefined,
    );
  });
});
