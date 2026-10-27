"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Clock3,
  Copy,
  Eye,
  Lightbulb,
  LoaderCircle,
  MessagesSquare,
  QrCode,
  Square,
  Users,
} from "lucide-react";
import { DashboardShell, Avatar } from "@/components/dashboard-shell";
import { StageGateDialog } from "@/components/classroom/classroom-chrome";
import { TeacherStageView } from "@/components/views/teacher/stage-dispatcher";
import { RealtimeTeachingActions } from "@/components/classroom/teacher-stage-dashboard";
import { TeacherProjectAnalytics } from "@/components/classroom/teacher-project-analytics";
import { TeacherKnowledgeAnalytics, TeacherPresentationAnalytics } from "@/components/classroom/teacher-presentation-analytics";
import { TeacherClassroomReview, type ClassroomReviewFocus } from "@/components/classroom/teacher-knowledge-review";
import { TeacherPresentationControls, TeacherPresentationHeader } from "@/components/classroom/teacher-presentation-chrome";
import { TeacherPresentationActionsProvider } from "@/components/classroom/teacher-presentation-actions";
import { LaunchReadingFollowUp } from "@/components/classroom/simple-stage-resources";
import { TeacherOperationDrawer } from "@/components/classroom/teacher-operation-details";
import { PublicDiscussionTeacherWorkspace } from "@/components/views/teacher/public-discussion-workspace";
import presentationStyles from "@/components/classroom/teacher-presentation.module.css";
import { useTeacherPresentation } from "@/hooks/use-teacher-presentation";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle, Button, Dialog, DialogContent, DialogDescription, DialogTitle, SaveStatus } from "@/components/ui";
import { buttonVariants } from "@/components/ui/button";
import { useSession, useCourse, useHydrated } from "@/lib/session/store";
import { cn } from "@/lib/utils";
import { evaluateStageGate } from "@/lib/classroom/stage-gates";
import { makeRecordId } from "@/lib/session/actions";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { useShowcasePresentation } from "@/hooks/use-showcase-presentation";
import { useCoursePresence } from "@/hooks/use-course-presence";
import { deriveStageReadiness } from "@/lib/learning-evidence/readiness";
import { STAGE_READINESS_LABEL } from "@/lib/learning-evidence/types";
import {
  adjustClassroomStageTiming,
  deriveClassroomTimingSnapshot,
  pauseClassroomTiming,
  resetActiveClassroomStageTiming,
  resumeClassroomTiming,
  transitionClassroomStageTiming,
  type ClassroomTimingState,
} from "@/lib/classroom/timing";
import { copyTextToClipboard } from "@/lib/browser/copy-text";
import { normalizeInviteCode } from "@/lib/session/invite-code";
import type { TeacherStageFocus } from "@/lib/classroom/teacher-dashboard-metrics";
import type { Course } from "@/lib/session/types";
import { defaultTeacherPresentationView, type TeacherPresentationView } from "@/lib/classroom/presentation";
import {
  TimerPanel,
} from "./classroom-page-parts";

type StageTransitionScope = {
  id: string;
  owner: string;
  courseId: string;
  targetIndex: number;
  stageKey: string;
  label: string;
};
type StageTransitionState = { scope: StageTransitionScope; saving: boolean; error?: string };

// Keep an unconfirmed transition across client navigation while SessionProvider
// retains its optimistic course. The audit ID prevents reuse for another stage command.
const pendingStageTransitions = new Map<string, StageTransitionState>();

function retainedStageTransition(course: Course | undefined, actor: string): StageTransitionState | null {
  if (!course) return null;
  const owner = JSON.stringify([actor, course.id]);
  const pending = pendingStageTransitions.get(owner);
  if (!pending) return null;
  if (course.status === "teaching" && course.currentStageIndex === pending.scope.targetIndex
    && course.stages[course.currentStageIndex]?.key === pending.scope.stageKey
    && course.stageTransitions?.at(-1)?.id === pending.scope.id) return pending;
  pendingStageTransitions.delete(owner);
  return null;
}

export default function TeachClassroomPage() {
  const params = useParams<{ id: string }>();
  // A route change retires pending save callbacks even when Next reuses this page.
  return <ClassroomPage key={params.id} courseId={params.id} />;
}

