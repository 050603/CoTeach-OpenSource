import type { SceneOutline } from '@openmaic/lib/types/generation';

type TeachingWidgetSuggestion = {
  widgetType: NonNullable<SceneOutline['widgetType']>;
  widgetOutline: NonNullable<SceneOutline['widgetOutline']>;
};

export type OutlineSource = 'confirmed' | 'generated';

const CODE_SIGNALS = [
  '编程', '代码', '算法', '程序', '递归', '排序算法', '数据结构', '循环语句',
  '条件语句', '数组', '字符串', '编译', '调试', '编程语法', '程序接口', '代码框架', '变量赋值',
];
const THREE_D_SIGNALS = [
  '分子', '原子', '太阳系', '行星', '轨道', '细胞', '骨骼', '肌肉', '器官', '立体',
  '晶体', '蛋白质', '地形', '地貌', '建筑', '雕塑', '空间结构', '几何体', '立方体', '球体',
  '圆柱', '圆锥',
];
const SIMULATION_SIGNALS = [
  '力学', '受力', '力与', '作用力', '运动', '速度', '加速度', '电路', '波动', '光学', '电磁', '温度', '压强', '化学反应',
  '生态', '实验', '模拟', '概率', '统计', '分布', '函数图', '坐标', '方程', '微积分', '导数',
  '积分', '随机', '方差', '均值', '回归', '拟合', '模型', '演化', '生长', '繁殖', '代谢',
  '光合', '呼吸', '遗传', '突变', '变量实验', '参数变化',
];
const GAME_SIGNALS = [
  '挑战', '练习', '游戏', '实战', '求解', '测试', '答题', '闯关', '竞赛', '比赛', '拼图',
  '分类规则', '配对', '建造', '决策',
];

function outlineText(outline: SceneOutline): string {
  return `${outline.title} ${outline.description} ${(outline.keyPoints ?? []).join(' ')}`.toLowerCase();
}

function hasAny(text: string, signals: ReadonlyArray<string>): boolean {
  return signals.some((signal) => text.includes(signal));
}

function matchesEnglish(text: string, words: string): boolean {
  return new RegExp(`\\b(?:${words})\\b`, 'i').test(text);
}

function inferCodeLanguage(text: string): NonNullable<SceneOutline['widgetOutline']>['language'] {
  if (matchesEnglish(text, 'javascript|typescript|js|ts')) return text.includes('typescript') ? 'typescript' : 'javascript';
  if (matchesEnglish(text, 'java')) return 'java';
  if (matchesEnglish(text, 'c\\+\\+|cpp')) return 'cpp';
  return 'python';
}

/** Select the interaction whose affordance best expresses the teaching task. */
export function suggestTeachingWidget(outline: SceneOutline): TeachingWidgetSuggestion {
  const text = outlineText(outline);

  if (hasAny(text, CODE_SIGNALS) || matchesEnglish(text, 'code|coding|python|javascript|typescript|java|algorithm|program|debug|api|class|object')) {
    return {
      widgetType: 'code',
      widgetOutline: {
        language: inferCodeLanguage(text),
        challengeType: 'guided-practice',
        concept: outline.title,
      },
    };
  }

  if (hasAny(text, THREE_D_SIGNALS) || matchesEnglish(text, '3d|molecule|atom|solar|planet|orbit|anatomy|organ|crystal|topography|sculpture')) {
    return {
      widgetType: 'visualization3d',
      widgetOutline: {
        visualizationType: 'custom',
        objects: outline.keyPoints.slice(0, 5),
        interactions: ['select', 'inspect', 'guided-tour', 'compare'],
        concept: outline.title,
      },
    };
  }

  if (hasAny(text, GAME_SIGNALS) || matchesEnglish(text, 'challenge|practice|game|apply|quiz|trivia|puzzle|build|decision')) {
    return {
      widgetType: 'game',
      widgetOutline: {
        gameType: 'strategy',
        challenge: outline.description || outline.title,
        playerControls: ['choose', 'manipulate', 'test', 'revise'],
        concept: outline.title,
      },
    };
  }

  if (hasAny(text, SIMULATION_SIGNALS) || matchesEnglish(text, 'force|motion|velocity|circuit|wave|reaction|experiment|simulation|probability|function|model|variable')) {
    return {
      widgetType: 'simulation',
      widgetOutline: {
        concept: outline.title,
        keyVariables: outline.keyPoints.slice(0, 4),
      },
    };
  }

  const diagramType = hasAny(text, ['流程', '步骤', '过程', '阶段'])
    ? 'flowchart'
    : hasAny(text, ['层级', '分类', '组成'])
      ? 'hierarchy'
      : 'system';
  return {
    widgetType: 'diagram',
    widgetOutline: {
      diagramType,
      nodeCount: Math.max(3, Math.min(outline.keyPoints.length * 2, 12)),
      concept: outline.title,
    },
  };
}

/**
 * @deprecated Interaction cadence is now selected by the outline prompt. This
 * compatibility export intentionally preserves the model/teacher plan exactly
 * and must never manufacture pages after planning.
 */
export function applyDeepInteractionPolicy(
  outlines: ReadonlyArray<SceneOutline>,
  _source: OutlineSource = 'generated',
): SceneOutline[] {
  return [...outlines];
}
