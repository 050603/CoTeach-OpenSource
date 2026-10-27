"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  Check,
  Download,
  BookOpen,
  FlaskConical,
  Gauge,
  History,
  Layers3,
  MoreHorizontal,
  Settings2,
  ShieldCheck,
  RotateCcw,
  X,
} from "lucide-react";
import { PreparationShell, preparationThemeClassName } from "@/components/teacher/preparation-shell";
import { Button, FlowActionBar, Pill, toast } from "@/components/ui";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CoursePublishPathPreview } from "@/components/teacher/course-publish-path-preview";
import { TeachingToolRunbook } from "@/components/teacher/teaching-tool-runbook";
import { StudentStageHost } from "@/components/openmaic-bridge/student-stage-host";
import { useCourseGenerationPreviewSync } from "@/hooks/use-course-generation-preview-sync";
import { useCourse, useHydrated, useSession } from "@/lib/session/store";
import type {
  AdaptiveBranchOutline,
  Course,
  CourseDesignWorkspaceSectionKey,
  OpenMaicSceneOutlineSnapshot,
} from "@/lib/session/types";
import type { Scene } from "@/lib/openmaic/types/stage";
import { courseDetailHref, courseEditorHref } from "@/lib/courses/preparation-navigation";
import { cn } from "@/lib/utils";
import { getNewSystemCourseReadiness } from "@/lib/classroom/new-system-course";
import { hasCourseAudioPublicationIdentity, isAdvisoryCourseReadinessCheck, isTechnicalCourseResourceIssue } from "@/lib/course-quality-review/teacher-review";
import {
  CourseQualityReview,
  type CourseQualityReviewSummary,
  type TeacherReviewDecision,
} from "@/components/teacher/course-quality-review";
import { downloadCoursePptx, downloadCourseResources } from "@/lib/course-resources/download-course-resources";
import type { PptxExportProgress } from "@openmaic/lib/export/image-pptx";
import { CourseDetailContent, CourseDetailMaterials, CourseDetailOverview, CourseDetailSettings, courseDetailStages } from "./course-detail-panels";
import type { CourseGenerationInputSummary } from "@/lib/course-design/generation-input-summary";
import styles from "./page.module.css";

type PreviewView = "overview" | "content" | "materials" | "settings" | "checks";

const PREVIEW_VIEWS: PreviewView[] = ["overview", "content", "materials", "settings", "checks"];

function parsePreviewView(value: string | null): PreviewView {
  if (value === "director" || !value) return "overview";
  if (value === "pages" || value === "student") return "content";
  return PREVIEW_VIEWS.includes(value as PreviewView) ? value as PreviewView : "overview";
}

type PublishCheck = {
  id: string;
  label: string;
  done: boolean;
  detail: string;
  advisory: boolean;
};

type ResourceRepairIssue = {
  id: string;
  type: "classroom" | "adaptive-resource" | "teaching-tool" | "tts" | "media" | "speech-sync" | "source-consistency";
  title: string;
  detail: string;
};

type ResourceRepairStatus = {
  status: "idle" | "running" | "completed" | "failed";
  error?: string;
  completed?: number;
  total?: number;
  failed?: number;
};

type PublicationState = {
  latestVersion: number | null;
  publishedVersion: number | null;
  draftVersion: number | null;
};

