'use client';

import { createContext, useContext } from 'react';

/** Course review permits playback and navigation without recording new learning. */
export const StudentCourseReviewContext = createContext(false);

export function useStudentCourseReview(): boolean {
  return useContext(StudentCourseReviewContext);
}
