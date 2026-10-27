import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIncrementalRecommendation, assertIncrementalArchiveText, assertIncrementalRecommendationFactsCount } from './incremental-showcase-acceptance.mjs';

test('archive verification keeps offline paragraphs and handles Word text runs and entities', () => {
  const source = '<h1>观察 &amp; 记录</h1><p>incremental-recovery-12</p><p>OFFLINE_EDIT_最新内容</p>';
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>观察 &amp; 记录</w:t></w:r></w:p><w:p><w:r><w:t>incremental-</w:t></w:r><w:r><w:t>recovery-12</w:t></w:r></w:p><w:p><w:r><w:t>OFFLINE_EDIT_最新内容</w:t></w:r></w:p></w:body></w:document>';
  assert.ok(assertIncrementalArchiveText(source, xml).sourceCharacters > 0);
  assert.throws(() => assertIncrementalArchiveText(source, xml.replace('OFFLINE_EDIT_最新内容', '')));
});

const fixture = () => ({
  versionId: 'current-version', sourceHtml: '<p>观察时长固定为十分钟，保留原始计数。</p>',
  candidate: { artifactVersionId: 'current-version', artifactKind: 'document', analysisStatus: 'complete',
    analyzedArtifactVersionId: 'current-version', analysisFreshness: 'exact', qualityScore: 78,
    coverage: { mode: 'full' }, reasons: [{ kind: 'quality', text: '比较条件明确', location: '段落 1', quote: '观察时长固定为十分钟' }] },
  prepared: { artifactVersionId: 'current-version', snapshot: { fingerprint: 'current-source',
    blocks: [{ location: '段落 1', text: '观察时长固定为十分钟，保留原始计数。' }] } },
  analysis: { id: 'analysis-current', status: 'COMPLETED', attemptCount: 1, input: { artifactVersionId: 'current-version', requests: [{ at: '2026-10-20T01:00:00Z' }],
    snapshot: { fingerprint: 'current-source' } } },
});

test('accepts a completed current-version recommendation backed by its actual source', () => {
  assert.equal(assertIncrementalRecommendation(fixture()).analysisTaskId, 'analysis-current');
});

test('pending, failed, obsolete and reused analyses cannot become current-version acceptance', () => {
  for (const status of ['pending', 'running', 'failed', 'unreadable']) {
    const input = fixture(); input.candidate.analysisStatus = status;
    assert.throws(() => assertIncrementalRecommendation(input));
  }
  for (const mutate of [input => { input.candidate.analyzedArtifactVersionId = 'old-version'; },
    input => { input.candidate.analysisFreshness = 'reused'; }, input => { input.analysis.input.snapshot.fingerprint = 'old-source'; }]) {
    const input = fixture(); mutate(input); assert.throws(() => assertIncrementalRecommendation(input));
  }
});

test('fabricated quotes, wrong locations and cross-source evidence cannot pass', () => {
  for (const mutate of [input => { input.candidate.reasons[0].quote = '杜撰的结论内容'; },
    input => { input.candidate.reasons[0].location = '段落 2'; }, input => { input.sourceHtml = '<p>另一个学生的项目报告。</p>'; },
    input => { input.candidate.reasons = [{ kind: 'earliest', text: '最早提交' }]; }]) {
    const input = fixture(); mutate(input); assert.throws(() => assertIncrementalRecommendation(input));
  }
});


test('zero recommendation AI requests accept an absent facts row or absent scoped count', () => {
  for (const facts of [null, undefined, {}, { output: {} }, { output: { counts: {} } }, { output: { counts: { self: 0 } } }]) {
    assert.doesNotThrow(() => assertIncrementalRecommendationFactsCount({ aiRequestCount: 0 }, 'self', facts));
  }
});

test('nonzero recommendation AI requests require their own cached count', () => {
  assert.doesNotThrow(() => assertIncrementalRecommendationFactsCount({ aiRequestCount: 3 }, 'self', {
    output: { counts: { self: 3 } },
  }));
  for (const facts of [null, undefined, { output: { counts: {} } }]) {
    assert.throws(() => assertIncrementalRecommendationFactsCount({ aiRequestCount: 3 }, 'self', facts));
  }
});

test('another student AI request count cannot satisfy the current recommendation', () => {
  const facts = { output: { counts: { other: 3 } } };
  assert.doesNotThrow(() => assertIncrementalRecommendationFactsCount({ aiRequestCount: 0 }, 'self', facts));
  assert.throws(() => assertIncrementalRecommendationFactsCount({ aiRequestCount: 3 }, 'self', facts));
});

test('mismatched recommendation AI counts remain failures in both directions', () => {
  for (const [candidateCount, cachedCount] of [[0, 1], [1, 0], [2, 3], [3, 2]]) {
    assert.throws(() => assertIncrementalRecommendationFactsCount({ aiRequestCount: candidateCount }, 'self', {
      output: { counts: { self: cachedCount } },
    }));
  }
});