function secondsLabel(seconds?: number): string {
  const value = Math.max(0, Math.round(seconds ?? 0));
  if (!value) return "未估时";
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  if (!minutes) return `${rest} 秒`;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function buildPublishChecks(course: Course): PublishCheck[] {
  return getNewSystemCourseReadiness(course).map((check) => ({
    id: check.id,
    label: check.label,
    done: check.ok,
    detail: check.ok ? "已完成。" : check.message,
    advisory: isAdvisoryCourseReadinessCheck(check.id),
  }));
}

export default function PreviewCoursePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const session = useSession();
  const { user, publishCourse } = session;
  const course = useCourse(params?.id);
  const hydrated = useHydrated();
  const { refreshKey: previewRefreshKey, previewClassroomId: livePreviewClassroomId } = useCourseGenerationPreviewSync({
    courseId: course?.id,
    courseVersion: course?.version,
    classroomId: course?.aiLearningClassroomId || course?.content._openmaicClassroomId,
    refreshCourse: () => session.refresh("teacher"),
  });
  const [publishing, setPublishing] = useState(false);
  const view = parsePreviewView(searchParams.get("view"));
  const [studentSidebarCollapsed, setStudentSidebarCollapsed] = useState(true);
  const [resourceIssues, setResourceIssues] = useState<ResourceRepairIssue[]>([]);
  const [resourceAuditLoaded, setResourceAuditLoaded] = useState(false);
  const [resourceAuditError, setResourceAuditError] = useState("");
  const [resourceRepairStatus, setResourceRepairStatus] = useState<ResourceRepairStatus>({ status: "idle" });
  const [speechSyncStatus, setSpeechSyncStatus] = useState<ResourceRepairStatus>({ status: "idle" });
  const [resourceRepairVersion, setResourceRepairVersion] = useState(0);
  const [reviewDecision, setReviewDecision] = useState<TeacherReviewDecision>({ canConfirm: false, signature: "", acceptedIssueIds: [], acknowledgeFailedCheck: false });
  const [publishedHere, setPublishedHere] = useState(false);
  const [downloadingResources, setDownloadingResources] = useState(false);
  const [pptxProgress, setPptxProgress] = useState<PptxExportProgress | null>(null);
  const [continuingFullCourse, setContinuingFullCourse] = useState(false);
  const [publicationState, setPublicationState] = useState<PublicationState | null>(null);
  const [generationInput, setGenerationInput] = useState<CourseGenerationInputSummary | null>();
  const [generationInputError, setGenerationInputError] = useState("");
  const [reviewSummary, setReviewSummary] = useState<CourseQualityReviewSummary | null>(null);
  const [checkingTiming, setCheckingTiming] = useState(false);
  const [timingAuditError, setTimingAuditError] = useState("");
  const onPreviewSceneChange = useCallback((scene: Scene) => {
    const current = new URL(window.location.href);
    if (current.pathname !== courseDetailHref(params.id)) return;
    if (!["content", "pages", "student"].includes(current.searchParams.get("view") ?? "")) return;
    const sceneId = scene.outlineId || scene.id;
    if (current.searchParams.get("sceneId") === sceneId) return;
    current.searchParams.set("sceneId", sceneId);
    current.searchParams.set("stage", "ai-learning");
    const outline = course?.content._openmaicSceneOutlines?.find((entry) => entry.id === sceneId);
    const section = outline?.lectureSectionId ?? course?.content.knowledgeLectureSections?.find((entry) => entry.sceneOutlineIds.includes(sceneId))?.id;
    if (section) current.searchParams.set("section", section);
    else current.searchParams.delete("section");
    router.replace(`${current.pathname}?${current.searchParams.toString()}`, { scroll: false });
  }, [params.id, router, course]);

  useEffect(() => {
    if (!params?.id) return;
    const controller = new AbortController();
    void fetch(`/api/courses/${params.id}/design-workspace`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("补充资料暂时无法读取，请刷新后重试。");
        return response.json() as Promise<{ publication?: PublicationState; generationInput?: CourseGenerationInputSummary | null }>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        if (payload.publication) setPublicationState(payload.publication);
        setGenerationInput(payload.generationInput ?? null);
        setGenerationInputError("");
      })
      .catch(() => { if (!controller.signal.aborted) setGenerationInputError("补充资料暂时无法读取，请刷新后重试。"); });
    return () => controller.abort();
  }, [params?.id, course?.version]);

  useEffect(() => {
    if (!params?.id) return;
    const controller = new AbortController();
    void fetch(`/api/courses/${params.id}/resource-repair`, {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("课程资源状态暂时无法读取");
      const payload = await response.json() as {
        issues?: ResourceRepairIssue[];
        repair?: ResourceRepairStatus;
        syncRepair?: ResourceRepairStatus;
      };
      setResourceIssues(payload.issues ?? []);
      setResourceRepairStatus((current) =>
        current.status === "running" ? current : payload.repair ?? { status: "idle" },
      );
      setSpeechSyncStatus((current) =>
        current.status === "running" ? current : payload.syncRepair ?? { status: "idle" },
      );
      setResourceAuditError("");
    }).catch((error) => {
      if (!controller.signal.aborted) {
        setResourceAuditError(error instanceof Error ? error.message : "课程资源状态暂时无法读取");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setResourceAuditLoaded(true);
    });
    return () => controller.abort();
  }, [params?.id, resourceRepairVersion]);

  useEffect(() => {
    if (!params?.id || resourceRepairStatus.status !== "running") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetch(`/api/courses/${params.id}/resource-repair`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("无法读取资源修复进度");
        const payload = await response.json() as { issues?: ResourceRepairIssue[]; repair?: ResourceRepairStatus };
        if (controller.signal.aborted) return;
        const issues = payload.issues ?? [];
        const repair = payload.repair ?? { status: "completed" };
        setResourceIssues(issues);
        setResourceRepairStatus(repair);
        if (repair.status === "running") {
          timer = setTimeout(poll, 2_500);
        } else if (repair.status === "failed") {
          toast.error("资源重试失败", { description: repair.error || "请稍后重试" });
        } else {
          setResourceRepairVersion((value) => value + 1);
          if (issues.length === 0) toast.success("缺失资源已经补齐");
          else toast.warning("部分资源仍未生成", { description: `还剩 ${issues.length} 项，可稍后再次重试。` });
        }
      } catch {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2_500);
      }
    };

    timer = setTimeout(poll, 1_000);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [params?.id, resourceRepairStatus.status]);

  useEffect(() => {
    if (!params?.id || speechSyncStatus.status !== "running") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/courses/${params.id}/resource-repair`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("无法读取同步修复进度");
        const payload = await response.json() as {
          issues?: ResourceRepairIssue[];
          syncRepair?: ResourceRepairStatus;
        };
        if (controller.signal.aborted) return;
        setResourceIssues(payload.issues ?? []);
        const status = payload.syncRepair ?? { status: "completed" as const };
        setSpeechSyncStatus(status);
        if (status.status === "running") timer = setTimeout(poll, 2_500);
        else if (status.status === "failed") {
          toast.error("朗读与动作同步修复失败", { description: status.error || "请检查本机对齐服务后重试" });
        } else {
          setResourceRepairVersion((value) => value + 1);
          if ((status.failed ?? 0) > 0) {
            toast.warning("部分讲稿仍待同步", { description: `${status.failed} 段对齐失败，可稍后再次修复。` });
          } else toast.success("朗读、字幕与指示动作已经同步");
        }
      } catch {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2_500);
      }
    };
    timer = setTimeout(poll, 1_000);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [params?.id, speechSyncStatus.status]);

  if (!hydrated) {
    return (
      <PreparationShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare">
        <div className="grid min-h-72 place-items-center text-sm text-stone-500">正在打开课程详情…</div>
      </PreparationShell>
    );
  }

  if (!course) {
    return (
      <PreparationShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare">
        <div className="grid min-h-72 place-items-center text-sm text-stone-500">
          <div className="text-center">
            <p>未找到课程。</p>
            <Link className="mt-3 inline-block font-semibold text-blue-700 hover:underline" href="/teacher/templates">返回课程列表</Link>
          </div>
        </div>
      </PreparationShell>
    );
  }

  const outlines = course.content._openmaicSceneOutlines ?? [];
  const classroomGenerationRun = course.content.classroomGenerationRun;
  const isTestLesson = classroomGenerationRun?.scope === "test-lesson";
  const testLessonTitle = classroomGenerationRun?.testLesson?.sectionTitle ?? "一个完整知识小节";
  const studentOutlines = outlines.filter((outline) => outline.audience !== "teacher");
  const detailStages = courseDetailStages(course);
  const legacyLectureView = ["pages", "student"].includes(searchParams.get("view") ?? "");
  const stageKey = legacyLectureView ? "ai-learning" : detailStages.find((stage) => stage.key === searchParams.get("stage"))?.key
    ?? (searchParams.has("sceneId") || searchParams.has("section") ? "ai-learning" : detailStages[0]?.key) ?? "ai-learning";
  const sectionId = searchParams.get("section") || undefined;
  const requestedSceneId = searchParams.get("sceneId") || undefined;
  const selectedOutline = studentOutlines.find((outline) => outline.id === requestedSceneId)
    ?? studentOutlines.find((outline) => sectionId && (outline.lectureSectionId === sectionId
      || course.content.knowledgeLectureSections?.find((section) => section.id === sectionId)?.sceneOutlineIds.includes(outline.id)))
    ?? studentOutlines[0];
  const currentDetailHref = `${courseDetailHref(course.id)}${searchParams.size ? `?${searchParams.toString()}` : ""}`;
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const adaptivePlan = course.content.adaptiveLearningPlan;
  const activeAdaptiveBranches = adaptivePlan?.branches.filter((branch) => branch.enabled !== false) ?? [];
  const hasDownloadableResources = Boolean(
    classroomId
    || course.content.teacherClassroomId
    || activeAdaptiveBranches.some((branch) => branch.preparedResource?.classroomId),
  );
  const activePreviewBranch = activeAdaptiveBranches.find((branch) => Boolean(branch.preparedResource?.classroomId)
    && (branch.id === searchParams.get("adaptiveBranchId")
      || branch.preparedResource?.classroomId === searchParams.get("classroomId")));
  const publishChecks = buildPublishChecks(course);
  const reviewRequired = course.content.qualityReviewRequired === true || Number(course.content.resourcePackage?.schemaVersion ?? 0) >= 2 || Number(course.content.stagePlan?.schemaVersion ?? 0) >= 2;
  const prerequisiteChecks = getNewSystemCourseReadiness(course).filter((check) => check.id !== "teacher-review");
  const prerequisitePublishChecks = publishChecks.filter((check) => check.id !== "teacher-review");
  const requiredChecks = prerequisiteChecks.filter((check) => !isAdvisoryCourseReadinessCheck(check.id));
  const readyCount = requiredChecks.filter((item) => item.ok).length;
  const requiredResourceIssues = resourceIssues.filter(isTechnicalCourseResourceIssue);
  const readyToPublish = resourceAuditLoaded
    && !resourceAuditError
    && !isTestLesson
    && readyCount === requiredChecks.length
    && requiredResourceIssues.length === 0
    && (!reviewRequired || reviewDecision.canConfirm);
  const pendingPublishCount = requiredChecks.length - readyCount
    + requiredResourceIssues.length
    + (resourceAuditError ? 1 : 0)
    + (reviewRequired && !reviewDecision.canConfirm ? 1 : 0);
  const isPublished = publishedHere || course.status === "ready"
    || course.status === "teaching"
    || course.status === "finished";
  const hasDesignDraft = course.status === "preparing" && Boolean(course.content.designWorkspaceRevision);
  const hasPublishedVersion = Boolean(publicationState?.publishedVersion);
  const missingResourceIssues = resourceIssues.filter((issue) => issue.type !== "speech-sync");
  const speechSyncIssues = resourceIssues.filter((issue) => issue.type === "speech-sync");
  const courseId = course.id;
  const publishBlockReason = !resourceAuditLoaded
    ? "正在核对课程资源"
    : resourceAuditError
      ? "资源状态读取失败，请重试"
      : requiredChecks.length !== readyCount
        ? `还有 ${requiredChecks.length - readyCount} 项发布条件未完成`
        : requiredResourceIssues.length
          ? `还有 ${requiredResourceIssues.length} 项课程资源需要处理`
          : reviewRequired && !reviewDecision.canConfirm
            ? reviewSummary?.status === "blocked" ? "终审存在必须处理的问题" : "等待教师确认当前版本"
            : undefined;

  async function publish() {
    if (isTestLesson) {
      toast.warning("测试样本不能发布", { description: "请返回课程生成页，切换为“完整课程”并完成正式生成。" });
      return;
    }
    setPublishing(true);
    try {
      if (reviewRequired) {
        const response = await fetch(`/api/courses/${courseId}/quality-review`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "confirm", ...reviewDecision, publish: true }) });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error || "教师终审未保存。");
        setPublishedHere(true);
      } else publishCourse(courseId);
      toast.success("课程已发布", {
        description: "可继续浏览课程，或安排到教学班中授课。",
      });
    } catch (error) {
      toast.error("课程尚未达到发布条件", {
        description: error instanceof Error ? error.message : "请检查未完成项目。",
      });
    } finally {
      setPublishing(false);
    }
  }

  async function continueFullCourse() {
    if (!isTestLesson || continuingFullCourse) return;
    setContinuingFullCourse(true);
    try {
      const response = await fetch(`/api/courses/${courseId}/design-generation`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote-test-lesson" }),
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; detail?: string };
      if (!response.ok) throw new Error(payload.detail || payload.error || "无法继续生成完整课程");
      toast.success("已开始生成完整课程", {
        description: "测试小节会保留，系统将按已确认大纲补齐其余页面和资源。",
      });
      router.push(`/teacher/prepare/${encodeURIComponent(courseId)}/verify`);
    } catch (error) {
      toast.error("完整课程尚未开始生成", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
      setContinuingFullCourse(false);
    }
  }

  async function retryMissingResources() {
    setResourceAuditError("");
    setResourceRepairStatus({ status: "running" });
    try {
      const response = await fetch(`/api/courses/${courseId}/resource-repair`, { method: "POST" });
      const payload = await response.json() as { issues?: ResourceRepairIssue[]; repair?: ResourceRepairStatus; error?: string };
      if (!response.ok) throw new Error(payload.error || "缺失资源重试失败");
      setResourceIssues(payload.issues ?? []);
      setResourceRepairStatus(payload.repair ?? { status: "running" });
      toast.info("已开始补齐缺失资源", { description: "音频会在后台继续生成，完成后此页面会自动更新。" });
    } catch (error) {
      setResourceRepairStatus({ status: "idle" });
      toast.error("资源重试失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  }

  async function recheckAudioTiming() {
    if (checkingTiming) return;
    setCheckingTiming(true);
    setTimingAuditError("");
    try {
      const response = await fetch(`/api/courses/${courseId}/timing-audit`, { method: "POST" });
      const payload = await response.json() as {
        audit?: Course["content"]["teachingTimingAudit"];
        error?: string;
      };
      if (!response.ok || !payload.audit) throw new Error(payload.error || "音频时长核查失败");
      await session.refresh("teacher");
      if (payload.audit.complete) {
        toast.success("全部音频时长已重新核查", {
          description: "请查看实测总时长与教案目标，再决定发布或继续修改。",
        });
      } else {
        toast.warning("仍有音频未完成", {
          description: `已测量 ${payload.audit.measuredSegmentCount}/${payload.audit.narrationSegmentCount} 段，请补齐后重新核查。`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "请稍后重试";
      setTimingAuditError(message);
      toast.error("音频时长核查失败", { description: message });
    } finally {
      setCheckingTiming(false);
    }
  }

  async function repairSpeechSynchronization() {
    setSpeechSyncStatus({ status: "running", completed: 0, total: 0, failed: 0 });
    try {
      const response = await fetch(`/api/courses/${courseId}/resource-repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "speech-sync" }),
      });
      const payload = await response.json() as {
        issues?: ResourceRepairIssue[];
        syncRepair?: ResourceRepairStatus;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "同步修复未能开始");
      setResourceIssues(payload.issues ?? []);
      setSpeechSyncStatus(payload.syncRepair ?? { status: "running" });
      toast.info("已开始修复朗读与动作同步", {
        description: "系统会复用现有语音，只补齐字幕和动作时间线。",
      });
    } catch (error) {
      setSpeechSyncStatus({ status: "idle" });
      toast.error("同步修复未能开始", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    }
  }

  async function downloadResources() {
    setDownloadingResources(true);
    try {
      await downloadCourseResources(courseId);
      toast.success("课程资源已开始下载", {
        description: "压缩包包含课程 PPT、讲稿、互动页面和原始课程资料。",
      });
    } catch (error) {
      toast.error("课程资源下载失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setDownloadingResources(false);
    }
  }

  async function downloadPptx() {
    setPptxProgress({ completed: 0, total: 0 });
    try {
      await downloadCoursePptx(courseId, setPptxProgress);
      toast.success("PPT 已开始下载", {
        description: "已导出逐页图片版课件，保留中文、公式与排版；页内文字和图形不可单独编辑。",
      });
    } catch (error) {
      toast.error("PPT 下载失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setPptxProgress(null);
    }
  }

  function changeDetailLocation(values: Record<string, string | undefined>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.push(`${courseDetailHref(courseId)}${next.size ? `?${next}` : ""}`, { scroll: false });
  }

  function closeBranchPreview() {
    changeDetailLocation({ classroomId: undefined, adaptiveBranchId: undefined });
  }

  function selectView(nextView: PreviewView) {
    changeDetailLocation({ view: nextView });
  }

  function selectStage(stage: string) {
    changeDetailLocation({ view: "content", stage, section: undefined, sceneId: undefined });
  }

  function selectPage(outline: OpenMaicSceneOutlineSnapshot) {
    changeDetailLocation({ view: "content", stage: outline.stageKey || "ai-learning", section: outline.lectureSectionId,
      sceneId: outline.id });
  }

  function openReviewPage(outlineId: string) {
    const outline = studentOutlines.find((item) => item.id === outlineId);
    if (!outline) {
      toast.info("请从检查项定位到对应内容", { description: "使用问题中的“定位并修改”可打开实际页面。" });
      return;
    }
    selectPage(outline);
  }

  return (
    <PreparationShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name}
      variant="bare" currentCourse={{ id: course.id, name: course.name, status: course.status }} wide>
      <main className={styles.detail}>
        <header className={styles.detailHeading}>
          <div className={styles.courseIdentity}>
            <p className={styles.eyebrow}>{isTestLesson ? "测试一节 · 待扩展为完整课程" : "课程详情"}</p>
            <h1>{course.name}</h1>
            <div className={styles.courseMeta}>
              <span>{[course.subject, course.grade].filter(Boolean).join(" · ")}</span>
              {isTestLesson ? <Pill tone="amber">测试一节 · 不可发布</Pill> : isPublished ? <Pill tone="green">当前发布版本{publicationState?.publishedVersion ? ` v${publicationState.publishedVersion}` : ""}</Pill>
                : hasDesignDraft && hasPublishedVersion ? <><Pill tone="green">当前发布 v{publicationState!.publishedVersion}</Pill><Pill tone="amber">草稿{publicationState?.draftVersion ? ` v${publicationState.draftVersion}` : ""} · 待完成 {pendingPublishCount} 项</Pill></>
                  : <Pill tone={readyToPublish ? "blue" : "amber"}>{readyToPublish ? "未发布 · 可以发布" : resourceAuditLoaded ? `待完成 ${pendingPublishCount} 项` : "正在核对资源"}</Pill>}
            </div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button className="min-h-11" variant="outline" aria-label="课程更多操作"><MoreHorizontal size={18}/>更多</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={cn("pbl-platform-theme min-w-56", preparationThemeClassName)}>
              <DropdownMenuItem asChild><Link className="min-h-11" href={courseEditorHref(course.id, "versions", { returnTo: currentDetailHref })}><History size={16}/>版本记录</Link></DropdownMenuItem>
              <DropdownMenuSeparator/>
              <DropdownMenuItem className="min-h-11" disabled={pptxProgress !== null || downloadingResources || !hasDownloadableResources} onSelect={(event) => { event.preventDefault(); void downloadPptx(); }}><Download size={16}/>{pptxProgress ? pptxProgress.total ? `正在导出 ${pptxProgress.completed}/${pptxProgress.total} 页…` : "正在准备 PPT…" : "下载 PPT"}</DropdownMenuItem>
              <DropdownMenuItem className="min-h-11" disabled={downloadingResources || pptxProgress !== null || !hasDownloadableResources} onSelect={(event) => { event.preventDefault(); void downloadResources(); }}><Download size={16}/>{downloadingResources ? "正在打包…" : "下载课程资源"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {isTestLesson ? <div className={styles.notice}><FlaskConical size={18}/><p>当前预览“{testLessonTitle}”，共 {studentOutlines.length} 页。完整大纲共 {classroomGenerationRun?.fullOutlineCount ?? studentOutlines.length} 页，继续生成时会保留已完成页面。</p></div> : null}
        {(pptxProgress || downloadingResources) ? <p className={styles.exportProgress} role="status">{downloadingResources ? "正在打包课程资源…" : pptxProgress?.total ? `正在导出 PPT：${pptxProgress.completed}/${pptxProgress.total} 页` : "正在准备 PPT…"}</p> : null}

        <div className={styles.tabs} onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
          const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
          const target = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
            : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
          event.preventDefault(); tabs[target]?.focus(); tabs[target]?.click();
        }}>
          <div aria-label="课程详情视图" role="tablist">
            <ViewTab active={view === "overview"} icon={<Layers3 size={17}/>} id="overview" label="课程总览" onClick={() => selectView("overview")}/>
            <ViewTab active={view === "content"} icon={<BookOpenCheck size={17}/>} id="content" label="教学内容" onClick={() => selectView("content")}/>
            <ViewTab active={view === "materials"} icon={<BookOpen size={17}/>} id="materials" label="课程资料" onClick={() => selectView("materials")}/>
            <ViewTab active={view === "settings"} icon={<Settings2 size={17}/>} id="settings" label="课程设置" onClick={() => selectView("settings")}/>
            <ViewTab active={view === "checks"} icon={<ShieldCheck size={17}/>} id="checks" label="检查与发布" onClick={() => selectView("checks")}/>
          </div>
        </div>

        <div className={styles.workspace}>
          {view === "overview" ? <div aria-labelledby="publish-tab-overview" id="publish-panel-overview" role="tabpanel"><CourseDetailOverview course={course} returnTo={currentDetailHref} onSelectStage={selectStage}/></div> : null}
          {view === "content" ? <div aria-labelledby="publish-tab-content" id="publish-panel-content" role="tabpanel">
            <CourseDetailContent course={course} stageKey={stageKey} sectionId={sectionId} selectedOutline={selectedOutline} returnTo={currentDetailHref}
              onSelectStage={selectStage} onSelectPage={selectPage} preview={activePreviewBranch ? <p className={styles.empty}>正在预览个性化学习资源。</p> : <StudentClassroomExperience
                classroomId={livePreviewClassroomId || classroomId} course={course} initialSceneId={requestedSceneId || selectedOutline?.id}
                previewRefreshKey={previewRefreshKey} onActiveSceneChange={onPreviewSceneChange}
                onSidebarCollapsedChange={setStudentSidebarCollapsed} sidebarCollapsed={studentSidebarCollapsed}/>}/>
            {adaptivePlan && stageKey === "ai-learning" ? <details id="course-learning-path" className={styles.fold}><summary>个性化学习路径 · {activeAdaptiveBranches.length} 条</summary><CoursePublishPathPreview mainScenes={studentOutlines}
              onPreviewBranch={(branch) => changeDetailLocation({ classroomId: branch.preparedResource?.classroomId })} plan={adaptivePlan}/></details> : null}
          </div> : null}
          {view === "materials" ? <div aria-labelledby="publish-tab-materials" id="publish-panel-materials" role="tabpanel"><CourseDetailMaterials course={course} returnTo={currentDetailHref} generationInput={generationInput} generationInputError={generationInputError}/></div> : null}
          {view === "settings" ? <div aria-labelledby="publish-tab-settings" id="publish-panel-settings" role="tabpanel"><CourseDetailSettings course={course} returnTo={currentDetailHref}/></div> : null}
          <div hidden={view !== "checks"} aria-labelledby="publish-tab-checks" id="publish-panel-checks" role="tabpanel" className={styles.checksPanel}>
            <div className={styles.checksHeading}><div><h2>发布前检查</h2><p>查看资源完整性，核对课程建议并确认当前版本。</p></div><span>{resourceAuditLoaded ? `${readyCount}/${requiredChecks.length} 项必要条件就绪` : "正在核对课程资源"}</span></div>
            {reviewRequired && !isTestLesson ? <CourseQualityReview courseId={courseId} returnTo={currentDetailHref}
              onDecisionChange={setReviewDecision} onOpenPage={openReviewPage} onSummaryChange={setReviewSummary} visible={view === "checks"}/>
              : <p className={styles.empty}>{isTestLesson ? "完成全课生成后再确认发布。" : "当前课程无需单独完成教师终审。"}</p>}
            {view === "checks" ? <>
              <PublicationStatusRail auditLoaded={resourceAuditLoaded} auditError={resourceAuditError} checks={prerequisitePublishChecks} course={course}
                checkingTiming={checkingTiming} timingAuditError={timingAuditError}
                missingResourceIssues={missingResourceIssues} onOpenReview={() => selectView("checks")}
                onRecheckTiming={() => void recheckAudioTiming()} onRepairResources={() => void retryMissingResources()}
                onRepairSpeech={() => void repairSpeechSynchronization()} onRetryAudit={() => setResourceRepairVersion((value) => value + 1)}
                repairStatus={resourceRepairStatus} reviewRequired={reviewRequired} reviewSummary={reviewSummary}
                speechStatus={speechSyncStatus} speechSyncIssues={speechSyncIssues} returnTo={currentDetailHref}/>
              <details className={styles.fold}><summary>教学工具执行核对</summary><TeachingToolRunbook classroomId={classroomId} key={resourceRepairVersion} outlines={studentOutlines} title="AI 教学工具执行核对"/></details>
            </> : null}
          </div>
        </div>
      </main>

      {activePreviewBranch?.preparedResource?.classroomId ? <BranchClassroomPreview branch={activePreviewBranch} course={course} onClose={closeBranchPreview}/> : null}
      <FlowActionBar persistent saveStatus={<div className={styles.actionStatus}>
        {!isPublished && publishBlockReason ? <button type="button" onClick={() => selectView("checks")}>{publishBlockReason}<ArrowRight size={14}/></button>
          : <span>{isPublished ? "已发布，可安排到教学班" : readyToPublish ? "课程已就绪，确认后可安排授课" : "正在核对课程资源"}</span>}
      </div>}>
        {isTestLesson ? <Button className="min-h-11" loading={continuingFullCourse} onClick={() => void continueFullCourse()}>{continuingFullCourse ? "正在启动完整课程" : "继续生成完整课程"}</Button>
          : !isPublished ? <Button className="min-h-11" disabled={!readyToPublish || publishing} loading={publishing} onClick={() => void publish()}>{course.content.teachingTimingAudit?.complete && course.content.teachingTimingAudit.narrationDurationSource === "actual-audio" ? "按核查时长确认并发布" : reviewRequired ? "确认并发布" : "发布课程"}</Button>
            : <Button className="min-h-11" onClick={() => router.push(`/teacher/teach/${course.id}/setup`)}>安排到教学班</Button>}
      </FlowActionBar>
    </PreparationShell>
  );
}

