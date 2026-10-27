import { describe, expect, it } from 'vitest';
import { buildPrompt, PROMPT_IDS } from './index';

describe('interactive action learner-agency contract', () => {
  it('keeps learner operations ahead of platform state changes', () => {
    const prompt = buildPrompt(PROMPT_IDS.INTERACTIVE_ACTIONS, {
      title: '变量仿真',
      conceptName: '变量关系',
      description: '拖动滑块并比较输出',
      designIdea: '参数实验',
      keyPoints: '控制变量',
      widgetType: 'simulation',
      widgetConfig: '{}',
    });
    const system = prompt?.system ?? '';

    expect(system).toContain('after the first speech');
    expect(system).toContain('The learner must perform every click');
    expect(system).toContain('Never use `widget_setState`');
    expect(system).toContain('must never substitute for the learner action');
    expect(system).toContain('Do not narrate the interaction as a test');
    expect(system).toContain('scores, correctness verdicts');
  });
});
