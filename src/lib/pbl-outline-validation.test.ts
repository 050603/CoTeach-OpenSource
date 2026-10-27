import { describe, expect, it } from 'vitest';
import { validatePblKnowledgeAlignment } from './pbl-outline-validation';

describe('PBL knowledge-point validation', () => {
  const points = [
    { id: 'kp-1', name: '变量' },
    { id: 'kp-2', name: '证据' },
  ];

  it('accepts known references and reports coverage', () => {
    const result = validatePblKnowledgeAlignment(
      [{ id: 'detail-1', title: '变量讲解', knowledgePointIds: ['kp-1'] }],
      points,
      { requireReferences: true },
    );

    expect(result.valid).toBe(true);
    expect(result.referencedPointIds).toEqual(['kp-1']);
    expect(result.unreferencedPointIds).toEqual(['kp-2']);
    expect(result.coverageRatio).toBe(0.5);
  });

  it('rejects references that are not in the confirmed catalog', () => {
    const result = validatePblKnowledgeAlignment(
      [{ id: 'detail-1', title: '偏题内容', knowledgePointIds: ['kp-unknown'] }],
      points,
    );

    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: 'unknown-knowledge-point',
      knowledgePointIds: ['kp-unknown'],
    });
  });

  it('reports missing references without treating an empty detail as an unknown ID', () => {
    const result = validatePblKnowledgeAlignment(
      [{ id: 'detail-1', title: '未关联', knowledgePointIds: [] }],
      points,
      { requireReferences: true },
    );

    expect(result.valid).toBe(true);
    expect(result.issues[0]?.code).toBe('missing-knowledge-reference');
  });
});
