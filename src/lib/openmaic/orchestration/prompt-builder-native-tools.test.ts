import { describe, expect, it } from 'vitest';
import type { AgentConfig } from './registry/types';
import { buildNativeToolPrompt } from './prompt-builder';

describe('native classroom tool prompt', () => {
  it('uses ordinary speech plus native tools instead of JSON action emulation', () => {
    const agent: AgentConfig = {
      id: 'teacher',
      name: 'Teacher',
      role: 'teacher',
      persona: 'Teach clearly.',
      avatar: '',
      color: '#000000',
      allowedActions: ['wb_draw_text', 'wb_draw_line', 'widget_annotation'],
      priority: 10,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      isDefault: false,
    };
    const prompt = buildNativeToolPrompt(agent, {
      stage: null,
      scenes: [],
      currentSceneId: null,
      mode: 'autonomous',
      whiteboardOpen: false,
    });

    expect(prompt).toContain('Use native tool calls for classroom actions');
    expect(prompt).toContain('wb_draw_text');
    expect(prompt).toContain('wb_draw_line');
    expect(prompt).not.toContain('You MUST output a JSON array');
  });
});
