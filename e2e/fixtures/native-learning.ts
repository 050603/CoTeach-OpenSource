import { browserLearningEventReceipt, createBrowserActionReceipts } from '../../scripts/lib/classroom-acceptance-action-receipts.mjs';
import type { Course, KnowledgeLectureAttempt } from '../../src/lib/session/types';
import { normalizePblCourseConfig } from '../../src/lib/pbl-course-config';

const now = '2026-10-13T00:00:00.000Z';
const id = 'native-learning-course';
const studentId = 'native-brand-student';
const question = { id: 'native-question', type: 'single', question: '比较鸟类数量时，为什么要保持观察时长一致？',
  options: [{ value: 'A', label: '控制观察时间这一条件' }, { value: 'B', label: '只凭印象比较' }],
  answer: ['A'], analysis: '保持相同观察时长，记录日期、地点与数量，才能合理比较观察结果。', points: 1, knowledgePointIds: ['native-point'] };
const attempt: KnowledgeLectureAttempt = {
  id: 'native-attempt', sectionId: 'native-section', quizOutlineId: 'native-quiz', runtimeSceneId: 'native-scene',
  submittedAt: now, score: 0, maxScore: 1, gradingSource: 'server', gradingStatus: 'graded', knowledgePointIds: ['native-point'],
  questions: [{ questionId: question.id, prompt: question.question, options: question.options, answer: 'B', rawAnswer: ['B'], questionType: 'single', points: 1, earned: 0,
    correct: false, feedback: question.analysis, referenceAnswer: '控制观察时间这一条件', gradingStatus: 'graded', knowledgePointIds: ['native-point'] }],
};

