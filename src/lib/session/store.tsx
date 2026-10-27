"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  applySessionAction,
  initialSessionState,
  makeRecordId,
} from "./actions";
import type { SessionAction, SessionState } from "./actions";
import type {
  ActivityRecord,
  AiAssessmentSuggestion,
  AiContribution,
  AiSupportRecord,
  AnnouncementReply,
  ClassConfig,
  ClassroomSubmission,
  ArtifactSnapshot,
  CompanionConfirmation,
  CompanionProcessRecord,
  CompanionTask,
  Course,
  CourseAnnouncement,
  CourseContent,
  CourseTodo,
  CourseUiState,
  CourseUpload,
  GroupAnnouncement,
  GroupBoard,
  GroupBoardMode,
  LearningEvidence,
  LearningSignal,
  OfflineInterventionRecord,
  ProjectGroup,
  ReflectionRecord,
  RubricScore,
  Stage,
  Student,
  StudentAiDecision,
  TeacherFeedback,
  TeamContribution,
  TeacherAgentDirective,
  WhiteboardNode,
  WorkPlanItem,
} from "./types";
import { projectionClientId } from "@/lib/realtime/projection-controller";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import { createScopedReadLane } from "@/lib/browser/scoped-read-lane";
import type { ActionAck } from "@/lib/courses/contracts";
import { acknowledgeSubmissionSave, readSubmissionSaves, retainSubmissionSave, sameSubmissionContent, type SubmissionSaveRecord, type SubmissionSaveConflict } from "@/lib/browser/submission-save-outbox";
import { clientUUID } from "@/lib/uuid";
import { submissionSaveTelemetry, unknownSubmissionSaveTelemetry } from "@/lib/browser/submission-save-telemetry";
import type { PendingSaveTelemetry } from "@/lib/presence-save-telemetry";
import { DEFAULT_EVALUATION_FLOWS } from "./types";
import { getStagesForSystemMode } from "@/lib/system-mode";
import { getNewSystemCourseReadiness } from "@/lib/classroom/new-system-course";
import { isAdvisoryCourseReadinessCheck } from "@/lib/course-quality-review/teacher-review";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import {
  DEFAULT_NEW_COURSE_HOURS,
  DEFAULT_NEW_COURSE_SUBJECT,
} from "@/lib/teacher/course-basics-draft";
import { loadJSON, saveJSON } from "./storage";
import { generateInviteCode, normalizeInviteCode } from "./invite-code";
import { toast } from "sonner";
import { getSessionRouteMode } from "./route-mode";
import {
  retryVersionConflict,
  SessionActionRequestError,
} from "./action-version-retry";
import {
  COURSE_EVENT_POLL_INTERVAL_MS,
  COURSE_SYNC_FAILURE_NOTICE_THRESHOLD,
  SESSION_REFRESH_INTERVAL_MS,
  courseRefreshDelay,
  isClassroomControlEvent,
  isRealtimePollingActive,
  latestEventCursor,
  type RealtimeTransportMode,
} from "@/lib/realtime/sync-policy";
import { createCourseRefreshScheduler } from "@/lib/realtime/course-refresh-scheduler";
import { decodeEventCursor } from "@/lib/realtime/event-cursor";
import { advanceCourseVersionCoverage, PRIVATE_VERSION_COVERAGE_PROTOCOL } from "@/lib/realtime/course-version-coverage";
import { createCourseCatchUpCoordinator } from "@/lib/realtime/course-catchup-coordinator";
import {
  PROJECTION_COALESCE_MS,
  PROJECTION_CONNECTED_CHECK_INTERVAL_MS,
  PROJECTION_POLL_INTERVAL_MS,
  PROJECTION_REQUEST_TIMEOUT_MS,
  estimateServerClockOffset,
  highestKnownProjectionVersion,
  isImmediateProjectionPatch,
  mergeCourseUiStateWithProjectionGuard,
  projectionPatchFromAction,
  shouldApplyProjectionVersion,
  withProjectionClockOffset,
  type ProjectionStateSnapshot,
} from "@/lib/realtime/projection-state";
import { LatestValueQueue } from "@/lib/realtime/latest-value-queue";
import { emitShowcasePresentation } from "@/lib/showcase/realtime-client";
import { emitDocumentReviewCompletion } from "@/lib/browser/document-review-notifications";
import { emitPublicDiscussionUpdate } from "@/lib/public-discussion/realtime-client";
import type { ShowcaseEventPayload } from "@/lib/showcase/types";

const IDENTITY_KEY = "openpbl.identity.v1";
// Separate identity keys per role to prevent teacher/student identity cross-contamination
// when both are open in the same browser.
const TEACHER_IDENTITY_KEY = "openpbl.identity.teacher.v1";
const STUDENT_IDENTITY_KEY = "openpbl.identity.student.v1";
const LEFT_CLASS_HISTORY_KEY = "openpbl.left-class-history.v1";

type LeftClassRecord = {
  courseId: string;
  courseName: string;
  studentId: string;
  studentName: string;
  leftAt: string;
};

type IdentityState = Pick<
  SessionState,
  "user" | "joinedCourseId" | "studentId" | "studentName"
> & {
  // Cached join timestamp so we can fully reconstruct the Student record
  // when the polling refresh races ahead of the server's JOIN_CLASS ack.
  joinedAt?: string;
  // Cached group membership so applyIdentity can restore the student's
  // group slot when polling returns server state that hasn't yet processed
  // the JOIN_GROUP action.
  joinedGroupId?: string;
  joinedGroupRole?: string;
};

type SubmissionInput = Omit<
  ClassroomSubmission,
  "id" | "courseId" | "createdAt" | "updatedAt"
> & { id?: string; courseId?: string; expectedVersion?: number; draftKey?: string; recoveredDraftKey?: string; aiRevisionSource?: import("./types").AiRevisionSource };

type QueuedProjectionUpdate = {
  action: SessionAction;
  requestId: string;
};

type TimingInitializationScope = {
  hydrationEpoch: number;
  courseEpoch: number;
  actorName: string;
  courseId: string;
  stageVersion: number;
  stageKey: string;
  // Only this request's validated ACK may advance its readback scope.
  acknowledgedStageVersion?: number;
};

type SessionApi = SessionState & {
  saveState: "idle" | "unsaved" | "saving" | "saved" | "error";
  lastSavedAt?: string;
  saveError?: string;
  retrySave: () => Promise<void>;
  readPendingSubmissionSaves: (courseId: string) => PendingSaveTelemetry;
  submissionSaveConflicts: SubmissionSaveConflict[];
  resolveSubmissionSaveConflict: (requestId: string, choice: "local" | "remote", content?: string) => Promise<ClassroomSubmission | undefined>;
  /** Wait for queued autosaves before a server-side final submission. */
  flushSaves: () => Promise<boolean>;
  setUser: (u: SessionState["user"]) => void;
  createCourse: (input: Partial<Course>) => Course;
  updateCourse: (id: string, patch: Partial<Course>) => void;
  deleteCourse: (id: string) => void;
  setCourseContent: (id: string, content: CourseContent) => void;
  setCourseStages: (id: string, stages: Stage[]) => void;
  publishCourse: (id: string) => void;
  startTeaching: (id: string, classConfig: ClassConfig) => string;
  restartTeaching: (id: string) => { inviteCode: string };
  endTeaching: (id: string) => void;
  advanceStage: (id: string, direction: 1 | -1) => void;
  setStage: (id: string, index: number) => void;
  joinClass: (code: string, name: string) => { ok: true; course: Course } | { ok: false; reason: string };
  rejoinClass: (record: LeftClassRecord) => { ok: true; course: Course } | { ok: false; reason: string };
  leaveClass: () => Promise<boolean>;
  getLeftClassHistory: () => LeftClassRecord[];
  updateStudentProgress: (stageKey: string, value: number) => void;
  upsertSubmission: (submission: SubmissionInput) => ClassroomSubmission | undefined;
  persistSubmission: (submission: SubmissionInput) => Promise<ClassroomSubmission | undefined>;
  addFeedback: (feedback: Omit<TeacherFeedback, "id" | "courseId" | "createdAt"> & { id?: string; courseId?: string }) => TeacherFeedback | undefined;
  upsertRubricScore: (score: Omit<RubricScore, "id" | "courseId" | "createdAt" | "updatedAt"> & { id?: string; courseId?: string }) => RubricScore | undefined;
  upsertReflection: (reflection: Omit<ReflectionRecord, "id" | "courseId" | "studentId" | "studentName" | "createdAt" | "updatedAt"> & { id?: string; courseId?: string; studentId?: string; studentName?: string }) => ReflectionRecord | undefined;
  upsertAnnouncement: (courseId: string, input: Omit<CourseAnnouncement, "id" | "createdAt" | "updatedAt" | "replies"> & { id?: string; replies?: AnnouncementReply[] }) => CourseAnnouncement;
  deleteAnnouncement: (courseId: string, announcementId: string) => void;
  replyAnnouncement: (courseId: string, announcementId: string, content: string) => AnnouncementReply | undefined;
  upsertTodo: (courseId: string, todo: CourseTodo) => void;
  completeTodo: (courseId: string, todoId: string, completed: boolean) => void;
  markResourceDownloaded: (courseId: string, resourceId: string) => void;
  upsertGroup: (courseId: string, group: ProjectGroup) => void;
  createGroup: (courseId: string, name?: string) => ProjectGroup;
  joinGroup: (courseId: string, groupId: string, role?: string) => void;
  leaveGroup: (courseId: string, groupId: string) => void;
  setGroupTopic: (courseId: string, groupId: string, patch: Partial<ProjectGroup>) => void;
  upsertGroupAnnouncement: (courseId: string, input: Omit<GroupAnnouncement, "id" | "actor" | "createdAt"> & { id?: string; actor?: string }) => GroupAnnouncement;
  upsertWorkPlanItem: (courseId: string, item: Omit<WorkPlanItem, "id"> & { id?: string }) => WorkPlanItem;
  deleteWorkPlanItem: (courseId: string, itemId: string) => void;
  upsertWhiteboardNode: (courseId: string, node: Omit<WhiteboardNode, "id"> & { id?: string }) => WhiteboardNode;
  deleteWhiteboardNode: (courseId: string, nodeId: string) => void;
  upsertGroupBoard: (courseId: string, board: { groupId: string; snapshot: unknown; mode?: GroupBoardMode; updatedAt?: string }) => void;
  upsertUpload: (upload: Omit<CourseUpload, "createdAt">) => CourseUpload;
  deleteUpload: (courseId: string, uploadId: string) => void;
  setPreviewUpload: (courseId: string, uploadId?: string) => void;
  upsertTeamContribution: (contribution: Omit<TeamContribution, "id" | "courseId" | "updatedAt"> & { id?: string; courseId?: string }) => TeamContribution | undefined;
  upsertAiSupport: (support: Omit<AiSupportRecord, "id" | "courseId" | "createdAt" | "updatedAt"> & { id?: string; courseId?: string }) => AiSupportRecord | undefined;
  addOfflineIntervention: (input: Omit<OfflineInterventionRecord, "id" | "teacherName" | "createdAt"> & { id?: string; teacherName?: string }) => OfflineInterventionRecord;
  resolveInterventionSignals: (courseId: string, signalIds: string[]) => void;
  upsertTeacherAgentDirective: (input: Omit<TeacherAgentDirective, "id" | "teacherName" | "createdAt" | "updatedAt"> & { id?: string; teacherName?: string; createdAt?: string }) => TeacherAgentDirective;
  upsertCompanionTask: (input: Omit<CompanionTask, "id" | "createdAt" | "updatedAt"> & { id?: string }) => CompanionTask;
  upsertCompanionConfirmation: (input: Omit<CompanionConfirmation, "id" | "createdAt" | "status"> & { id?: string; status?: CompanionConfirmation["status"] }) => CompanionConfirmation;
  resolveCompanionConfirmation: (courseId: string, confirmationId: string, status: CompanionConfirmation["status"]) => void;
  addCompanionProcessRecord: (input: Omit<CompanionProcessRecord, "id" | "createdAt"> & { id?: string }) => CompanionProcessRecord;
  requestTeacherHelp: (courseId: string, stageKey: string) => LearningSignal | undefined;
  upsertLearningEvidence: (evidence: LearningEvidence) => LearningEvidence;
  reviewLearningEvidence: (courseId: string, evidenceId: string, status: "teacher-confirmed" | "needs-revision", feedback?: string) => void;
  upsertArtifactSnapshot: (snapshot: ArtifactSnapshot) => ArtifactSnapshot;
  upsertAiContribution: (contribution: AiContribution) => AiContribution;
  recordStudentAiDecision: (decision: StudentAiDecision) => StudentAiDecision;
  upsertAiAssessmentSuggestion: (suggestion: AiAssessmentSuggestion) => AiAssessmentSuggestion;
  setUiState: (courseId: string, patch: Partial<CourseUiState>, control?: { takeover?: boolean }) => void;
  initializeClassroomTiming: (courseId: string) => Promise<boolean>;
  addActivity: (courseId: string, action: string, detail?: string, actor?: string) => void;
  setPresentingGroup: (courseId: string, groupId: string) => void;
  getCourse: (id: string) => Course | undefined;
  findCourseByCode: (code: string) => Course | undefined;
  generateNewInviteCode: (id: string) => string;
  refresh: (preferredRole?: "teacher" | "student") => Promise<void>;
  // Stage 4 realtime sync
  connectWebSocket: (courseId: string | undefined) => void;
  disconnectWebSocket: () => void;
  realtimeMode: "websocket" | "polling";
};

const SessionContext = createContext<SessionApi | null>(null);

function reducer(state: SessionState, action: SessionAction): SessionState {
  return applySessionAction(state, action);
}

// crypto.randomUUID 仅在安全上下文(HTTPS/localhost)可用,内网 IP 直访
// 需降级,详见 @/lib/uuid。
function makeCourseId(): string {
  return clientUUID();
}

function makeStudentId(): string {
  return clientUUID();
}

function makeEmptyHydratedState(): SessionState {
  return {
    ...initialSessionState(),
    hydrated: true,
    updatedAt: new Date().toISOString(),
  };
}

function getClientRole(): "teacher" | "student" | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.location.pathname.startsWith("/student")) return "student";
  if (window.location.pathname.startsWith("/teacher")) return "teacher";
  return undefined;
}

function redirectAfterUnauthorized(role: "teacher" | "student" | undefined) {
  if (typeof window === "undefined" || !role) return;
  if (role === "teacher") {
    const redirect = `${window.location.pathname}${window.location.search}`;
    window.location.assign(
      `/teacher/login?redirect=${encodeURIComponent(redirect)}`,
    );
    return;
  }
  window.location.assign("/student");
}

function studentClassroomForPath(
  pathname: string,
  search = typeof window === "undefined" ? "" : window.location.search,
): string | undefined {
  // The standalone player's path identifies the native learning classroom;
  // its authenticated CoTeach course is carried separately in the query.
  if (/^\/student\/ai-learning\/[^/]+/.test(pathname)) {
    return new URLSearchParams(search).get("courseId") || undefined;
  }
  return pathname.match(/^\/student\/(?:classroom|ai-collaboration|micro-lesson)\/([^/]+)/)?.[1];
}

type SessionBootstrap = { courseId: string; eventCursor: string };
type SessionHydrationFlight = {
  path: string;
  search: string;
  role: "teacher" | "student";
  sequence: number;
  scopeEpoch: number;
  courseEpoch: number;
  promise: Promise<void>;
  superseded: Promise<void>;
  supersede: () => void;
};

async function fetchSession(
  preferredRole?: "teacher" | "student",
  pathname = typeof window === "undefined" ? "" : window.location.pathname,
  search = typeof window === "undefined" ? "" : window.location.search,
): Promise<SessionState & { bootstrap?: SessionBootstrap }> {
  const role = preferredRole ?? getClientRole();
  const classroomId = role === "student" ? studentClassroomForPath(pathname, search)
    : pathname.match(/^\/teacher\/(?:teach|prepare)\/([^/]+)/)?.[1];
  const res = await boundedFetch(classroomId ? `/api/courses?courseId=${encodeURIComponent(classroomId)}` : "/api/courses", {
    cache: "no-store",
    headers: role ? { "X-OpenPBL-Role": role } : undefined,
  });
  if (!res.ok) {
    // 401 表示未登录——在公开页面（首页、登录页）轮询时属正常情况，
    // 不应作为错误抛出，避免每 5 秒弹出"无法读取课堂数据"提示。
    if (res.status === 401) {
      redirectAfterUnauthorized(role);
      throw new Error("SESSION_UNAUTHORIZED");
    }
    const body = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(body?.error ?? `SESSION_FETCH_FAILED_${res.status}`);
  }
  const state = (await res.json()) as SessionState;
  return { ...state, hydrated: true };
}

