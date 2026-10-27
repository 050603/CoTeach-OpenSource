"use client";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  FlaskConical,
  Image as ImageIcon,
  LoaderCircle,
  Mic2,
  Paperclip,
  PenLine,
  Send,
  Settings2,
  Sparkles,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { AnimatePresence, LayoutGroup } from "motion/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CourseGenerationGlyph } from "@/components/course-workshop-animation";
import { QuickKnowledgeReviewDialog } from "@/components/teacher/quick-knowledge-review-dialog";
import { QuickOutlineReviewDialog } from "@/components/teacher/quick-outline-review-dialog";
import { QuickGenerationStage } from "@/components/teacher/quick-generation-stage";
import { StudentStageHost } from "@/components/openmaic-bridge/student-stage-host";
import { CollaborativePreparation } from "@/components/teacher/collaborative-preparation";
import type { ConfirmedPreparation } from "@/lib/collaborative-preparation/types";
import { ResourcePackageForm } from "@/components/teacher/resource-package-form";
import { CourseTextbookSelector } from "@/components/teacher/course-textbook-selector";
import type { CourseResourcePackage, ResourcePackageJobSnapshot } from "@/lib/resource-package/types";
import { courseGenerationDraftKey, courseGenerationSettingsKey, readCourseGenerationDraft, readCourseGenerationSettings, type CourseGenerationInputDraft, type CourseGenerationSettings, type PreparationMode } from "@/lib/teacher/course-generation-draft";
import {
  buildQuickClassroomArtifacts,
  combineQuickGenerationProgress,
  resolveQuickClassroomActiveArtifactId,
  type QuickClassroomGenerationSnapshot,
} from "@/lib/course-generation/quick-artifacts";
import { isGenerationHeartbeatStale } from "@/lib/course-generation/heartbeat";
import { resolveLatestCompletedArtifactId } from "@/lib/course-design/active-artifact";
import { readJsonResponse } from "@/lib/http/read-json-response";
import type {
  Course,
  CourseContent,
  CourseDesignGenerationArtifact,
  CourseDesignGenerationTraceEntry,
  KnowledgeGraph,
  KnowledgePoint,
  OpenMaicSceneOutlineSnapshot,
  TeachingBlueprint,
} from "@/lib/session/types";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import { cn } from "@/lib/utils";
import {
  GENERATION_REFERENCE_ACCEPT,
  MAX_GENERATION_REFERENCE_FILES,
} from "@/lib/course-design/generation-reference-policy";
import type { ClassroomGenerationScope } from "@/lib/course-generation/generation-scope";
import type { CourseEvidenceSnapshot, CourseTextbookSelection } from "@/lib/textbook/course-evidence-types";
import styles from "./fast-course-generator.module.css";

type JobStatus = "queued" | "running" | "review_available" | "paused" | "cancelling" | "cancelled" | "completed" | "failed";

type DesignJob = {
  id: string;
  status: JobStatus;
  step: string;
  reviewStatus: "unavailable" | "available" | "paused" | "approved" | "auto-continued";
  reviewKind?: "knowledge" | "capacity" | "outline" | null;
  reviewAvailableUntil?: string | null;
  stepIndex: number;
  progress: number;
  message: string;
  estimatedRemainingSeconds: number | null;
  tokenUsage?: {
    totalTokens: number;
    calls: number;
    approximate: boolean;
  };
  currentCall?: {
    stage?: string;
    status?: "queued" | "awaiting-first-output" | "reasoning" | "receiving-output" | "retry-wait";
    attempt?: number;
    maxAttempts?: number;
    queueMs?: number;
    startedAt?: number;
    lastActivityAt?: number;
    firstOutputAt?: number;
    retryAt?: number;
    reasoningCharacters?: number;
    textCharacters?: number;
  } | null;
  trace: Array<CourseDesignGenerationTraceEntry & { progress?: number; stepIndex?: number }>;
  qualityReport?: { score?: number; summary?: string; checks?: string[] } | null;
  error?: string | null;
  startedAt?: string | null;
  lastHeartbeatAt?: string | null;
  updatedAt?: string | null;
  requestPreview?: {
    teacherBrief?: string;
    resourcePackageId?: string;
    resourcePackageRevision?: number;
    preparationSessionId?: string;
    preparationRevision?: number;
    confirmedPreparation?: ConfirmedPreparation;
    supplementalAnswers?: { brief?: string };
    generationScope?: ClassroomGenerationScope;
    testSectionId?: string;
    generationMode?: CourseGenerationMode;
    assessmentMode?: AssessmentMode;
    options?: GenerationOptions | null;
    referenceMaterials?: UploadedKnowledgeReference[];
    textbookSelections?: CourseTextbookSelection[];
  };
};

type ResponsePayload = {
  backgroundEnabled: boolean;
  job: DesignJob | null;
  knowledgePreview?: {
    knowledgePoints: KnowledgePoint[];
    knowledgeGraph: KnowledgeGraph;
    knowledgeScopePlan?: CourseContent["knowledgeScopePlan"];
    courseEvidence?: CourseEvidenceSnapshot;
  } | null;
  outlinePreview?: OpenMaicSceneOutlineSnapshot[];
  blueprintPreview?: TeachingBlueprint | null;
  error?: string;
  detail?: string;
};

type ClassroomGenerationResponse = {
  backgroundEnabled: boolean;
  recoveryPhase?: "design";
  detail?: string;
  job: (QuickClassroomGenerationSnapshot & {
    id: string;
    estimatedRemainingSeconds: number | null;
    error?: string | null;
    startedAt?: string | null;
    lastHeartbeatAt?: string | null;
    updatedAt?: string | null;
  }) | null;
  error?: string;
};

type GenerationOptions = {
  enableImageGeneration: boolean;
  enableTTS: boolean;
  enableVideoGeneration: boolean;
};

type CourseGenerationMode = "standard" | "deep-interaction";
type AssessmentMode = "adaptive" | "constructed-response";

type UploadedKnowledgeReference = {
  id: string;
  fileName: string;
  fileType?: string;
  mimeType?: string;
  size?: string;
};

const CLASSROOM_PAGE_STAGE_LABELS: Record<string, string> = {
  restoring: "恢复断点",
  content: "生成正文",
  "reviewed-content": "恢复旧版页面断点",
  actions: "生成讲稿与动作",
  narration: "编写课堂讲稿",
  assembling: "组装保存",
};


function sceneOutlinesForPreview(outlines: readonly OpenMaicSceneOutlineSnapshot[] = []): SceneOutline[] {
  return outlines.map((outline, index) => ({
    ...outline,
    type: outline.type === "quiz" || outline.type === "interactive" || outline.type === "pbl" ? outline.type : "slide",
    description: outline.description ?? "",
    keyPoints: outline.keyPoints ?? [],
    order: outline.order ?? index + 1,
  })) as SceneOutline[];
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "剩余时间估算中";
  if (seconds <= 0) return "正在完成保存";
  return `预计还需约 ${Math.max(1, Math.ceil(seconds / 60))} 分钟`;
}

function pageRuntimeLabel(page: NonNullable<QuickClassroomGenerationSnapshot["activePages"]>[number]): string {
  const details: string[] = [];
  if ((page.queueMs ?? 0) >= 1_000) details.push(`排队 ${Math.ceil(page.queueMs! / 1_000)} 秒`);
  if ((page.executionMs ?? 0) >= 1_000) details.push(`已执行 ${Math.ceil(page.executionMs! / 1_000)} 秒`);
  if ((page.retryCount ?? 0) > 0) details.push(`已重试 ${page.retryCount} 次`);
  if (page.lastOutputAt) {
    details.push(`最近输出 ${Math.max(0, Math.floor((Date.now() - page.lastOutputAt) / 1_000))} 秒前`);
  }
  return details.length ? `，${details.join("，")}` : "";
}

export function designCallLabel(call: DesignJob["currentCall"]): string {
  if (!call) return "";
  const status = call.status === "queued"
    ? "等待模型并发槽位"
    : call.status === "awaiting-first-output"
      ? "等待供应商首个响应"
      : call.status === "reasoning"
        ? "模型推理中"
        : call.status === "receiving-output"
          ? call.stage === "knowledgePoints"
            ? "正在接收图谱"
            : "正在接收结构化结果"
          : call.status === "retry-wait"
            ? "等待传输重试"
            : "模型处理中";
  const details = [status];
  if ((call.attempt ?? 1) > 1) details.push(`第 ${call.attempt}/${call.maxAttempts ?? 3} 次尝试`);
  if ((call.queueMs ?? 0) >= 1_000) details.push(`排队 ${Math.ceil(call.queueMs! / 1_000)} 秒`);
  if (call.startedAt) details.push(`已执行 ${Math.max(0, Math.floor((Date.now() - call.startedAt) / 1_000))} 秒`);
  if (call.lastActivityAt) {
    details.push(`最近输出 ${Math.max(0, Math.floor((Date.now() - call.lastActivityAt) / 1_000))} 秒前`);
  }
  if (call.status === "retry-wait" && call.retryAt) {
    details.push(`${Math.max(0, Math.ceil((call.retryAt - Date.now()) / 1_000))} 秒后重试`);
  }
  return details.join("，");
}