function ViewTab({
  active,
  icon,
  id,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  id: PreviewView;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-controls={`publish-panel-${id}`}
      aria-selected={active}
      className={cn(
        "relative inline-flex min-h-11 items-center gap-2 rounded-t-[8px] border-b-2 px-4 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--pbl-teacher)]",
        active
          ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]"
          : "border-transparent text-stone-500 hover:bg-stone-50 hover:text-stone-800",
      )}
      id={`publish-tab-${id}`}
      onClick={onClick}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      {icon}{label}
    </button>
  );
}

const PUBLISH_SECTION_BY_CHECK: Record<string, CourseDesignWorkspaceSectionKey | undefined> = {
  basics: "materials",
  stages: "stage-plan",
  timing: "timing",
  "ai-outline": "blueprint",
  "ai-classroom": "classroom",
  "full-classroom-generation": "classroom",
  "design-workspace-freshness": "classroom",
};

function PublicationStatusRail({
  auditError,
  auditLoaded,
  checks,
  checkingTiming,
  course,
  missingResourceIssues,
  onOpenReview,
  onRecheckTiming,
  onRepairResources,
  onRepairSpeech,
  onRetryAudit,
  repairStatus,
  reviewRequired,
  reviewSummary,
  speechStatus,
  speechSyncIssues,
  timingAuditError,
  returnTo,
}: {
  auditError: string;
  auditLoaded: boolean;
  checks: PublishCheck[];
  checkingTiming: boolean;
  course: Course;
  missingResourceIssues: ResourceRepairIssue[];
  onOpenReview: () => void;
  onRecheckTiming: () => void;
  onRepairResources: () => void;
  onRepairSpeech: () => void;
  onRetryAudit: () => void;
  repairStatus: ResourceRepairStatus;
  reviewRequired: boolean;
  reviewSummary: CourseQualityReviewSummary | null;
  speechStatus: ResourceRepairStatus;
  speechSyncIssues: ResourceRepairIssue[];
  timingAuditError: string;
  returnTo: string;
}) {
  const hasClassroom = Boolean(course.aiLearningClassroomId || course.content._openmaicClassroomId);
  const timing = course.content.moduleTimingPlan;
  const timingAudit = course.content.teachingTimingAudit;
  const measuredAudioSec = timingAudit
    ? timingAudit.substantiveTeachingDurationSec + timingAudit.assessmentAudioDurationSec
    : 0;
  const missingAudioCount = timingAudit?.narrationDurationSource === "actual-audio"
    ? Math.max(0, timingAudit.narrationSegmentCount - timingAudit.measuredSegmentCount)
    : 0;
  const teachingDifferenceSec = timingAudit
    ? timingAudit.substantiveTeachingDurationSec - timingAudit.plannedSubstantiveTeachingSec
    : 0;
  const plannedTeachingSec = timingAudit?.plannedSubstantiveTeachingSec ?? 0;
  const savedReview = course.content.teacherReview;
  const reviewStatus = hasCourseAudioPublicationIdentity(course) || reviewSummary?.status === "audio-updated" ? "audio-updated"
    : savedReview || reviewSummary?.status === "confirmed" ? "confirmed"
    : reviewSummary?.status ?? "loading";
  const reviewLabel = !reviewRequired ? "无需单独终审"
    : reviewStatus === "audio-updated" ? "沿用原内容终审，音频已更新"
      : reviewStatus === "confirmed" ? "当前版本已终审"
      : reviewStatus === "blocked" ? `存在 ${reviewSummary?.blockingCount ?? 0} 项阻断问题`
        : reviewStatus === "attention" ? `还有 ${reviewSummary?.attentionCount ?? 0} 项建议待核对`
          : reviewStatus === "ready" ? "可以确认当前版本"
            : reviewStatus === "error" ? "终审状态读取失败" : "正在读取终审状态";
  const incompleteChecks = checks.filter((item) => !item.done && !item.advisory);
  const advisoryChecks = checks.filter((item) => !item.done && item.advisory);
  const requiredResourceIssues = missingResourceIssues.filter(isTechnicalCourseResourceIssue);
  const resourceNeedsAttention = Boolean(auditError || repairStatus.status === "failed" || missingResourceIssues.length);
  const speechNeedsAttention = !hasClassroom || speechStatus.status === "failed" || speechSyncIssues.length > 0;
  const reviewNeedsAttention = reviewRequired && ["blocked", "attention", "error"].includes(reviewStatus);

  return <aside aria-label="课程发布状态" className={styles.statusRail}>
    <div className="space-y-3">
      {resourceNeedsAttention ? <details open={Boolean(requiredResourceIssues.length || auditError || repairStatus.status === "failed")} className={styles.fold}>
        <summary className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2"><AlertTriangle className={auditError || repairStatus.status === "failed" ? "text-rose-700" : "text-amber-700"} size={17} /><h2 className="text-sm font-black text-stone-950">{requiredResourceIssues.length || auditError ? "课程资源需要处理" : "课程资源核对提示"}</h2></div>
          <StatusBadge tone={auditError || repairStatus.status === "failed" ? "danger" : "warning"}>{auditError ? "读取失败" : repairStatus.status === "failed" ? "补齐失败" : repairStatus.status === "running" ? "补齐中" : requiredResourceIssues.length ? `${requiredResourceIssues.length} 项未就绪` : "不阻断发布"}</StatusBadge>
        </summary>
        {auditError ? <p className="mt-2 text-xs leading-5 text-rose-800">{auditError}</p> : <>
          {repairStatus.status === "failed" ? <p className="mt-2 text-xs leading-5 text-rose-800">{repairStatus.error || "上次资源补齐失败，请重试。"}</p> : null}
          {missingResourceIssues.length ? <ul className="mt-3 space-y-2 text-xs leading-5 text-stone-700">{missingResourceIssues.map((issue) => <li key={issue.id}><strong className="text-stone-950">{issue.title}</strong>：{issue.detail}</li>)}</ul> : null}
        </>}
        {auditError ? <Button className="mt-3 min-h-11 w-full" onClick={onRetryAudit} variant="outline"><RotateCcw size={14} />重新读取</Button> : <>
          <Button className="mt-3 min-h-11 w-full" loading={repairStatus.status === "running"} onClick={onRepairResources} variant="outline"><RotateCcw size={14} />重试缺失资源</Button>
          <Link className="mt-1 inline-flex min-h-11 w-full items-center justify-center text-xs font-bold text-[var(--pbl-teacher)] hover:underline" href={courseEditorHref(course.id, "design", { section: "classroom", returnTo })}>定位并修改</Link>
        </>}
      </details> : <StatusSummaryRow label="课程资源" status={!auditLoaded ? "核对中" : repairStatus.status === "running" ? "补齐中" : "完整"} tone={auditLoaded && repairStatus.status !== "running" ? "success" : "neutral"} />}

      {speechNeedsAttention ? <section className={cn("rounded-[12px] border px-4 py-4", speechStatus.status === "failed" ? "border-rose-200 bg-rose-50/60" : "border-amber-200 bg-amber-50/55")} role={speechStatus.status === "failed" ? "alert" : undefined}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2"><AlertTriangle className={speechStatus.status === "failed" ? "text-rose-700" : "text-amber-700"} size={17} /><h2 className="text-sm font-black text-stone-950">朗读与动作同步</h2></div>
          <StatusBadge tone={speechStatus.status === "failed" ? "danger" : "warning"}>{!hasClassroom ? "待生成" : speechStatus.status === "running" ? `${speechStatus.completed ?? 0}/${speechStatus.total || "…"}` : speechStatus.status === "failed" ? "修复失败" : `${speechSyncIssues.length} 项待处理`}</StatusBadge>
        </div>
        {!hasClassroom ? <p className="mt-2 text-xs leading-5 text-stone-600">生成 AI 课堂后可以核对字幕和指示动作时间线。</p>
          : speechStatus.status === "failed" ? <p className="mt-2 text-xs leading-5 text-rose-800">{speechStatus.error || "同步修复未完成，请稍后重试。"}</p>
            : <ul className="mt-3 space-y-2 text-xs leading-5 text-stone-700">{speechSyncIssues.map((issue) => <li key={issue.id}><strong className="text-stone-950">{issue.title}</strong>：{issue.detail}</li>)}</ul>}
        {hasClassroom ? <Button className="mt-3 min-h-11 w-full" loading={speechStatus.status === "running"} onClick={onRepairSpeech} variant="outline"><RotateCcw size={14} />修复朗读与动作同步</Button> : null}
      </section> : <StatusSummaryRow label="朗读与动作同步" status={speechStatus.status === "running" ? `${speechStatus.completed ?? 0}/${speechStatus.total || "…"}` : "已同步"} tone={speechStatus.status === "running" ? "neutral" : "success"} />}

      {[
        { id: "required", items: incompleteChecks, title: `还需完成 ${incompleteChecks.length} 项`, badge: "影响发布" },
        { id: "advisory", items: advisoryChecks, title: "课程核对提示", badge: "不阻断发布" },
      ].filter((group) => group.items.length > 0).map((group) => <details className={styles.fold} open={group.id === "required"} key={group.id}>
        <summary className="flex items-center justify-between gap-3"><span>{group.title}</span><StatusBadge tone="warning">{group.badge}</StatusBadge></summary>
        <ul className="mt-3 divide-y divide-amber-200/70">{group.items.map((item) => {
          const section = item.id === "design-workspace-freshness" ? course.content.designWorkspaceRevision?.pendingUpdates[0]?.target ?? "classroom" : PUBLISH_SECTION_BY_CHECK[item.id];
          return <li className="py-2.5 first:pt-0 last:pb-0" key={item.id}><p className="text-xs font-bold text-stone-950">{item.label}</p><p className="mt-0.5 text-[11px] leading-5 text-stone-600">{item.detail}</p>{item.id === "timing" && hasClassroom && !timingAudit ? <Button className="mt-2 min-h-11 w-full" disabled={checkingTiming} loading={checkingTiming} onClick={onRecheckTiming} variant="outline" type="button"><RotateCcw size={13} />重新核查全部音频</Button> : null}{section ? <Link className="mt-1 inline-flex min-h-11 items-center gap-1 text-[11px] font-bold text-[var(--pbl-teacher)] hover:underline" href={courseEditorHref(course.id, "design", { section, returnTo })}>定位并修改 <ArrowRight size={11} /></Link> : null}</li>;
        })}</ul>
      </details>)}

      {reviewNeedsAttention ? <section className={cn("rounded-[12px] border px-4 py-4", reviewStatus === "blocked" || reviewStatus === "error" ? "border-rose-200 bg-rose-50/60" : "border-amber-200 bg-amber-50/55")}>
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-black text-stone-950">教师终审</h2><StatusBadge tone={reviewStatus === "blocked" || reviewStatus === "error" ? "danger" : "warning"}>{reviewStatus === "blocked" ? "有阻断" : reviewStatus === "error" ? "读取失败" : "待核对"}</StatusBadge></div>
        <p className="mt-2 text-xs leading-5 text-stone-700">{reviewLabel}</p>
        <Button className="mt-3 min-h-11 w-full" onClick={onOpenReview} variant="outline">查看并处理检查结果</Button>
      </section> : <section className="rounded-[12px] border border-stone-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3"><h2 className="text-sm font-bold text-stone-900">教师终审</h2><StatusBadge tone={reviewStatus === "confirmed" || reviewStatus === "ready" ? "success" : "neutral"}>{reviewStatus === "confirmed" ? "已确认" : reviewStatus === "ready" ? "可确认" : "读取中"}</StatusBadge></div>
        <p className="mt-1 text-xs leading-5 text-stone-500">{reviewLabel}{savedReview ? ` · ${new Date(savedReview.confirmedAt).toLocaleDateString("zh-CN")}` : ""}</p>
        {reviewRequired ? <button className="mt-1 min-h-11 text-xs font-bold text-[var(--pbl-teacher)] hover:underline" onClick={onOpenReview} type="button">打开检查与终审</button> : null}
      </section>}

      <details className={styles.fold} aria-label="课程音频时长核查">
        <summary className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-stone-900">全课音频时长核查</h2>
          <StatusBadge tone={!timingAudit || !timingAudit.complete ? "warning" : timingAudit.narrationDurationSource === "estimated-script" ? "neutral" : timingAudit.teachingRatioValid ? "success" : "warning"}>
            {!timingAudit ? "待核查" : !timingAudit.complete ? "音频未齐" : timingAudit.narrationDurationSource === "estimated-script" ? "讲稿估算" : timingAudit.teachingRatioValid ? "已核查" : "时长有偏差"}
          </StatusBadge>
        </summary>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3">
          <div><dt className="text-[11px] text-stone-500">{missingAudioCount ? "已测音频合计" : "全部音频合计"}</dt><dd className="mt-1 text-sm font-bold text-stone-900">{timingAudit?.narrationDurationSource === "actual-audio" ? secondsLabel(measuredAudioSec) : "待测量"}</dd></div>
          <div><dt className="text-[11px] text-stone-500">AI 阶段总预算</dt><dd className="mt-1 text-sm font-bold text-stone-900">{timing ? `${timing.totalMinutes} 分钟` : "未规划"}</dd></div>
          <div><dt className="text-[11px] text-stone-500">讲授音频 / 教案讲授目标</dt><dd className="mt-1 text-sm font-bold text-stone-900">{timingAudit ? `${secondsLabel(timingAudit.substantiveTeachingDurationSec)} / ${plannedTeachingSec > 0 ? secondsLabel(plannedTeachingSec) : "未单列"}` : "待核查"}</dd></div>
          <div><dt className="text-[11px] text-stone-500">小测音频</dt><dd className="mt-1 text-sm font-bold text-stone-900">{timingAudit?.narrationDurationSource === "actual-audio" ? secondsLabel(timingAudit.assessmentAudioDurationSec) : "待测量"}</dd></div>
        </dl>
        {timingAudit?.narrationDurationSource === "actual-audio" ? <p className={cn("mt-3 text-[11px] leading-5", missingAudioCount || !timingAudit.teachingRatioValid ? "text-amber-800" : "text-stone-600")}>
          {missingAudioCount
            ? `已测量 ${timingAudit.measuredSegmentCount}/${timingAudit.narrationSegmentCount} 段音频，还有 ${missingAudioCount} 段需要补齐。`
            : plannedTeachingSec > 0
              ? `已测量全部 ${timingAudit.narrationSegmentCount} 段音频；讲授部分较教案目标${Math.abs(teachingDifferenceSec) < 0.5 ? "相同" : `${teachingDifferenceSec > 0 ? "多" : "少"} ${secondsLabel(Math.abs(teachingDifferenceSec))}`}（偏差 ${Math.round(Math.abs(teachingDifferenceSec) / plannedTeachingSec * 100)}%）。`
              : `已测量全部 ${timingAudit.narrationSegmentCount} 段音频；教案未单列讲授音频目标。`}
        </p> : <p className="mt-3 text-[11px] leading-5 text-stone-600">{timingAudit ? "当前未启用语音，讲授时长按教案估算。" : "编辑课堂后，请重新核查最新音频时长。"}</p>}
        <p className="mt-1 text-[11px] leading-5 text-stone-500">AI 阶段总预算还包含学生阅读、互动和页面切换时间。</p>
        {timingAuditError ? <p className="mt-2 text-xs text-rose-700" role="alert">{timingAuditError}</p> : null}
        {hasClassroom ? <Button className="mt-3 min-h-11 w-full" disabled={checkingTiming} loading={checkingTiming} onClick={onRecheckTiming} variant="outline" type="button"><RotateCcw size={14} />{checkingTiming ? "正在核查全部音频" : "重新核查全部音频"}</Button> : null}
        {hasClassroom ? <Link className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-[var(--pbl-teacher)] hover:underline" href={courseEditorHref(course.id, "classroom", { returnTo })}>编辑音频与页面<ArrowRight size={15}/></Link> : null}
      </details>

      <PublishReadiness checks={checks} />
    </div>
  </aside>;
}

function StatusSummaryRow({ label, status, tone }: { label: string; status: string; tone: "neutral" | "success" }) {
  return <section className="flex min-h-12 items-center justify-between gap-3 rounded-[12px] border border-stone-200 bg-white px-4 py-2.5"><h2 className="text-sm font-bold text-stone-900">{label}</h2><StatusBadge tone={tone}>{status}</StatusBadge></section>;
}

function StatusBadge({ children, tone }: { children: React.ReactNode; tone: "neutral" | "success" | "warning" | "danger" }) {
  return <span className={cn(
    "shrink-0 rounded-full px-2 py-1 text-[10px] font-bold",
    tone === "success" ? "bg-emerald-50 text-emerald-700" : tone === "warning" ? "bg-amber-100 text-amber-900" : tone === "danger" ? "bg-rose-100 text-rose-800" : "bg-stone-100 text-stone-600",
  )}>{children}</span>;
}

function PublishReadiness({ checks }: { checks: PublishCheck[] }) {
  const requiredChecks = checks.filter((item) => !item.advisory);
  const readyCount = requiredChecks.filter((item) => item.done).length;
  return (
    <details className="overflow-hidden rounded-[12px] border border-stone-200 bg-white">
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2.5 text-sm font-bold text-stone-700 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--pbl-teacher)]"><span>查看发布条件与核对提示</span><span className="text-xs font-semibold text-stone-500">{readyCount}/{requiredChecks.length}</span></summary>
      <ul className="divide-y divide-stone-100 border-t border-stone-200">{checks.map((item) => <li className="flex gap-2.5 px-4 py-3" key={item.id}><span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full", item.done ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700")}>{item.done ? <Check size={12} /> : <AlertTriangle size={11} />}</span><div><p className="text-xs font-bold text-stone-900">{item.label}{item.advisory ? <span className="ml-2 font-normal text-stone-500">教师参考</span> : null}</p><p className="mt-0.5 text-[11px] leading-5 text-stone-500">{item.detail}</p></div></li>)}</ul>
    </details>
  );
}

