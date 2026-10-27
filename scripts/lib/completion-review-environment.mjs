import { courseReadWorkerSettings } from './course-read-role.mjs';
import assert from 'node:assert/strict';

const keys = ['WORKERS', 'CONNECTION_BUDGET', 'PER_WORKER_CONNECTIONS'].map(key => `OPENPBL_COURSE_READ_${key}`);

export function completionReviewContextsPerBrowser(environment) {
  const value = Number(environment.COMPLETION_REVIEW_CONTEXTS_PER_BROWSER ?? 10);
  assert.ok(Number.isInteger(value) && value >= 1 && value <= 10,
    'COMPLETION_REVIEW_CONTEXTS_PER_BROWSER must be an integer from 1 through 10');
  return value;
}

export function completionReviewPreparationConcurrency(environment, students) {
  const value = Number(environment.COMPLETION_REVIEW_PREPARATION_CONCURRENCY ?? students);
  assert.ok(Number.isInteger(value) && value >= 1 && value <= students,
    'COMPLETION_REVIEW_PREPARATION_CONCURRENCY must be an integer within the student roster');
  return value;
}

export function completionReviewLayoutPlan(students, targetBrand, caseCount, excludedIndices = []) {
  const sources = students.filter(student => student.brand !== targetBrand && !excludedIndices.includes(student.index));
  assert.ok(sources.length, 'An opposite-brand completed student is required for review restoration');
  return { concurrency: Math.min(2, sources.length), sourceStudentIndices: Array.from({ length: caseCount }, (_, index) => sources[index % sources.length].index) };
}

/** Only numeric settings cross into the disposable runtime. Its reader URL is
 * subsequently provisioned against the new local PostgreSQL container. */
export function completionCourseReadEnvironment(environment, installed) {
  const numeric = values => Object.fromEntries(keys.filter(key => values?.[key] !== undefined).map(key => [key, values[key]]));
  const installedNumeric = numeric(installed);
  const resolved = { ...installedNumeric, ...numeric(environment) };
  const settings = courseReadWorkerSettings(resolved);
  if (installed) courseReadWorkerSettings(installedNumeric);
  return { environment: resolved, evidence: {
    source: installed ? 'installed-course-read-numeric-settings' : 'explicit-environment-or-default',
    installed: Object.fromEntries(Object.entries(installedNumeric).map(([key, value]) => [key, Number(value)])),
    effective: { workers: settings.workers, ...(settings.enabled ? { connectionBudget: settings.budget, perWorkerConnections: settings.perWorkerConnections } : {}) },
    explicitOverrides: keys.filter(key => environment[key] !== undefined),
    matchesInstalled: !!installed && keys.every(key => resolved[key] === installedNumeric[key]),
    productionDatabaseUrlCopied: false,
  } };
}
