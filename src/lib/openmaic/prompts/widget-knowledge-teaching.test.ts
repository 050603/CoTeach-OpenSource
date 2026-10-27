import { describe, expect, it } from 'vitest';
import { buildPrompt, PROMPT_IDS } from './index';

const widgetPromptIds = [
  PROMPT_IDS.CODE_CONTENT,
  PROMPT_IDS.DIAGRAM_CONTENT,
  PROMPT_IDS.GAME_CONTENT,
  PROMPT_IDS.SIMULATION_CONTENT,
  PROMPT_IDS.VISUALIZATION3D_CONTENT,
] as const;

describe('widget knowledge-teaching contract', () => {
  it('keeps code execution on supported same-origin runtimes with recoverable failures', () => {
    const prompt = buildPrompt(PROMPT_IDS.CODE_CONTENT, {
      title: 'Python loop explorer',
      programmingLanguage: 'python',
      description: 'Observe how loop state changes.',
      keyPoints: '1. Loop state\n2. Iteration order',
    });
    const system = prompt?.system ?? '';

    expect(system).toContain('/api/openmaic/interactive-runtime/pyodide/pyodide.js');
    expect(system).toContain('document.baseURI');
    expect(system).toContain('Do not load `numpy`');
    expect(system).toContain('provide a retry button');
    expect(system).toContain('never render an endless loader');
    expect(system).not.toContain('TypeScript (via Babel CDN transpilation)');
  });

  it.each(widgetPromptIds)('%s requires a complete, non-decorative exploration loop', (promptId) => {
    const prompt = buildPrompt(promptId, {
      title: '测试主题',
      description: '测试描述',
      keyPoints: '1. 知识点 A\n2. 知识点 B',
    });
    const user = prompt?.user ?? '';

    expect(user).toContain('Objective Alignment');
    expect(user).toContain('No Decorative Interaction');
    expect(user).toContain('Explanatory Feedback');
    expect(user).toContain('Exploration Evidence');
    expect(user).toContain('predict');
    expect(user).toContain('observe');
    expect(user).toContain('not a quiz');
    expect(user).toContain('no score');
    expect(user).not.toContain('correct/incorrect');
  });

  it.each(widgetPromptIds)('%s reports meaningful activity completion to playback', (promptId) => {
    const prompt = buildPrompt(promptId, {
      title: 'Activity completion contract',
      description: 'Learners must complete a meaningful task.',
      keyPoints: '1. Explain the target concept\n2. Apply it in a new case',
    });
    const user = prompt?.user ?? '';

    expect(user).toContain('Activity Completion Protocol');
    expect(user).toContain('window.__maicActivity.complete()');
    expect(user).toContain('window.__maicActivity.reset()');
    expect(user).toContain('data-activity-complete');
    expect(user).toContain('meaningful exploration');
    expect(user).toContain('Do not signal completion');
  });

  it.each(widgetPromptIds)('%s preserves the baseline classroom-to-widget action contract', (promptId) => {
    const prompt = buildPrompt(promptId, {
      title: 'Widget action contract',
      description: 'A meaningful learner activity.',
      keyPoints: '1. Observe a relationship',
    });
    const system = prompt?.system ?? '';

    expect(system).toContain('SET_WIDGET_STATE');
    expect(system).toContain('HIGHLIGHT_ELEMENT');
    expect(system).toContain('ANNOTATE_ELEMENT');
    expect(system).toContain('REVEAL_ELEMENT');
    expect(system).toContain("window.addEventListener('message'");
  });
});
