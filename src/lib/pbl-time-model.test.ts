import { describe, expect, it } from 'vitest';
import {
  assessPblTimeAllocation,
  buildPblModelTimingPlan,
  buildPblModuleTimingPlan,
  buildPblProjectMainline,
  derivePblTimeRatios,
  estimateTtsDurationSec,
  PBL_TIME_RATIOS,
  reallocatePblStageDurations,
  rescalePblDetailDurations,
  suggestPblTimeAllocation,
  isPblModuleTimingPlanConfirmed,
} from './pbl-time-model';

describe('PBL time model', () => {
  it('keeps the standard ratios normalized', () => {
    expect(Object.values(PBL_TIME_RATIOS).reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  it('allocates one-to-many knowledge activities and preserves the total', () => {
    const suggestions = suggestPblTimeAllocation(120, [
      { id: 'launch', stageKey: 'launch' },
      { id: 'k1', stageKey: 'ai-learning' },
      { id: 'k2', stageKey: 'ai-learning' },
      { id: 'k3', stageKey: 'ai-learning' },
      { id: 'make', stageKey: 'make' },
      { id: 'showcase', stageKey: 'showcase' },
      { id: 'reflection', stageKey: 'reflection' },
    ]);

    expect(Object.values(suggestions).reduce((sum, value) => sum + value, 0)).toBe(120);
    expect(suggestions.k1).toBe(suggestions.k2);
    expect(suggestions.k2).toBe(suggestions.k3);
    expect(suggestions.make).toBeGreaterThan(suggestions.k1);
  });

  it('warns when knowledge teaching is longer than project practice', () => {
    const assessment = assessPblTimeAllocation(60, [
      { id: 'knowledge', stageKey: 'ai-learning', durationMin: 20 },
      { id: 'practice', stageKey: 'make', durationMin: 10 },
      { id: 'other', stageKey: 'launch', durationMin: 30 },
    ]);

    expect(assessment.warnings.map((warning) => warning.code)).toContain('knowledge-exceeds-practice');
  });

  it('allows a teacher override while reporting total mismatch', () => {
    const assessment = assessPblTimeAllocation(90, [
      { id: 'launch', stageKey: 'launch', durationMin: 10 },
      { id: 'practice', stageKey: 'make', durationMin: 50 },
    ]);

    expect(assessment.allocatedMinutes).toBe(60);
    expect(assessment.warnings.map((warning) => warning.code)).toContain('allocation-total-mismatch');
  });

  it('always recommends all six modules instead of renormalizing to AI learning', () => {
    const assessment = assessPblTimeAllocation(120, [
      { id: 'knowledge', stageKey: 'ai-learning', durationMin: 120 },
    ]);

    expect(assessment.recommendedStageTotals.knowledge).toBe(24);
    expect(assessment.recommendedStageTotals.practice).toBe(48);
    expect(assessment.warnings.map((warning) => warning.code)).toContain('missing-module');
  });

  it('keeps practice as the largest module for advanced projects', () => {
    const ratios = derivePblTimeRatios({
      topic: '跨学科开放性研究项目',
      grade: '高一',
      difficulty: 'advanced',
      knowledgePoints: [
        { id: 'kp-1', level: 'foundation' },
        { id: 'kp-2', level: 'application' },
        { id: 'kp-3', level: 'extension' },
      ],
    });

    expect(ratios.practice).toBeGreaterThan(ratios.knowledge);
    expect(ratios.practice).toBeGreaterThan(ratios.launch);
    expect(Object.values(ratios).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it('reserves more scaffolding time when the teacher confirms explicit learning needs', () => {
    const baseline = derivePblTimeRatios({ grade: '高二' });
    const supported = derivePblTimeRatios({
      grade: '高二',
      learnerProfile: { learningNeeds: '抽象概念需要图示、分步示例和理解检查' },
    });

    expect(supported.knowledge).toBeGreaterThan(baseline.knowledge);
    expect(supported.proposal).toBeGreaterThan(baseline.proposal);
    expect(Object.values(supported).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
  });

  it('builds a strict six-module mainline and rescales child targets', () => {
    const activities = [
      { id: 'launch', stageKey: 'project-launch', durationMin: 10 },
      { id: 'knowledge', stageKey: 'ai-learning', durationMin: 20 },
      { id: 'proposal', stageKey: 'proposal', durationMin: 10 },
      { id: 'practice', stageKey: 'make', durationMin: 50 },
      { id: 'showcase', stageKey: 'showcase', durationMin: 20 },
      { id: 'reflection', stageKey: 'reflection', durationMin: 10 },
    ];
    const mainline = buildPblProjectMainline(120, activities);
    expect(mainline.modules).toHaveLength(6);
    expect(mainline.modules.at(-1)?.endMin).toBe(120);

    const details = rescalePblDetailDurations(
      [
        { id: 'd1', parentActivityId: 'practice', targetDurationSec: 1200 },
        { id: 'd2', parentActivityId: 'practice', targetDurationSec: 1800 },
      ],
      [{ id: 'practice', durationMin: 30 }],
    );
    expect(details.reduce((sum, detail) => sum + (detail.targetDurationSec ?? 0), 0)).toBe(1800);
  });

  it('does not create a project mainline before modules exist', () => {
    expect(buildPblProjectMainline(60, []).modules).toEqual([]);
  });

  it('keeps the course total fixed when a teacher changes a stage total', () => {
    const activities = [
      { id: 'launch', stageKey: 'launch', durationMin: 12 },
      { id: 'knowledge', stageKey: 'ai-learning', durationMin: 24 },
      { id: 'proposal', stageKey: 'proposal', durationMin: 12 },
      { id: 'practice', stageKey: 'make', durationMin: 48 },
      { id: 'showcase', stageKey: 'showcase', durationMin: 18 },
      { id: 'reflection', stageKey: 'reflection', durationMin: 6 },
    ];
    const next = reallocatePblStageDurations(120, activities, 'practice', 60);
    const assessment = assessPblTimeAllocation(120, next);

    expect(assessment.stageTotals.practice).toBe(60);
    expect(assessment.allocatedMinutes).toBe(120);
    expect(next.every((activity) => activity.durationMin >= 1)).toBe(true);
  });

  it('builds an AI module recommendation from course difficulty and knowledge complexity', () => {
    const activities = [
      { id: 'launch', stageKey: 'launch', durationMin: 1 },
      { id: 'knowledge', stageKey: 'ai-learning', durationMin: 1 },
      { id: 'proposal', stageKey: 'proposal', durationMin: 1 },
      { id: 'practice', stageKey: 'make', durationMin: 1 },
      { id: 'showcase', stageKey: 'showcase', durationMin: 1 },
      { id: 'reflection', stageKey: 'reflection', durationMin: 1 },
    ];
    const plan = buildPblModuleTimingPlan(120, activities, {
      difficulty: 'advanced',
      knowledgePoints: [
        { id: 'kp-1', level: 'application' },
        { id: 'kp-2', level: 'extension' },
      ],
    }, { now: '2026-07-13T00:00:00.000Z' });

    expect(plan.status).toBe('suggested');
    expect(plan.totalMinutes).toBe(120);
    expect(plan.allocations.reduce((sum, item) => sum + item.durationMin, 0)).toBe(120);
    expect(plan.allocations.find((item) => item.activityKind === 'practice' || item.stageKey === 'make')?.durationMin)
      .toBeGreaterThan(plan.allocations.find((item) => item.stageKey === 'ai-learning')?.durationMin ?? 0);
    expect(plan.generatedAt).toBe('2026-07-13T00:00:00.000Z');
  });

  it('normalizes a model recommendation to the canonical six stages and fixed total', () => {
    const activities = [
      { id: 'launch', stageKey: 'launch', durationMin: 1 },
      { id: 'knowledge', stageKey: 'ai-learning', durationMin: 1 },
      { id: 'proposal', stageKey: 'proposal', durationMin: 1 },
      { id: 'practice', stageKey: 'make', durationMin: 1 },
      { id: 'showcase', stageKey: 'showcase', durationMin: 1 },
      { id: 'reflection', stageKey: 'reflection', durationMin: 1 },
    ];
    const plan = buildPblModelTimingPlan(90, activities, {
      allocations: [
        { stageKey: 'project-launch', durationMin: 10, rationale: '需要建立真实问题情境。' },
        { stageKey: 'knowledge', durationMin: 25, rationale: '知识图谱包含两个先修依赖。' },
        { stageKey: 'proposal-review', durationMin: 10, rationale: '学生需要比较方案。' },
        { stageKey: 'project-making', durationMin: 35, rationale: '主要时间用于制作和迭代。' },
        { stageKey: 'showcase', durationMin: 15, rationale: '需要公开表达和反馈。' },
        { stageKey: 'reflection-transfer', durationMin: 5, rationale: '完成迁移反思。' },
      ],
      evidence: ['八年级', '2 个核心知识点', '学情需要分步案例'],
      assumptions: ['按 30 人班级估算'],
      confidence: 'high',
    }, undefined, { now: '2026-07-28T00:00:00.000Z' });

    expect(plan.allocations.reduce((sum, item) => sum + item.durationMin, 0)).toBe(90);
    expect(plan.allocations.map((item) => item.stageKey)).toEqual([
      'launch',
      'ai-learning',
      'proposal',
      'make',
      'showcase',
      'reflection',
    ]);
    expect(plan.recommendationSource).toBe('llm');
    expect(plan.confidence).toBe('high');
    expect(plan.rationaleByStage?.['ai-learning']).toContain('先修依赖');
    expect(plan.evidence).toContain('学情需要分步案例');
  });

  it('fills invalid or missing model stages with deterministic context recommendations', () => {
    const activities = [
      { id: 'launch', stageKey: 'launch', durationMin: 1 },
      { id: 'knowledge', stageKey: 'ai-learning', durationMin: 1 },
      { id: 'proposal', stageKey: 'proposal', durationMin: 1 },
      { id: 'practice', stageKey: 'make', durationMin: 1 },
      { id: 'showcase', stageKey: 'showcase', durationMin: 1 },
      { id: 'reflection', stageKey: 'reflection', durationMin: 1 },
    ];
    const plan = buildPblModelTimingPlan(60, activities, {
      allocations: [
        { stageKey: 'ai-learning', durationMin: 20, rationale: '复杂知识需要讲解。' },
        { stageKey: 'unknown-stage', durationMin: 999, rationale: '无效阶段。' },
      ],
      confidence: 'medium',
    }, { difficulty: 'advanced' }, { now: '2026-07-28T00:00:00.000Z' });

    expect(plan.allocations).toHaveLength(6);
    expect(plan.allocations.reduce((sum, item) => sum + item.durationMin, 0)).toBe(60);
    expect(plan.allocations.every((item) => item.durationMin >= 1)).toBe(true);
    expect(plan.assumptions?.some((item) => item.includes('缺失阶段'))).toBe(true);
  });

  it('keeps teacher-edited allocations as the confirmed source of truth', () => {
    const activities = [
      { id: 'launch', stageKey: 'launch', durationMin: 10 },
      { id: 'knowledge', stageKey: 'ai-learning', durationMin: 24 },
      { id: 'proposal', stageKey: 'proposal', durationMin: 12 },
      { id: 'practice', stageKey: 'make', durationMin: 48 },
      { id: 'showcase', stageKey: 'showcase', durationMin: 18 },
      { id: 'reflection', stageKey: 'reflection', durationMin: 8 },
    ];
    const plan = buildPblModuleTimingPlan(120, activities, undefined, {
      status: 'confirmed',
      preserveCurrentDurations: true,
      now: '2026-07-13T00:00:00.000Z',
    });

    expect(plan.allocations.reduce((sum, item) => sum + item.durationMin, 0)).toBe(120);
    expect(isPblModuleTimingPlanConfirmed(plan)).toBe(true);
  });

  it('does not confirm a plan with an invalid total or missing canonical module', () => {
    const plan = buildPblModuleTimingPlan(60, [
      { id: 'launch', stageKey: 'launch', durationMin: 10 },
      { id: 'knowledge', stageKey: 'ai-learning', durationMin: 50 },
    ], undefined, { status: 'confirmed', preserveCurrentDurations: true });

    expect(isPblModuleTimingPlanConfirmed(plan)).toBe(false);
  });

  it('estimates a positive Chinese TTS duration', () => {
    expect(estimateTtsDurationSec('请先观察数据，再说明你的判断依据。')).toBeGreaterThan(1);
  });
});
