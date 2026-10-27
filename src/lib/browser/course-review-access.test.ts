import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { courseReviewKey, courseReviewPages, hasCourseReview, rememberCourseReview } from './course-review-access';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it('restores only the same learner, course instance, classroom and complete page set', () => {
  const key = courseReviewKey('course-a', 'student-a', 'classroom-a');
  const pages = courseReviewPages([{ id: 'a' }, { id: 'b' }]);
  rememberCourseReview(key, pages);
  expect(hasCourseReview(key, courseReviewPages([{ id: 'b' }, { id: 'a' }]))).toBe(true);
  expect(hasCourseReview(courseReviewKey('course-b', 'student-a', 'classroom-a'), pages)).toBe(false);
  expect(hasCourseReview(courseReviewKey('course-a', 'student-b', 'classroom-a'), pages)).toBe(false);
  expect(hasCourseReview(courseReviewKey('course-a', 'student-a', 'classroom-b'), pages)).toBe(false);
  expect(hasCourseReview(key, courseReviewPages([{ id: 'a' }]))).toBe(false);
  expect(hasCourseReview(key, courseReviewPages([{ id: 'a' }, { id: 'b' }, { id: 'new' }]))).toBe(false);
});

it('does not persist anonymous review or require available browser storage', () => {
  expect(courseReviewKey('course', undefined, 'classroom')).toBeNull();
  expect(hasCourseReview(null, 'pages')).toBe(false);
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
  expect(hasCourseReview('key', 'pages')).toBe(false);
  expect(() => rememberCourseReview('key', 'pages')).not.toThrow();
});