function StudentClassroomExperience({
  classroomId, course, initialSceneId, previewRefreshKey, onActiveSceneChange, onSidebarCollapsedChange, sidebarCollapsed,
}: {
  classroomId?: string; course: Course; initialSceneId?: string; previewRefreshKey: string;
  onActiveSceneChange: (scene: Scene) => void; onSidebarCollapsedChange: (collapsed: boolean) => void; sidebarCollapsed: boolean;
}) {
  return <section aria-label="学生课堂课前预览" className={styles.previewSurface}>
    {classroomId ? <StudentStageHost backHref={courseDetailHref(course.id, { view: "content", stage: "ai-learning", sceneId: initialSceneId })}
      className={styles.studentPlayer} classroomId={classroomId} courseId={course.id} initialSceneId={initialSceneId}
      previewRefreshKey={previewRefreshKey} knowledgeGraph={course.content.knowledgeGraph} knowledgePoints={course.content.knowledgePoints}
      courseMindMap={course.content.courseMindMap} mode="teacher-preview" onActiveSceneChange={onActiveSceneChange}
      onSidebarCollapsedChange={onSidebarCollapsedChange} sidebarCollapsed={sidebarCollapsed} variant="embedded"/>
      : <div className={styles.previewEmpty}><Gauge size={32}/><h3>学习页面尚未生成</h3><p>完成课程生成后，可以在这里查看课件、音频、小测和互动内容。</p>
        <Link className={styles.textAction} href={`/teacher/prepare/${encodeURIComponent(course.id)}/verify`}>继续生成课程<ArrowRight size={15}/></Link></div>}
    <p className={styles.previewNote}>课前预览使用实际课堂内容，操作不会记录为学生学习进度。</p>
  </section>;
}

function BranchClassroomPreview({
  branch,
  course,
  onClose,
}: {
  branch: AdaptiveBranchOutline;
  course: Course;
  onClose: () => void;
}) {
  const classroomId = branch.preparedResource?.classroomId;
  if (!classroomId) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={undefined} showCloseButton={false} className={cn("pbl-platform-theme flex h-[min(900px,calc(100dvh-24px))] w-[calc(100vw-24px)] max-w-[1220px] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[1220px]", preparationThemeClassName)}>
        <header className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-3">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-800">个性化插入资源 · 学生实景</p>
            <DialogTitle className="mt-0.5 text-sm font-black text-stone-900">{branch.title}</DialogTitle>
          </div>
          <button aria-label="关闭课堂实景" className="grid size-11 shrink-0 place-items-center rounded-full text-stone-500 hover:bg-stone-100" onClick={onClose} type="button"><X size={18} /></button>
        </header>
        <StudentStageHost
          backHref={`/teacher/prepare/${course.id}/preview`}
          classroomId={classroomId}
          className="min-h-0 flex-1"
          mode="teacher-preview"
          standalone
          variant="embedded"
        />
      </DialogContent>
    </Dialog>
  );
}