// Explicit browser-only responses. The native zoom suite routes every API and
// never writes these synthetic student/course identities to the service.
export function nativeLearningFixture() {
  let active = false;
  let role: 'teacher' | 'student' = 'student';
  let failedExplanation = false;
  let failSave = true;
  const actionReceipts = createBrowserActionReceipts(id, now);
  const tutorMessages = [{ id: 'native-explanation', role: 'assistant', content: '先比较相同的观察时长，再依据记录讨论差异。', createdAt: now }];
  const course: Course = {
    id, version: 1, name: '原生缩放科学观察课堂', subject: '科学', grade: '初中', hours: 1,
    status: 'teaching', summary: '', drivingQuestion: '如何比较鸟类数量？', createdAt: now, updatedAt: now,
    stages: [{ key: 'launch', label: '项目启动', view: 'simple-resource', description: '查看课堂任务与观察要求。' },
      { key: 'ai-learning', label: '知识讲授', view: 'ai-learning', description: '学习科学观察方法并完成检测。' },
      { key: 'make', label: '项目实践', view: 'ai-collaboration', description: '记录观察结果并保存项目成果。' },
      { key: 'showcase', label: '成果汇报', view: 'showcase-reporting', description: '展示观察证据与结论。' },
      { key: 'reflection', label: '学习反思', view: 'reflection-survey', description: '回顾观察方法与学习收获。' }], currentStageIndex: 1,
    students: [{ id: studentId, name: '原生缩放验收', joinedAt: now, stageProgress: {} }],
    resources: [], groups: [], submissions: [], activityLog: [], uiState: {},
    aiLearningClassroomId: 'native-learning-classroom', pblConfig: normalizePblCourseConfig({ makeArtifactMode: 'python' }),
    content: { pblOutline: '记录观察证据', lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' },
      knowledgePoints: [{ id: 'native-point', name: '科学观察', description: question.analysis }],
      knowledgeLectureSections: [{ id: 'native-section', title: '科学观察', order: 0, estimatedMinutes: 5, quizOutlineId: 'native-quiz',
        sceneOutlineIds: [], knowledgePointIds: ['native-point'] }] },
    aiLearningProgress: { [studentId]: { classroomId: 'native-learning-classroom', studentId, currentSceneIndex: 0, totalScenes: 1,
      completedScenes: ['native-scene'], lastActiveAt: now, masteryLevel: 'in-progress', knowledgeLectureAttempts: [attempt] } },
  };
  const state = () => ({ courses: [course], hydrated: true, user: { role, name: '原生缩放验收' },
    ...(role === 'student' ? { studentId, studentName: '原生缩放验收', joinedCourseId: id } : {}) });
  return {
    id,
    question,
    setMode(mode: 'quiz' | 'python' | 'document') {
      active = true;
      role = 'student';
      failSave = true;
      course.currentStageIndex = mode === 'quiz' ? 1 : 2;
      course.pblConfig = normalizePblCourseConfig({ ...course.pblConfig, makeArtifactMode: mode === 'document' ? 'document' : 'python' });
    },
    setTeacherMode() {
      active = true;
      role = 'teacher';
      course.currentStageIndex = 1;
      course.students = Array.from({ length: 30 }, (_, index) => ({ id: index ? `${studentId}-${index}` : studentId,
        name: `缩放验收学生${index + 1}`, joinedAt: now, stageProgress: {} }));
      course.classroomPopulation = { enrolledCount: 30, enteredCount: 30 };
      course.aiLearningProgress = Object.fromEntries(course.students.map(student => [student.id, {
        classroomId: 'native-learning-classroom', studentId: student.id, currentSceneIndex: 0, totalScenes: 1,
        completedScenes: ['native-scene'], lastActiveAt: now, masteryLevel: 'in-progress',
        knowledgeLectureAttempts: [{ ...attempt, id: `native-attempt-${student.id}` }],
      }]));
      // The same paused timing contract as teacher-presentation.spec.ts keeps
      // this layout audit independent of a running lesson timer.
      course.uiState = { classroomTiming: {
        schemaVersion: 1, status: 'paused', sessionStartedAt: now, pausedAt: now, activeStageKey: 'ai-learning', updatedAt: now,
        stages: course.stages.map((stage, index) => ({ stageKey: stage.key, label: stage.label, basePlannedSec: 600,
          adjustmentSec: 0, elapsedSec: 0, status: index === 1 ? 'active' : index < 1 ? 'completed' : 'pending' })),
      } };
    },
    recoverSave() { failSave = false; },
    response(pathname: string, method: string, body: Record<string, unknown>) {
      if (!active) return undefined;
      const ok = (body: unknown) => ({ status: 200, body });
      if (pathname === '/api/courses' && method === 'GET') return ok(state());
      if (pathname === `/api/courses/${id}/state`) return ok({ course, eventCursor: '0' });
      if (pathname === `/api/courses/${id}/events`) return ok({ events: [], nextCursor: '0', hasMore: false, courseVersion: course.version });
      if (pathname === `/api/courses/${id}/presence`) return ok({ members: [] });
      if (pathname === `/api/courses/${id}/projection`) return ok({ courseId: id, courseVersion: course.version, projectionVersion: 0, resourceProjection: null, teacherResourceProjection: null });
      if (pathname === `/api/courses/${id}/public-discussion` || pathname === `/api/courses/${id}/public-discussion/settings`) return ok({ enabled: false, session: null });
      if (pathname === `/api/courses/${id}/actions`) {
        const previous = actionReceipts.lookup(body);
        if (previous) return previous;
        let submissionVersion: number | undefined;
        const action = body.action as { type?: string; payload?: { submission?: NonNullable<Course['submissions']>[number]; patch?: Partial<Course> } } | undefined;
        if (action?.type === 'UPDATE_COURSE' && action.payload?.patch) Object.assign(course, action.payload.patch);
        if (action?.type === 'UPSERT_SUBMISSION') {
          if (failSave) return { status: 503, body: { message: '验收故障：服务器暂时无法保存，草稿仍保留在本机。' } };
          if (action.payload?.submission) {
            const saved = action.payload.submission;
            submissionVersion = (course.submissions?.find(item => item.id === saved.id)?.version ?? 0) + 1;
            course.submissions = [...(course.submissions ?? []).filter(item => item.id !== saved.id), { ...saved, version: submissionVersion }];
          }
        }
        course.version = (course.version ?? 0) + 1;
        return ok(actionReceipts.remember(body, { ok: true, courseVersion: course.version, ...(submissionVersion === undefined ? {} : { submissionVersion }), updatedAt: now }));
      }
      if (pathname === '/api/openmaic/classroom') return ok({ success: true, classroom: {
        stage: { id: course.aiLearningClassroomId, name: course.name, createdAt: now, updatedAt: now },
        scenes: [{ id: 'native-scene', stageId: course.aiLearningClassroomId, outlineId: 'native-quiz', lectureSectionId: 'native-section',
          title: '科学观察检测', type: 'quiz', order: 0, content: { type: 'quiz', questions: [question] }, actions: [] }],
      } });
      if (pathname === '/api/openmaic/progress') return ok({ data: { progress: {} } });
      if (pathname === '/api/knowledge-lecture/settings') return ok({ settings: {} });
      if (pathname === '/api/knowledge-lecture') {
        if (body.action === 'tutor-explain' && !failedExplanation) {
          failedExplanation = true;
          return { status: 503, body: { error: 'TUTOR_REQUEST_FAILED' } };
        }
        if (body.action === 'tutor-explain') return ok({ explanation: {
          id: 'native-shared-explanation', questionFingerprint: 'native-question-fingerprint', source: 'prepared',
          text: '先比较相同的观察时长，再依据记录讨论差异。', boardNotes: [],
        } });
        if (body.action === 'tutor-message') tutorMessages.push({ id: `native-message-${tutorMessages.length}`, role: 'student', content: String(body.message), createdAt: now });
        return ok({ attempt, thread: { id: 'native-thread', attemptId: attempt.id, questionId: question.id,
          messages: tutorMessages, boardNotes: [], createdAt: now, updatedAt: now } });
      }
      if (pathname === '/api/ai-collaboration/code' || pathname === '/api/ai-collaboration/document') {
        return ok({ messages: [], commentThreads: [], starters: [], conversations: [], proactiveReviewEnabled: false });
      }
      if (pathname === '/api/ai-collaboration/memory') return ok({ memories: [], continuation: null });
      if (['/api/openmaic/server-providers', '/api/openmaic/provider-config', '/api/server-providers'].includes(pathname)) return ok({ providers: [], models: [], success: true });
      if (pathname === '/api/learning-events' && method === 'POST') return browserLearningEventReceipt(body, Date.now());
      if (pathname === '/api/learning-events') return ok({ success: true });
      if (pathname === '/api/ai-collaboration/events') return ok({ events: [], success: true });
      if (pathname === `/api/courses/${id}/learning-events` || pathname === `/api/courses/${id}/learning-analytics`) return ok({ success: true });
      return undefined;
    },
  };
}
