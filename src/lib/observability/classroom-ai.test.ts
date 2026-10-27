import { describe, expect, it, vi } from 'vitest';
import { Histogram, register } from 'prom-client';
const mocks = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('./logger', () => ({ logger: { info: mocks.info } }));
import { recordAiAdmission, startClassroomAiCall, withClassroomAiUsage } from './classroom-ai';

describe('classroom AI accounting', () => {
  it('reports unknown usage instead of inventing zero and records once', () => {
    const finish = withClassroomAiUsage({ feature: 'knowledge-tutor', courseId: 'course' }, () => startClassroomAiCall('quiz-grade', 'provider', 'model'));
    finish('failed'); finish('failed');
    expect(mocks.info).toHaveBeenCalledTimes(1);
    expect(mocks.info.mock.calls[0][0]).toMatchObject({ courseId: 'course', feature: 'knowledge-tutor',
      usageSource: 'unknown', inputTokens: null, outputTokens: null, totalTokens: null });
  });
  it('keeps provider zero counts and cached tokens without double-counting calls', () => {
    mocks.info.mockClear();
    const finish = startClassroomAiCall('document-collaboration', 'provider', 'model');
    finish('response', { inputTokens: 100, outputTokens: 0, cacheReadTokens: 50, totalTokens: 100 });
    expect(mocks.info.mock.calls[0][0]).toMatchObject({ usageSource: 'provider', inputTokens: 100, outputTokens: 0, cacheReadTokens: 50 });
  });
  it('exposes empty admission counters without fake samples and preserves real counters on module reload', async () => {
    const histogram = register.getSingleMetric('classroom_ai_admission_seconds');
    if (!(histogram instanceof Histogram)) throw new Error('Admission metric must be a histogram');
    const before = (await histogram.get()).values.filter(value => value.metricName === 'classroom_ai_admission_seconds_count');
    expect(before).toHaveLength(4);
    expect(before.every(value => value.value === 0)).toBe(true);
    recordAiAdmission('interactive', 'admitted', 0.2);
    vi.resetModules();
    await import('./classroom-ai');
    const after = (await histogram.get()).values.filter(value => value.metricName === 'classroom_ai_admission_seconds_count');
    expect(after.find(value => value.labels?.priority === 'interactive' && value.labels?.outcome === 'admitted')?.value).toBe(1);
    expect(after.filter(value => value.labels?.priority !== 'interactive' || value.labels?.outcome !== 'admitted').every(value => value.value === 0)).toBe(true);
  });
  it('propagates usage across bundles while keeping concurrent request scopes isolated', async () => {
    mocks.info.mockClear();
    vi.resetModules();
    const second = await import('./classroom-ai');
    expect(second.withClassroomAiUsage).not.toBe(withClassroomAiUsage);
    await Promise.all(['first', 'second'].map(requestId => withClassroomAiUsage({ feature: 'document-collaboration', requestId }, async () => {
      await Promise.resolve();
      const finish = second.startClassroomAiCall('llm-client', 'fixture', 'fixture');
      finish('response');
    })));
    expect(mocks.info.mock.calls.map(call => call[0])).toEqual([
      expect.objectContaining({ feature: 'document-collaboration', requestId: 'first' }),
      expect.objectContaining({ feature: 'document-collaboration', requestId: 'second' }),
    ]);
    second.startClassroomAiCall('outside-scope', 'fixture', 'fixture')('response');
    expect(mocks.info.mock.calls[2][0]).toMatchObject({ feature: 'outside-scope' });
    expect(mocks.info.mock.calls[2][0]).not.toHaveProperty('requestId');
  });
});
