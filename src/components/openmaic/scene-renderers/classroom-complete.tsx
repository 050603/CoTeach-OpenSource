'use client';

import { useCallback, useEffect, useId, useReducer, useRef, type CSSProperties } from 'react';
import { ArrowRight } from 'lucide-react';
import { useKnowledgeLectureQuizAttempts } from '@/components/openmaic-bridge/knowledge-lecture-quiz-lock';
import { useStudentCourseReview } from '@/components/openmaic-bridge/student-course-review-context';
import { useI18n } from '@openmaic/lib/hooks/use-i18n';
import { useStageStore } from '@openmaic/lib/store';
import type { Scene } from '@openmaic/lib/types/stage';
import { summarizeScenes, type SubmissionReader } from '@openmaic/lib/classroom/complete-summary';
import { readSubmittedState } from '@openmaic/lib/quiz/persistence';
import type { QuestionResult } from '@openmaic/lib/quiz/grading';
import styles from './classroom-complete.module.css';

const confetti = [
  [-84, -60, -210], [-52, -86, 170], [-14, -91, -160], [31, -87, 220],
  [70, -70, -230], [91, -29, 180], [86, 22, -190], [63, 67, 240],
  [24, 86, -160], [-22, 87, 200], [-67, 64, -220], [-90, 20, 190],
  [-91, -25, -170], [-70, -80, 250], [63, -87, -200], [89, 55, 230],
] as const;

