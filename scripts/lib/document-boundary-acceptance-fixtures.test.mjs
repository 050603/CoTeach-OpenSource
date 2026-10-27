import assert from 'node:assert/strict';
import test from 'node:test';
import { boundaryCases, boundaryConstraintCases, boundaryCourses, boundaryShapeChecks, classifyBoundaryResult } from './document-boundary-acceptance-fixtures.mjs';

test('the same formatting request is auxiliary in the research course and protected in the formatting course', () => {
  const auxiliary = boundaryCases.find(row => row.id === '03');
  const protectedCase = boundaryCases.find(row => row.id === '17');
  assert.equal(auxiliary.request, protectedCase.request);
  assert.equal(auxiliary.documentHtml, protectedCase.documentHtml);
  assert.deepEqual(auxiliary.expectedKinds, ['work-delivery']);
  assert.deepEqual(protectedCase.expectedKinds, ['boundary']);
  assert.match(boundaryCourses.C.expectedOutcome, /标题、编号和引用格式本身/);
  assert.equal(boundaryCases.length, 18);
  assert.equal(new Set(boundaryCases.map(row => row.id)).size, 18);
});

test('multi-turn cumulative scenario moves its initial delegation out of the six-message history window using real requests', () => {
  const cumulative = boundaryCases.find(row => row.id === '18');
  assert.ok(cumulative.turns.length > 6);
  assert.match(cumulative.turns[0], /研究问题/);
  assert.match(cumulative.request, /拼成最终/);
  assert.deepEqual(cumulative.expectedKinds, ['boundary']);
});

test('a successful HTTP response without a result is a technical failure, never a boundary success', () => {
  assert.equal(classifyBoundaryResult({ httpStatus: 200, response: { status: 'completed' } }), '技术或交付质量失败');
  assert.equal(classifyBoundaryResult({ httpStatus: 422, response: { result: { kind: 'boundary' } } }), '技术或交付质量失败');
  assert.equal(classifyBoundaryResult({ httpStatus: 200, response: { result: { kind: 'boundary' } } }), '教学边界拦截');
  assert.equal(classifyBoundaryResult({ httpStatus: 200, response: { result: { kind: 'task-clarification', delegation: { decision: 'unavailable' } } } }), '技术或交付质量失败');
  assert.equal(classifyBoundaryResult({ caseId: '14', httpStatus: 200, response: { result: { kind: 'boundary' } } }), '与项目无关');
});

test('shape checks expose inappropriate document actions and protected deliveries independently of the apparent category', () => {
  const checklist = boundaryCases.find(row => row.id === '15');
  assert.deepEqual(boundaryShapeChecks(checklist, { result: { kind: 'work-delivery', deliverable: { documentActions: [{ operation: 'none' }] } } }), []);
  assert.match(boundaryShapeChecks(checklist, { result: { kind: 'work-delivery', deliverable: { documentActions: [{ operation: 'append' }] } } }).join(), /入文/);
  const core = boundaryCases.find(row => row.id === '08');
  assert.match(boundaryShapeChecks(core, { result: { kind: 'boundary', deliverable: { content: '代写结论', documentActions: [] } } }).join(), /核心任务/);
});

test('explicit document work must include an executable action, not just advice or chat-only content', () => {
  const table = boundaryCases.find(row => row.id === '01');
  const delivery = documentActions => ({ result: { kind: 'work-delivery', deliverable: { content: '观察记录表', documentActions } } });
  assert.match(boundaryShapeChecks(table, delivery([{ operation: 'none' }])).join(), /没有可执行/);
  assert.match(boundaryShapeChecks(table, delivery([])).join(), /没有可执行/);
  assert.deepEqual(boundaryShapeChecks(table, delivery([{ operation: 'append', content: '观察记录表' }])), []);
});


test('supplemental mixed requests preserve independent placement and link constraints without replacing the original matrix', () => {
  assert.equal(boundaryCases.length, 18);
  assert.deepEqual(boundaryConstraintCases.map(row => row.id), ['M01', 'M02', 'M03']);
  for (const row of boundaryConstraintCases.slice(0, 2)) {
    assert.equal(row.conversationOnly, true);
    assert.equal(row.partial, true);
    assert.ok(row.requiredUrls.every(url => row.documentHtml.includes(url)));
    assert.match(boundaryShapeChecks(row, { result: { kind: 'work-delivery', deliverable: { content: '', documentActions: [{ operation: 'append' }] } } }).join(), /入文/);
    assert.match(boundaryShapeChecks(row, { result: { kind: 'work-delivery', deliverable: { content: '', documentActions: [{ operation: 'none' }] } } }).join(), /链接/);
  }
});