async function hasAuthenticatedSession(
  role: "teacher" | "student",
): Promise<boolean> {
  const response = await boundedFetch("/api/auth/me", {
    cache: "no-store",
    headers: { "X-OpenPBL-Role": role },
  });
  if (!response.ok) return false;
  const body = (await response.json().catch(() => null)) as
    | { user?: { role?: string } | null }
    | null;
  return body?.user?.role === role;
}

function courseIdForAction(action: SessionAction): string | null {
  if (!("payload" in action) || typeof action.payload !== "object" || !action.payload) return null;
  const payload = action.payload as Record<string, unknown>;
  const value = payload.courseId ?? payload.id;
  return typeof value === "string" ? value : null;
}

async function postSessionAction(
  action: SessionAction,
  state: SessionState,
  requestId: string,
  expectedVersionOverride?: number,
  includeExpectedVersion = true,
  requireSubmissionReceipt = false,
): Promise<ActionAck> {
  const role = getClientRole();
  const courseId = courseIdForAction(action);
  if (!courseId) throw new Error("ACTION_COURSE_REQUIRED");
  const courseVersion = state.courses.find((course) => course.id === courseId)?.version;
  const expectedVersion = expectedVersionOverride ?? courseVersion;
  const res = await boundedFetch(`/api/courses/${encodeURIComponent(courseId)}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(role ? { "X-OpenPBL-Role": role } : {}),
    },
    body: JSON.stringify({
      requestId,
      ...(includeExpectedVersion && action.type !== "CREATE_COURSE" && expectedVersion
        ? { expectedVersion }
        : {}),
      action,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | {
          code?: string;
          error?: string;
          message?: string;
          details?: { currentVersion?: number; currentSubmission?: ClassroomSubmission };
        }
      | null;
    if (res.status === 401) redirectAfterUnauthorized(role);
    throw new SessionActionRequestError(
      body?.code ?? body?.message ?? body?.error ?? `SESSION_ACTION_FAILED_${res.status}`,
      res.status,
      body?.details?.currentVersion,
      body?.message ?? body?.error,
      body?.details?.currentSubmission,
    );
  }
  const receiptError = () => new Error("尚未收到与本次保存匹配的服务器回执，本机草稿已保留，请重试。");
  const body = await res.json().catch((error: unknown) => {
    if (requireSubmissionReceipt) throw receiptError();
    throw error;
  });
  if (requireSubmissionReceipt) {
    const positiveVersion = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    const baseline = action.type === "UPSERT_SUBMISSION" ? action.payload.expectedSubmissionVersion : undefined;
    if (res.status !== 200 || !body || typeof body !== "object" || Array.isArray(body)
      || body.requestId !== requestId || typeof body.eventCursor !== "string" || !decodeEventCursor(body.eventCursor)
      || !positiveVersion(body.courseVersion) || !positiveVersion(body.submissionVersion)
      || !Number.isSafeInteger(baseline) || Number(baseline) < 0 || body.submissionVersion !== Number(baseline) + 1
      || (body.stageVersion !== undefined && !positiveVersion(body.stageVersion))) {
      // A transport success is not this immutable operation's durable receipt.
      // Keep the original outbox entry for an exact replay, including after navigation.
      throw receiptError();
    }
  }
  if (action.type === "SET_UI_STATE" && action.payload.intent) {
    const version = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    if (res.status !== 200 || !body || typeof body !== "object" || Array.isArray(body)
      || body.requestId !== requestId || typeof body.eventCursor !== "string" || !decodeEventCursor(body.eventCursor)
      || !version(body.courseVersion) || !version(body.stageVersion)) {
      throw new Error("尚未收到本次计时初始化的服务器回执，请保留页面并重试。");
    }
  }
  return body as ActionAck;
}

async function postSessionActionWithRetry(
  action: SessionAction,
  state: SessionState,
  requestId: string,
  beforeSend?: () => void,
  requireSubmissionReceipt = false,
): Promise<ActionAck> {
  const courseId = courseIdForAction(action);
  const initialVersion = courseId
    ? state.courses.find((course) => course.id === courseId)?.version
    : undefined;
  return retryVersionConflict(
    (expectedVersion) => { beforeSend?.(); return postSessionAction(action, state, requestId, expectedVersion, true, requireSubmissionReceipt); },
    initialVersion,
  );
}

async function postProjectionActionWithRetry(
  update: QueuedProjectionUpdate,
  state: SessionState,
): Promise<ActionAck> {
  return retryVersionConflict(
    () => postSessionAction(
      update.action,
      state,
      update.requestId,
      undefined,
      false,
    ),
    undefined,
  );
}

function projectionPollDelay(intervalMs: number): number {
  return intervalMs * (0.85 + Math.random() * 0.3);
}

export function SessionProvider({ children, search }: { children: ReactNode; search?: string }) {
  const pathname = usePathname();
  const studentCourseId = studentClassroomForPath(pathname, search);
  const [state, dispatch] = useReducer(reducer, undefined, initialSessionState);
  // Realtime course data can arrive before /api/courses authenticates the
  // route's student identity. Cached "last joined" identity is not readiness
  // for a different classroom, even when a snapshot has hydrated its data.
  const [authenticatedStudentIdentity, setAuthenticatedStudentIdentity] = useState<{ courseId: string; studentId: string }>();
  const authenticatedStudentIdentityRef = useRef(authenticatedStudentIdentity);
  const pendingIdentityRefreshRef = useRef(false);
  // A pending identity read may supply the INITIAL course cursor. This is not
  // an HTTP/result cache: notifications and subsequent polls still catch up.
  const sessionHydrationFlightRef = useRef<SessionHydrationFlight | null>(null);
  const sessionHydrationSequenceRef = useRef(0);
  const sessionHydrationScopeEpochRef = useRef(0);
  const stateRef = useRef(state);
  const [saveState, setSaveState] = useState<SessionApi["saveState"]>("idle");
  const [lastSavedReceipt, setLastSavedReceipt] = useState<{ at: string; studentScope?: { actorId: string; courseId: string } }>();
  const lastStudentSaveScopeRef = useRef<{ actorId: string; courseId: string } | undefined>(undefined);
  const [saveError, setSaveError] = useState<string>();
  const failedActionsRef = useRef(new Map<string, { action: SessionAction; requestId: string; actorId?: string; draftKey?: string; timingScope?: TimingInitializationScope }>());
  const timingInitializationRef = useRef<{ scope: TimingInitializationScope; requestId: string; promise: Promise<boolean> } | null>(null);
  const teacherTimingHydrationRef = useRef<{ scopeEpoch: number; path: string; courseId: string; actorName: string } | undefined>(undefined);
  const savedSubmissionsRef = useRef(new Map<string, ClassroomSubmission>());
  const savedSubmissionBaselinesRef = useRef(new Map<string, { version?: number; draftKey?: string; receipt: boolean }>());
  const submissionOutboxReadErrorRef = useRef(false);
  const saveRequestsRef = useRef(new Map<string, Promise<boolean>>());
  const [submissionSaveConflicts, setSubmissionSaveConflicts] = useState<SubmissionSaveConflict[]>([]);
  const commitQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pollingRef = useRef(true);
  // Tracks the number of in-flight commit POSTs. Only the LAST response
  // (when pending drops to 0) triggers a HYDRATE; intermediate responses
  // are ignored so they can't overwrite newer local optimistic state.
  const pendingCommitsRef = useRef(0);
  // Tracks the most recent course.updatedAt we've seen from the server, so
  // the long-polling fallback can skip HYDRATE when nothing changed (Stage 4).
  const lastSeenUpdatedAtRef = useRef<string | undefined>(undefined);
  // WebSocket connection state (Stage 4 realtime sync).
  const wsRef = useRef<WebSocket | null>(null);
  const wsFailureCountRef = useRef(0);
  const wsRetryTimerRef = useRef<number | null>(null);
  const wsCourseIdRef = useRef<string | undefined>(undefined);
  const wsModeRef = useRef<"websocket" | "polling">("polling");
  const eventCursorRef = useRef<Record<string, string>>({});
  // A projection receipt can raise Course.version without reading the rest of
  // its state. Keep personal-event coverage separate from that UI version and
  // anchor it only to a full, accepted snapshot for this authenticated owner.
  const reconciledStudentVersionRef = useRef<{ courseId: string; studentId: string; version: number } | undefined>(undefined);
  const courseEtagsRef = useRef(new Map<string, { etag: string; version: number }>());
  const courseRefreshSchedulerRef = useRef<ReturnType<typeof createCourseRefreshScheduler> | null>(null);
  const courseCatchUpCoordinatorRef = useRef<ReturnType<typeof createCourseCatchUpCoordinator> | null>(null);
  const coursePollTimerRef = useRef<number | null>(null);
  const coursePollInFlightRef = useRef(false);
  const courseRequestEpochRef = useRef(0);
  const confirmedSubmissionVersionsRef = useRef(new Map<string, number>());
  const courseReadControllerRef = useRef(new AbortController());
  const coursePollFailuresRef = useRef(0);
  const wsConnectionTimerRef = useRef<number | null>(null);
  const wsSubscriptionTimerRef = useRef<number | null>(null);
  const projectionPollTimerRef = useRef<number | null>(null);
  const projectionReadLaneRef = useRef<{
    courseId: string;
    epoch: number;
    lane: ReturnType<typeof createScopedReadLane>;
  } | null>(null);
  const projectionVersionRef = useRef<Record<string, number>>({});
  const projectionQueuesRef = useRef<Map<string, LatestValueQueue<QueuedProjectionUpdate>>>(new Map());
  const projectionFailureCountRef = useRef<Record<string, number>>({});
  const [realtimeMode, setRealtimeMode] = useState<"websocket" | "polling">("polling");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function applyIdentity(next: SessionState): SessionState {
    // With JWT auth, the session endpoint derives identity from the signed
    // cookie. Never overwrite that trusted identity with stale localStorage.
    if (
      next.user.role === "student" &&
      next.studentId &&
      next.joinedCourseId
    ) {
      return next;
    }
    if (getClientRole() === "teacher") return next;

    // Try role-specific identity keys first, then fall back to the legacy
    // shared key. This prevents cross-contamination when teacher and student
    // tabs are open in the same browser.
    const identity =
      loadJSON<IdentityState | null>(STUDENT_IDENTITY_KEY, null) ??
      loadJSON<IdentityState | null>(IDENTITY_KEY, null);
    if (!identity) return next;
    let result: SessionState = {
      ...next,
      user: identity.user ?? next.user,
      joinedCourseId: identity.joinedCourseId,
      studentId: identity.studentId,
      studentName: identity.studentName,
    };
    // Ensure the local student is registered in the joined course's student list.
    // Polling refresh may HYDRATE with server state that hasn't yet processed
    // our JOIN_CLASS action, causing the student to transiently disappear from
    // course.students. We restore them here so teacher & peer views always show
    // the joined student (and online counts stay accurate).
    if (identity.joinedCourseId && identity.studentId && identity.studentName) {
      const restoredStudent: Student = {
        id: identity.studentId,
        name: identity.studentName,
        joinedAt: identity.joinedAt ?? new Date().toISOString(),
        stageProgress: {},
      };
      result = {
        ...result,
        courses: result.courses.map((c) => {
          if (c.id !== identity.joinedCourseId) return c;
          let course = c;
          // Restore student in students list if missing
          if (!course.students.some((s) => s.id === restoredStudent.id)) {
            course = { ...course, students: [...course.students, restoredStudent] };
          }
          // Restore student in group members if missing (same race condition
          // as above: JOIN_GROUP may not have been processed by the server yet).
          if (identity.joinedGroupId && course.groups) {
            const group = course.groups.find((g) => g.id === identity.joinedGroupId);
            if (group && !group.members.some((m) => m.studentId === identity.studentId)) {
              course = {
                ...course,
                groups: course.groups.map((g) =>
                  g.id === identity.joinedGroupId
                    ? {
                        ...g,
                        members: [
                          ...g.members,
                          {
                            studentId: identity.studentId!,
                            name: identity.studentName!,
                            role: identity.joinedGroupRole ?? "成员",
                          },
                        ],
                      }
                    : g,
                ),
              };
            }
          }
          return course;
        }),
      };
    }
    return result;
  }

  function needsStudentIdentity(path: string, search?: string): boolean {
    const courseId = studentClassroomForPath(path, search);
    const identity = authenticatedStudentIdentityRef.current;
    return Boolean(courseId && (identity?.courseId !== courseId
      || identity.studentId !== stateRef.current.studentId
      || stateRef.current.user.role !== "student" || stateRef.current.joinedCourseId !== courseId));
  }

  function resumePendingIdentityRefresh() {
    if (pendingCommitsRef.current > 0 || !pendingIdentityRefreshRef.current) return;
    pendingIdentityRefreshRef.current = false;
    if (needsStudentIdentity(window.location.pathname)) void refresh("student");
  }

  function isCurrentSessionHydration(flight: SessionHydrationFlight) {
    return flight.path === window.location.pathname
      && (flight.role !== "student" || studentClassroomForPath(flight.path, flight.search)
        === studentClassroomForPath(window.location.pathname, window.location.search))
      && flight.scopeEpoch === sessionHydrationScopeEpochRef.current
      && flight.sequence === sessionHydrationSequenceRef.current;
  }

  function refresh(preferredRole?: "teacher" | "student"): Promise<void> {
    const requestPath = window.location.pathname;
    let supersede!: () => void;
    const superseded = new Promise<void>((resolve) => { supersede = resolve; });
    const previous = sessionHydrationFlightRef.current;
    const flight: SessionHydrationFlight = {
      path: requestPath,
      search: window.location.search,
      role: preferredRole ?? (requestPath.startsWith("/teacher") ? "teacher" : "student"),
      sequence: ++sessionHydrationSequenceRef.current,
      scopeEpoch: sessionHydrationScopeEpochRef.current,
      courseEpoch: courseRequestEpochRef.current,
      promise: Promise.resolve(),
      superseded,
      supersede,
    };
    sessionHydrationFlightRef.current = flight;
    // Wake initial-bootstrap waiters so a newer accepted identity can unblock
    // fresh events even while the superseded HTTP request is still pending.
    // This neither cancels the request nor shares/caches ordinary refreshes.
    previous?.supersede();
    flight.promise = Promise.resolve().then(() => refreshSession(flight)).finally(() => {
      if (sessionHydrationFlightRef.current === flight) sessionHydrationFlightRef.current = null;
    });
    return flight.promise;
  }

  async function refreshSession(flight: SessionHydrationFlight) {
    if (!isCurrentSessionHydration(flight)) return;
    const requestPath = flight.path;
    const preferredRole = flight.role;
    if (getSessionRouteMode(pathname) === "identity") {
      const role = preferredRole ?? (pathname.startsWith("/teacher") ? "teacher" : "student");
      const response = await boundedFetch("/api/auth/me", { cache: "no-store", headers: { "X-OpenPBL-Role": role } });
      const body = response.ok ? await response.json() as { user?: { role?: string; displayName?: string; studentName?: string } } : null;
      if (!isCurrentSessionHydration(flight)) return;
      const next = makeEmptyHydratedState();
      if (body?.user?.role === role) next.user = { ...next.user, role, name: body.user.displayName || body.user.studentName || (role === "teacher" ? "教师" : "学生") };
      dispatch({ type: "HYDRATE", payload: next });
      return;
    }
    // Skip polling refresh while commits are in-flight — the server file
    // may not yet reflect those actions (they're queued), and HYDRATEing
    // would overwrite local optimistic state, causing the same
    // "course disappears" symptom as the commit race condition.
    if (pendingCommitsRef.current > 0) {
      if (needsStudentIdentity(requestPath, flight.search)) pendingIdentityRefreshRef.current = true;
      return;
    }
    try {
      const { bootstrap, ...fetched } = await fetchSession(preferredRole, requestPath, flight.search);
      const next = applyIdentity(fetched);
      if (!isCurrentSessionHydration(flight)) return;
      if (pendingCommitsRef.current > 0) {
        if (needsStudentIdentity(requestPath, flight.search)) pendingIdentityRefreshRef.current = true;
        return;
      }
      const previousState = stateRef.current;
      const teacherClassroom = flight.role === "teacher" && fetched.user.role === "teacher"
        ? /^\/teacher\/(?:teach|prepare)\/([^/]+)/.exec(requestPath)?.[1] : undefined;
      const sameReadIdentity = next.user.role === previousState.user.role
        && (next.user.role !== "student" || next.studentId === previousState.studentId)
        && (next.user.role !== "teacher" || next.user.name === previousState.user.name);
      // A retained course belongs to a previously authenticated route epoch.
      // Only a successful teacher read in this epoch can justify its version
      // winning over a fresh snapshot, including normal same-name login flows.
      const retainTeacherProjection = !teacherClassroom
        || hasCurrentTeacherTimingHydration(teacherClassroom, next.user.name);
      const changedReadIdentity = previousState.hydrated && !sameReadIdentity;
      const currentCourseScope = flight.courseEpoch === courseRequestEpochRef.current;
      const subscribedCourse = wsCourseIdRef.current;
      if (changedReadIdentity) {
        // Course versions are not identities: a newer private projection from
        // the previous student must never win over this authenticated snapshot.
        // Retain durable failed saves for their owner, but retire old reads and
        // receipt/baseline caches before accepting the new identity.
        teardownWebSocket();
        eventCursorRef.current = {};
        reconciledStudentVersionRef.current = undefined;
        projectionVersionRef.current = {};
        savedSubmissionsRef.current.clear();
        savedSubmissionBaselinesRef.current.clear();
        confirmedSubmissionVersionsRef.current.clear();
        lastStudentSaveScopeRef.current = undefined;
        setLastSavedReceipt(undefined);
      }
      const requestedStudentClassroom = studentClassroomForPath(requestPath, flight.search);
      if (requestedStudentClassroom) {
        const identity = fetched.user.role === "student" && fetched.studentId
          && fetched.joinedCourseId === requestedStudentClassroom
          ? { courseId: requestedStudentClassroom, studentId: fetched.studentId } : undefined;
        authenticatedStudentIdentityRef.current = identity;
        setAuthenticatedStudentIdentity(identity);
      }
      // Initial session hydration can arrive after a newer per-course snapshot.
      let acceptedBootstrapCourse = false;
      let acceptedStudentSnapshot: Course | undefined;
      next.courses = next.courses.map((incoming) => {
        const current = sameReadIdentity && retainTeacherProjection
          ? previousState.courses.find((course) => course.id === incoming.id) : undefined;
        if (current && (current.version ?? 0) > (incoming.version ?? 0)) return current;
        if (incoming.id === bootstrap?.courseId && Number.isSafeInteger(incoming.version)) acceptedBootstrapCourse = true;
        if (incoming.id === requestedStudentClassroom && fetched.user.role === "student") acceptedStudentSnapshot = incoming;
        if (!current) return incoming;
        return { ...incoming, uiState: mergeCourseUiStateWithProjectionGuard(current.uiState, incoming.uiState, hasProjectionWork(incoming.id)) };
      });
      const authenticatedTeacherClassroom = teacherClassroom
        && fetched.courses.some(course => course.id === teacherClassroom) ? teacherClassroom : undefined;
      // Long-polling optimisation (Stage 4): skip HYDRATE if nothing changed.
      // When WebSocket is connected, we rely on patch-driven refreshes; the
      // 5s long-poll is only a fallback and shouldn't churn the UI.
      if (
        wsModeRef.current === "polling" &&
        lastSeenUpdatedAtRef.current &&
        next.updatedAt === lastSeenUpdatedAtRef.current &&
        sameReadIdentity &&
        next.studentId === stateRef.current.studentId &&
        next.joinedCourseId === stateRef.current.joinedCourseId &&
        next.courses.length === stateRef.current.courses.length &&
        next.courses.every((course, index) => course.id === stateRef.current.courses[index]?.id)
        // A matching old updatedAt is not current-epoch teacher authentication.
        && (!teacherClassroom || hasCurrentTeacherTimingHydration(teacherClassroom, next.user.name))
      ) {
        return;
      }
      lastSeenUpdatedAtRef.current = next.updatedAt;
      // Realtime course/projection responses can arrive before React commits
      // this HYDRATE. Keep their merge source in sync with the authenticated
      // session so a first-load snapshot cannot erase the student identity.
      stateRef.current = next;
      // Register only a successful, still-current authenticated scoped response,
      // before dispatch lets the automatic page effect observe its course.
      teacherTimingHydrationRef.current = authenticatedTeacherClassroom
        ? { scopeEpoch: flight.scopeEpoch, path: requestPath, courseId: authenticatedTeacherClassroom, actorName: fetched.user.name }
        : undefined;
      if (acceptedStudentSnapshot && (currentCourseScope || changedReadIdentity)) rememberStudentSnapshotVersion(acceptedStudentSnapshot);
      // Only this accepted, authenticated snapshot can seed the initial cursor.
      // Retained newer courses, optimistic-save guards and early no-op returns
      // must not acknowledge metadata from a discarded response.
      if (bootstrap && acceptedBootstrapCourse && fetched.user.role === flight.role
        && typeof bootstrap.eventCursor === "string"
        && (bootstrap.eventCursor === "0" || decodeEventCursor(bootstrap.eventCursor))
        && bootstrap.courseId === wsCourseIdRef.current
        && currentCourseScope
        && eventCursorRef.current[bootstrap.courseId] === undefined
        && (flight.role === "teacher"
          ? /^\/teacher\/(?:teach|prepare)\/([^/]+)/.exec(requestPath)?.[1] === bootstrap.courseId
          : requestedStudentClassroom === bootstrap.courseId
            && authenticatedStudentIdentityRef.current?.courseId === bootstrap.courseId
            && authenticatedStudentIdentityRef.current.studentId === fetched.studentId)) {
        eventCursorRef.current[bootstrap.courseId] = bootstrap.eventCursor;
      }
      dispatch({ type: "HYDRATE", payload: next });
      if (changedReadIdentity && subscribedCourse) connectWebSocket(subscribedCourse);
    } catch (error) {
      if (!isCurrentSessionHydration(flight)) return;
      // A failed current-auth read cannot authorize a new timing command or
      // its retry. Keep visible data and durable failures for fresh recovery.
      teacherTimingHydrationRef.current = undefined;
      // 401（未登录）在公开页面轮询时属正常情况，静默处理不弹提示。
      // 仅对真正的服务器错误（500 等）弹出错误提示。
      const isUnauthorized = error instanceof Error && error.message === "SESSION_UNAUTHORIZED";
      if (isUnauthorized) {
        authenticatedStudentIdentityRef.current = undefined;
        setAuthenticatedStudentIdentity(undefined);
      }
      if (!isUnauthorized) {
        console.error("[session] Failed to fetch session state:", error);
        toast.error("无法读取课堂数据", { id: "session-read-error", description: "请检查会话接口或服务器数据文件后重试。" });
      }
      if (!stateRef.current.hydrated) {
        dispatch({ type: "HYDRATE", payload: makeEmptyHydratedState() });
      }
    }
  }

  function commit(
    originalAction: SessionAction,
    options?: { localOnly?: boolean; requestId?: string; actorId?: string; draftKey?: string; timingScope?: TimingInitializationScope },
  ): Promise<boolean> {
    // Detach caller-owned arrays/objects so every retry has the same fingerprint.
    let action: SessionAction = originalAction.type === "UPSERT_SUBMISSION" ? JSON.parse(JSON.stringify(originalAction)) : originalAction;
    const actorId = options?.actorId ?? (originalAction.type === "UPSERT_SUBMISSION" && stateRef.current.user.role === "student" ? stateRef.current.studentId : undefined);
    const requestId = options?.requestId ?? clientUUID();
    const running = saveRequestsRef.current.get(requestId);
    if (running) return running;
    if (action.type === "UPSERT_SUBMISSION") {
      const { courseId, submission } = action.payload;
      const key = `${courseId}:${submission.id}`;
      if (!confirmedSubmissionVersionsRef.current.has(key)) {
        const persisted = stateRef.current.courses.find((course) => course.id === courseId)
          ?.submissions?.find((item) => item.id === submission.id);
        confirmedSubmissionVersionsRef.current.set(key, persisted?.version ?? 0);
      }
    }
    if (!options?.requestId) dispatch(action);
    if (options?.localOnly || action.type === "SET_USER" || action.type === "HYDRATE") return Promise.resolve(true);
    setSaveState("saving");
    if (!options?.timingScope || !hasCurrentSaveFailures()) setSaveError(undefined);
    pendingCommitsRef.current++;
    const run = async () => {
      if (options?.timingScope && !isCurrentTimingInitializationScope(options.timingScope)) throw new Error("CLASSROOM_TIMING_SCOPE_RETIRED");
      let record: SubmissionSaveRecord | undefined;
      if (action.type === "UPSERT_SUBMISSION") {
        const identity = authenticatedStudentIdentityRef.current;
        if (actorId && (stateRef.current.user.role !== "student" || !identity
          || identity.courseId !== action.payload.courseId || identity.studentId !== actorId || actorId !== action.payload.submission.studentId)) {
          throw new Error("课堂身份已变化，草稿仍保留，请返回对应课堂后重试。");
        }
        if (action.payload.expectedSubmissionVersion === undefined) {
          const key = `${action.payload.courseId}:${action.payload.submission.id}`;
          action = { ...action, payload: { ...action.payload, expectedSubmissionVersion: confirmedSubmissionVersionsRef.current.get(key) ?? 0 } };
        }
        if (actorId) {
          record = { requestId, actorId, draftKey: options?.draftKey, action, createdAt: Date.now(), state: "pending" };
          try { retainSubmissionSave(record); }
          catch { throw new Error("浏览器无法保存待发送草稿，请保留当前页面并下载本机草稿后重试。"); }
        }
      }
      let ack: Pick<ActionAck, "courseVersion" | "stageVersion" | "submissionVersion">;
      let reconciled: ClassroomSubmission | undefined;
      let receivedDurableReceipt = false;
      try {
        const received = await postSessionActionWithRetry(action, stateRef.current, requestId, () => {
          if (options?.timingScope && !isCurrentTimingInitializationScope(options.timingScope)) throw new Error("CLASSROOM_TIMING_SCOPE_RETIRED");
          if (record && (authenticatedStudentIdentityRef.current?.studentId !== record.actorId
            || authenticatedStudentIdentityRef.current?.courseId !== record.action.payload.courseId)) {
            throw new Error("课堂身份已变化，未确认草稿已保留。返回对应课堂后可继续恢复。");
          }
        }, Boolean(record));
        ack = received;
        receivedDurableReceipt = received.requestId === requestId && typeof received.eventCursor === "string" && received.eventCursor.length > 0;
      } catch (error) {
        if (record && error instanceof SessionActionRequestError && error.code === "DRAFT_VERSION_CONFLICT" && error.currentSubmission) {
          if (sameSubmissionContent(record.action.payload.submission, error.currentSubmission)) {
            reconciled = error.currentSubmission;
            // A read-confirmed identical revision is not a receipt for the rejected request.
            ack = { courseVersion: stateRef.current.courses.find(course => course.id === record!.action.payload.courseId)?.version ?? 1,
              submissionVersion: reconciled.version ?? error.currentVersion };
          } else {
            const conflict: SubmissionSaveConflict = { ...record, state: "conflict", remote: error.currentSubmission };
            retainSubmissionSave(conflict);
            setSubmissionSaveConflicts(current => [...current.filter(item => item.requestId !== requestId), conflict]);
            throw error;
          }
        } else throw error;
      }
      if (options?.timingScope && !isCurrentTimingInitializationScope(options.timingScope)) throw new Error("CLASSROOM_TIMING_SCOPE_RETIRED");
      if (record && (authenticatedStudentIdentityRef.current?.studentId !== record.actorId
        || authenticatedStudentIdentityRef.current?.courseId !== record.action.payload.courseId)) {
        acknowledgeSubmissionSave(record);
        failedActionsRef.current.delete(requestId);
        return;
      }
      if (action.type === "UPSERT_SUBMISSION" && ack.submissionVersion !== undefined) {
        const submission = reconciled ?? { ...action.payload.submission, version: ack.submissionVersion };
        const savedKey = `${action.payload.courseId}:${action.payload.submission.id}`;
        const previousSaved = savedSubmissionsRef.current.get(savedKey);
        const previousBaseline = savedSubmissionBaselinesRef.current.get(savedKey);
        // An identical read reconciliation is not this request's receipt. It
        // also must not erase an earlier real receipt for the same revision;
        // keep that receipt bound to its original editor and baseline.
        const sameConfirmedRevision = previousBaseline?.receipt && previousSaved?.id === submission.id
          && previousSaved.version === submission.version && sameSubmissionContent(previousSaved, submission);
        savedSubmissionsRef.current.set(savedKey, submission);
        if (receivedDurableReceipt || !sameConfirmedRevision) {
          savedSubmissionBaselinesRef.current.set(savedKey, { version: action.payload.expectedSubmissionVersion, draftKey: record?.draftKey, receipt: receivedDurableReceipt });
        }
        confirmedSubmissionVersionsRef.current.set(`${action.payload.courseId}:${submission.id}`, ack.submissionVersion);
        confirmedSubmissionVersionsRef.current.set(`${action.payload.courseId}:${action.payload.submission.id}`, ack.submissionVersion);
        const savedCourseId = action.payload.courseId;
        const submittedId = action.payload.submission.id;
        const submissions = stateRef.current.courses.find(course => course.id === savedCourseId)?.submissions ?? [];
        const optimistic = submissions.find(item => item.id === submittedId);
        // A receipt confirms its snapshot, never a newer optimistic edit queued behind it.
        if (!optimistic || sameSubmissionContent(optimistic, action.payload.submission)) {
          const savedAction: SessionAction = { type: "UPDATE_COURSE", payload: { id: action.payload.courseId, patch: {
            submissions: [...submissions.filter(item => item.id !== submittedId && item.id !== submission.id), submission],
          } } };
          stateRef.current = applySessionAction(stateRef.current, savedAction);
          dispatch(savedAction);
        }
      }
      const courseId = courseIdForAction(action);
      if (courseId) {
        const current = stateRef.current.courses.find(course => course.id === courseId);
        const versionAction: SessionAction = { type: "UPDATE_COURSE", payload: { id: courseId, patch: {
          version: Math.max(current?.version ?? 0, ack.courseVersion),
          ...(ack.stageVersion === undefined ? {} : { stageVersion: Math.max(current?.stageVersion ?? 1, ack.stageVersion) }),
        } } };
        // The server initializes the clock under a fresh stage/timing token.
        // Preserve the immutable raw base intent, but keep this request alive
        // across its own ACK metadata update so it can read the actual clock.
        // The strict original scope was checked above before adopting this ACK.
        if (options?.timingScope && action.type === "SET_UI_STATE" && action.payload.intent
          && receivedDurableReceipt && ack.stageVersion !== undefined) {
          options.timingScope.acknowledgedStageVersion = ack.stageVersion;
        }
        stateRef.current = applySessionAction(stateRef.current, versionAction);
        dispatch(versionAction);
      }
      if (record) acknowledgeSubmissionSave(record);
      failedActionsRef.current.delete(requestId);
      setSubmissionSaveConflicts(current => current.filter(item => item.requestId !== requestId));
    };
    const queued = commitQueueRef.current.then(run, run);
    commitQueueRef.current = queued.catch(() => undefined);
    const result = queued.then(() => {
      if (options?.timingScope && !isCurrentTimingInitializationScope(options.timingScope)) return false;
      if (action.type !== "UPSERT_SUBMISSION" || !actorId) {
        lastStudentSaveScopeRef.current = undefined;
        setLastSavedReceipt({ at: new Date().toISOString() });
      } else if (isCurrentSaveScope(action, actorId)
        && studentClassroomForPath(window.location.pathname) === action.payload.courseId) {
        lastStudentSaveScopeRef.current = { actorId, courseId: action.payload.courseId };
        setLastSavedReceipt({ at: new Date().toISOString(), studentScope: { actorId, courseId: action.payload.courseId } });
      }
      return true;
    }).catch((error) => {
      if (options?.timingScope && !isCurrentTimingInitializationScope(options.timingScope)) return false;
      console.error("[session] Failed to persist session action:", error);
      failedActionsRef.current.set(requestId, { action, requestId, actorId, draftKey: options?.draftKey, ...(options?.timingScope ? { timingScope: options.timingScope } : {}) });
      const reason = error instanceof Error ? error.message : "数据保存失败，请重试。";
      if (isCurrentSaveScope(action, actorId, options?.timingScope)) {
        setSaveError(reason);
        // Code/document workspaces show this exact error inline, with retry
        // and local-draft recovery. Repeated autosave toasts can cover those
        // controls in a zoomed desktop window.
        const inlineWorkspaceFeedback = stateRef.current.user.role === "student"
          && /^\/student\/ai-collaboration\/[^/]+(?:\/|$)/.test(window.location.pathname);
        if (!inlineWorkspaceFeedback) {
          toast.error("课堂数据尚未保存", { id: "session-write-error", description: reason });
        }
      }
      return false;
    }).finally(() => {
      pendingCommitsRef.current--;
      saveRequestsRef.current.delete(requestId);
      setSaveState(pendingCommitsRef.current > 0 ? "saving" : hasCurrentSaveFailures() || submissionOutboxReadErrorRef.current ? "error"
        : action.type === "UPSERT_SUBMISSION" && actorId ? settledStudentSaveState() : "saved");
      resumePendingIdentityRefresh();
    });
    saveRequestsRef.current.set(requestId, result);
    return result;
  }

  function projectionQueueFor(courseId: string) {
    const existing = projectionQueuesRef.current.get(courseId);
    if (existing) return existing;
    const queue = new LatestValueQueue<QueuedProjectionUpdate>(
      async (update) => {
        const requestStartedAt = Date.now();
        let ack: ActionAck;
        try {
          ack = await postProjectionActionWithRetry(update, stateRef.current);
        } catch (error) {
          if (error instanceof SessionActionRequestError && error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status)) {
            queue.dispose();
            projectionQueuesRef.current.delete(courseId);
            void refreshCourse(courseId).catch(recordCourseSyncFailure);
            toast.error("投屏控制未生效", { description: error.message, id: "projection-sync-error" });
            return;
          }
          throw error;
        }
        const responseReceivedAt = Date.now();
        if (ack.projection) {
          applyProjectionSnapshot(
            courseId,
            ack.projection,
            requestStartedAt,
            responseReceivedAt,
            queue.hasPending(),
          );
        }
      },
      PROJECTION_COALESCE_MS,
      PROJECTION_POLL_INTERVAL_MS,
      (error) => {
        const failures = (projectionFailureCountRef.current[courseId] ?? 0) + 1;
        projectionFailureCountRef.current[courseId] = failures;
        console.error("[session] Projection update failed; retrying latest state:", error);
        if (failures === COURSE_SYNC_FAILURE_NOTICE_THRESHOLD) {
          toast.error("投屏同步暂时中断", {
            id: "projection-sync-error",
            description: "系统正在重试最新投屏状态。",
          });
        }
      },
    );
    projectionQueuesRef.current.set(courseId, queue);
    return queue;
  }

  function queueProjectionAction(action: SessionAction): void {
    const patch = projectionPatchFromAction(action);
    const courseId = courseIdForAction(action);
    if (!patch || !courseId) {
      void commit(action);
      return;
    }
    const previous = stateRef.current.courses.find(
      (course) => course.id === courseId,
    )?.uiState;
    if (previous?.projectionController
      && previous.projectionController.clientId !== projectionClientId()
      && !(action.type === "SET_UI_STATE" && action.payload.projectionControl?.takeover)) return;
    const immediate = isImmediateProjectionPatch(previous, patch);
    const next = applySessionAction(stateRef.current, action);
    stateRef.current = next;
    dispatch(action);
    projectionQueueFor(courseId).enqueue(
      { action, requestId: clientUUID() },
      immediate,
    );
  }

  function hasProjectionWork(courseId: string): boolean {
    return projectionQueuesRef.current.get(courseId)?.hasWork() ?? false;
  }

  // Failed student saves belong to their authenticated classroom identity.
  // Keep other scopes in memory and in the durable outbox for their own return.
  function isCurrentSaveScope(action: SessionAction, actorId?: string, timingScope?: TimingInitializationScope): boolean {
    if (timingScope) return isCurrentTimingInitializationScope(timingScope);
    if (!actorId || action.type !== "UPSERT_SUBMISSION") return true;
    const identity = authenticatedStudentIdentityRef.current;
    return stateRef.current.user.role === "student" && identity?.studentId === actorId
      && identity.courseId === action.payload.courseId;
  }

  function settledStudentSaveState(): "idle" | "saved" {
    const scope = lastStudentSaveScopeRef.current;
    const identity = authenticatedStudentIdentityRef.current;
    return scope && stateRef.current.user.role === "student"
      && identity?.studentId === scope.actorId && identity.courseId === scope.courseId
      && studentClassroomForPath(window.location.pathname) === scope.courseId ? "saved" : "idle";
  }

  function hasCurrentSaveFailures(): boolean {
    return [...failedActionsRef.current.values()].some(failed => isCurrentSaveScope(failed.action, failed.actorId, failed.timingScope));
  }

  function hasCurrentTeacherTimingHydration(courseId: string, actorName = stateRef.current.user.name): boolean {
    const authenticated = teacherTimingHydrationRef.current;
    return authenticated?.scopeEpoch === sessionHydrationScopeEpochRef.current
      && authenticated.path === window.location.pathname && authenticated.courseId === courseId
      && authenticated.actorName === actorName;
  }

  function isCurrentTimingInitializationScope(scope: TimingInitializationScope): boolean {
    const current = stateRef.current;
    const course = current.courses.find(item => item.id === scope.courseId);
    const stageVersion = course?.stageVersion ?? 1;
    // The browser exposes role/name, not teacher sub/SV. Epochs fence normal
    // route/account transitions; only the server authorizes the actual actor.
    return getClientRole() === "teacher" && current.user.role === "teacher"
      && hasCurrentTeacherTimingHydration(scope.courseId, scope.actorName)
      && current.user.name === scope.actorName
      && sessionHydrationScopeEpochRef.current === scope.hydrationEpoch
      && isCurrentCourseRead(scope.courseId, scope.courseEpoch)
      && course?.status === "teaching" && Number.isSafeInteger(stageVersion) && stageVersion >= 1
      && stageVersion === (scope.acknowledgedStageVersion ?? scope.stageVersion)
      && course.stages[course.currentStageIndex]?.key === scope.stageKey;
  }

  async function refreshTimingInitialization(scope: TimingInitializationScope): Promise<void> {
    // commit() settles pendingCommits before resolving. Wait for other already
    // queued writes too, so the existing snapshot lane can read authoritative data.
    await commitQueueRef.current;
    await Promise.all([...saveRequestsRef.current.values()]);
    if (!isCurrentTimingInitializationScope(scope)) return;
    courseEtagsRef.current.delete(scope.courseId);
    try {
      const refreshed = await refreshCourse(scope.courseId, undefined, "classroom-control");
      if (isCurrentTimingInitializationScope(scope) && (!refreshed
        || !stateRef.current.courses.find(item => item.id === scope.courseId)?.uiState?.classroomTiming)) {
        toast.error("课堂计时仍待同步", { id: "classroom-timing-readback", description: "尚未读到服务器计时状态，请保留页面并重试同步。" });
      }
    } catch (error) {
      if (isCurrentTimingInitializationScope(scope)) recordCourseSyncFailure(error);
    }
  }

  function initializeClassroomTiming(courseId: string): Promise<boolean> {
    const current = stateRef.current;
    const course = current.courses.find(item => item.id === courseId);
    const stageKey = course?.stages[course.currentStageIndex]?.key;
    const stageVersion = course?.stageVersion ?? 1;
    if (current.user.role !== "teacher" || getClientRole() !== "teacher" || course?.status !== "teaching"
      || !hasCurrentTeacherTimingHydration(courseId) || !stageKey || !Number.isSafeInteger(stageVersion) || stageVersion < 1) return Promise.resolve(false);
    if (course.uiState?.classroomTiming) return Promise.resolve(true);
    const previous = timingInitializationRef.current;
    if (previous && isCurrentTimingInitializationScope(previous.scope)) return previous.promise;
    for (const [id, failed] of failedActionsRef.current) {
      if (failed.timingScope && !isCurrentTimingInitializationScope(failed.timingScope)) failedActionsRef.current.delete(id);
    }
    const scope: TimingInitializationScope = { hydrationEpoch: sessionHydrationScopeEpochRef.current,
      courseEpoch: courseRequestEpochRef.current, actorName: current.user.name, courseId,
      stageVersion, stageKey };
    if (!isCurrentTimingInitializationScope(scope)) return Promise.resolve(false);
    const requestId = clientUUID();
    const action: SessionAction = { type: "SET_UI_STATE", payload: { courseId, patch: {},
      intent: { type: "initialize-classroom-timing", baseStageVersion: scope.stageVersion, stageKey } } };
    const record = { scope, requestId, promise: Promise.resolve(false) };
    // Store before enqueueing: no optimistic timer is installed, and re-renders
    // during POST/ACK/readback must join this exact original command.
    timingInitializationRef.current = record;
    record.promise = commit(action, { requestId, timingScope: scope }).then(async saved => {
      await refreshTimingInitialization(scope);
      return saved;
    });
    return record.promise;
  }

  async function retrySave() {
    for (const failed of [...failedActionsRef.current.values()]) {
      if (!isCurrentSaveScope(failed.action, failed.actorId, failed.timingScope)) continue;
      if (submissionSaveConflicts.some(item => item.requestId === failed.requestId)) continue;
      await commit(failed.action, { requestId: failed.requestId, actorId: failed.actorId, draftKey: failed.draftKey, timingScope: failed.timingScope });
      if (failed.timingScope) await refreshTimingInitialization(failed.timingScope);
    }
  }

  async function flushSaves(): Promise<boolean> {
    await commitQueueRef.current;
    await Promise.all([...saveRequestsRef.current.values()]);
    return pendingCommitsRef.current === 0 && !hasCurrentSaveFailures() && !submissionOutboxReadErrorRef.current;
  }

  useEffect(() => {
    const identity = authenticatedStudentIdentity;
    if (!identity) return;
    let cancelled = false;
    const recover = () => {
      if (cancelled) return;
      try {
        const records = readSubmissionSaves(identity.studentId, identity.courseId);
        submissionOutboxReadErrorRef.current = false;
        const conflicts = records.filter((record): record is SubmissionSaveConflict => record.state === "conflict" && Boolean(record.remote));
        setSubmissionSaveConflicts(conflicts);
        for (const record of records) {
          if (record.state === "resolved") continue;
          failedActionsRef.current.set(record.requestId, record);
          if (record.state === "pending") void commit(record.action, { requestId: record.requestId, actorId: record.actorId, draftKey: record.draftKey });
        }
        setSaveState(pendingCommitsRef.current > 0 ? "saving" : hasCurrentSaveFailures() ? "error" : settledStudentSaveState());
        if (!hasCurrentSaveFailures()) setSaveError(undefined);
      } catch {
        submissionOutboxReadErrorRef.current = true;
        setSaveError("无法读取本机待保存记录，请保留浏览器数据并下载本机草稿后重试。");
        setSaveState("error");
      }
    };
    void Promise.resolve().then(recover);
    window.addEventListener("online", recover);
    window.addEventListener("focus", recover);
    return () => { cancelled = true; window.removeEventListener("online", recover); window.removeEventListener("focus", recover); };
    // Recovery always uses authenticated identity, never a cached identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedStudentIdentity?.courseId, authenticatedStudentIdentity?.studentId]);

  async function resolveSubmissionSaveConflict(requestId: string, choice: "local" | "remote", content?: string) {
    const conflict = submissionSaveConflicts.find(item => item.requestId === requestId);
    const identity = authenticatedStudentIdentityRef.current;
    if (!conflict || identity?.studentId !== conflict.actorId || identity.courseId !== conflict.action.payload.courseId) return undefined;
    const submission = choice === "remote" ? conflict.remote : {
      ...conflict.action.payload.submission, id: conflict.remote.id, createdAt: conflict.remote.createdAt,
      ...(content === undefined ? {} : { content }),
    };
    // Keep both versions in the archived record, including after explicit adoption.
    try { retainSubmissionSave({ ...conflict, state: "resolved" }); }
    catch { setSaveError("无法保留冲突副本，请下载本机草稿后重试。"); return undefined; }
    failedActionsRef.current.delete(requestId);
    setSubmissionSaveConflicts(current => current.filter(item => item.requestId !== requestId));
    if (choice === "local") {
      const saved = await commit({ type: "UPSERT_SUBMISSION", payload: { courseId: conflict.action.payload.courseId,
        submission, expectedSubmissionVersion: conflict.remote.version ?? 1 } });
      if (!saved) return undefined;
      return { ...submission, version: confirmedSubmissionVersionsRef.current.get(`${conflict.action.payload.courseId}:${submission.id}`) };
    }
    const action: SessionAction = { type: "UPSERT_SUBMISSION", payload: { courseId: conflict.action.payload.courseId, submission } };
    stateRef.current = applySessionAction(stateRef.current, action);
    dispatch(action);
    confirmedSubmissionVersionsRef.current.set(`${conflict.action.payload.courseId}:${submission.id}`, submission.version ?? 1);
    setSaveState(pendingCommitsRef.current ? "saving" : hasCurrentSaveFailures() || submissionOutboxReadErrorRef.current ? "error" : "saved");
    return submission;
  }

  // ---- Stage 4: WebSocket realtime sync ----
  function rememberStudentSnapshotVersion(course: Course) {
    const identity = authenticatedStudentIdentityRef.current;
    const version = course.version;
    if (stateRef.current.user.role !== "student" || !identity || identity.courseId !== course.id
      || identity.studentId !== stateRef.current.studentId || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return;
    // A newly accepted full snapshot replaces the evidence baseline, even if
    // its version is below a previous peer-only watermark. Never keep a max
    // across a restore/version reset or borrow a newer projection receipt.
    reconciledStudentVersionRef.current = { ...identity, version };
  }

  // The WebSocket server runs on a separate port (default 3001). Clients
  // try to connect once on mount; on 5 consecutive failures they give up
  // and stay on the durable per-course event polling fallback. The first
  // successful connection switches wsModeRef to "websocket" while retaining
  // a lower-frequency durable cursor check for cross-instance correctness.
  function teardownWebSocket() {
    courseRequestEpochRef.current += 1;
    courseEtagsRef.current.clear();
    courseReadControllerRef.current.abort();
    courseReadControllerRef.current = new AbortController();
    coursePollInFlightRef.current = false;
    courseRefreshSchedulerRef.current?.dispose();
    courseRefreshSchedulerRef.current = null;
    courseCatchUpCoordinatorRef.current?.dispose();
    courseCatchUpCoordinatorRef.current = null;
    if (wsRetryTimerRef.current !== null) {
      window.clearTimeout(wsRetryTimerRef.current);
      wsRetryTimerRef.current = null;
    }
    if (wsSubscriptionTimerRef.current !== null) {
      window.clearTimeout(wsSubscriptionTimerRef.current);
      wsSubscriptionTimerRef.current = null;
    }
    if (wsConnectionTimerRef.current !== null) {
      window.clearTimeout(wsConnectionTimerRef.current);
      wsConnectionTimerRef.current = null;
    }
    stopCoursePolling();
    stopProjectionPolling();
    const ws = wsRef.current;
    if (!ws) return;
    try {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
    } catch {
      /* noop */
    }
    wsRef.current = null;
  }

  function stopCoursePolling() {
    if (coursePollTimerRef.current !== null) {
      window.clearInterval(coursePollTimerRef.current);
      coursePollTimerRef.current = null;
    }
  }

  function clearProjectionPollTimer() {
    if (projectionPollTimerRef.current !== null) {
      window.clearTimeout(projectionPollTimerRef.current);
      projectionPollTimerRef.current = null;
    }
  }

  function stopProjectionPolling() {
    clearProjectionPollTimer();
    projectionReadLaneRef.current?.lane.dispose();
    projectionReadLaneRef.current = null;
  }

  function recordCourseSyncSuccess() {
    if (coursePollFailuresRef.current >= COURSE_SYNC_FAILURE_NOTICE_THRESHOLD) {
      toast.success("课堂实时同步已恢复", { id: "course-sync-error" });
    }
    coursePollFailuresRef.current = 0;
  }

  function recordCourseSyncFailure(error: unknown) {
    coursePollFailuresRef.current += 1;
    console.error("[session] Course synchronization failed:", error);
    if (coursePollFailuresRef.current === COURSE_SYNC_FAILURE_NOTICE_THRESHOLD) {
      toast.error("课堂实时同步中断", {
        id: "course-sync-error",
        description: "无法从服务器读取最新课堂状态，系统正在自动重试。",
      });
    }
  }

  function applyProjectionSnapshot(
    courseId: string,
    snapshot: ProjectionStateSnapshot,
    requestStartedAt: number,
    responseReceivedAt: number,
    preserveOptimisticProjection = false,
  ): boolean {
    if (snapshot.courseId !== courseId) return false;
    const incomingVersion = snapshot.projectionVersion;
    const current = stateRef.current;
    const currentCourse = current.courses.find((course) => course.id === courseId);
    const hydratedVersion = currentCourse?.uiState?.projectionVersion;
    const trackedVersion = projectionVersionRef.current[courseId];
    const knownVersion = highestKnownProjectionVersion(
      hydratedVersion,
      trackedVersion,
    );
    if (!shouldApplyProjectionVersion(
      knownVersion,
      incomingVersion,
    )) {
      return false;
    }
    const offsetMs = estimateServerClockOffset(
      snapshot.serverTime,
      requestStartedAt,
      responseReceivedAt,
    );
    const adjusted = withProjectionClockOffset(snapshot, offsetMs);
    if (!currentCourse) return false;
    const patch: Partial<CourseUiState> = {
      projectionVersion: incomingVersion,
      projectionUpdatedAt: snapshot.projectionUpdatedAt,
      projectionClockOffsetMs: offsetMs,
      projectionController: snapshot.projectionController,
      ...(preserveOptimisticProjection
        ? {}
        : {
            resourceProjection: adjusted.resourceProjection,
            teacherResourceProjection: adjusted.teacherResourceProjection,
          }),
    };
    let next = applySessionAction(current, {
      type: "SET_UI_STATE",
      payload: { courseId, patch },
    });
    next = {
      ...next,
      courses: next.courses.map((course) => course.id === courseId
        ? { ...course, version: Math.max(course.version ?? 0, snapshot.courseVersion) }
        : course),
    };
    projectionVersionRef.current[courseId] = incomingVersion;
    stateRef.current = next;
    dispatch({ type: "HYDRATE", payload: next });
    if (
      (projectionFailureCountRef.current[courseId] ?? 0)
      >= COURSE_SYNC_FAILURE_NOTICE_THRESHOLD
    ) {
      toast.success("投屏同步已恢复", { id: "projection-sync-error" });
    }
    projectionFailureCountRef.current[courseId] = 0;
    return true;
  }

  function refreshProjectionState(courseId: string, needsFresh = false): Promise<void> {
    if (
      !isRealtimePollingActive(document.visibilityState)
      || wsCourseIdRef.current !== courseId
    ) return Promise.resolve();
    const epoch = courseRequestEpochRef.current;
    let scoped = projectionReadLaneRef.current;
    if (!scoped || scoped.courseId !== courseId || scoped.epoch !== epoch) {
      scoped?.lane.dispose();
      // Authenticated identity changes retire this epoch through teardown.
      // Transport-mode/timer changes keep the same lane and its current read.
      const role = getClientRole() ?? "student";
      const lane = createScopedReadLane(async (signal) => {
        if (signal.aborted || !isCurrentCourseRead(courseId, epoch)
          || !isRealtimePollingActive(document.visibilityState)) return;
        const requestStartedAt = Date.now();
        try {
          const response = await boundedFetch(
            `/api/courses/${encodeURIComponent(courseId)}/projection`,
            {
              cache: "no-store",
              headers: { "X-OpenPBL-Role": role },
              signal,
            },
            PROJECTION_REQUEST_TIMEOUT_MS,
          );
          const responseReceivedAt = Date.now();
          if (!response.ok) throw new Error(`PROJECTION_STATE_FAILED_${response.status}`);
          const snapshot = await response.json() as ProjectionStateSnapshot;
          if (signal.aborted || !isCurrentCourseRead(courseId, epoch)) return;
          applyProjectionSnapshot(
            courseId,
            snapshot,
            requestStartedAt,
            responseReceivedAt,
            hasProjectionWork(courseId),
          );
        } catch (error) {
          // Only scope disposal suppresses a failure. A 750ms timeout belongs
          // to this attempt, so the lane remains usable for the next trigger.
          if (!signal.aborted && isCurrentCourseRead(courseId, epoch)) {
            recordCourseSyncFailure(error);
          }
        }
      });
      scoped = { courseId, epoch, lane };
      projectionReadLaneRef.current = scoped;
    }
    return scoped.lane.request(needsFresh);
  }

  function startProjectionPolling(courseId: string | undefined): void {
    clearProjectionPollTimer();
    if (!courseId) {
      stopProjectionPolling();
      return;
    }
    const epoch = courseRequestEpochRef.current;
    void refreshProjectionState(courseId);
    const interval = wsModeRef.current === "websocket"
      ? PROJECTION_CONNECTED_CHECK_INTERVAL_MS
      : PROJECTION_POLL_INTERVAL_MS;
    // Per-client jitter prevents a whole class from polling in lockstep.
    const tick = () => {
      if (!isCurrentCourseRead(courseId, epoch)) return;
      void refreshProjectionState(courseId);
      projectionPollTimerRef.current = window.setTimeout(tick, projectionPollDelay(interval));
    };
    projectionPollTimerRef.current = window.setTimeout(tick, projectionPollDelay(interval));
  }

  function isCurrentCourseRead(courseId: string, epoch: number): boolean {
    return epoch === courseRequestEpochRef.current && wsCourseIdRef.current === courseId;
  }

  function startCoursePolling(
    courseId: string | undefined,
    mode: RealtimeTransportMode = wsModeRef.current,
  ) {
    stopCoursePolling();
    if (!courseId) return;

    const poll = async () => {
      if (
        !isRealtimePollingActive(document.visibilityState)
        || coursePollInFlightRef.current
        || pendingCommitsRef.current > 0
      ) return;
      coursePollInFlightRef.current = true;
      const epoch = courseRequestEpochRef.current;
      try {
        // Polling and socket subscription share the same bootstrap/catch-up;
        // subscription must not read from cursor 0 while its seed is pending.
        await syncCourseRealtime(courseId, false);
      } finally {
        if (epoch === courseRequestEpochRef.current) coursePollInFlightRef.current = false;
      }
    };

    void poll();
    coursePollTimerRef.current = window.setInterval(
      () => void poll(),
      COURSE_EVENT_POLL_INTERVAL_MS[mode] * (0.85 + Math.random() * 0.3),
    );
  }

  function switchToPolling() {
    pollingRef.current = true;
    if (wsModeRef.current !== "polling") {
      wsModeRef.current = "polling";
      setRealtimeMode("polling");
    }
    startCoursePolling(wsCourseIdRef.current, "polling");
    startProjectionPolling(wsCourseIdRef.current);
  }

  function refreshCourse(
    courseId: string,
    cursor?: string,
    priority: "classroom-control" | "standard" = "standard",
    delayMs = 0,
  ): Promise<boolean> {
    if (wsCourseIdRef.current !== courseId) return Promise.resolve(false);
    if (!courseRefreshSchedulerRef.current) {
      courseRefreshSchedulerRef.current = createCourseRefreshScheduler({
        read: (capturedCursor) => readCourseSnapshot(courseId, capturedCursor),
        minimumIntervalMs: getClientRole() === "teacher" ? 750 : 0,
        onRefreshed: recordCourseSyncSuccess,
        onError: recordCourseSyncFailure,
      });
    }
    return courseRefreshSchedulerRef.current.request(cursor, priority, delayMs);
  }

  async function readCourseSnapshot(courseId: string, cursor?: string): Promise<boolean> {
    const epoch = courseRequestEpochRef.current;
    if (pendingCommitsRef.current > 0) return false;
    const localVersion = stateRef.current.courses.find(course => course.id === courseId)?.version;
    const cached = courseEtagsRef.current.get(courseId);
    const response = await boundedFetch(`/api/courses/${encodeURIComponent(courseId)}/state`, {
      signal: courseReadControllerRef.current.signal,
      cache: "no-store",
      headers: { "X-OpenPBL-Role": getClientRole() ?? "student",
        ...(cached && localVersion === cached.version ? { "If-None-Match": cached.etag } : {}) },
    });
    if (response.status === 304) {
      if (epoch !== courseRequestEpochRef.current || wsCourseIdRef.current !== courseId
        || pendingCommitsRef.current > 0
        || stateRef.current.courses.find(course => course.id === courseId)?.version !== localVersion) return false;
      // The representation includes the confirmed event cursor. The requested
      // cursor can be newer than this query; its trailing read is retained by
      // the refresh scheduler, so do not acknowledge it here.
      return true;
    }
    if (!response.ok) throw new Error(`COURSE_STATE_FAILED_${response.status}`);
    const body = (await response.json()) as {
      course: Course;
      eventCursor: string;
    };
    if (epoch !== courseRequestEpochRef.current || wsCourseIdRef.current !== courseId) return false;
    // A local action may have started while the request was in flight. Never
    // overwrite that optimistic state with an older server snapshot.
    if (pendingCommitsRef.current > 0) return false;
    const current = stateRef.current;
    const currentCourse = current.courses.find((course) => course.id === courseId);
    if (
      typeof currentCourse?.version === "number"
      && typeof body.course.version === "number"
      && currentCourse.version > body.course.version
    ) {
      return false;
    }
    for (const submission of body.course.submissions ?? []) {
      confirmedSubmissionVersionsRef.current.set(`${courseId}:${submission.id}`, submission.version ?? 1);
    }
    const incomingCourse: Course = currentCourse
      ? {
          ...body.course,
          uiState: mergeCourseUiStateWithProjectionGuard(
            currentCourse.uiState,
            body.course.uiState,
            hasProjectionWork(courseId),
          ),
        }
      : body.course;
    const found = current.courses.some((course) => course.id === courseId);
    const next = applyIdentity({
      ...current,
      courses: found
        ? current.courses.map((course) => (course.id === courseId ? incomingCourse : course))
        : [incomingCourse, ...current.courses],
      updatedAt: body.course.updatedAt,
      hydrated: true,
    });
    eventCursorRef.current[courseId] = latestEventCursor(
      eventCursorRef.current[courseId],
      cursor,
      body.eventCursor,
    );
    stateRef.current = next;
    rememberStudentSnapshotVersion(body.course);
    const etag = response.headers.get("ETag");
    if (etag) courseEtagsRef.current.set(courseId, { etag, version: body.course.version ?? 0 });
    else courseEtagsRef.current.delete(courseId);
    dispatch({ type: "HYDRATE", payload: next });
    return true;
  }

  function scheduleCourseRefresh(
    courseId: string,
    cursor?: string,
    priority: "classroom-control" | "standard" = "standard",
  ) {
    const delay = priority === "standard" && getClientRole() === "teacher"
      ? 750
      : courseRefreshDelay(Math.random(), priority);
    const epoch = courseRequestEpochRef.current;
    void refreshCourse(courseId, cursor, priority, delay).catch((error) => {
      if (isCurrentCourseRead(courseId, epoch)) recordCourseSyncFailure(error);
    });
  }

  async function catchUpCourseEvents(courseId: string) {
    const epoch = courseRequestEpochRef.current;
    const after = eventCursorRef.current[courseId] ?? "0";
    const response = await boundedFetch(
      `/api/courses/${encodeURIComponent(courseId)}/events?after=${encodeURIComponent(after)}`,
      { cache: "no-store", signal: courseReadControllerRef.current.signal, headers: { "X-OpenPBL-Role": getClientRole() ?? "student" } },
    );
    if (!response.ok) throw new Error(`COURSE_EVENTS_FAILED_${response.status}`);
    const body = (await response.json()) as {
      events: Array<{
        cursor?: string;
        type?: string;
        courseVersion?: number;
        payload?: Record<string, unknown> | null;
      }>;
      nextCursor: string;
      hasMore: boolean;
      requiresReconciliation?: boolean;
      courseVersion?: number;
      privateVersionCoverage?: { protocol?: string; after?: string; through?: string; ranges?: unknown };
    };
    if (epoch !== courseRequestEpochRef.current || wsCourseIdRef.current !== courseId) return;
    const localVersion = stateRef.current.courses.find(
      (course) => course.id === courseId,
    )?.version ?? 0;
    let versionGap = body.requiresReconciliation === true
      && typeof body.courseVersion === "number"
      && body.courseVersion > localVersion;
    const reconciled = reconciledStudentVersionRef.current;
    const identity = authenticatedStudentIdentityRef.current;
    const coverage = body.privateVersionCoverage;
    const serverVersion = body.courseVersion;
    let coveredPrivateVersion: number | undefined;
    if (stateRef.current.user.role === "student" && body.events.length === 0 && reconciled && identity
      && reconciled.courseId === courseId && identity.courseId === courseId
      && reconciled.studentId === identity.studentId && identity.studentId === stateRef.current.studentId
      && coverage?.protocol === PRIVATE_VERSION_COVERAGE_PROTOCOL && coverage.after === after && coverage.through === body.nextCursor
      && typeof serverVersion === "number" && Number.isSafeInteger(serverVersion) && serverVersion >= 0) {
      // A backwards version can be a late read or a restored server. Neither
      // is evidence for keeping an old high peer-only watermark: obtain a full
      // snapshot, whose existing version/identity guards decide acceptance.
      if (serverVersion < reconciled.version) versionGap = true;
      else {
        coveredPrivateVersion = advanceCourseVersionCoverage(reconciled.version, coverage.ranges);
        versionGap = body.requiresReconciliation === true && serverVersion > coveredPrivateVersion;
      }
    }
    const projectionsApplied = body.events.length > 0
      && body.events.every((event) => applyProjectionEvent(courseId, {
        type: event.type,
        courseVersion: event.courseVersion,
        cursor: event.cursor,
        payload: event.payload ?? undefined,
      }));
    if (
      (body.events.length > 0 && !projectionsApplied)
      || (versionGap && !projectionsApplied)
    ) {
      const refreshed = await refreshCourse(courseId, body.nextCursor);
      if (!refreshed) return;
    } else {
      eventCursorRef.current[courseId] = latestEventCursor(
        eventCursorRef.current[courseId],
        body.nextCursor,
      );
      if (coveredPrivateVersion !== undefined && reconciled && reconciledStudentVersionRef.current === reconciled) {
        reconciledStudentVersionRef.current = { ...reconciled, version: coveredPrivateVersion };
      }
    }
    if (body.hasMore) await catchUpCourseEvents(courseId);
  }

  async function seedCourseRealtime(courseId: string, epoch: number): Promise<boolean> {
    let flight = sessionHydrationFlightRef.current;
    const role = getClientRole() ?? "student";
    while (flight && isCurrentSessionHydration(flight) && flight.role === role
      && flight.courseEpoch === epoch
      && (role === "student" ? studentClassroomForPath(flight.path, flight.search)
        : /^\/teacher\/(?:teach|prepare)\/([^/]+)/.exec(flight.path)?.[1]) === courseId) {
      await Promise.race([flight.promise, flight.superseded]);
      if (!isCurrentCourseRead(courseId, epoch) || pendingCommitsRef.current > 0) return false;
      const latest = sessionHydrationFlightRef.current;
      if (eventCursorRef.current[courseId] !== undefined || latest === flight) break;
      flight = latest;
    }
    if (!isCurrentCourseRead(courseId, epoch) || pendingCommitsRef.current > 0) return false;
    // Independent notifications may have reconciled /state while identity was
    // pending. Never replace that real read with a cached hydration result.
    if (eventCursorRef.current[courseId] !== undefined) return true;
    return refreshCourse(courseId);
  }

  async function syncCourseRealtime(courseId: string, requireFreshCatchUp = true) {
    const epoch = courseRequestEpochRef.current;
    if (!isCurrentCourseRead(courseId, epoch)) return;
    if (!courseCatchUpCoordinatorRef.current) {
      courseCatchUpCoordinatorRef.current = createCourseCatchUpCoordinator({
        isCurrent: () => isCurrentCourseRead(courseId, epoch),
        hasCursor: () => eventCursorRef.current[courseId] !== undefined,
        seed: () => seedCourseRealtime(courseId, epoch),
        catchUp: () => catchUpCourseEvents(courseId),
        onRefreshed: recordCourseSyncSuccess,
        onError: recordCourseSyncFailure,
      });
    }
    const catchUp = courseCatchUpCoordinatorRef.current.request(requireFreshCatchUp);
    // Only the existing transport-recovery calls request projection refresh.
    // Ordinary course polls must not increase the projection polling cadence.
    if (requireFreshCatchUp) await Promise.all([catchUp, refreshProjectionState(courseId, true)]);
    else await catchUp;
  }

  function applyProjectionEvent(
    courseId: string,
    event: {
      type?: string;
      courseVersion?: number;
      cursor?: string;
      payload?: Record<string, unknown>;
    },
  ): boolean {
    const payload = event.payload;
    if (
      !payload
      || (event.type !== "projection-changed" && event.type !== "SET_UI_STATE")
    ) return false;
    const hasResourceProjection = Object.prototype.hasOwnProperty.call(
      payload,
      "resourceProjection",
    );
    const hasTeacherProjection = Object.prototype.hasOwnProperty.call(
      payload,
      "teacherResourceProjection",
    );
    if (!hasResourceProjection && !hasTeacherProjection) return false;
    if (
      typeof payload.projectionVersion !== "number"
      || typeof payload.projectionUpdatedAt !== "string"
      || typeof payload.serverTime !== "string"
    ) {
      return false;
    }
    const receivedAt = Date.now();
    const snapshot: ProjectionStateSnapshot = {
      courseId,
      courseVersion: typeof payload.courseVersion === "number"
        ? payload.courseVersion
        : event.courseVersion ?? 0,
      projectionVersion: payload.projectionVersion,
      projectionUpdatedAt: payload.projectionUpdatedAt,
      serverTime: payload.serverTime,
      projectionController: payload.projectionController as CourseUiState["projectionController"],
      resourceProjection: hasResourceProjection
        ? payload.resourceProjection as CourseUiState["resourceProjection"]
        : null,
      teacherResourceProjection: hasTeacherProjection
        ? payload.teacherResourceProjection as CourseUiState["teacherResourceProjection"]
        : null,
    };
    applyProjectionSnapshot(
      courseId,
      snapshot,
      receivedAt,
      receivedAt,
      hasProjectionWork(courseId),
    );
    return true;
  }

  function connectWebSocket(courseId: string | undefined) {
    if (typeof window === "undefined") return;
    const previousCourseId = wsCourseIdRef.current;
    wsCourseIdRef.current = courseId;
    if (!courseId) {
      teardownWebSocket();
      switchToPolling();
      return;
    }
    // Focus/network recovery on an already subscribed room only needs an
    // immediate durable catch-up. A course switch gets a fresh socket so old
    // handler closures cannot apply messages to the new room.
    if (
      wsRef.current
      && wsRef.current.readyState === WebSocket.OPEN
      && previousCourseId === courseId
    ) {
      startProjectionPolling(courseId);
      void syncCourseRealtime(courseId);
      return;
    }
    if (
      wsRef.current
      && wsRef.current.readyState === WebSocket.CONNECTING
      && previousCourseId === courseId
    ) {
      startCoursePolling(courseId, "polling");
      startProjectionPolling(courseId);
      void refreshProjectionState(courseId, true);
      return;
    }
    // A new transport has not joined its room yet. Retire the previous mode
    // and start the fast fallback once, before waiting for open/subscribed.
    teardownWebSocket();
    switchToPolling();

    const role = getClientRole();
    if (!role) return;
    const configuredUrl = process.env.NEXT_PUBLIC_WEBSOCKET_URL?.trim();
    // `next dev` does not expose the standalone WebSocket server on `/ws`.
    // Without an explicit development URL, polling is the intended transport;
    // repeatedly opening a socket here only produces noisy browser errors.
    if (process.env.NODE_ENV === "development" && !configuredUrl) {
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(
      configuredUrl || `${protocol}//${window.location.host}/ws`,
      window.location.href,
    );
    url.searchParams.set("role", role);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.warn("[session] WebSocket construction failed:", err);
      return;
    }
    wsRef.current = ws;
    wsConnectionTimerRef.current = window.setTimeout(() => {
      wsConnectionTimerRef.current = null;
      if (wsRef.current === ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, 5_000);
    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      if (wsConnectionTimerRef.current !== null) {
        window.clearTimeout(wsConnectionTimerRef.current);
        wsConnectionTimerRef.current = null;
      }
      wsFailureCountRef.current = 0;
      // Opening alone does not confirm room membership. Keep the existing
      // fast fallback and its deadlines; subscribed performs fresh catch-up.
      try {
        ws.send(JSON.stringify({ type: "subscribe", courseId }));
        if (wsSubscriptionTimerRef.current !== null) {
          window.clearTimeout(wsSubscriptionTimerRef.current);
        }
        wsSubscriptionTimerRef.current = window.setTimeout(() => {
          wsSubscriptionTimerRef.current = null;
          if (wsRef.current === ws) ws.close(4008, "SUBSCRIBE_TIMEOUT");
        }, 3_000);
      } catch {
        ws.close(1011, "SUBSCRIBE_FAILED");
      }
    };

    ws.onmessage = (event) => {
      // Course events advance a durable cursor. Catch up only the affected
      // course instead of downloading the full cross-course session.
      try {
        const data = event.data as unknown;
        if (typeof data === "string") {
          const parsed = JSON.parse(data) as {
            type?: string;
            courseId?: string;
            event?: {
              type?: string;
              payload?: { eventCursor?: string; actionType?: string; [key: string]: unknown };
            };
          };
          if (parsed.type === "subscribed" && parsed.courseId === courseId) {
            if (wsSubscriptionTimerRef.current !== null) {
              window.clearTimeout(wsSubscriptionTimerRef.current);
              wsSubscriptionTimerRef.current = null;
            }
            pollingRef.current = false;
            if (wsModeRef.current !== "websocket") {
              wsModeRef.current = "websocket";
              setRealtimeMode("websocket");
            }
            startProjectionPolling(courseId);
            startCoursePolling(courseId, "websocket");
            void syncCourseRealtime(courseId);
            return;
          }
          if (parsed.type === "course-event" && parsed.courseId === courseId) {
            if (parsed.event?.type === "companion-message") {
              emitDocumentReviewCompletion(courseId, parsed.event.payload ?? {});
            }
            if (parsed.event?.type === "showcase-presentation") {
              emitShowcasePresentation(
                courseId,
                (parsed.event.payload ?? {}) as ShowcaseEventPayload,
              );
              return;
            }
            if (parsed.event?.type === "public-discussion") {
              emitPublicDiscussionUpdate(courseId);
              return;
            }
            if (applyProjectionEvent(courseId, {
              type: parsed.event?.type,
              courseVersion: typeof parsed.event?.payload?.courseVersion === "number"
                ? parsed.event.payload.courseVersion
                : undefined,
              cursor: parsed.event?.payload?.eventCursor,
              payload: parsed.event?.payload,
            })) {
              recordCourseSyncSuccess();
              return;
            }
            scheduleCourseRefresh(
              courseId,
              parsed.event?.payload?.eventCursor,
              isClassroomControlEvent(
                parsed.event?.type,
                parsed.event?.payload?.actionType,
              )
                ? "classroom-control"
                : "standard",
            );
          }
        }
      } catch {
        /* noop */
      }
    };

    // Browsers expose WebSocket failures as an opaque Event. `onclose` below
    // owns the actionable fallback/retry path, so logging the Event here adds
    // noise without diagnostic information.
    ws.onerror = () => {};

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      if (wsConnectionTimerRef.current !== null) {
        window.clearTimeout(wsConnectionTimerRef.current);
        wsConnectionTimerRef.current = null;
      }
      if (wsSubscriptionTimerRef.current !== null) {
        window.clearTimeout(wsSubscriptionTimerRef.current);
        wsSubscriptionTimerRef.current = null;
      }
      wsRef.current = null;
      wsFailureCountRef.current++;
      switchToPolling();
      const delay = Math.min(
        30_000,
        1_000 * 2 ** Math.min(wsFailureCountRef.current - 1, 5),
      );
      const jitter = Math.floor(Math.random() * 500);
      wsRetryTimerRef.current = window.setTimeout(() => {
        wsRetryTimerRef.current = null;
        connectWebSocket(wsCourseIdRef.current);
      }, delay + jitter);
    };
  }

  useEffect(() => {
    const scopeEpoch = ++sessionHydrationScopeEpochRef.current;
    teacherTimingHydrationRef.current = undefined;
    timingInitializationRef.current = null;
    for (const [id, failed] of failedActionsRef.current) {
      if (failed.timingScope) failedActionsRef.current.delete(id);
    }
    const mode = getSessionRouteMode(pathname);
    const role = pathname.startsWith("/teacher") ? "teacher" : "student";
    let cancelled = false;
    let refreshEnabled = false;
    let intervalId: number | undefined;

    const refreshWhenVisible = () => {
      if (
        refreshEnabled
        && !cancelled
        && document.visibilityState === "visible"
        && pollingRef.current
        && (!wsCourseIdRef.current || needsStudentIdentity(pathname))
      ) {
        void refresh(role);
      }
    };

    async function startSessionRefresh() {
      if (mode === "identity") {
        // AI settings need the signed-in name but have no legacy classroom data.
        await refresh(role).catch(() => {
          if (!cancelled) dispatch({ type: "HYDRATE", payload: makeEmptyHydratedState() });
        });
        return;
      }
      if (mode === "none") {
        if (!stateRef.current.hydrated) {
          dispatch({ type: "HYDRATE", payload: makeEmptyHydratedState() });
        }
        return;
      }

      if (mode === "optional" && !(await hasAuthenticatedSession(role))) {
        if (!cancelled && !stateRef.current.hydrated) {
          dispatch({ type: "HYDRATE", payload: makeEmptyHydratedState() });
        }
        return;
      }
      if (cancelled) return;

      refreshEnabled = true;
      await refresh(role);
      if (cancelled) return;

      // Poll only while the current route can legitimately access course
      // data. A client-side route change tears this interval down.
      intervalId = window.setInterval(() => {
        // Classroom views already reconcile a lightweight per-course event
        // cursor. Avoid downloading the full cross-course session as well.
        if (
          isRealtimePollingActive(document.visibilityState)
          && pollingRef.current
          && (!wsCourseIdRef.current || needsStudentIdentity(pathname))
        ) void refresh(role);
      }, SESSION_REFRESH_INTERVAL_MS);
    }

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    void startSessionRefresh();
    return () => {
      cancelled = true;
      if (sessionHydrationScopeEpochRef.current === scopeEpoch) sessionHydrationScopeEpochRef.current += 1;
      if (teacherTimingHydrationRef.current?.scopeEpoch === scopeEpoch) teacherTimingHydrationRef.current = undefined;
      refreshEnabled = false;
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
    // The standalone player's query can change its course without changing
    // its native-classroom path. Both define the authenticated route scope.
    // refresh reads mutable state through refs, not callback identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, studentCourseId]);

  // Classroom pages subscribe through useRealtimeSync. Connections fail
  // silently and the per-course event cursor keeps the UI fresh regardless.
  // Tear down both transports on unmount.
  useEffect(() => {
    const projectionQueues = projectionQueuesRef.current;
    return () => {
      teardownWebSocket();
      for (const queue of projectionQueues.values()) queue.dispose();
      projectionQueues.clear();
    };
    // The provider owns one socket lifecycle; render-local function identity
    // changes must not tear it down and recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function disconnectRealtime() {
    wsCourseIdRef.current = undefined;
    pollingRef.current = true;
    teardownWebSocket();
    if (wsModeRef.current !== "polling") {
      wsModeRef.current = "polling";
      setRealtimeMode("polling");
    }
  }

  useEffect(() => {
    // Persist identity per-browser so refreshes keep the joined student context.
    // We also cache joinedAt (looked up from the joined course's students list)
    // and group membership so applyIdentity can fully reconstruct the Student
    // record when polling refresh races ahead of the server's action processing.
    let joinedAt: string | undefined;
    let joinedGroupId: string | undefined;
    let joinedGroupRole: string | undefined;
    if (state.joinedCourseId && state.studentId) {
      const joinedCourse = state.courses.find((c) => c.id === state.joinedCourseId);
      joinedAt = joinedCourse?.students.find((s) => s.id === state.studentId)?.joinedAt;
      // Find which group the student belongs to
      const studentGroup = joinedCourse?.groups?.find((g) =>
        g.members.some((m) => m.studentId === state.studentId),
      );
      if (studentGroup) {
        joinedGroupId = studentGroup.id;
        joinedGroupRole = studentGroup.members.find((m) => m.studentId === state.studentId)?.role;
      }
    }
    const identity: IdentityState = {
      user: state.user,
      joinedCourseId: state.joinedCourseId,
      studentId: state.studentId,
      studentName: state.studentName,
      joinedAt,
      joinedGroupId,
      joinedGroupRole,
    };
    // Save to role-specific key to prevent teacher/student cross-contamination
    const identityKey = state.user.role === "teacher" ? TEACHER_IDENTITY_KEY : STUDENT_IDENTITY_KEY;
    saveJSON(identityKey, identity);
    // Also save to legacy key for backwards compat
    saveJSON(IDENTITY_KEY, identity);
  }, [state.user, state.joinedCourseId, state.studentId, state.studentName, state.courses]);

  const api: SessionApi = useMemo(() => {
    const prepareSubmission = (input: SubmissionInput): {
      courseId: string;
      submission: ClassroomSubmission;
      expectedSubmissionVersion?: number;
      aiRevisionSource?: import("./types").AiRevisionSource;
    } | undefined => {
      const courseId = input.courseId ?? state.joinedCourseId;
      if (!courseId) return undefined;
      const now = new Date().toISOString();
      const existingSubmission = input.id
        ? state.courses
          .find((course) => course.id === courseId)
          ?.submissions?.find((submission) => submission.id === input.id)
        : undefined;
      return {
        courseId,
        ...(input.expectedVersion !== undefined ? { expectedSubmissionVersion: input.expectedVersion } : {}),
        ...(input.aiRevisionSource ? { aiRevisionSource: input.aiRevisionSource } : {}),
        submission: {
          id: input.id ?? makeRecordId("sub"),
          courseId,
          studentId: input.studentId ?? state.studentId,
          studentName: input.studentName ?? state.studentName ?? state.user.name,
          groupId: input.groupId,
          stageKey: input.stageKey,
          type: input.type,
          title: input.title,
          content: input.content,
          files: input.files,
          status: "draft",
          version: existingSubmission ? (existingSubmission.version ?? 1) + 1 : 1,
          createdAt: existingSubmission?.createdAt ?? now,
          updatedAt: now,
        },
      };
    };
    return {
      ...state,
      hydrated: state.hydrated && (!studentCourseId
        || (authenticatedStudentIdentity !== undefined
          && authenticatedStudentIdentity.courseId === studentCourseId
          && authenticatedStudentIdentity.studentId === state.studentId && state.user.role === "student"
          && state.joinedCourseId === authenticatedStudentIdentity.courseId)),
      saveState,
      lastSavedAt: !lastSavedReceipt?.studentScope || (state.user.role === "student"
        && authenticatedStudentIdentity?.studentId === lastSavedReceipt.studentScope.actorId
        && authenticatedStudentIdentity.courseId === lastSavedReceipt.studentScope.courseId
        && studentCourseId === lastSavedReceipt.studentScope.courseId) ? lastSavedReceipt?.at : undefined,
      saveError,
      retrySave,
      readPendingSubmissionSaves(courseId) {
        const identity = authenticatedStudentIdentityRef.current;
        if (!identity || identity.courseId !== courseId || stateRef.current.joinedCourseId !== courseId || stateRef.current.user.role !== "student"
          || stateRef.current.studentId !== identity.studentId) return unknownSubmissionSaveTelemetry();
        return submissionSaveTelemetry(identity.studentId, courseId);
      },
      flushSaves,
      submissionSaveConflicts,
      resolveSubmissionSaveConflict,
      setUser(u) {
        commit({ type: "SET_USER", payload: u }, { localOnly: true });
      },
      createCourse(input) {
        const id = makeCourseId();
        const now = new Date().toISOString();
        const course: Course = {
          ...input,
          id,
          name: input.name ?? "未命名课程",
          subject: input.subject ?? DEFAULT_NEW_COURSE_SUBJECT,
          grade: input.grade ?? "",
          hours: input.hours ?? DEFAULT_NEW_COURSE_HOURS,
          summary: input.summary ?? "",
          drivingQuestion: input.drivingQuestion ?? "",
          pblConfig: normalizePblCourseConfig(input.pblConfig),
          status: "draft",
          evaluationContractVersion: 2,
          stages: input.stages ?? getStagesForSystemMode(),
          currentStageIndex: 0,
          content: input.content ?? {
            pblOutline: "",
            knowledgePoints: [],
            teachingOutline: [],
            lessonOutline: [],
            evaluationPlan: {
              dimensions: [],
              overallRubric: "",
              flows: DEFAULT_EVALUATION_FLOWS.map((flow) => ({
                ...flow,
                evidenceRequirements: [...flow.evidenceRequirements],
              })),
            },
          },
          classConfig: undefined,
          inviteCode: undefined,
          students: [],
          submissions: [],
          feedback: [],
          rubricScores: [],
          reflections: [],
          activityLog: [],
          announcements: [],
          todos: defaultTodos(),
          resources: [],
          groups: [],
          groupAnnouncements: [],
          workPlan: [],
          whiteboard: [],
          boards: [],
          uploads: [],
          teamContributions: [],
          aiSupports: [],
          companionTasks: [],
          companionConfirmations: [],
          companionProcessRecords: [],
          learningEvidence: [],
          artifactSnapshots: [],
          aiContributions: [],
          studentAiDecisions: [],
          aiAssessmentSuggestions: [],
          teacherInterventions: [],
          stageTransitions: [],
          evaluations: [],
          uiState: {},
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        commit({ type: "CREATE_COURSE", payload: course });
        return course;
      },
      updateCourse(id, patch) {
        commit({ type: "UPDATE_COURSE", payload: { id, patch } });
      },
      deleteCourse(id) {
        commit({ type: "DELETE_COURSE", payload: { id } });
      },
      setCourseContent(id, content) {
        commit({ type: "SET_COURSE_CONTENT", payload: { id, content } });
      },
      setCourseStages(id, stages) {
        commit({ type: "SET_COURSE_STAGES", payload: { id, stages } });
      },
      publishCourse(id) {
        const course = state.courses.find((item) => item.id === id);
        const blocker = course
          ? getNewSystemCourseReadiness(course).find((check) => !check.ok && !isAdvisoryCourseReadinessCheck(check.id))
          : undefined;
        if (!course || blocker) {
          throw new Error(blocker?.message ?? "课程不存在，无法发布。");
        }
        commit({ type: "PUBLISH_COURSE", payload: { id } });
      },
      startTeaching(id, classConfig) {
        const course = state.courses.find((item) => item.id === id);
        const blockers = course
          ? getNewSystemCourseReadiness(course).filter((check) => !check.ok && !isAdvisoryCourseReadinessCheck(check.id))
          : [];
        if (!course || blockers.length > 0) {
          throw new Error(
            blockers[0]?.message ?? "课程不存在，无法开始授课。",
          );
        }
        const code = course.platformContext ? (course.inviteCode ?? "") : generateInviteCode(6);
        commit({
          type: "START_TEACHING",
          payload: { id, classConfig, inviteCode: code },
        });
        return code;
      },
      restartTeaching(id) {
        const newInviteCode = generateInviteCode(6);
        commit({
          type: "RESTART_TEACHING",
          payload: { id, newInviteCode },
        });
        return { inviteCode: newInviteCode };
      },
      endTeaching(id) {
        commit({ type: "END_TEACHING", payload: { id } });
      },
      advanceStage(id, direction) {
        commit({ type: "ADVANCE_STAGE", payload: { id, direction } });
      },
      setStage(id, index) {
        commit({ type: "SET_STAGE", payload: { id, index } });
      },
      joinClass(code, name) {
        const target = state.courses.find(
          (c) =>
            c.inviteCode &&
            c.inviteCode.toUpperCase() === normalizeInviteCode(code) &&
            c.status === "teaching",
        );
        if (!target) {
          return { ok: false, reason: "邀请码无效，或教师尚未开始授课" };
        }
        const trimmedName = name?.trim() || "学生";

        // ===== Same-name account merge =====
        // If a student with the same name already exists in this course,
        // reuse the existing account instead of creating a new one. This
        // ensures each student name appears only once in the teacher's
        // roster, and preserves all of the student's prior learning data
        // (stageProgress, submissions, group membership, etc.).
        const existing = target.students.find(
          (s) => s.name.toLowerCase() === trimmedName.toLowerCase(),
        );
        const student: Student = existing
          ? { ...existing, name: trimmedName, lastSeenAt: new Date().toISOString() }
          : {
              id: makeStudentId(),
              name: trimmedName,
              joinedAt: new Date().toISOString(),
              stageProgress: {},
              lastSeenAt: new Date().toISOString(),
            };

        // Update the user object so the top-right avatar shows the student's
        // name and role, not the default teacher identity.
        const studentUser = { role: "student" as const, name: student.name };
        // Pre-seed the identity cache so the next polling refresh cannot
        // drop the just-joined student from course.students before the
        // server's JOIN_CLASS ack lands.
        const identity: IdentityState = {
          user: studentUser,
          joinedCourseId: target.id,
          studentId: student.id,
          studentName: student.name,
          joinedAt: student.joinedAt,
        };
        saveJSON(STUDENT_IDENTITY_KEY, identity);
        saveJSON(IDENTITY_KEY, identity);
        void commit(
          { type: "SET_USER", payload: studentUser },
          { localOnly: true },
        );
        commit({ type: "JOIN_CLASS", payload: { courseId: target.id, student } });
        return { ok: true, course: target };
      },
      async leaveClass() {
        if (state.joinedCourseId && state.studentId) {
          // Save left-class history so the student can rejoin by name later.
          const leftCourse = state.courses.find((c) => c.id === state.joinedCourseId);
          if (leftCourse) {
            const history = loadJSON<LeftClassRecord[]>(LEFT_CLASS_HISTORY_KEY, []);
            const record: LeftClassRecord = {
              courseId: leftCourse.id,
              courseName: leftCourse.name,
              studentId: state.studentId!,
              studentName: state.studentName ?? state.user.name,
              leftAt: new Date().toISOString(),
            };
            // Keep only the latest record per course
            const filtered = history.filter((r) => r.courseId !== record.courseId);
            filtered.push(record);
            saveJSON(LEFT_CLASS_HISTORY_KEY, filtered);
          }
          const leaveAction: SessionAction = {
            type: "LEAVE_CLASS",
            payload: {
              courseId: state.joinedCourseId,
              studentId: state.studentId,
            },
          };
          const persisted = await commit(leaveAction);
          if (!persisted) return false;
          // The authenticated response is scoped by the still-valid student
          // cookie and can carry the old course identity. Clear it again only
          // after the response arrives.
          dispatch(leaveAction);
          // Reset user to a generic student so the avatar no longer shows
          // the previous student name after leaving.
          await commit(
            { type: "SET_USER", payload: { role: "student", name: "" } },
            { localOnly: true },
          );
        }
        return true;
      },
      rejoinClass(record: LeftClassRecord) {
        const target = state.courses.find((c) => c.id === record.courseId);
        if (!target || target.status !== "teaching") {
          // Remove stale history entry
          const history = loadJSON<LeftClassRecord[]>(LEFT_CLASS_HISTORY_KEY, []);
          saveJSON(LEFT_CLASS_HISTORY_KEY, history.filter((r) => r.courseId !== record.courseId));
          return { ok: false as const, reason: "课堂已结束或不存在，无法重新加入" };
        }
        // Check if student is still in the course's student list
        const existingStudent = target.students.find((s) => s.id === record.studentId);
        if (existingStudent) {
          // Student record still exists (teacher may not have removed them) — just restore identity
          const studentUser = { role: "student" as const, name: record.studentName };
          const identity: IdentityState = {
            user: studentUser,
            joinedCourseId: target.id,
            studentId: record.studentId,
            studentName: record.studentName,
            joinedAt: existingStudent.joinedAt,
          };
          saveJSON(STUDENT_IDENTITY_KEY, identity);
          saveJSON(IDENTITY_KEY, identity);
          void commit(
            { type: "SET_USER", payload: studentUser },
            { localOnly: true },
          );
          commit({ type: "JOIN_CLASS", payload: { courseId: target.id, student: existingStudent } });
        } else {
          // Student was removed from the course — re-add them
          const student: Student = {
            id: record.studentId,
            name: record.studentName,
            joinedAt: new Date().toISOString(),
            stageProgress: {},
          };
          const studentUser = { role: "student" as const, name: record.studentName };
          const identity: IdentityState = {
            user: studentUser,
            joinedCourseId: target.id,
            studentId: student.id,
            studentName: student.name,
            joinedAt: student.joinedAt,
          };
          saveJSON(STUDENT_IDENTITY_KEY, identity);
          saveJSON(IDENTITY_KEY, identity);
          void commit(
            { type: "SET_USER", payload: studentUser },
            { localOnly: true },
          );
          commit({ type: "JOIN_CLASS", payload: { courseId: target.id, student } });
        }
        // Remove the history entry after successful rejoin
        const history = loadJSON<LeftClassRecord[]>(LEFT_CLASS_HISTORY_KEY, []);
        saveJSON(LEFT_CLASS_HISTORY_KEY, history.filter((r) => r.courseId !== record.courseId));
        return { ok: true as const, course: target };
      },
      getLeftClassHistory() {
        const history = loadJSON<LeftClassRecord[]>(LEFT_CLASS_HISTORY_KEY, []);
        // Filter out entries for courses that are no longer teaching
        return history.filter((r) => {
          const course = state.courses.find((c) => c.id === r.courseId);
          return course?.status === "teaching";
        });
      },
      updateStudentProgress(stageKey, value) {
        if (!state.joinedCourseId || !state.studentId) return;
        commit({
          type: "UPDATE_STUDENT_PROGRESS",
          payload: {
            courseId: state.joinedCourseId,
            studentId: state.studentId,
            stageKey,
            value,
          },
        });
      },
      upsertSubmission(input) {
        const prepared = prepareSubmission(input);
        if (!prepared) return undefined;
        commit({ type: "UPSERT_SUBMISSION", payload: prepared });
        return prepared.submission;
      },
      async persistSubmission(input) {
        const prepared = prepareSubmission(input);
        if (!prepared) return undefined;
        let confirmedOwnReceipt: ClassroomSubmission | undefined;
        const identity = authenticatedStudentIdentityRef.current;
        if (identity && identity.courseId === prepared.courseId && identity.studentId === prepared.submission.studentId) {
          try {
            for (const pending of readSubmissionSaves(identity.studentId, identity.courseId)) {
              if (pending.state === "resolved" || pending.action.payload.submission.stageKey !== prepared.submission.stageKey
                || pending.action.payload.submission.type !== prepared.submission.type) continue;
              if (pending.state === "conflict" || !await commit(pending.action, { requestId: pending.requestId, actorId: pending.actorId, draftKey: pending.draftKey })) return undefined;
              if (pending.draftKey && (pending.draftKey === input.draftKey || pending.draftKey === input.recoveredDraftKey)
                && pending.action.payload.submission.id === prepared.submission.id
                && pending.action.payload.expectedSubmissionVersion === prepared.expectedSubmissionVersion) {
                const saved = savedSubmissionsRef.current.get(`${prepared.courseId}:${prepared.submission.id}`);
                if (saved) {
                  if (savedSubmissionBaselinesRef.current.get(`${prepared.courseId}:${prepared.submission.id}`)?.receipt) confirmedOwnReceipt = saved;
                  prepared.expectedSubmissionVersion = saved.version;
                  prepared.submission = { ...prepared.submission, id: saved.id, createdAt: saved.createdAt };
                }
              }
            }
          } catch { submissionOutboxReadErrorRef.current = true; setSaveError("无法读取本机待保存记录，请保留当前页面后重试。"); setSaveState("error"); return undefined; }
        }
        const known = savedSubmissionsRef.current.get(`${prepared.courseId}:${prepared.submission.id}`);
        const knownBase = savedSubmissionBaselinesRef.current.get(`${prepared.courseId}:${prepared.submission.id}`);
        if (known && knownBase?.draftKey && (knownBase.draftKey === input.draftKey || knownBase.draftKey === input.recoveredDraftKey)
          && knownBase.version === prepared.expectedSubmissionVersion) {
          // A recovered receipt proves this editor's old baseline advanced through its own pending request.
          if (knownBase.receipt) confirmedOwnReceipt = known;
          prepared.expectedSubmissionVersion = known.version;
          prepared.submission = { ...prepared.submission, id: known.id, createdAt: known.createdAt };
        }
        // The restored editor can still run its old autosave timer after provider recovery.
        // Return its own identical durable receipt instead of issuing a second write/version.
        if (confirmedOwnReceipt && sameSubmissionContent(prepared.submission, confirmedOwnReceipt)) return confirmedOwnReceipt;
        const persisted = await commit({ type: "UPSERT_SUBMISSION", payload: prepared }, { draftKey: input.draftKey });
        return persisted ? savedSubmissionsRef.current.get(`${prepared.courseId}:${prepared.submission.id}`) ?? prepared.submission : undefined;
      },
      addFeedback(input) {
        const courseId = input.courseId;
        if (!courseId) return undefined;
        const feedback: TeacherFeedback = {
          id: input.id ?? makeRecordId("fb"),
          courseId,
          targetType: input.targetType,
          targetId: input.targetId,
          stageKey: input.stageKey,
          kind: input.kind,
          content: input.content,
          sourceRole: input.sourceRole ?? "teacher",
          sourceName: input.sourceName ?? state.user.name,
          evidence: input.evidence ?? [],
          status: input.status ?? "open",
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_FEEDBACK", payload: { courseId, feedback } });
        return feedback;
      },
      upsertRubricScore(input) {
        const courseId = input.courseId;
        if (!courseId) return undefined;
        const now = new Date().toISOString();
        const score: RubricScore = {
          id: input.id ?? makeRecordId("score"),
          courseId,
          groupId: input.groupId,
          stageKey: input.stageKey,
          dimensionScores: input.dimensionScores,
          rubricSnapshot: input.rubricSnapshot,
          teacherTotal: input.teacherTotal,
          aiDimensionScores: input.aiDimensionScores,
          aiTotal: input.aiTotal,
          aiProcessSummary: input.aiProcessSummary,
          aiProcessEvidence: input.aiProcessEvidence,
          finalTotal: input.finalTotal,
          scoringMode: input.scoringMode,
          comment: input.comment,
          total: input.total,
          status: input.status,
          createdAt: now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_RUBRIC_SCORE", payload: { courseId, score } });
        return score;
      },
      upsertReflection(input) {
        const courseId = input.courseId ?? state.joinedCourseId;
        const studentId = input.studentId ?? state.studentId;
        if (!courseId || !studentId) return undefined;
        const now = new Date().toISOString();
        const course = state.courses.find((candidate) => candidate.id === courseId);
        const existing = course?.reflections?.find((reflection) => reflection.id === input.id)
          ?? (input.survey
            ? [...(course?.reflections ?? [])]
              .filter((reflection) => reflection.studentId === studentId)
              .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
            : undefined);
        const reflectionId = existing?.id ?? input.id ?? makeRecordId("ref");
        const reflection: ReflectionRecord = {
          id: reflectionId,
          courseId,
          studentId,
          studentName: input.studentName ?? state.studentName ?? state.user.name,
          content: input.content,
          improvementPlan: input.improvementPlan,
          survey: input.survey,
          courseReflection: input.courseReflection,
          experienceSurvey: input.experienceSurvey,
          // A legacy reflection may share the same record id, but its
          // creation time predates the survey. Start the survey's first
          // submission clock at this save; subsequent structured updates
          // retain that original timestamp.
          createdAt: input.survey && !existing?.survey
            ? now
            : existing?.createdAt ?? now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_REFLECTION", payload: { courseId, reflection } });
        return reflection;
      },
      upsertAnnouncement(courseId, input) {
        const now = new Date().toISOString();
        const announcement: CourseAnnouncement = {
          id: input.id ?? makeRecordId("ann"),
          title: input.title,
          content: input.content,
          pinned: input.pinned,
          replies: input.replies ?? [],
          createdAt: now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_ANNOUNCEMENT", payload: { courseId, announcement } });
        return announcement;
      },
      deleteAnnouncement(courseId, announcementId) {
        commit({ type: "DELETE_ANNOUNCEMENT", payload: { courseId, announcementId } });
      },
      replyAnnouncement(courseId, announcementId, content) {
        if (!content.trim()) return undefined;
        const reply: AnnouncementReply = {
          id: makeRecordId("reply"),
          studentId: state.studentId,
          studentName: state.studentName ?? state.user.name,
          content: content.trim(),
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_ANNOUNCEMENT_REPLY", payload: { courseId, announcementId, reply } });
        return reply;
      },
      upsertTodo(courseId, todo) {
        commit({ type: "UPSERT_TODO", payload: { courseId, todo } });
      },
      completeTodo(courseId, todoId, completed) {
        const course = state.courses.find((c) => c.id === courseId);
        const todo = course?.todos?.find((item) => item.id === todoId);
        if (!todo || !state.studentId) return;
        commit({
          type: "SET_STUDENT_TODO_COMPLETION",
          payload: { courseId, todoId, studentId: state.studentId, completed },
        });
      },
      markResourceDownloaded(courseId, resourceId) {
        if (!state.studentId) return;
        commit({
          type: "MARK_RESOURCE_DOWNLOADED",
          payload: {
            courseId,
            resourceId,
            studentId: state.studentId,
            studentName: state.studentName ?? state.user.name,
          },
        });
      },
      upsertGroup(courseId, group) {
        commit({ type: "UPSERT_GROUP", payload: { courseId, group } });
      },
      createGroup(courseId, name) {
        const now = new Date().toISOString();
        const course = state.courses.find((c) => c.id === courseId);
        const inquiryQuestions = normalizePblCourseConfig(course?.pblConfig).inquiryQuestions;
        const group: ProjectGroup = {
          id: makeRecordId("group"),
          name: name || `第 ${(course?.groups?.length ?? 0) + 1} 组`,
          topic: inquiryQuestions.length === 1 ? inquiryQuestions[0] : "待确定选题方向",
          goal: "明确问题、形成可落地方案，并准备阶段性汇报。",
          keywords: ["项目研究", "真实情境", "数据驱动"],
          selectedForms: ["方案报告"],
          members: [],
          createdAt: now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_GROUP", payload: { courseId, group } });
        return group;
      },
      joinGroup(courseId, groupId, role) {
        if (!state.studentId) return;
        commit({
          type: "JOIN_GROUP",
          payload: {
            courseId,
            groupId,
            studentId: state.studentId,
            studentName: state.studentName ?? state.user.name,
            role,
          },
        });
      },
      leaveGroup(courseId, groupId) {
        if (!state.studentId) return;
        commit({ type: "LEAVE_GROUP", payload: { courseId, groupId, studentId: state.studentId } });
      },
      setGroupTopic(courseId, groupId, patch) {
        commit({
          type: "SET_GROUP_TOPIC",
          payload: {
            courseId,
            groupId,
            patch,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
      },
      upsertGroupAnnouncement(courseId, input) {
        const announcement: GroupAnnouncement = {
          id: input.id ?? makeRecordId("gann"),
          groupId: input.groupId,
          title: input.title,
          content: input.content,
          actor: input.actor ?? state.studentName ?? state.user.name,
          createdAt: new Date().toISOString(),
        };
        commit({
          type: "UPSERT_GROUP_ANNOUNCEMENT",
          payload: {
            courseId,
            announcement,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
        return announcement;
      },
      upsertWorkPlanItem(courseId, input) {
        const item: WorkPlanItem = {
          id: input.id ?? makeRecordId("task"),
          groupId: input.groupId,
          role: input.role,
          memberName: input.memberName,
          task: input.task,
          progress: input.progress,
        };
        commit({
          type: "UPSERT_WORK_PLAN_ITEM",
          payload: {
            courseId,
            item,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
        return item;
      },
      deleteWorkPlanItem(courseId, itemId) {
        commit({
          type: "DELETE_WORK_PLAN_ITEM",
          payload: {
            courseId,
            itemId,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
      },
      upsertWhiteboardNode(courseId, input) {
        const node: WhiteboardNode = {
          id: input.id ?? makeRecordId("node"),
          groupId: input.groupId,
          label: input.label,
          note: input.note,
          x: input.x,
          y: input.y,
          color: input.color,
          parentId: input.parentId,
        };
        commit({ type: "UPSERT_WHITEBOARD_NODE", payload: { courseId, node } });
        return node;
      },
      deleteWhiteboardNode(courseId, nodeId) {
        commit({ type: "DELETE_WHITEBOARD_NODE", payload: { courseId, nodeId } });
      },
      upsertGroupBoard(courseId, input) {
        const existing = state.courses.find((c) => c.id === courseId)?.boards?.find((b) => b.groupId === input.groupId);
        const board: GroupBoard = {
          groupId: input.groupId,
          snapshot: input.snapshot,
          mode: input.mode ?? existing?.mode ?? "mindmap",
          updatedAt: input.updatedAt ?? new Date().toISOString(),
        };
        commit({ type: "UPSERT_GROUP_BOARD", payload: { courseId, board } });
      },
      upsertUpload(input) {
        const upload: CourseUpload = {
          ...input,
          createdAt: new Date().toISOString(),
        };
        commit({ type: "UPSERT_UPLOAD", payload: { courseId: upload.courseId, upload } });
        return upload;
      },
      deleteUpload(courseId, uploadId) {
        commit({ type: "DELETE_UPLOAD", payload: { courseId, uploadId } });
      },
      setPreviewUpload(courseId, uploadId) {
        commit({
          type: "SET_PREVIEW_UPLOAD",
          payload: {
            courseId,
            uploadId,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
      },
      upsertTeamContribution(input) {
        const courseId = input.courseId ?? state.joinedCourseId;
        if (!courseId) return undefined;
        const contribution: TeamContribution = {
          id: input.id ?? makeRecordId("contrib"),
          courseId,
          groupId: input.groupId,
          studentId: input.studentId ?? state.studentId,
          studentName: input.studentName,
          percent: input.percent,
          note: input.note,
          updatedAt: new Date().toISOString(),
        };
        commit({ type: "UPSERT_TEAM_CONTRIBUTION", payload: { courseId, contribution } });
        return contribution;
      },
      upsertAiSupport(input) {
        const courseId = input.courseId ?? state.joinedCourseId;
        if (!courseId) return undefined;
        const existing = state.courses.find((c) => c.id === courseId)?.aiSupports?.find((item) => item.id === input.id);
        const now = new Date().toISOString();
        const support: AiSupportRecord = {
          id: input.id ?? makeRecordId("ais"),
          courseId,
          stageKey: input.stageKey,
          targetType: input.targetType,
          targetId: input.targetId,
          groupId: input.groupId,
          studentId: input.studentId ?? state.studentId,
          studentName: input.studentName ?? state.studentName ?? state.user.name,
          kind: input.kind,
          trigger: input.trigger,
          inputSummary: input.inputSummary,
          diagnosis: input.diagnosis,
          suggestions: input.suggestions,
          evidence: input.evidence,
          status: input.status,
          source: input.source,
          editedContent: input.editedContent,
          structuredPayload: input.structuredPayload,
          adoption: input.adoption,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_AI_SUPPORT", payload: { courseId, support } });
        return support;
      },
      addOfflineIntervention(input) {
        const intervention: OfflineInterventionRecord = {
          ...input,
          id: input.id ?? makeRecordId("offline-intervention"),
          teacherName: input.teacherName ?? state.user.name,
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_OFFLINE_INTERVENTION", payload: { courseId: input.courseId, intervention } });
        return intervention;
      },
      resolveInterventionSignals(courseId, signalIds) {
        if (!signalIds.length) return;
        commit({ type: "RESOLVE_INTERVENTION_SIGNALS", payload: { courseId, signalIds } });
      },
      upsertTeacherAgentDirective(input) {
        const existing = state.courses
          .find((course) => course.id === input.courseId)
          ?.teacherAgentDirectives?.find((directive) => directive.id === input.id);
        const now = new Date().toISOString();
        const directive: TeacherAgentDirective = {
          ...input,
          id: input.id ?? makeRecordId("teacher-directive"),
          teacherName: input.teacherName ?? state.user.name,
          createdAt: input.createdAt ?? existing?.createdAt ?? now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_TEACHER_AGENT_DIRECTIVE", payload: { courseId: input.courseId, directive } });
        return directive;
      },
      upsertCompanionTask(input) {
        const now = new Date().toISOString();
        const courseId = input.courseId;
        const existing = state.courses
          .find((course) => course.id === courseId)
          ?.companionTasks?.find((task) => task.id === input.id);
        const task: CompanionTask = {
          ...input,
          id: input.id ?? makeRecordId("companion-task"),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_COMPANION_TASK", payload: { courseId, task } });
        return task;
      },
      upsertCompanionConfirmation(input) {
        const now = new Date().toISOString();
        const courseId = input.courseId;
        const existing = state.courses
          .find((course) => course.id === courseId)
          ?.companionConfirmations?.find((confirmation) => confirmation.id === input.id);
        const confirmation: CompanionConfirmation = {
          ...input,
          id: input.id ?? makeRecordId("companion-confirmation"),
          status: input.status ?? existing?.status ?? "pending",
          createdAt: existing?.createdAt ?? now,
        };
        commit({ type: "UPSERT_COMPANION_CONFIRMATION", payload: { courseId, confirmation } });
        return confirmation;
      },
      resolveCompanionConfirmation(courseId, confirmationId, status) {
        commit({
          type: "RESOLVE_COMPANION_CONFIRMATION",
          payload: {
            courseId,
            confirmationId,
            status,
            resolvedAt: new Date().toISOString(),
            studentId: state.studentId,
          },
        });
      },
      addCompanionProcessRecord(input) {
        const record: CompanionProcessRecord = {
          ...input,
          id: input.id ?? makeRecordId("companion-process"),
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_COMPANION_PROCESS_RECORD", payload: { courseId: input.courseId, record } });
        return record;
      },
      requestTeacherHelp(courseId, stageKey) {
        if (!state.studentId) return undefined;
        const course = state.courses.find((item) => item.id === courseId);
        const existing = course?.learningSignals?.find((item) =>
          item.studentId === state.studentId
          && item.stageKey === stageKey
          && item.kind === "student-help-request"
          && item.status === "open");
        if (existing) return existing;

        const now = new Date().toISOString();
        const signal: LearningSignal = {
          id: makeRecordId("student-help"),
          courseId,
          studentId: state.studentId,
          stageKey,
          kind: "student-help-request",
          severity: "warning",
          status: "open",
          title: "学生主动请求帮助",
          summary: "学生希望教师查看当前任务或证据缺口；该请求不计入学习评价。",
          normalizedIssueKey: `student-help-request:${state.studentId}:${stageKey}`,
          evidenceEventIds: [],
          aiInterventionAttempts: 0,
          firstDetectedAt: now,
          lastDetectedAt: now,
        };
        commit({ type: "REQUEST_TEACHER_HELP", payload: { courseId, signal } });
        return signal;
      },
      upsertLearningEvidence(evidence) {
        commit({
          type: "UPSERT_LEARNING_EVIDENCE",
          payload: { courseId: evidence.courseId, evidence },
        });
        return evidence;
      },
      reviewLearningEvidence(courseId, evidenceId, status, feedback) {
        commit({
          type: "REVIEW_LEARNING_EVIDENCE",
          payload: {
            courseId,
            evidenceId,
            status,
            feedback,
            reviewedAt: new Date().toISOString(),
          },
        });
      },
      upsertArtifactSnapshot(snapshot) {
        commit({
          type: "UPSERT_ARTIFACT_SNAPSHOT",
          payload: { courseId: snapshot.courseId, snapshot },
        });
        return snapshot;
      },
      upsertAiContribution(contribution) {
        commit({
          type: "UPSERT_AI_CONTRIBUTION",
          payload: { courseId: contribution.courseId, contribution },
        });
        return contribution;
      },
      recordStudentAiDecision(decision) {
        commit({
          type: "RECORD_STUDENT_AI_DECISION",
          payload: { courseId: decision.courseId, decision },
        });
        return decision;
      },
      upsertAiAssessmentSuggestion(suggestion) {
        commit({
          type: "UPSERT_AI_ASSESSMENT_SUGGESTION",
          payload: { courseId: suggestion.courseId, suggestion },
        });
        return suggestion;
      },
      initializeClassroomTiming,
      setUiState(courseId, patch, control) {
        const action: SessionAction = {
          type: "SET_UI_STATE",
          payload: { courseId, patch },
        };
        if (projectionPatchFromAction(action)) {
          const course = stateRef.current.courses.find(item => item.id === courseId);
          const stageKey = course?.stages[course.currentStageIndex]?.key;
          if (!course || course.status !== "teaching" || !stageKey) return;
          action.payload.projectionControl = { clientId: projectionClientId(), ...control,
            baseStageVersion: course.stageVersion ?? 1, stageKey };
          queueProjectionAction(action);
        }
        else void commit(action);
      },
      addActivity(courseId, action, detail, actor = state.user.name) {
        const activity: ActivityRecord = {
          id: makeRecordId("act"),
          actor,
          action,
          detail,
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_ACTIVITY", payload: { courseId, activity } });
      },
      setPresentingGroup(courseId, groupId) {
        commit({ type: "SET_PRESENTING_GROUP", payload: { courseId, groupId } });
      },
      getCourse(id) {
        return state.courses.find((c) => c.id === id);
      },
      findCourseByCode(code) {
        return state.courses.find(
          (c) => c.inviteCode && c.inviteCode.toUpperCase() === normalizeInviteCode(code),
        );
      },
      generateNewInviteCode(id) {
        const code = generateInviteCode(6);
        commit({
          type: "UPDATE_COURSE",
          payload: { id, patch: { inviteCode: code } },
        });
        return code;
      },
      refresh,
      connectWebSocket,
      disconnectWebSocket: disconnectRealtime,
      realtimeMode,
    };
  // The API is rebuilt for every session-state change. refresh and
  // connectWebSocket deliberately read live mutable state from refs; adding
  // their render-local identities would defeat memoization without changing
  // the exposed behavior.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state,
    pathname,
    studentCourseId,
    authenticatedStudentIdentity,
    saveState,
    lastSavedReceipt,
    saveError,
    submissionSaveConflicts,
    realtimeMode,
  ]);

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return ctx;
}

export function useCourse(id: string | undefined): Course | undefined {
  const { courses } = useSession();
  if (!id) return undefined;
  return courses.find((c) => c.id === id);
}

export function useSessionSnapshot() {
  const { courses, user, hydrated, joinedCourseId, studentName } = useSession();
  return { courses, user, hydrated, joinedCourseId, studentName };
}

export function useHydrated(): boolean {
  return useSession().hydrated;
}

function defaultTodos(): CourseTodo[] {
  // CourseTodo.id 是全局主键（@id），不能跨课程重复。
  // 使用 makeRecordId 生成唯一 ID，避免创建第二个课程时触发 P2002 唯一约束冲突。
  return [
    {
      id: makeRecordId("todo-read-brief"),
      title: "阅读项目说明",
      description: "了解项目背景、目标与成果要求。",
      stageKey: "launch",
      completedBy: [],
    },
    {
      id: makeRecordId("todo-pick-direction"),
      title: "选择研究主题",
      description: "从本节课程主题中选择你希望深入研究的方向。",
      stageKey: "launch",
      completedBy: [],
    },
  ];
}