function CompletionMark() {
  return (
    <div className={styles.mark} aria-hidden="true">
      <svg viewBox="0 0 200 200" fill="none" focusable="false">
        <circle cx="100" cy="100" r="74" className={styles.halo} />
        <circle cx="100" cy="100" r="63" className={styles.pulse} />
        <circle cx="100" cy="100" r="63" className={`${styles.pulse} ${styles.secondPulse}`} />
        <circle cx="100" cy="100" r="76" pathLength="1" className={styles.rim} />
        <g className={styles.seal}>
          <path d="M67 135L62 177L82 165L97 180L103 139M98 140L105 180L120 165L140 177L133 134" className={styles.ribbon} />
          <circle cx="100" cy="100" r="61" className={styles.disc} />
          <circle cx="100" cy="100" r="52" className={styles.innerRim} />
          <path d="M73 101L92 120L128 81" pathLength="1" className={styles.checkmark} />
        </g>
        <g transform="translate(100 100)">
          {confetti.map(([x, y, rotation], index) => (
            <g key={index} className={styles.confetti} style={{
              '--confetti-x': `${x}px`, '--confetti-y': `${y}px`,
              '--confetti-turn': `${rotation}deg`, '--confetti-delay': `${.48 + index % 4 * .07}s`,
            } as CSSProperties}>
              {index % 3 === 0 ? <circle r="2.4" />
                : index % 3 === 1 ? <path d="M0 -4L1.3 -1.3L4 0L1.3 1.3L0 4L-1.3 1.3L-4 0L-1.3 -1.3Z" />
                  : <rect x="-2" y="-4" width="4" height="8" rx="1" />}
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}

interface ClassroomCompletePageProps {
  readonly scenes: Scene[];
  readonly title: string;
  readonly onReviewScene?: (sceneId: string) => void;
  readonly readSubmission?: SubmissionReader;
}

export function ClassroomCompletePage({ scenes, title, onReviewScene, readSubmission = readSubmittedState }: ClassroomCompletePageProps) {
  const readOnly = useStudentCourseReview();
  const { t } = useI18n();
  const headingId = useId();
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const serverResults = useRef(new Map<string, { reader: SubmissionReader; results: QuestionResult[] }>());

  useEffect(() => {
    if (readOnly) return;
    const onGraded = (event: Event) => {
      const detail = (event as CustomEvent<{ sceneId?: string; results?: QuestionResult[] }>).detail;
      if (!detail?.sceneId || !scenes.some((scene) => scene.id === detail.sceneId)) return;
      if (Array.isArray(detail.results)) serverResults.current.set(detail.sceneId, { reader: readSubmission, results: detail.results });
      refresh();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || scenes.some((scene) =>
        event.key === `quizAnswers:${scene.id}` || event.key === `quizResults:${scene.id}`)) refresh();
    };
    window.addEventListener('openpbl:knowledge-lecture-server-graded', onGraded);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('openpbl:knowledge-lecture-server-graded', onGraded);
      window.removeEventListener('storage', onStorage);
    };
  }, [scenes, readSubmission, readOnly]);

  const { quiz, assessment } = summarizeScenes(scenes, (sceneId) => {
    const saved = readSubmission(sceneId);
    const latest = serverResults.current.get(sceneId);
    // A refreshed provider supersedes events received against an older snapshot.
    return !readOnly && latest?.reader === readSubmission
      ? { kind: 'reviewing', answers: saved?.answers ?? {}, results: latest.results } : saved;
  });
  const fullyGraded = quiz?.pct !== undefined;
  const reviewLabel = assessment?.unsubmittedCount ? 'continueQuiz'
    : !fullyGraded ? 'reviewAnswers' : assessment?.reviewCount ? 'reviewMistakes' : 'reviewQuiz';
  const guidance = assessment?.unsubmittedCount ? 'unfinishedGuidance'
    : !fullyGraded ? 'pendingGuidance' : assessment?.reviewCount ? 'mistakesGuidance' : 'allCorrectGuidance';

  return (
    <section className={styles.page} aria-labelledby={headingId}>
      <span className="sr-only" role="status">{readOnly ? '本课回看' : t('classroomComplete.announcement')}</span>
      <div className={styles.content}>
        {scenes.length > 0 && !readOnly && <CompletionMark />}
        <header className={styles.copy}>
          <h2 id={headingId}>{readOnly && scenes.length ? '本课回看' : t(`classroomComplete.${scenes.length ? 'headline' : 'emptyHeadline'}`)}</h2>
          {title && <p className={styles.courseTitle}>{title}</p>}
          {scenes.length === 0 && <p className={styles.emptyDescription}>{t('classroomComplete.emptyDescription')}</p>}
        </header>

        {assessment && (
          <div className={styles.recap} role="group" aria-label={t('classroomComplete.quizReview')} aria-live="polite" aria-atomic="true">
            <dl className={styles.stats}>
              <div>
                <dt>{t('classroomComplete.submittedLabel')}</dt>
                <dd>{t('classroomComplete.submittedQuestions', { count: assessment.submittedCount, total: assessment.questionCount })}</dd>
              </div>
              <div>
                <dt>{t('classroomComplete.correctLabel')}</dt>
                <dd>{t('classroomComplete.questionCount', { count: assessment.correctCount })}</dd>
              </div>
              <div>
                <dt>{t(`classroomComplete.${fullyGraded ? 'accuracyLabel' : assessment.pendingCount ? 'pendingLabel' : 'unsubmittedLabel'}`)}</dt>
                <dd className={fullyGraded ? styles.accuracy : undefined}>{fullyGraded
                  ? t('classroomComplete.accuracyPercent', { percent: Math.round(assessment.correctCount / assessment.questionCount * 100) })
                  : t('classroomComplete.questionCount', { count: assessment.pendingCount || assessment.unsubmittedCount })}</dd>
              </div>
            </dl>
            <p className={styles.guidance}>{readOnly ? '以上为本次课堂保存的作答情况，可继续回看题目与解析。' : t(`classroomComplete.${guidance}`)}</p>
          </div>
        )}

        {onReviewScene && scenes.length > 0 && (
          <nav className={styles.actions}>
            {assessment && (
              <button type="button" className={styles.primaryAction} onClick={() => onReviewScene(assessment.reviewSceneId)}>
                {readOnly ? '回看题目与解析' : t(`classroomComplete.${reviewLabel}`)}<ArrowRight size={18} aria-hidden="true" />
              </button>
            )}
            <button type="button" className={assessment ? styles.secondaryAction : styles.primaryAction} onClick={() => onReviewScene(scenes[0].id)}>
              {t('classroomComplete.reviewCourse')}{!assessment && <ArrowRight size={18} aria-hidden="true" />}
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}

export function ClassroomCompletePageConnected({ onReviewScene }: { readonly onReviewScene?: (sceneId: string) => void }) {
  const readOnly = useStudentCourseReview();
  const stage = useStageStore((state) => state.stage);
  const scenes = useStageStore((state) => state.scenes);
  const attempts = useKnowledgeLectureQuizAttempts();
  const readSubmission = useCallback<SubmissionReader>((sceneId) => {
    const scene = scenes.find((item) => item.id === sceneId);
    const attempt = (scene?.outlineId ? attempts.get(scene.outlineId) : undefined) ?? attempts.get(sceneId);
    if (!attempt) return readOnly ? null : readSubmittedState(sceneId);
    return {
      kind: 'reviewing',
      answers: Object.fromEntries(attempt.questions.map((question) => [question.questionId, question.rawAnswer ?? question.answer ?? ''])),
      results: attempt.questions.map((question) => ({
        questionId: question.questionId,
        correct: question.correct,
        status: question.gradingStatus === 'pending' || question.gradingStatus === 'failed' ? 'pending' : 'graded',
        earned: question.earned,
      })),
    };
  }, [attempts, scenes, readOnly]);
  return <ClassroomCompletePage scenes={scenes} title={stage?.name ?? ''} onReviewScene={onReviewScene} readSubmission={readSubmission} />;
}