function liveDesignArtifact(
  job: DesignJob | null,
  course: Course,
): CourseDesignGenerationArtifact | null {
  if (!job || job.status === "completed") return null;
  const common = {
    summary: job.message || "正在读取本次课程的已确认信息。",
    accent: "blue" as const,
  };
  if (["queued", "base"].includes(job.step)) {
    return {
      id: "new-system-base",
      kind: "facts",
      eyebrow: "课程生成 · 课程定位",
      title: "正在确认课程定位",
      ...common,
      accent: "orange",
      items: [
        { label: "课程", value: course.name || "本次课程" },
        { label: "学习对象", value: course.grade || "正在读取" },
        { label: "教师课时容量", value: `${Math.round(course.hours * 60)} 分钟` },
      ],
    };
  }
  if (["knowledgePoints", "knowledgeReview"].includes(job.step)) {
    return {
      id: "new-system-knowledge",
      kind: "facts",
      eyebrow: "课程生成 · 知识图谱",
      title: job.status === "paused" || job.status === "review_available" ? "知识图谱等待教师确认" : "正在生成知识图谱",
      ...common,
      items: [
        { label: "课程主题", value: course.name || "本次课程" },
        { label: "生成内容", value: "知识点、层级与依赖关系" },
        { label: "下一步", value: job.status === "paused" || job.status === "review_available" ? "教师确认后进入时长规划" : "完成后继续规划讲授时长" },
      ],
    };
  }
  if (["aiDurationPlanning", "capacityReview"].includes(job.step)) {
    return {
      id: "new-system-ai-duration",
      kind: "facts",
      eyebrow: "课程生成 · 时长规划",
      title: job.step === "capacityReview" ? "知识范围与时间存在冲突" : "正在规划知识讲授时长",
      ...common,
      accent: "violet",
      items: [
        { label: "课程容量", value: `${Math.round(course.hours * 60)} 分钟` },
        { label: "规划依据", value: "知识层级、依赖关系与学情" },
        { label: "时间范围", value: course.content.stagePlan ? "采用教师确认的教案时长" : "整课时长的 20%–40%" },
        ...(job.step === "capacityReview" ? [{ label: "处理方式", value: "等待教师决定，不会倒计时继续" }] : []),
      ],
    };
  }
  if (["lessonOutline", "outlineReview"].includes(job.step)) {
    return {
      id: "new-system-pages",
      kind: "facts",
      eyebrow: "课程生成 · 页面大纲",
      title: job.status === "paused" || job.status === "review_available" ? "页面大纲等待教师确认" : "正在编排页面大纲",
      ...common,
      accent: "green",
      items: [
        { label: "知识讲解", value: "按知识小节组织页面" },
        { label: "互动练习", value: "在需要操作与反馈处安排" },
        { label: "学习检测", value: "每个知识小节结束后检查达成" },
      ],
    };
  }
  return null;
}

