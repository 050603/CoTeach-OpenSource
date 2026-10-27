import assert from 'node:assert/strict';
import test from 'node:test';
import { completionCourseReadEnvironment, completionReviewContextsPerBrowser, completionReviewPreparationConcurrency, completionReviewLayoutPlan } from './completion-review-environment.mjs';

const installed = { OPENPBL_COURSE_READ_WORKERS: '2', OPENPBL_COURSE_READ_CONNECTION_BUDGET: '57',
  OPENPBL_COURSE_READ_PER_WORKER_CONNECTIONS: '16', OPENPBL_COURSE_READ_DATABASE_URL: 'postgresql://private-production-value' };

test('inherits only numeric reader settings and never the production database URL', () => {
  const resolved = completionCourseReadEnvironment({}, installed);
  assert.deepEqual(resolved.evidence.effective, { workers: 2, connectionBudget: 57, perWorkerConnections: 16 });
  assert.equal(resolved.evidence.matchesInstalled, true);
  assert.equal('OPENPBL_COURSE_READ_DATABASE_URL' in resolved.environment, false);
  assert.equal(JSON.stringify(resolved).includes('private-production-value'), false);
});

test('explicit numeric environment overrides the installed values', () => {
  const resolved = completionCourseReadEnvironment({ OPENPBL_COURSE_READ_WORKERS: '1' }, installed);
  assert.equal(resolved.evidence.effective.workers, 1);
  assert.equal(resolved.evidence.matchesInstalled, false);
  assert.deepEqual(resolved.evidence.explicitOverrides, ['OPENPBL_COURSE_READ_WORKERS']);
});

test('an explicit disabled reader remains disabled and invalid limits fail', () => {
  assert.equal(completionCourseReadEnvironment({ OPENPBL_COURSE_READ_WORKERS: '0' }, installed).evidence.effective.workers, 0);
  assert.throws(() => completionCourseReadEnvironment({ OPENPBL_COURSE_READ_CONNECTION_BUDGET: '32' }, installed), /COURSE_READ_PRIMARY_BUDGET_EXHAUSTED/);
});

test('browser grouping retains the default maximum of ten contexts', () => {
  assert.equal(completionReviewContextsPerBrowser({}), 10);
});

test('browser grouping supports one independent browser per student and the upper bound', () => {
  assert.equal(completionReviewContextsPerBrowser({ COMPLETION_REVIEW_CONTEXTS_PER_BROWSER: '1' }), 1);
  assert.equal(completionReviewContextsPerBrowser({ COMPLETION_REVIEW_CONTEXTS_PER_BROWSER: '10' }), 10);
});

test('browser grouping rejects fractional, out-of-range and nonnumeric configuration', () => {
  for (const value of ['0', '11', '1.5', 'invalid', '']) {
    assert.throws(() => completionReviewContextsPerBrowser({ COMPLETION_REVIEW_CONTEXTS_PER_BROWSER: value }), /integer from 1 through 10/);
  }
});

test('preparation defaults to the full roster and explicitly supports eight-person cold-start waves', () => {
  assert.equal(completionReviewPreparationConcurrency({}, 40), 40);
  assert.equal(completionReviewPreparationConcurrency({ COMPLETION_REVIEW_PREPARATION_CONCURRENCY: '8' }, 40), 8);
  assert.equal(completionReviewPreparationConcurrency({}, 2), 2);
  for (const value of ['0', '41', '1.5', 'invalid']) assert.throws(() => completionReviewPreparationConcurrency({ COMPLETION_REVIEW_PREPARATION_CONCURRENCY: value }, 40));
});

test('layout identity rotation uses the opposite brand, excludes idle probes and gives concurrent pairs different students', () => {
  const students = Array.from({ length: 40 }, (_, index) => ({ index, brand: index % 2 }));
  for (const targetBrand of [0, 1]) {
    const plan = completionReviewLayoutPlan(students, targetBrand, 38, [2, 3]);
    assert.equal(plan.concurrency, 2);
    for (let index = 0; index < plan.sourceStudentIndices.length; index += 2) assert.notEqual(plan.sourceStudentIndices[index], plan.sourceStudentIndices[index + 1]);
    assert.ok(plan.sourceStudentIndices.every(index => students[index].brand !== targetBrand && ![2, 3].includes(index)));
    const uses = plan.sourceStudentIndices.reduce((counts, index) => ({ ...counts, [index]: (counts[index] ?? 0) + 1 }), {});
    assert.deepEqual(new Set(Object.values(uses)), new Set([2]));
  }
});

test('layout-only two-student scope runs serially and preserves the opposite-brand identity', () => {
  const students = [{ index: 0, brand: 0 }, { index: 1, brand: 1 }];
  const plan = completionReviewLayoutPlan(students, 0, 38);
  assert.equal(plan.concurrency, 1); assert.ok(plan.sourceStudentIndices.every(index => index === 1));
  assert.throws(() => completionReviewLayoutPlan(students, 0, 38, [1]), /opposite-brand/);
});