function ClassroomPage({ courseId }: { courseId: string }) {
  const router = useRouter();
  const session = useSession();
  const { user, endTeaching, updateCourse, setUiState, initializeClassroomTiming, flushSaves, retrySave, saveState, saveError } = session;
  const course = useCourse(courseId);
  useRealtimeSync(courseId);
  const presence = useCoursePresence({
    courseId: course?.id,
    role: "teacher",
    enabled: course?.status === "teaching",
  });
  const hydrated = useHydrated();
  const [nowTick, setNowTick] = useState(0);
  const [targetStageIndex, setTargetStageIndex] = useState<number | null>(null);
  const [stageTransition, setStageTransition] = useState<StageTransitionState | null>(() => retainedStageTransition(course, user.name));
  const transitionRef = useRef<{ scope: StageTransitionScope; running: boolean } | null>(stageTransition ? { scope: stageTransition.scope, running: false } : null);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string>();
  const [endDialogOpen, setEndDialogOpen] = useState(false);
  const [dashboardFocus, setDashboardFocus] = useState<TeacherStageFocus>();
  const presentation = useTeacherPresentation();
  const presentationStage = course?.stages[course.currentStageIndex];
  const presentationStageScope = `${course?.id}:${course?.currentStageIndex}:${presentationStage?.key}`;
  const [appliedPresentationStage, setAppliedPresentationStage] = useState(presentationStageScope);
  const [reviewFocus, setReviewFocus] = useState<ClassroomReviewFocus>();
  const [practiceStudentId, setPracticeStudentId] = useState<string>();
  const [presentationView, setPresentationView] = useState<TeacherPresentationView>(() => defaultTeacherPresentationView(presentationStage));
  if (appliedPresentationStage !== presentationStageScope) {
    setAppliedPresentationStage(presentationStageScope);
    setPresentationView(defaultTeacherPresentationView(presentationStage));
    setReviewFocus(undefined);
    setPracticeStudentId(undefined);
  } else if ((presentationView === "student-work" && presentationStage?.view !== "ai-collaboration") || (presentationView === "classroom-review" && presentationStage?.key !== "ai-learning")) {
    setPresentationView(defaultTeacherPresentationView(presentationStage));
  }
  const [presentationDetails, setPresentationDetails] = useState(false);
  const [presentationDiscussion, setPresentationDiscussion] = useState(false);
  const [stageActionsTarget, setStageActionsTarget] = useState<HTMLDivElement | null>(null);
  const [stageLeadingActionsTarget, setStageLeadingActionsTarget] = useState<HTMLDivElement | null>(null);
  const [launchReadingOpen, setLaunchReadingOpen] = useState(false);
  const [presentationTool, setPresentationTool] = useState<"timer" | "advice" | "tools" | "invite" | "students" | null>(null);
  const displayScope = `${course?.id}:${course?.currentStageIndex}:${presentationView}`;
  const [appliedDisplayScope, setAppliedDisplayScope] = useState(displayScope);
  if (appliedDisplayScope !== displayScope) {
    setAppliedDisplayScope(displayScope);
    setPresentationDetails(false);
    setPresentationDiscussion(false);
    setPresentationTool(null);
    setLaunchReadingOpen(false);
  }
  const showcaseController = useShowcasePresentation(
    !stageTransition && course?.status === "teaching" && course.stages[course.currentStageIndex]?.key === "showcase" ? course.id : undefined,
  );

  useEffect(() => () => { transitionRef.current = null; }, []);

  const finishStageTransition = useCallback(async (scope: StageTransitionScope, retry: boolean) => {
    try {
      if (retry) await retrySave();
      const saved = await flushSaves();
      if (!saved) throw new Error("阶段切换尚未保存，请重试。");
      if (pendingStageTransitions.get(scope.owner)?.scope === scope) pendingStageTransitions.delete(scope.owner);
      if (transitionRef.current?.scope !== scope) return;
      transitionRef.current = null;
      setStageTransition(null);
    } catch (error) {
      const failed = { scope, saving: false, error: error instanceof Error ? error.message : "阶段切换未完成，请重试。" };
      if (pendingStageTransitions.get(scope.owner)?.scope === scope) pendingStageTransitions.set(scope.owner, failed);
      if (transitionRef.current?.scope !== scope) return;
      transitionRef.current.running = false;
      setStageTransition(failed);
    }
  }, [flushSaves, retrySave]);

  useEffect(() => {
    // Strict Effects replay retires refs without discarding the retained state.
    if (!transitionRef.current && stageTransition) transitionRef.current = { scope: stageTransition.scope, running: false };
    const pending = transitionRef.current;
    if (stageTransition?.saving && pending && !pending.running) {
      pending.running = true;
      void finishStageTransition(pending.scope, false);
    }
  }, [finishStageTransition, stageTransition]);

  useEffect(() => {
    const pending = transitionRef.current;
    if (pending && (course?.id !== pending.scope.courseId || course.status !== "teaching"
      || course.currentStageIndex !== pending.scope.targetIndex
      || course.stages[course.currentStageIndex]?.key !== pending.scope.stageKey)) {
      if (pendingStageTransitions.get(pending.scope.owner)?.scope === pending.scope) pendingStageTransitions.delete(pending.scope.owner);
      transitionRef.current = null;
      setStageTransition(null);
    }
  }, [course]);

  useEffect(() => {
    if (!hydrated) return;
    if (course && course.status !== "teaching" && !ending && (course.status !== "finished" || (saveState !== "saving" && saveState !== "error"))) router.replace(course.status === "finished" ? `/teacher/classrooms/${course.id}` : `/teacher/teach/${course.id}/setup`);
  }, [course, hydrated, router, ending, saveState]);

  useEffect(() => {
    if (!course || course.status !== "teaching") return;
    const id = window.setInterval(() => setNowTick((t) => t + 1), 1_000);
    return () => window.clearInterval(id);
  }, [course]);

  useEffect(() => {
    if (
      !course
      || course.status !== "teaching"
      || course.uiState?.classroomTiming
    ) {
      return;
    }
    void initializeClassroomTiming(course.id);
  }, [course, initializeClassroomTiming]);

  const onlineCount = course?.students.filter((student) =>
    presence.onlineStudentIds.has(student.id)
  ).length ?? 0;

  const timingSnapshot = useMemo(() => {
    void nowTick;
    const timing = course?.uiState?.classroomTiming;
    return timing
      ? deriveClassroomTimingSnapshot(timing, new Date().toISOString())
      : undefined;
  }, [course?.uiState?.classroomTiming, nowTick]);

  if (!hydrated) {
    return (
      <DashboardShell backHref={`/teacher/teach/${encodeURIComponent(courseId)}/setup`} backLabel="返回教学工作台" role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">加载中...</div>
      </DashboardShell>
    );
  }

  if (!course) {
    return (
      <DashboardShell backHref="/teacher/classes" backLabel="返回教学班" role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">
          未找到课程。
          <Link className="mt-4 text-blue-700 hover:underline" href="/teacher/classes">返回教学班</Link>
        </div>
      </DashboardShell>
    );
  }

  const currentStage = course.stages[course.currentStageIndex];
  async function endClass() {
    if (!course || ending || transitionRef.current) return;
    setEnding(true);
    setEndError(undefined);
    try {
      if (saveState === "error") await retrySave();
      if (!await flushSaves()) throw new Error("课堂数据尚未保存，请重试");
      if (course.status !== "finished") endTeaching(course.id);
      if (!await flushSaves()) throw new Error("结束课堂未保存，请重试");
      setEndDialogOpen(false);
      router.replace(`/teacher/classrooms/${course.id}`);
    } catch (error) { setEndError(error instanceof Error ? error.message : "结束课堂失败"); }
    finally { setEnding(false); }
  }

  function persistClassroomTiming(classroomTiming: ClassroomTimingState) {
    if (!course || transitionRef.current) return;
    setUiState(course.id, { classroomTiming });
  }

  function toggleClassroomTimer() {
    if (!course) return;
    const timing = course.uiState?.classroomTiming;
    if (!timing) return;
    persistClassroomTiming(
      timing.status === "paused"
        ? resumeClassroomTiming(timing)
        : pauseClassroomTiming(timing),
    );
  }

  function adjustActiveStage(deltaSec: number) {
    if (!course) return;
    const timing = course.uiState?.classroomTiming;
    if (!timing?.activeStageKey) return;
    persistClassroomTiming(
      adjustClassroomStageTiming(timing, timing.activeStageKey, deltaSec),
    );
  }

  function resetActiveStageTimer() {
    if (!course) return;
    const timing = course.uiState?.classroomTiming;
    if (!timing) return;
    persistClassroomTiming(resetActiveClassroomStageTiming(timing));
  }


  function requestStage(index: number) {
    if (!course || ending || transitionRef.current) return;
    if (index < 0 || index >= course.stages.length || index === course.currentStageIndex) return;
    setTargetStageIndex(index);
  }

  function confirmStage() {
    if (!course || targetStageIndex === null || ending || transitionRef.current) return;
    const gate = evaluateStageGate(course);
    const gateOverridden = targetStageIndex > course.currentStageIndex && !gate.canAdvance;
    const from = course.stages[course.currentStageIndex];
    const to = course.stages[targetStageIndex];
    const scope: StageTransitionScope = {
      id: makeRecordId("transition"), owner: JSON.stringify([user.name, course.id]), courseId: course.id,
      targetIndex: targetStageIndex, stageKey: to.key, label: to.key === "showcase" ? "成果汇报" : to.label,
    };
    const transitionAt = new Date().toISOString();
    const classroomTiming = course.uiState?.classroomTiming
      ? transitionClassroomStageTiming(
          course.uiState.classroomTiming,
          to.key,
          transitionAt,
        )
      : undefined;
    // Establish the barrier before the optimistic course update mounts its view.
    transitionRef.current = { scope, running: true };
    pendingStageTransitions.set(scope.owner, { scope, saving: true });
    setStageTransition({ scope, saving: true });
    updateCourse(course.id, {
      currentStageIndex: targetStageIndex,
      stageTransitions: [...(course.stageTransitions ?? []), {
        id: scope.id,
        baseStageVersion: course.stageVersion,
        fromStageKey: from.key,
        toStageKey: to.key,
        gateStatus: gateOverridden ? "overridden" : "passed",
        blockers: gate.blockers.map((item) => item.message),
        warnings: gate.warnings.map((item) => item.message),
        actor: user.name,
        createdAt: transitionAt,
      }],
      uiState: {
        ...(course.uiState ?? {}),
        teacherResourceProjection: null,
        resourceProjection: null,
        ...(classroomTiming ? { classroomTiming } : {}),
      },
    });
    setTargetStageIndex(null);
    setDashboardFocus(undefined);
    setPresentationTool(null);
    void finishStageTransition(scope, false);
  }

  async function retryClassroomSave() {
    const pending = transitionRef.current;
    if (!pending) return retrySave();
    if (pending.running) return;
    pending.running = true;
    pendingStageTransitions.set(pending.scope.owner, { scope: pending.scope, saving: true });
    setStageTransition({ scope: pending.scope, saving: true });
    await finishStageTransition(pending.scope, true);
  }

  const isolatedView = presentationView === "analytics" || presentationView === "classroom-review";
  const stageHidden = presentationDiscussion || (currentStage?.key !== "reflection" && isolatedView && !presentationDetails);

  return (
    <TeacherPresentationActionsProvider target={!presentationDiscussion && !stageHidden ? stageActionsTarget : null} leadingTarget={!stageHidden && currentStage?.key === "launch" ? stageLeadingActionsTarget : null}>
    <DashboardShell role="teacher" userName={user.name} variant="bare" immersive hideAiSettings hideNotifications>
      <div className={cn("teacher-presentation", presentationStyles.shell)} data-stage={currentStage?.key}>
      <TeacherPresentationHeader
        course={course} degraded={presence.degraded} onlineCount={onlineCount}
        fullscreen={presentation.active} onFullscreen={() => void (presentation.active ? presentation.exit() : presentation.enter())}
        fullscreenNotice={presentation.notice}
        timing={timingSnapshot} onTogglePause={toggleClassroomTimer} onResetTimer={resetActiveStageTimer}
        saveStatus={<SaveStatus lastSavedAt={session.lastSavedAt} onRetry={() => void retryClassroomSave()} state={stageTransition?.saving ? "saving" : saveState} />}
      />

      {/* The same classroom surface is mounted in windowed and fullscreen views. */}
      <div className={cn(presentationStyles.body, presentationView === "student-work" && !presentationDetails && presentationStyles.studentWorkBody, currentStage?.key === "showcase" && presentationStyles.showcaseBody)}>
        {/* 中间：阶段控制 + 横幅 + 阶段视图 */}
        <div className={presentationStyles.content}>
          {stageTransition ? <section className="pbl-card grid min-h-56 place-items-center rounded-[var(--radius-lg)] p-4" aria-busy={stageTransition.saving}>
            {stageTransition.saving ? <p role="status" className="inline-flex items-center gap-2 text-sm text-[var(--pbl-text-muted)]"><LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={18} />正在切换到{stageTransition.scope.label}…</p>
              : <div role="alert" className="space-y-3 text-center text-sm"><p className="text-[var(--pbl-danger)]">{saveError ?? stageTransition.error}</p><Button onClick={() => void retryClassroomSave()}>重试阶段切换</Button></div>}
          </section> : <>
          {currentStage?.key === "ai-learning" ? (
            <PublicDiscussionTeacherWorkspace course={course} hidden={!presentationDiscussion} />
          ) : null}

          {currentStage && currentStage.key !== "reflection" && currentStage.key !== "ai-learning" && currentStage.key !== "make" && !presentationDiscussion && presentationView === "analytics" && !presentationDetails ? <TeacherPresentationAnalytics course={course} stageKey={currentStage.key} showcaseData={showcaseController.data} degraded={presence.degraded} onDetails={() => {
            if (currentStage.key === "launch") setLaunchReadingOpen(true);
            else if (currentStage.key === "showcase") { setPresentationDetails(false); setPresentationView("teaching"); }
            else setPresentationDetails(true);
          }} onStudentDetails={(studentId) => { setDashboardFocus({ stageKey: "ai-learning", target: "student", studentId, tab: "trajectory" }); setPresentationDetails(true); }} /> : null}

          {currentStage?.key === "make" ? <TeacherProjectAnalytics key={`project-analytics:${presentationStageScope}`} course={course} active={!presentationDiscussion && presentationView === "analytics"} degraded={presence.degraded}
            onStudentWork={(studentId) => { setPracticeStudentId(studentId); setPresentationDetails(false); setPresentationView("student-work"); }} /> : null}

          {currentStage?.key === "ai-learning" ? <>
            <TeacherKnowledgeAnalytics key={`analytics:${presentationStageScope}`} course={course} degraded={presence.degraded} active={!presentationDiscussion && presentationView === "analytics"}
              onQuestionReview={() => { setReviewFocus((previous) => ({ sequence: (previous?.sequence ?? 0) + 1 })); setPresentationView("classroom-review"); }}
              onKnowledgeReview={(pointId) => { setReviewFocus((previous) => ({ sequence: (previous?.sequence ?? 0) + 1, pointId })); setPresentationView("classroom-review"); }} />
            <TeacherClassroomReview key={`review:${presentationStageScope}:${course.aiLearningClassroomId}`} course={course} degraded={presence.degraded} active={!presentationDiscussion && presentationView === "classroom-review"} focus={reviewFocus} />
          </> : null}

          {currentStage ? (
            <section
              className={cn("classroom-stage", presentationStyles.stage)}
              data-details={presentationDetails}
              hidden={stageHidden}
              key={currentStage.key}
            >
              <TeacherStageView
                active={!stageHidden}
                selectedPracticeStudentId={practiceStudentId}
                onSelectStudent={setPracticeStudentId}
                course={course}
                focus={dashboardFocus}
                showcaseController={showcaseController}
                fullscreen={presentation}
                view={currentStage.view}
                presentation={presentationDetails && currentStage.key !== "make" && currentStage.key !== "showcase" ? "workspace" : presentationView === "student-work" ? "teaching" : isolatedView ? "analytics" : "teaching"}
                showStudentWork={!presentationDetails && presentationView === "student-work"}
                immersive
                projectTimerControls={{ onTogglePause: toggleClassroomTimer, onAdjust: adjustActiveStage, onReset: resetActiveStageTimer }}
              />
            </section>
          ) : null}
          </>}
        </div>

      </div>

      <TeacherPresentationControls
        stageTransitionPending={Boolean(stageTransition) || ending}
        stageActionsRef={setStageActionsTarget}
        leadingActionsRef={setStageLeadingActionsTarget}
        course={course}
        view={presentationView}
        details={presentationDetails}
        discussion={presentationDiscussion}
        onView={(view) => { setPresentationDetails(false); setPresentationDiscussion(false); setDashboardFocus(undefined); setPresentationView(view); }}
        onWorkspace={() => { if (currentStage?.key === "make" || currentStage?.key === "showcase") return; setPresentationDiscussion(false); setPresentationDetails(true); }}
        onDetailsClose={() => { setPresentationDetails(false); setPresentationDiscussion(false); setDashboardFocus(undefined); }}
        onStage={requestStage}
        onTools={() => setPresentationTool("tools")}
        onEnd={() => setEndDialogOpen(true)}
      />

      <TeacherOperationDrawer open={currentStage?.key === "launch" && launchReadingOpen} onOpenChange={setLaunchReadingOpen} title="资料阅读明细" description="查看本阶段学生的资料阅读状态。">
        <LaunchReadingFollowUp course={course} />
      </TeacherOperationDrawer>

      <Dialog open={presentationTool !== null} onOpenChange={(open) => { if (!open) setPresentationTool(null); }}>
        <DialogContent className={presentationStyles.dialog}>
          <DialogTitle>{presentationTool === "timer" ? "课堂计时" : presentationTool === "advice" ? "教学建议" : presentationTool === "invite" ? "学生邀请码" : presentationTool === "students" ? "在线学生" : "课堂工具"}</DialogTitle>
          <DialogDescription>{currentStage?.label} · {course.name}</DialogDescription>
          {presentationTool === "timer" ? <TimerPanel snapshot={timingSnapshot} onTogglePause={toggleClassroomTimer} onReset={resetActiveStageTimer} onAdjust={adjustActiveStage} /> : presentationTool === "advice" ? <div className={presentationStyles.advice}><RealtimeTeachingActions course={course} stageKey={currentStage?.key ?? "launch"} /></div> : null}
          {presentationTool === "tools" ? <div className={cn("grid gap-3 sm:grid-cols-2", presentationStyles.tools)}>
            <Button onClick={() => setPresentationTool("timer")} variant="outline"><Clock3 size={18} />课堂计时</Button>
            <Button onClick={() => setPresentationTool("invite")} variant="outline"><QrCode size={18} />学生邀请码</Button>
            <Button onClick={() => setPresentationTool("students")} variant="outline"><Users size={18} />在线学生</Button>
            <Link className={buttonVariants({ variant: "outline" })} href={`/teacher/prepare/${course.platformContext?.templateId ?? course.id}/preview`} target="_blank" rel="noopener noreferrer"><Eye size={18} />查看课程</Link>
            <Button onClick={() => setPresentationTool("advice")} variant="outline"><Lightbulb size={18} />教学建议</Button>
            {currentStage?.key === "ai-learning" ? <Button aria-pressed={presentationDiscussion} onClick={() => { setPresentationTool(null); setPresentationDetails(false); setPresentationDiscussion(true); setDashboardFocus(undefined); }} variant="outline"><MessagesSquare size={18} />AI 公开讨论</Button> : null}
            {course.currentStageIndex < course.stages.length - 1 ? <Button disabled={Boolean(stageTransition) || ending} onClick={() => { setPresentationTool(null); setEndDialogOpen(true); }} variant="outline" className="text-red-800"><Square size={18} />结束课堂</Button> : null}
          </div> : null}
          {presentationTool === "invite" ? <InvitePanel code={course.inviteCode} onCopy={() => course.inviteCode ? copyTextToClipboard(normalizeInviteCode(course.inviteCode)).then(() => true, () => false) : Promise.resolve(false)} accessHref={`/teacher/classes/${course.platformContext?.offeringId ?? ""}/access`} /> : null}
          {presentationTool === "students" ? <StudentsPanel course={course} currentStageKey={currentStage?.key} onlineStudentIds={presence.onlineStudentIds} /> : null}
        </DialogContent>
      </Dialog>

      {targetStageIndex !== null ? <StageGateDialog course={course} onConfirm={confirmStage} onOpenChange={(open) => { if (!open) setTargetStageIndex(null); }} open targetIndex={targetStageIndex} presentation /> : null}

      <AlertDialog onOpenChange={setEndDialogOpen} open={endDialogOpen}>
        <AlertDialogContent className={presentationStyles.dialog}>
          <AlertDialogTitle>结束本次课堂？</AlertDialogTitle>
          <AlertDialogDescription>课堂结束后学生将进入只读回看。结束前请确认授课资源和项目实践产物已经保存；保存成功后将进入课堂学习记录。</AlertDialogDescription>
          {endError ? <div role="alert" className="space-y-2 text-sm text-red-700">
            <p>{endError}</p>
            {saveError ? <p>{saveError}</p> : null}
            <p>可再次点击“结束课堂”重试，保存成功后才会结束。</p>
          </div> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>继续授课</AlertDialogCancel>
            <Button disabled={ending || Boolean(stageTransition)} onClick={() => void endClass()}>{ending ? "正在结束…" : "结束课堂"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>


      </div>
    </DashboardShell>
    </TeacherPresentationActionsProvider>
  );
}

function InvitePanel({
  code,
  onCopy,
  accessHref,
}: {
  code?: string;
  onCopy: () => Promise<boolean>;
  accessHref: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    setCopyState(await onCopy() ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <div>
      <div className="mb-2.5 pr-8">
        <div className="text-base font-bold text-stone-900">学生邀请码</div>
        <p className="mt-0.5 text-[13px] text-stone-500">学生凭教学班邀请码加入课程，再进入本课堂</p>
      </div>
      {code ? (
        <>
          <div className="text-center">
            <div className="font-mono text-[30px] font-bold tracking-[0.18em] text-stone-900">
              {code.slice(0, 3)} {code.slice(3, 6)}
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            <button
              className="inline-flex h-9 items-center justify-center gap-1 rounded-[var(--radius-xs)] bg-[var(--pbl-teacher)] text-xs font-semibold text-white transition hover:bg-[var(--pbl-teacher-hover)]"
              onClick={() => void copy()}
              type="button"
            >
              {copyState === "copied" ? <CheckCircle2 size={13} /> : <Copy size={13} />}
              {copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制"}
            </button>
            <Link className="inline-flex h-9 items-center justify-center gap-1 rounded-[var(--radius-xs)] border border-stone-200 bg-white text-xs font-semibold text-stone-600" href={accessHref}>邀请设置</Link>
          </div>
        </>
      ) : (
        <div className="py-6 text-center text-sm text-stone-500">暂未生成邀请码</div>
      )}
    </div>
  );
}

function StudentsPanel({
  course,
  currentStageKey,
  onlineStudentIds,
}: {
  course: NonNullable<ReturnType<typeof useCourse>>;
  currentStageKey?: string;
  onlineStudentIds: ReadonlySet<string>;
}) {
  const total = course.students.length;
  const online = course.students.filter((student) => onlineStudentIds.has(student.id)).length;
  return (
    <div>
      <div className="mb-2.5 flex items-center justify-between gap-2 pr-8">
        <div>
          <div className="text-base font-bold text-stone-900">在线学生</div>
          <p className="mt-0.5 text-[13px] text-stone-500">{online} 在线 / {total} 总数</p>
        </div>
        <span className="inline-flex h-6 items-center gap-1 rounded-full bg-[var(--pbl-success-soft)] px-2 text-[11px] font-bold text-[var(--pbl-success)] ring-1 ring-green-200">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--pbl-success)]" />
          {online} / {total}
        </span>
      </div>
      {total === 0 ? (
        <div className="py-6 text-center text-sm text-stone-500">
          <Users className="mx-auto mb-1 text-stone-300" size={20} />
          暂无学生加入
        </div>
      ) : (
        <ul className="max-h-[300px] space-y-1.5 overflow-auto pr-1">
          {[...course.students]
            .sort((a, b) => {
              const aOnline = onlineStudentIds.has(a.id);
              const bOnline = onlineStudentIds.has(b.id);
              if (aOnline !== bOnline) return aOnline ? -1 : 1;
              return 0;
            })
            .map((s) => {
              const readiness = currentStageKey
                ? deriveStageReadiness(course, s.id, currentStageKey)
                : null;
              const sOnline = onlineStudentIds.has(s.id);
              return (
                <li
                  className="flex items-center gap-2 rounded-[var(--radius-xs)] border border-stone-200 bg-white/70 px-2.5 py-2"
                  key={s.id}
                >
                  <Avatar name={s.name} size={28} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-stone-800">
                    {s.name}
                  </span>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      sOnline ? "bg-[var(--pbl-success)]" : "bg-stone-300",
                    )}
                    title={sOnline ? "在线" : "离线"}
                  />
                  <span className="shrink-0 text-right text-[11px] font-bold text-stone-600">
                    {readiness ? STAGE_READINESS_LABEL[readiness.status] : "未开始"}
                  </span>
                </li>
              );
            })}
        </ul>
      )}
    </div>
  );
}

/* ============================================================
   数据面板卡
   ============================================================ */