export function FastCourseGenerator({
  course,
  teacherId,
  onOpenDetailed,
  simplified = false,
}: {
  course: Course;
  teacherId?: string;
  onOpenDetailed: () => void | Promise<void>;
  simplified?: boolean;
}) {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [preparationMode, setPreparationMode] = useState<"resource-package" | "collaborative-preparation">(() => course.content?.preparationSource === "collaborative-preparation" ? "collaborative-preparation" : "resource-package");
  const [hasChosenMode, setHasChosenMode] = useState(false);
  const ideaInputId = useId();
  const [initialIdea, setInitialIdea] = useState("");
  const [initialMessage, setInitialMessage] = useState<string>();
  const uploadInput = useRef<HTMLInputElement>(null);
  const [packageUploadReady, setPackageUploadReady] = useState(false);
  const ideaDraftKey = teacherId ? `openpbl:preparation-message:v1:${encodeURIComponent(teacherId)}:${encodeURIComponent(course.id)}` : "";
  const consumeInitialMessage = useCallback(() => setInitialMessage(undefined), []);
  useEffect(() => {
    if (!ideaDraftKey) return;
    try { const saved = window.sessionStorage.getItem(ideaDraftKey); if (saved) queueMicrotask(() => setInitialIdea(saved)); } catch { /* Browser draft is optional. */ }
  }, [ideaDraftKey]);
  function updateInitialIdea(value: string) {
    setInitialIdea(value);
    if (ideaDraftKey) try { window.sessionStorage.setItem(ideaDraftKey, value); } catch { /* Browser draft is optional. */ }
  }
  const [collaborativeReferences, setCollaborativeReferences] = useState<UploadedKnowledgeReference[]>([]);
  const [collaborativeTextbooks, setCollaborativeTextbooks] = useState<CourseTextbookSelection[]>([]);
  const collaborativeSourcesRestored = useRef(false);
  const modeStorageKey = teacherId ? `openpbl:preparation-mode:v1:${encodeURIComponent(teacherId)}:${encodeURIComponent(course.id)}` : "";
  const modeSettings = useRef<Partial<Record<PreparationMode, CourseGenerationSettings>>>({});
  const [confirmedPackage, setConfirmedPackage] = useState<CourseResourcePackage | null>(null);
  const [hasResourcePackage, setHasResourcePackage] = useState(false);
  const [packageSnapshot, setPackageSnapshot] = useState<ResourcePackageJobSnapshot | null>();
  const [inputStep, setInputStep] = useState(0);
  const lastPackageTransition = useRef("");
  const packageHasContent = useRef(false);
  const [jobLoaded, setJobLoaded] = useState(false);
  const [restoredInputKey, setRestoredInputKey] = useState("");
  const restoredSourceKey = useRef<string | undefined>(undefined);
  const requestHydrated = useRef(false);
  const legacyInput = useRef(false);
  const [generationMode, setGenerationMode] = useState<CourseGenerationMode>("standard");
  const [generationScope, setGenerationScope] = useState<ClassroomGenerationScope>("full-course");
  const [assessmentMode, setAssessmentMode] = useState<AssessmentMode>("adaptive");
  const [job, setJob] = useState<DesignJob | null>(null);
  const [classroomJob, setClassroomJob] = useState<ClassroomGenerationResponse["job"]>(null);
  const [backgroundEnabled, setBackgroundEnabled] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingReference, setUploadingReference] = useState(false);
  const [referenceMaterials, setReferenceMaterials] = useState<UploadedKnowledgeReference[]>([]);
  const [textbookSelections, setTextbookSelections] = useState<CourseTextbookSelection[]>([]);
  const [classroomRetrying, setClassroomRetrying] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [knowledgePreview, setKnowledgePreview] = useState<{
    knowledgePoints: KnowledgePoint[];
    knowledgeGraph: KnowledgeGraph;
    knowledgeScopePlan?: CourseContent["knowledgeScopePlan"];
    courseEvidence?: CourseEvidenceSnapshot;
  }>({ knowledgePoints: [], knowledgeGraph: { nodes: [], edges: [] } });
  const [knowledgeReviewOpen, setKnowledgeReviewOpen] = useState(false);
  const [outlinePreview, setOutlinePreview] = useState<SceneOutline[]>(() => sceneOutlinesForPreview(course.content?._openmaicSceneOutlines));
  const [blueprintPreview, setBlueprintPreview] = useState<TeachingBlueprint | null>(course.content?.teachingBlueprint ?? null);
  const [outlineReviewOpen, setOutlineReviewOpen] = useState(false);
  const [outlineDetailsOpen, setOutlineDetailsOpen] = useState(false);
  const [outlineDetailsRefreshing, setOutlineDetailsRefreshing] = useState(false);
  const [outlineDetailsError, setOutlineDetailsError] = useState<string>();
  const [generationPreview, setGenerationPreview] = useState<{
    classroomId: string;
    loadedScenesCount: number;
    revision: number;
  } | null>(null);
  const [options, setOptions] = useState<GenerationOptions>({
    enableImageGeneration: true,
    enableTTS: true,
    enableVideoGeneration: false,
  });
  const running = job?.status === "queued"
    || job?.status === "running"
    || job?.status === "review_available"
    || job?.status === "paused"
    || job?.status === "cancelling";
  // Existing failed jobs can retry their exact saved request without a new ZIP.
  const savedRequest = job?.requestPreview;
  const legacyResumeAvailable = !hasResourcePackage && Boolean(savedRequest)
    && (job?.status === "failed" || job?.status === "cancelled")
    && !savedRequest?.resourcePackageId
    && !savedRequest?.preparationSessionId
    && brief === (savedRequest?.teacherBrief ?? "")
    && generationMode === (savedRequest?.generationMode ?? "standard")
    && generationScope === (savedRequest?.generationScope ?? "full-course")
    && assessmentMode === (savedRequest?.assessmentMode ?? "adaptive")
    && options.enableImageGeneration === (savedRequest?.options?.enableImageGeneration !== false)
    && options.enableTTS === (savedRequest?.options?.enableTTS !== false)
    && options.enableVideoGeneration === (savedRequest?.options?.enableVideoGeneration === true)
    && JSON.stringify(referenceMaterials.map((item) => item.id).sort()) === JSON.stringify((savedRequest?.referenceMaterials ?? []).map((item) => item.id).sort())
    && JSON.stringify(textbookSelections) === JSON.stringify(savedRequest?.textbookSelections ?? []);

  useEffect(() => {
    if (!jobLoaded || !teacherId) return;
    const settings = { generationMode, generationScope, assessmentMode, options };
    modeSettings.current[preparationMode] = settings;
    try {
      window.localStorage.setItem(courseGenerationSettingsKey(teacherId, course.id, preparationMode), JSON.stringify(settings));
    } catch { /* Settings remain usable when browser storage is unavailable. */ }
  }, [assessmentMode, course.id, generationMode, generationScope, jobLoaded, options, preparationMode, teacherId]);

  const restoreCollaborativeSources = useCallback((references: UploadedKnowledgeReference[], textbooks: CourseTextbookSelection[]) => {
    if (collaborativeSourcesRestored.current) return;
    collaborativeSourcesRestored.current = true;
    setCollaborativeReferences(references);
    setCollaborativeTextbooks(textbooks);
  }, []);
  function changePreparationMode(mode: "resource-package" | "collaborative-preparation") {
    setHasChosenMode(true);
    if (modeStorageKey) try { window.localStorage.setItem(modeStorageKey, mode); } catch { /* Optional browser preference. */ }
    if (mode === preparationMode) return;
    modeSettings.current[preparationMode] = { generationMode, generationScope, assessmentMode, options };
    const settings = modeSettings.current[mode];
    setGenerationMode(settings?.generationMode ?? "standard");
    setGenerationScope(settings?.generationScope ?? "full-course");
    setAssessmentMode(settings?.assessmentMode ?? "adaptive");
    setOptions(settings?.options ?? { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false });
    setPreparationMode(mode);
  }

  const handlePackageSnapshot = useCallback((next: ResourcePackageJobSnapshot | null) => {
    setPackageSnapshot(next);
    const pack = next?.package;
    packageHasContent.current = Boolean(pack);
    const transition = `${next?.id ?? "none"}:${next?.status ?? "none"}:${pack?.id ?? ""}:${pack?.revision ?? ""}:${pack?.confirmedAt ?? ""}`;
    if (lastPackageTransition.current !== transition) {
      lastPackageTransition.current = transition;
      setInputStep(pack?.confirmedAt && next?.status === "ready" ? 2 : pack && ["ready", "blocked"].includes(next?.status ?? "") ? 1 : !next && legacyInput.current ? 2 : 0);
    }
  }, []);
  const handleConfirmedPackage = useCallback((pack: CourseResourcePackage | null) => {
    setConfirmedPackage(pack);
    if (!pack && packageHasContent.current) setInputStep((current) => current === 2 ? 1 : current);
  }, []);

  const inputStorageKey = teacherId ? courseGenerationDraftKey(teacherId, course.id) : "";
  const sourceKey = packageSnapshot?.package ? `${packageSnapshot.package.id}:${packageSnapshot.package.revision}` : "legacy";
  const inputIdentity = `${inputStorageKey}:${sourceKey}:${job?.id ?? "new"}`;
  useEffect(() => {
    if (preparationMode !== "resource-package" || !inputStorageKey || !jobLoaded || packageSnapshot === undefined || restoredInputKey === inputIdentity) return;
    const editable = !running && job?.status !== "completed";
    // A local confirmation advances the same package's revision. Keep the live
    // teacher input and bind it to that revision; only a different package (or
    // teacher/course) replaces the source. Fresh mounts still require an exact
    // revision match before restoring a browser draft.
    const scopeKey = `${inputStorageKey}:${packageSnapshot?.package?.id ?? "legacy"}`;
    const sameActiveSource = restoredSourceKey.current === scopeKey;
    let saved: CourseGenerationInputDraft | null = null;
    try { if (editable && !sameActiveSource) saved = readCourseGenerationDraft(window.sessionStorage, inputStorageKey, sourceKey, job?.id ?? null); } catch { /* Storage may be disabled by the browser. */ }
    const sourceReplaced = restoredSourceKey.current !== undefined && !sameActiveSource;
    queueMicrotask(() => {
      if (editable && (saved || sourceReplaced)) {
        setBrief(saved?.brief ?? "");
        setGenerationMode(saved?.generationMode ?? "standard");
        setGenerationScope(saved?.generationScope ?? "full-course");
        setAssessmentMode(saved?.assessmentMode ?? "adaptive");
        setOptions(saved?.options ?? { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false });
        setReferenceMaterials(saved?.referenceMaterials ?? []);
        setTextbookSelections(saved?.textbookSelections ?? []);
      }
      restoredSourceKey.current = scopeKey;
      setRestoredInputKey(inputIdentity);
    });
  }, [inputIdentity, inputStorageKey, job?.id, job?.status, jobLoaded, packageSnapshot, preparationMode, restoredInputKey, running, sourceKey]);

  useEffect(() => {
    if (preparationMode !== "resource-package" || !inputStorageKey || restoredInputKey !== inputIdentity || running || job?.status === "completed") return;
    const saved: CourseGenerationInputDraft = { sourceKey, jobId: job?.id ?? null, brief, generationMode, generationScope, assessmentMode, options, referenceMaterials, textbookSelections };
    try { window.sessionStorage.setItem(inputStorageKey, JSON.stringify(saved)); } catch { /* Input remains usable when session storage is unavailable. */ }
  }, [assessmentMode, brief, generationMode, generationScope, inputIdentity, inputStorageKey, job?.id, job?.status, options, preparationMode, referenceMaterials, restoredInputKey, running, sourceKey, textbookSelections]);

  const applyPayload = useCallback((payload: ResponsePayload) => {
    setBackgroundEnabled(payload.backgroundEnabled);
    setJob(payload.job);
    setJobLoaded(true);
    if (!requestHydrated.current) {
      requestHydrated.current = true;
      const request = payload.job?.requestPreview;
      const requestMode: PreparationMode = request?.preparationSessionId ? "collaborative-preparation" : "resource-package";
      let remembered: string | null = null;
      try {
        remembered = modeStorageKey ? window.localStorage.getItem(modeStorageKey) ?? window.sessionStorage.getItem(modeStorageKey) : null;
        if (teacherId) for (const mode of ["resource-package", "collaborative-preparation"] as const) {
          const stored = readCourseGenerationSettings(window.localStorage, courseGenerationSettingsKey(teacherId, course.id, mode));
          if (stored) modeSettings.current[mode] = stored;
        }
      } catch { /* Optional browser preferences. */ }
      // A persisted course source takes precedence over an old browser preference
      // or a retained generation task from the other preparation mode.
      const activeMode: PreparationMode = course.content?.preparationSource
        ?? (request ? requestMode : remembered === "collaborative-preparation" ? "collaborative-preparation" : "resource-package");
      if (remembered === "resource-package" || remembered === "collaborative-preparation") setHasChosenMode(true);
      if (request) {
        const requestSettings: CourseGenerationSettings = {
          generationMode: request.generationMode ?? "standard",
          generationScope: request.generationScope ?? "full-course",
          assessmentMode: request.assessmentMode ?? "adaptive",
          options: {
            enableImageGeneration: request.options?.enableImageGeneration !== false,
            enableTTS: request.options?.enableTTS !== false,
            enableVideoGeneration: request.options?.enableVideoGeneration === true,
          },
        };
        const requestInProgress = payload.job && !["failed", "cancelled"].includes(payload.job.status);
        if (requestInProgress || !modeSettings.current[requestMode]) modeSettings.current[requestMode] = requestSettings;
      }
      const settings = modeSettings.current[activeMode];
      setPreparationMode(activeMode);
      setGenerationMode(settings?.generationMode ?? "standard");
      setGenerationScope(settings?.generationScope ?? "full-course");
      setAssessmentMode(settings?.assessmentMode ?? "adaptive");
      setOptions(settings?.options ?? { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false });
      if (payload.job?.requestPreview && !payload.job.requestPreview.preparationSessionId && !payload.job.requestPreview.resourcePackageId && ["failed", "cancelled"].includes(payload.job.status)) {
        legacyInput.current = true;
        setInputStep(2);
      }
      const savedBrief = payload.job?.requestPreview?.teacherBrief;
      if (savedBrief && !payload.job?.requestPreview?.preparationSessionId) setBrief(savedBrief);
      const savedReferences = payload.job?.requestPreview?.referenceMaterials;
      if (payload.job?.requestPreview?.preparationSessionId) {
        setCollaborativeReferences(savedReferences ?? []);
        setCollaborativeTextbooks(payload.job.requestPreview.textbookSelections ?? []);
      } else {
        if (savedReferences?.length) setReferenceMaterials((current) => current.length > 0 ? current : savedReferences);
        if (payload.job?.requestPreview?.textbookSelections?.length) setTextbookSelections((current) => current.length ? current : payload.job!.requestPreview!.textbookSelections!);
      }
    }
    if (payload.knowledgePreview) setKnowledgePreview(payload.knowledgePreview);
    if (payload.outlinePreview) setOutlinePreview(sceneOutlinesForPreview(payload.outlinePreview));
    if (payload.blueprintPreview !== undefined) setBlueprintPreview(payload.blueprintPreview);
    if (payload.job?.status === "failed") {
      setError(`${payload.job.error || "快速生成遇到系统或网络错误，请稍后重试。"} 首稿、教师要求和已完成内容均已保存。可继续已保存首稿，或修改要求后主动重生成失败阶段。`);
    } else if (payload.job && ["queued", "running", "review_available", "paused", "completed"].includes(payload.job.status)) {
      // Clear the previous failure only after the durable task has resumed.
      setError(undefined);
    }
    if (payload.job?.status === "cancelled") setError("本次快速生成已中断，可以修改要求后重新开始。");
  }, [course.content?.preparationSource, course.id, modeStorageKey, teacherId]);

  const fetchJobPayload = useCallback(async () => {
    const response = await fetch(`/api/courses/${course.id}/design-generation`, { cache: "no-store" });
    const payload = await readJsonResponse<ResponsePayload>(response, "快速生成服务没有返回内容，请刷新页面后重试。");
    if (!response.ok) throw new Error(payload.detail || payload.error || "无法读取快速生成状态");
    return payload;
  }, [course.id]);

  const fetchJob = useCallback(async () => {
    const payload = await fetchJobPayload();
    applyPayload(payload);
    return payload;
  }, [applyPayload, fetchJobPayload]);

  const fetchClassroomJob = useCallback(async (startPersistedJob = false) => {
    const response = await fetch(`/api/courses/${course.id}/generation`, startPersistedJob
      ? {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "start-persisted-job" }),
        }
      : { cache: "no-store" });
    const payload = await readJsonResponse<ClassroomGenerationResponse>(response, "无法读取最终课程生成进度，请稍后重试。");
    if (!response.ok) throw new Error(payload.error || "无法读取最终课程生成进度");
    setBackgroundEnabled(payload.backgroundEnabled);
    setClassroomJob(payload.job);
    if (payload.job?.status === "failed") setError(payload.job.error || "最终课程内容生成未完成，请重试。");
    else if (payload.job?.status === "cancelled") setError("本次最终课程内容生成已中断，可以返回后重新生成。");
    else if (payload.job) setError(undefined);
    return payload;
  }, [course.id]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchJob().catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法读取快速生成状态");
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fetchJob]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void fetchJob().catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [fetchJob, running]);

  useEffect(() => {
    if (job?.status !== "completed") return;
    let cancelled = false;
    const continueGeneration = async () => {
      try {
        let payload = await fetchClassroomJob(false);
        if (!cancelled && payload.job?.status === "queued" && !payload.backgroundEnabled) {
          payload = await fetchClassroomJob(true);
        }
        if (!cancelled && !payload.job) setError("课程设计已经完成，但没有找到后续课堂生成任务。");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法继续生成最终课程内容");
      }
    };
    void continueGeneration();
    return () => { cancelled = true; };
  }, [fetchClassroomJob, job?.status]);

  const classroomRunning = job?.status === "completed" && (classroomJob?.status === "queued"
    || classroomJob?.status === "running"
    || classroomJob?.status === "cancelling");
  useEffect(() => {
    if (!classroomRunning) return;
    const timer = window.setInterval(() => void fetchClassroomJob(false).catch(() => undefined), 2_000);
    return () => window.clearInterval(timer);
  }, [classroomRunning, fetchClassroomJob]);

  useEffect(() => {
    if (!confirmCancel) return;
    const timer = window.setTimeout(() => setConfirmCancel(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirmCancel]);

  async function start(preparation?: ConfirmedPreparation) {
    if (!preparation && !confirmedPackage?.confirmedAt && !legacyResumeAvailable) {
      setError("请先上传资源包并确认教学要求。");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/courses/${course.id}/design-generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teacherBrief: preparation ? "" : brief,
          ...(preparation ? { preparationSessionId: preparation.sessionId, preparationRevision: preparation.revision } : confirmedPackage?.confirmedAt ? {
            supplementalAnswers: { brief },
            resourcePackageId: confirmedPackage.id,
            resourcePackageRevision: confirmedPackage.revision,
          } : {}),
          generationMode,
          generationScope,
          assessmentMode,
          options,
          referenceIds: preparation?.referenceIds ?? referenceMaterials.map((material) => material.id),
          textbookSelections: preparation?.textbookSelections ?? textbookSelections,
        }),
      });
      const payload = await readJsonResponse<ResponsePayload>(
        response,
        "快速生成服务没有返回内容。请确认数据库迁移已完成，然后重试。",
      );
      if (!response.ok) throw new Error(payload.detail || payload.error || "无法启动快速生成");
      if (!preparation && inputStorageKey) try { window.sessionStorage.removeItem(inputStorageKey); } catch { /* Optional draft storage. */ }
      applyPayload(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法启动快速生成");
    } finally {
      setSubmitting(false);
    }
  }

  async function resumeSavedFirstDraft() {
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/courses/${course.id}/design-generation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resume-saved-first-draft" }),
      });
      const payload = await readJsonResponse<ResponsePayload>(response, "未收到继续生成的响应，请稍后查看任务状态。");
      if (!response.ok) throw new Error(payload.detail || payload.error || "已保存首稿暂时无法继续生成");
      applyPayload(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "已保存首稿暂时无法继续生成");
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadKnowledgeReferences(files: readonly File[]) {
    const collaborative = preparationMode === "collaborative-preparation";
    const setReferences = collaborative ? setCollaborativeReferences : setReferenceMaterials;
    const available = MAX_GENERATION_REFERENCE_FILES - (collaborative ? collaborativeReferences : referenceMaterials).length;
    if (collaborative) collaborativeSourcesRestored.current = true;
    if (available <= 0) {
      setError(`最多上传 ${MAX_GENERATION_REFERENCE_FILES} 份知识资料。`);
      return;
    }
    const selected = files.slice(0, available);
    setUploadingReference(true);
    setError(undefined);
    try {
      for (const file of selected) {
        const form = new FormData();
        form.append("file", file);
        form.append("courseId", course.id);
        form.append("purpose", "generation-reference");
        const response = await fetch("/api/uploads", { method: "POST", body: form });
        const payload = await readJsonResponse<UploadedKnowledgeReference & { message?: string; error?: string }>(
          response,
          "知识资料上传后没有收到响应，请重试。",
        );
        if (!response.ok || !payload.id || !payload.fileName) {
          throw new Error(payload.message || payload.error || `无法上传“${file.name}”`);
        }
        setReferences((current) => current.some((item) => item.id === payload.id)
          ? current
          : [...current, payload]);
      }
      if (files.length > selected.length) {
        setError(`最多上传 ${MAX_GENERATION_REFERENCE_FILES} 份知识资料，其余文件未上传。`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "知识资料上传失败，请重试。");
    } finally {
      setUploadingReference(false);
    }
  }

  async function removeKnowledgeReference(material: UploadedKnowledgeReference) {
    setError(undefined);
    if (preparationMode === "collaborative-preparation") {
      // Submitted discussion revisions may still reference this source. Remove
      // the current selection without deleting a historical source asset.
      collaborativeSourcesRestored.current = true;
      setCollaborativeReferences((current) => current.filter((item) => item.id !== material.id));
      return;
    }
    try {
      const response = await fetch(`/api/uploads/${material.id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`无法移除“${material.fileName}”`);
      setReferenceMaterials((current) => current.filter((item) => item.id !== material.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法移除知识资料，请重试。");
    }
  }

  async function cancelGeneration() {
    if (!confirmCancel) {
      setConfirmCancel(true);
      return;
    }
    setConfirmCancel(false);
    try {
      if (job?.status === "completed" && classroomJob && classroomJob.status !== "completed") {
        const response = await fetch(`/api/courses/${course.id}/generation`, { method: "DELETE" });
        const payload = await readJsonResponse<ClassroomGenerationResponse>(response, "中断请求没有得到响应，请稍后重试。");
        if (!response.ok) throw new Error(payload.error || "无法中断最终课程生成");
        setClassroomJob(payload.job);
      } else {
        const response = await fetch(`/api/courses/${course.id}/design-generation`, { method: "DELETE" });
        const payload = await readJsonResponse<ResponsePayload>(response, "中断请求没有得到响应，请稍后重试。");
        if (!response.ok) throw new Error(payload.detail || payload.error || "无法中断生成");
        applyPayload(payload);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法中断生成");
    }
  }

  async function resumeClassroomGeneration() {
    setClassroomRetrying(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/courses/${course.id}/generation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regenerate-failed-stages" }),
      });
      const payload = await readJsonResponse<ClassroomGenerationResponse>(response, "续生成请求没有得到响应，请稍后重试。");
      if (!response.ok) throw new Error(payload.detail || payload.error || "无法从已完成页面继续生成");
      setBackgroundEnabled(payload.backgroundEnabled);
      setClassroomJob(payload.job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法从已完成页面继续生成");
    } finally {
      setClassroomRetrying(false);
    }
  }

  async function reviewArtifact() {
    try {
      if (job?.status === "review_available") {
        const response = await fetch(`/api/courses/${course.id}/design-generation`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "pause" }),
        });
        const payload = await readJsonResponse<ResponsePayload>(response, "暂停请求没有得到响应，请稍后重试。");
        if (!response.ok) throw new Error(payload.detail || payload.error || "无法暂停生成");
        applyPayload(payload);
      }
      const latest = await fetchJob();
      if (latest.job?.status !== "review_available" && latest.job?.status !== "paused") {
        throw new Error("确认窗口已结束，任务正在自动继续。请查看当前生成进度。");
      }
      if (latest.job?.reviewKind === "knowledge") {
        setKnowledgePreview(latest.knowledgePreview ?? {
          knowledgePoints: [],
          knowledgeGraph: { nodes: [], edges: [] },
        });
        setKnowledgeReviewOpen(true);
      } else if (latest.job?.reviewKind === "capacity") {
        const accepted = window.confirm(`${latest.job.message}\n\n选择“确定”表示按当前知识范围与时长继续；选择“取消”会保持暂停，便于先调整课程资料或时间。`);
        if (accepted) await resumeAfterCapacityReview();
      } else {
        setOutlinePreview(sceneOutlinesForPreview(latest.outlinePreview));
        setOutlineReviewOpen(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开待确认内容");
    }
  }

  async function viewOutlineDetails() {
    setOutlineDetailsOpen(true);
    setOutlineDetailsRefreshing(true);
    setOutlineDetailsError(undefined);
    try {
      const payload = await fetchJobPayload();
      if (payload.outlinePreview) setOutlinePreview(sceneOutlinesForPreview(payload.outlinePreview));
      if (payload.blueprintPreview !== undefined) setBlueprintPreview(payload.blueprintPreview);
    } catch (cause) {
      setOutlineDetailsError(cause instanceof Error ? cause.message : "最新课程设计读取失败，已保存的详情仍可查看。");
    } finally {
      setOutlineDetailsRefreshing(false);
    }
  }

  async function resumeAfterCapacityReview() {
    setError(undefined);
    const response = await fetch(`/api/courses/${course.id}/design-generation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", reviewKind: "capacity" }),
    });
    const payload = await readJsonResponse<ResponsePayload>(response, "保存容量决定后未收到响应，请稍后重试。");
    if (!response.ok) throw new Error(payload.detail || payload.error || "无法按当前范围与时长继续生成");
    applyPayload(payload);
  }

  async function resumeAfterKnowledgeReview(
    knowledgePoints: KnowledgePoint[],
    knowledgeGraph: KnowledgeGraph,
  ) {
    setError(undefined);
    const response = await fetch(`/api/courses/${course.id}/design-generation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "resume",
        reviewKind: "knowledge",
        knowledgePoints,
        knowledgeGraph,
      }),
    });
    const payload = await readJsonResponse<ResponsePayload>(response, "保存知识图谱后未收到响应，请稍后重试。");
    if (!response.ok) throw new Error(payload.detail || payload.error || "无法保存知识图谱并继续生成");
    setKnowledgePreview({ knowledgePoints, knowledgeGraph });
    setKnowledgeReviewOpen(false);
    applyPayload(payload);
  }

  async function resumeAfterOutlineReview(outlines: SceneOutline[], testSectionId?: string) {
    setError(undefined);
    const response = await fetch(`/api/courses/${course.id}/design-generation`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume", reviewKind: "outline", sceneOutlines: outlines, testSectionId }),
    });
    const payload = await readJsonResponse<ResponsePayload>(response, "保存大纲后未收到响应，请稍后重试。");
    if (!response.ok) throw new Error(payload.detail || payload.error || "无法保存大纲并继续生成");
    if (payload.job?.reviewStatus !== "approved"
      || !["queued", "running", "completed"].includes(payload.job.status)) {
      throw new Error("大纲未被采用，确认窗口可能已结束。请返回生成进度查看最新状态。");
    }
    setOutlinePreview(outlines);
    setOutlineReviewOpen(false);
    applyPayload(payload);
  }

  const artifacts = useMemo<CourseDesignGenerationArtifact[]>(() => {
    const seen = new Set<string>();
    const completedArtifacts = (job?.trace ?? []).flatMap((entry) => entry.artifacts ?? []).filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
    const liveArtifact = liveDesignArtifact(job, course);
    if (liveArtifact && !seen.has(liveArtifact.id)) completedArtifacts.push(liveArtifact);
    return completedArtifacts;
  }, [course, job]);

  const combinedArtifacts = useMemo(
    () => [...artifacts, ...buildQuickClassroomArtifacts(classroomJob, { aiLearningOnly: simplified })],
    [artifacts, classroomJob, simplified],
  );

  const classroomCompleted = classroomJob?.status === "completed" && Boolean(classroomJob.result?.id);
  const classroomFailed = job?.status === "completed" && classroomJob?.status === "failed";
  const designRecovering = isGenerationHeartbeatStale(job);
  const classroomRecovering = isGenerationHeartbeatStale(classroomJob);
  const recovering = job?.status === "completed" ? classroomRecovering : designRecovering;
  const overallProgress = job?.status === "completed"
    ? combineQuickGenerationProgress(100, classroomJob?.progress ?? 0, classroomCompleted)
    : combineQuickGenerationProgress(job?.progress ?? 0, 0, false);
  const activeArtifactId = job?.status === "completed"
    ? resolveQuickClassroomActiveArtifactId(classroomJob, { aiLearningOnly: simplified })
    : resolveLatestCompletedArtifactId(artifacts);
  const activeMessage = recovering
    ? "正在自动恢复"
    : job?.status === "completed"
    ? classroomJob?.activePages?.length
      ? classroomJob.activePages
          .map((page) => `第 ${page.index} 页：${page.title}（${CLASSROOM_PAGE_STAGE_LABELS[page.stage] ?? page.stage}${pageRuntimeLabel(page)}）`)
          .join("；")
      : classroomJob?.message || "课程设计已完成，正在衔接课堂内容生成"
    : job?.currentCall
      ? `${job.message || "正在分析课程信息"}（${designCallLabel(job.currentCall)}）`
      : job?.message || "正在分析课程信息";
  const scopedActiveMessage = generationScope === "test-lesson"
    ? `测试模式（正式链路 · 单个完整知识小节）：${activeMessage}`
    : activeMessage;
  const activeRemaining = job?.status === "completed"
    ? classroomJob?.estimatedRemainingSeconds
    : job?.estimatedRemainingSeconds;
  const activeStartedAt = job?.status === "completed"
    ? classroomJob?.startedAt ?? job.startedAt ?? null
    : job?.startedAt ?? null;
  const tokenUsage = Math.max(0, job?.tokenUsage?.totalTokens ?? 0)
    + Math.max(0, classroomJob?.tokenUsage?.totalTokens ?? 0);
  const showGenerationCanvas = running || job?.status === "completed" || classroomRunning || classroomCompleted;
  const outlineDetailsAvailable = outlinePreview.length > 0 || Boolean(blueprintPreview?.sections.length);

  const outlineDetailsDialog = (
    <AnimatePresence>
      {outlineDetailsOpen ? (
        <QuickOutlineReviewDialog
          blueprint={blueprintPreview}
          initialOutlines={outlinePreview}
          onClose={() => setOutlineDetailsOpen(false)}
          readOnly
          refreshing={outlineDetailsRefreshing}
          refreshError={outlineDetailsError}
        />
      ) : null}
    </AnimatePresence>
  );

  if (showGenerationCanvas) {
    return (
      <LayoutGroup id={`quick-generation-${course.id}`}>
      <QuickGenerationStage
        activeArtifactId={activeArtifactId}
        artifacts={combinedArtifacts}
        backgroundEnabled={backgroundEnabled}
        brief={job?.requestPreview?.teacherBrief || brief}
        cancelling={job?.status === "cancelling" || classroomJob?.status === "cancelling"}
        confirmCancel={confirmCancel}
        completed={classroomCompleted}
        failed={classroomFailed}
        failureMessage={classroomJob?.error || error}
        message={scopedActiveMessage}
        onCancel={() => void cancelGeneration()}
        onLeave={() => router.push("/teacher/templates")}
        onOpenCourse={() => {
          if (classroomJob?.result?.id) router.push(`/teacher/prepare/${encodeURIComponent(course.id)}/preview?view=overview&classroomId=${encodeURIComponent(classroomJob.result.id)}`);
        }}
        onPreviewGenerated={() => {
          if (!classroomJob?.preview) return;
          setGenerationPreview({
            classroomId: classroomJob.preview.classroomId,
            loadedScenesCount: classroomJob.preview.scenesCount,
            revision: 0,
          });
        }}
        onRetry={() => void resumeClassroomGeneration()}
        onReview={() => void reviewArtifact()}
        onViewOutline={() => void viewOutlineDetails()}
        outlineDetailsAvailable={outlineDetailsAvailable}
        paused={job?.status === "paused"}
        progress={overallProgress}
        previewScenesCount={classroomJob?.preview?.scenesCount ?? 0}
        recovering={recovering}
        remainingLabel={classroomCompleted
          ? generationScope === "test-lesson"
            ? "测试小节已经由正式课堂链路生成并自动保存；发布前仍需生成完整课程"
            : "全部内容已经生成并自动保存"
          : classroomFailed ? "首稿及已完成页面均已保存，可主动重生成失败阶段" : recovering ? "正在重新连接后台生成任务" : formatDuration(activeRemaining)}
        retrying={classroomRetrying}
        reviewAvailable={job?.status === "review_available" || job?.status === "paused"}
        reviewAvailableUntil={job?.reviewAvailableUntil ?? null}
        reviewKind={job?.reviewKind ?? null}
        testMode={generationScope === "test-lesson"}
        startedAt={activeStartedAt}
        tokenUsage={tokenUsage}
      />
      <AnimatePresence>
        {knowledgeReviewOpen ? (
          <QuickKnowledgeReviewDialog
            courseEvidence={knowledgePreview.courseEvidence ?? course.content.courseEvidence}
            initialKnowledgeGraph={knowledgePreview.knowledgeGraph}
            initialKnowledgePoints={knowledgePreview.knowledgePoints}
            knowledgeScopePlan={knowledgePreview.knowledgeScopePlan ?? course.content.knowledgeScopePlan}
            onClose={() => setKnowledgeReviewOpen(false)}
            onConfirm={resumeAfterKnowledgeReview}
          />
        ) : null}
        {outlineReviewOpen ? (
          <QuickOutlineReviewDialog
            blueprint={blueprintPreview}
            initialOutlines={outlinePreview}
            testMode={generationScope === "test-lesson"}
            onClose={() => setOutlineReviewOpen(false)}
            onConfirm={resumeAfterOutlineReview}
          />
        ) : null}
      </AnimatePresence>
      {outlineDetailsDialog}
      {generationPreview ? (
        <GenerationCheckpointPreview
          availableScenesCount={classroomJob?.preview?.scenesCount ?? generationPreview.loadedScenesCount}
          course={course}
          preview={generationPreview}
          lifecycleKey={`${classroomJob?.id ?? ''}:${classroomJob?.status ?? ''}`}
          onClose={() => setGenerationPreview(null)}
        />
      ) : null}
      </LayoutGroup>
    );
  }

  const packageGenerationSettings = (
        <details className="rounded-xl border border-slate-200 bg-white px-5 py-3 sm:px-6">
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-slate-900">生成设置<span className="ml-2 font-normal text-slate-500">{generationScope === "test-lesson" ? "测试一节" : "完整课程"} · {assessmentMode === "constructed-response" ? "综合简答" : "普通检测"} · {generationMode === "deep-interaction" ? "深度交互" : "普通交互"}</span></summary>
          <fieldset className="space-y-5 border-t border-slate-100 py-4" disabled={submitting}>
            <div role="group" aria-label="生成内容选项" className="flex flex-wrap gap-3">
              <OptionToggle active={options.enableImageGeneration} description="为适合的课堂页面生成配图" icon={ImageIcon} label="图片" onClick={() => setOptions((current) => ({ ...current, enableImageGeneration: !current.enableImageGeneration }))} />
              <OptionToggle active={options.enableTTS} description="为授课内容生成中文语音" icon={Volume2} label="语音" onClick={() => setOptions((current) => ({ ...current, enableTTS: !current.enableTTS }))} />
              <OptionToggle active={options.enableVideoGeneration} description="在适合的页面尝试生成视频资源" icon={Video} label="视频" onClick={() => setOptions((current) => ({ ...current, enableVideoGeneration: !current.enableVideoGeneration }))} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <GenerationModeButton active={generationScope === "test-lesson"} ariaLabel={generationScope === "test-lesson" ? "关闭测试模式，生成完整课程" : "开启单节测试模式"} icon={FlaskConical} label="测试一节" description="先生成完整设计，再选择一节试用；测试结果不能直接发布。" onClick={() => setGenerationScope((current) => current === "test-lesson" ? "full-course" : "test-lesson")} />
              <GenerationModeButton active={assessmentMode === "constructed-response"} ariaLabel={assessmentMode === "constructed-response" ? "关闭深度作答，使用普通检测" : "开启深度作答模式"} icon={PenLine} label="深度作答" description="每小节用一道综合简答题检测理解；默认使用多种客观题。" onClick={() => setAssessmentMode((current) => current === "constructed-response" ? "adaptive" : "constructed-response")} />
              <GenerationModeButton active={generationMode === "deep-interaction"} ariaLabel={generationMode === "deep-interaction" ? "关闭深度交互，使用普通模式" : "开启深度交互模式"} icon={Sparkles} label="深度交互" description="在适合的知识点安排模拟、编程与探索。" onClick={() => setGenerationMode((current) => current === "deep-interaction" ? "standard" : "deep-interaction")} />
            </div>
          </fieldset>
        </details>
  );

  const generationSettings = preparationMode === "resource-package" ? packageGenerationSettings : (
    <section aria-label="生成设置" className={styles.generationSettings}>
      <header><h2>课程生成设置</h2><p>选择生成范围与课堂形式，确认后按以下设置生成。</p><span>{generationScope === "test-lesson" ? "测试一节" : "完整课程"} · {assessmentMode === "constructed-response" ? "综合简答" : "普通检测"} · {generationMode === "deep-interaction" ? "深度交互" : "普通交互"}</span></header>
      <div className={styles.settingGroups}>
        <GenerationChoiceGroup label="生成范围" value={generationScope} onChange={setGenerationScope} disabled={submitting} choices={[
          { value: "full-course", label: "完整课程", description: "生成全部知识讲授内容，完成检查后可发布。" },
          { value: "test-lesson", label: "单节测试", description: "先生成完整设计，再选择一节试用；测试结果不能直接发布。" },
        ]} />
        <GenerationChoiceGroup label="课堂检测" value={assessmentMode} onChange={setAssessmentMode} disabled={submitting} choices={[
          { value: "adaptive", label: "普通检测", description: "每小节用多种客观题检查学生理解。" },
          { value: "constructed-response", label: "综合简答", description: "每小节用一道综合简答题，引导学生解释思路。" },
        ]} />
        <GenerationChoiceGroup label="交互方式" value={generationMode} onChange={setGenerationMode} disabled={submitting} choices={[
          { value: "standard", label: "普通交互", description: "通过讲解与练习推进知识学习。" },
          { value: "deep-interaction", label: "深度交互", description: "在适合的知识点安排模拟、编程与探索。" },
        ]} />
      </div>
      <fieldset className={styles.mediaSettings} disabled={submitting}>
        <legend>生成资源</legend><p>按课堂需要开启或关闭，蓝色表示已开启。</p>
        <div role="group" aria-label="生成内容选项">
          <OptionToggle active={options.enableImageGeneration} description="为适合的课堂页面生成配图" icon={ImageIcon} label="图片" showState onClick={() => setOptions((current) => ({ ...current, enableImageGeneration: !current.enableImageGeneration }))} />
          <OptionToggle active={options.enableTTS} description="为授课内容生成中文语音" icon={Volume2} label="语音" showState onClick={() => setOptions((current) => ({ ...current, enableTTS: !current.enableTTS }))} />
          <OptionToggle active={options.enableVideoGeneration} description="在适合的页面尝试生成视频资源" icon={Video} label="视频" showState onClick={() => setOptions((current) => ({ ...current, enableVideoGeneration: !current.enableVideoGeneration }))} />
        </div>
      </fieldset>
    </section>
  );

  const modeChosen = hasChosenMode || Boolean(course.content?.preparationSource || course.content?.resourcePackage || packageSnapshot || job || outlineDetailsAvailable);

  return (
    <section className="mx-auto w-full max-w-[1120px] px-4 py-6 sm:px-6 sm:py-8">
      <header className={styles.header} data-expanded={!modeChosen}>
        <div className={styles.introduction}>
          <h1>{modeChosen ? preparationMode === "collaborative-preparation" ? "AI 协同备课" : "准备课程资料" : "选择备课方式"}</h1>
          {!modeChosen && <p>从已有资料开始，或与 AI 一起推敲教学想法。</p>}
        </div>
        {!jobLoaded && !error && !modeChosen ? <p role="status" className="text-sm text-slate-500">正在读取备课方式…</p> : <div role="group" aria-label="备课模式" className={styles.modes} data-expanded={!modeChosen}>
          {modeChosen ? <>
            <button type="button" aria-label="导入交接包" aria-pressed={preparationMode === "resource-package"} disabled={submitting || uploadingReference || (!jobLoaded && !error)} className={styles.modeButton} onClick={() => changePreparationMode("resource-package")}><FileText className={styles.modeIcon} aria-hidden="true" /><strong>导入交接包</strong></button>
            <button type="button" aria-label="AI 协同备课" aria-pressed={preparationMode === "collaborative-preparation"} disabled={submitting || uploadingReference || (!jobLoaded && !error)} className={styles.modeButton} onClick={() => changePreparationMode("collaborative-preparation")}><Sparkles className={styles.modeIcon} aria-hidden="true" /><strong>AI 协同备课</strong></button>
          </> : <>
            <section aria-label="导入交接包" className={styles.entryCard}>
              <div className={styles.entryHeading}><span><FileText aria-hidden="true" /></span><div><h2>导入交接包</h2><p>已有课程资料，从这里开始</p></div></div>
              <p className={styles.entryDescription}>把整理好的教案与知识资料交给系统，核对解析结果后即可生成课程。</p>
              <div className={styles.packageContents}><h3>一个 ZIP，带上课程资料</h3><ul><li><Check aria-hidden="true" />知识点文档</li><li><Check aria-hidden="true" />完整教案</li><li><Check aria-hidden="true" />项目启动课件</li></ul><p>支持 ZIP 格式，最大 50 MiB。</p></div>
              <div className={styles.entryAction}><button type="button" className={styles.entryPrimary} disabled={!packageUploadReady || submitting} onClick={() => uploadInput.current?.click()}><Paperclip aria-hidden="true" />选择交接包<ArrowRight aria-hidden="true" /></button><div className={styles.entryFoot}><p>选择文件后自动上传并解析。</p><button type="button" onClick={() => changePreparationMode("resource-package")}>查看导入说明</button></div></div>
            </section>
            <section aria-label="AI 协同备课" className={styles.entryCard}>
              <div className={styles.entryHeading}><span><Sparkles aria-hidden="true" /></span><div><h2>AI 协同备课</h2><p>从一个教学想法开始</p></div></div>
              <p className={styles.entryDescription}>先说说想教什么，AI 会与你逐步讨论目标、活动和评价，共同形成课程方案。</p>
              <form className={styles.ideaForm} onSubmit={(event) => { event.preventDefault(); if (!initialIdea.trim() || submitting) return; setInitialMessage(initialIdea.trim()); changePreparationMode("collaborative-preparation"); }}>
                <label htmlFor={ideaInputId}>这次想和学生一起学什么？</label>
                <textarea id={ideaInputId} aria-label="课程想法" maxLength={12000} value={initialIdea} onChange={(event) => updateInitialIdea(event.target.value)} placeholder="例如：给初一学生上一节 45 分钟的课，让他们用校园用水数据理解平均数，最后提出节水建议。" />
                <div className={styles.entryAction}><button type="submit" className={styles.entryPrimary} disabled={!initialIdea.trim() || submitting}><Sparkles aria-hidden="true" />开始协同备课<ArrowRight aria-hidden="true" /></button><p>不必写完整教案，之后可以继续补充资料。</p></div>
              </form>
            </section>
          </>}
        </div>}
        {!simplified ? <button className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm" onClick={() => void onOpenDetailed()} type="button"><Settings2 className="mr-2 inline size-4" />课程设计</button> : null}
      </header>
      {/* Keep package recovery mounted while the teacher chooses a starting point. */}
      <div hidden={!modeChosen}>
      {preparationMode === "collaborative-preparation" && savedRequest?.preparationSessionId && job?.status === "failed" && job.stepIndex === 2 ? <section aria-label="恢复已保存的课程生成" className="mb-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] p-5">
        <div><h2 className="font-semibold text-slate-900">课程首稿已保存</h2><p className="mt-1 text-sm leading-6 text-slate-600">沿用本次已确认方案，继续处理已保存的首稿。需要调整教学方案时，也可以在下方继续讨论并重新确认。</p></div>
        <button className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--pbl-teacher-border)] bg-white px-4 text-sm font-semibold text-[var(--pbl-teacher)]" disabled={submitting || uploadingReference} onClick={() => void resumeSavedFirstDraft()} type="button">继续已保存首稿</button>
      </section> : null}
      {preparationMode === "collaborative-preparation" ? <CollaborativePreparation key={`${teacherId ?? "teacher"}:${course.id}`} courseId={course.id} teacherId={teacherId} disabled={submitting || uploadingReference} referenceMaterials={collaborativeReferences} textbookSelections={collaborativeTextbooks} onRestoreSources={restoreCollaborativeSources} onConfirmed={start} initialMessage={initialMessage} onInitialMessageConsumed={consumeInitialMessage} generationSettings={generationSettings} sourceControls={<section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 sm:p-6"><h2 className="text-base font-semibold text-slate-900">教材与参考资料（可选）</h2><p className="text-sm leading-7 text-slate-600">可以先讨论，再按需要补充。新增资料后，AI 会据此更新方案。</p><CompactKnowledgeUpload disabled={submitting || collaborativeReferences.length >= MAX_GENERATION_REFERENCE_FILES} uploading={uploadingReference} onFiles={(files) => void uploadKnowledgeReferences(files)} />{collaborativeReferences.length ? <ul aria-label="已上传知识资料" className="flex flex-wrap gap-2">{collaborativeReferences.map((item) => <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 pl-3 text-sm"><span className="max-w-60 truncate">{item.fileName}</span><button className="grid size-11 shrink-0 place-items-center" aria-label={`移除知识资料 ${item.fileName}`} disabled={submitting || uploadingReference} type="button" onClick={() => void removeKnowledgeReference(item)}><X className="size-4" /></button></li>)}</ul> : null}<details><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-slate-900">选用教材（可选）</summary><CourseTextbookSelector disabled={submitting} value={collaborativeTextbooks} onChange={(value) => { collaborativeSourcesRestored.current = true; setCollaborativeTextbooks(value); }} returnTo={`/teacher/prepare/${encodeURIComponent(course.id)}/verify`} /></details></section>} /> : <>
      <ol aria-label="备课步骤" className="mb-6 grid grid-cols-3 gap-2 rounded-xl border border-slate-200 bg-white p-2">
        {["上传资源包", "核对解析结果", "补充要求与生成"].map((label, index) => <li key={label}>
          <button aria-current={inputStep === index ? "step" : undefined} className={cn("flex min-h-14 w-full items-center gap-2 rounded-lg px-2 py-3 text-left text-xs font-medium transition sm:px-4 sm:text-sm disabled:cursor-not-allowed disabled:opacity-45", inputStep === index ? "bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : "text-slate-500 hover:bg-slate-50")}
            disabled={submitting || (index === 1 && !packageSnapshot?.package) || (index === 2 && !confirmedPackage?.confirmedAt && !legacyResumeAvailable)} onClick={() => setInputStep(index)} type="button">
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-full border text-xs", inputStep === index ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher)] text-white" : "border-slate-300")}>{index < inputStep ? <Check className="size-4" /> : index + 1}</span><span>{label}</span>
          </button>
        </li>)}
      </ol>
      <div hidden={inputStep === 2}>
        <ResourcePackageForm uploadInputRef={uploadInput} onUploadAvailabilityChange={setPackageUploadReady} onUploadSelected={() => changePreparationMode("resource-package")} courseId={course.id} teacherId={teacherId} disabled={submitting || running || classroomRunning} displayStep={inputStep === 0 ? "upload" : "review"} onConfirmed={handleConfirmedPackage} onPackagePresent={setHasResourcePackage} onSnapshot={handlePackageSnapshot} />
        <div className="flex flex-wrap justify-between gap-3">
          {inputStep === 1 ? <button className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm text-slate-700" onClick={() => setInputStep(0)} type="button"><ArrowLeft className="size-4" />上一步：资源包</button> : <span />}
          {inputStep === 0 && packageSnapshot?.package && ["ready", "blocked"].includes(packageSnapshot.status) ? <button className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white" onClick={() => setInputStep(1)} type="button">核对解析结果<ArrowRight className="size-4" /></button> : null}
          {inputStep === 1 && confirmedPackage?.confirmedAt ? <button className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white" onClick={() => setInputStep(2)} type="button">继续：补充要求与生成<ArrowRight className="size-4" /></button> : null}
        </div>
      </div>
      {inputStep === 2 ? <div className="space-y-5">
        {confirmedPackage ? <section aria-label="已采用的课程资料" className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-5 py-4">
          <div><p className="text-xs font-medium text-[var(--pbl-teacher)]">已确认的课程资料</p><h2 className="mt-1 font-semibold text-slate-900">{confirmedPackage.draft.courseName}</h2><p className="mt-1 text-sm text-slate-600">{confirmedPackage.draft.grade} · {confirmedPackage.draft.totalMinutes} 分钟 · {confirmedPackage.source.fileName}</p></div>
          <button className="min-h-11 rounded-lg border border-[var(--pbl-teacher-border)] bg-white px-4 text-sm font-medium text-[var(--pbl-teacher)]" onClick={() => setInputStep(1)} type="button">查看或修改资料</button>
        </section> : <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">旧任务可沿用原有要求继续。修改要求或创建新课堂时，需先上传并确认资源包。<button className="ml-2 min-h-11 font-semibold underline" onClick={() => setInputStep(0)} type="button">上传资源包</button></p>}
        <section className="rounded-xl border border-slate-200 bg-white p-5 sm:p-6">
          <label className="block"><span className="text-base font-semibold text-slate-900">补充教学要求 <span className="text-sm font-normal text-slate-500">（可选）</span></span><span className="mt-2 block text-sm leading-6 text-slate-600">已有资料足够时可以直接生成，也可以补充教学重点、学生困难或案例偏好。</span>
            <textarea aria-label="补充课程生成要求（可选）" className="mt-4 min-h-32 w-full resize-y rounded-lg border border-slate-300 bg-white px-4 py-3 text-sm leading-7 text-slate-900 focus-visible:outline-2 focus-visible:outline-[var(--pbl-teacher)]" disabled={submitting} maxLength={4000} onChange={(event) => setBrief(event.target.value)} placeholder="例如：重点解释概念之间的区别，采用贴近学生生活的案例。" value={brief} />
          </label>
          <div className="mt-4"><CompactKnowledgeUpload disabled={submitting || referenceMaterials.length >= MAX_GENERATION_REFERENCE_FILES} onFiles={(files) => void uploadKnowledgeReferences(files)} uploading={uploadingReference} /></div>
          {referenceMaterials.length ? <ul aria-label="已上传知识资料" className="mt-3 flex flex-wrap gap-2">{referenceMaterials.map((material) => <li className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 pl-3 text-sm text-slate-700" key={material.id}><span className="max-w-72 truncate">{material.fileName}</span><button aria-label={`移除知识资料 ${material.fileName}`} className="grid size-11 shrink-0 place-items-center rounded-lg hover:bg-slate-200" disabled={submitting || uploadingReference} onClick={() => void removeKnowledgeReference(material)} type="button"><X className="size-4" /></button></li>)}</ul> : null}
        </section>
        <details className="rounded-xl border border-slate-200 bg-white px-5 py-3 sm:px-6"><summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-slate-900">选用教材（可选）<span className="ml-2 font-normal text-slate-500">{textbookSelections.length ? `已选 ${textbookSelections.length} 本` : "使用教材原文作为课程依据"}</span></summary><div className="pb-2 pt-3"><CourseTextbookSelector disabled={submitting} onChange={setTextbookSelections} value={textbookSelections} returnTo={`/teacher/prepare/${encodeURIComponent(course.id)}/verify`} /></div></details>
        {generationSettings}
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur">
          <div><button className="inline-flex min-h-11 items-center gap-2 text-sm text-slate-600" onClick={() => setInputStep(confirmedPackage ? 1 : 0)} type="button"><ArrowLeft className="size-4" />返回核对资料</button>{teacherId ? <p className="text-xs text-slate-500">未提交的要求保留在当前浏览器会话。</p> : null}</div>
          <div className="flex flex-wrap gap-2">
            {job?.status === "failed" && job.stepIndex === 2 ? <button className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-4 text-sm font-semibold text-[var(--pbl-teacher)]" disabled={submitting || uploadingReference} onClick={() => void resumeSavedFirstDraft()} type="button">继续已保存首稿</button> : null}
            <button aria-label={job?.status === "failed" ? "重生成失败阶段" : "开始生成课程"} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45" disabled={submitting || uploadingReference || (!confirmedPackage?.confirmedAt && !legacyResumeAvailable)} onClick={() => void start()} type="button">{submitting ? <CourseGenerationGlyph className="size-5" /> : <Send className="size-4" />}{submitting ? "正在提交…" : job?.status === "failed" ? "重生成失败阶段" : "开始生成课程"}</button>
          </div>
        </div>
      </div> : null}
      </>}
      </div>
      {outlineDetailsAvailable ? <div className="mt-5"><button className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700" onClick={() => void viewOutlineDetails()} type="button"><FileText className="size-4" />查看大纲与蓝图</button></div> : null}
      {error ? <p role="alert" className="mt-4 rounded-lg bg-red-50 px-4 py-3 text-sm leading-6 text-red-700">{error}</p> : null}
      {outlineDetailsDialog}
    </section>
  );
}

function GenerationCheckpointPreview({
  availableScenesCount,
  course,
  onClose,
  preview,
  lifecycleKey,
}: {
  availableScenesCount: number;
  course: Course;
  onClose: () => void;
  preview: { classroomId: string; loadedScenesCount: number; revision: number };
  lifecycleKey: string;
}) {

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div aria-label="已生成课程页面预览" aria-modal="true" className="fixed inset-0 z-[100] flex flex-col bg-stone-100" role="dialog">
      <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 py-3 shadow-sm sm:px-6">
        <div className="min-w-0">
          <p className="text-sm font-black text-stone-950">已生成页面预览</p>
          <p className="mt-0.5 text-xs text-stone-500">
            当前已生成 {availableScenesCount} 页 · 页面与音频自动同步
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="inline-flex min-h-11 items-center gap-2 rounded-[8px] bg-stone-950 px-4 text-xs font-bold text-white transition hover:bg-[var(--pbl-teacher)]"
            onClick={onClose}
            type="button"
          >
            返回生成进度 <X className="size-3.5" />
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 p-2 sm:p-3">
        <StudentStageHost
          backHref={`/teacher/prepare/${course.id}/verify`}
          className="h-full min-h-[520px] overflow-hidden rounded-[10px] border border-stone-200 bg-white shadow-sm"
          classroomId={preview.classroomId}
          courseId={course.id}
          key={preview.classroomId}
          knowledgeGraph={course.content.knowledgeGraph}
          courseMindMap={course.content.courseMindMap}
          knowledgePoints={course.content.knowledgePoints}
          mode="teacher-preview"
          previewRefreshKey={lifecycleKey}
          standalone
          variant="embedded"
        />
      </div>
    </div>
  );
}

function CompactKnowledgeUpload({
  disabled,
  onFiles,
  uploading,
}: {
  disabled: boolean;
  onFiles: (files: File[]) => void;
  uploading: boolean;
}) {
  return <div className="space-y-2">
    <label className={cn("inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700", disabled || uploading ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-slate-50")}>
      {uploading ? <LoaderCircle className="size-4 animate-spin" /> : <Paperclip className="size-4" />}{uploading ? "正在上传…" : "添加参考资料（可选）"}
      <input accept={GENERATION_REFERENCE_ACCEPT} aria-describedby="generation-reference-types" aria-label="上传知识资料" className="sr-only" disabled={disabled || uploading} multiple onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) onFiles(files); }} type="file" />
    </label>
    <p className="text-xs leading-5 text-slate-500" id="generation-reference-types">支持 PDF、Word（DOCX）、PPT（PPTX）、TXT 和 Markdown，最多上传 {MAX_GENERATION_REFERENCE_FILES} 份。资料仅作为课程生成依据，不会直接发布给学生。</p>
  </div>;
}

function GenerationChoiceGroup<T extends string>({ label, value, choices, onChange, disabled }: {
  label: string;
  value: T;
  choices: Array<{ value: T; label: string; description: string }>;
  onChange: (value: T) => void;
  disabled: boolean;
}) {
  const name = useId();
  return <fieldset role="radiogroup" aria-labelledby={`${name}-label`} className={styles.settingGroup} disabled={disabled}><legend id={`${name}-label`}>{label}</legend>{choices.map((choice) =>
    <label key={choice.value} className={styles.settingChoice} data-selected={choice.value === value}>
      <input type="radio" name={name} aria-label={choice.label} value={choice.value} checked={choice.value === value} onChange={() => onChange(choice.value)} />
      <span><strong>{choice.label}</strong><small>{choice.description}</small></span>
    </label>
  )}</fieldset>;
}

function GenerationModeButton({
  active,
  description,
  icon: Icon,
  label,
  ariaLabel,
  onClick,
}: {
  active: boolean;
  ariaLabel: string;
  description: string;
  icon: typeof Sparkles;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      aria-label={ariaLabel}
      className={cn(
        "min-h-24 rounded-lg border border-slate-200 p-3 text-left text-sm transition",
        active
          ? "border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"
          : "text-stone-500 hover:text-stone-800",
      )}
      onClick={onClick}
      title={description}
      type="button"
    >
      <span className="flex items-center gap-2 font-semibold"><Icon className="size-4" />{label}</span><span className="mt-2 block text-xs leading-5 text-slate-500">{description}</span>
    </button>
  );
}

function OptionToggle({
  active,
  description,
  icon: Icon,
  label,
  onClick,
  showState = false,
}: {
  active: boolean;
  description: string;
  icon: typeof Mic2;
  label: string;
  onClick: () => void;
  showState?: boolean;
}) {
  return (
    <button
      aria-pressed={active}
      aria-label={`${label}：${description}`}
      className={cn(
        "inline-flex min-h-11 items-center gap-2 rounded-lg border px-4 text-sm font-medium transition",
        active ? "border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : "border-stone-200 bg-white text-stone-500 hover:bg-stone-50",
      )}
      onClick={onClick}
      title={description}
      type="button"
    >
      <Icon className="size-3.5" />{label}{showState && <span className="text-xs font-normal">{active ? "已开启" : "已关闭"}</span>}
    </button>
  );
}
