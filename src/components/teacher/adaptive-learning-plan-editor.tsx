"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  CircleGauge,
  FileQuestion,
  GripVertical,
  Layers3,
  MousePointer2,
  PlaySquare,
  RotateCw,
  Sparkles,
} from "lucide-react";
import type {
  AdaptiveBranchOutline,
  AdaptiveLearningPlan,
  KnowledgeGraph,
  KnowledgePoint,
  OpenMaicSceneOutlineSnapshot,
} from "@/lib/session/types";
import {
  adaptiveResourceAddsNovelContent,
  buildAdaptiveResourceRequirement,
  deriveMasteryAssessmentSceneIds,
  evaluateAdaptiveLearningPlanQuality,
  hasCompleteAdaptivePrerequisiteLoop,
} from "@/lib/adaptive-learning";
import { generateAdaptiveClassroom } from "@/lib/adaptive-learning-client";
import { adaptiveBranchGenerationSignature } from "@/lib/teacher/adaptive-resource-generation";
import { cn } from "@/lib/utils";
import {
  CourseGenerationGlyph,
} from "@/components/course-workshop-animation";
import { StageGenerationCardStack } from "@/components/teacher/stage-generation-card-stack";

type AdaptiveMainScene = Pick<
  OpenMaicSceneOutlineSnapshot,
  "id" | "title" | "type" | "order" | "stageKey" | "audience" | "knowledgePointIds"
>;

type CourseInsertionSlot = {
  assessmentSceneId?: string;
  beforeSceneId?: string;
  id: string;
  label: string;
  placement: "before-main-course" | "after-module";
};

const RESOURCE_LABEL: Record<AdaptiveBranchOutline["kind"], string> = {
  prerequisite: "先决知识回顾",
  "worked-example": "新例题",
  application: "应用举例",
  extension: "拓展与思考",
};

function resourceKind(branch: AdaptiveBranchOutline): AdaptiveBranchOutline["kind"] {
  return (branch.kind as string) === "foundation" ? "prerequisite" : branch.kind;
}

function resourceLabel(branch: AdaptiveBranchOutline): string {
  return RESOURCE_LABEL[resourceKind(branch)] ?? "额外学习资源";
}

export function AdaptiveLearningPlanEditor({
  courseId,
  courseName = "当前课程",
  knowledgePoints,
  mainScenes = [],
  plan,
  onChange,
}: {
  courseId: string;
  courseName?: string;
  knowledgePoints: KnowledgePoint[];
  mainScenes?: AdaptiveMainScene[];
  plan?: AdaptiveLearningPlan;
  onChange: (plan: AdaptiveLearningPlan, knowledgeGraph?: KnowledgeGraph) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [generatingBranchIds, setGeneratingBranchIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string>();
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [selectedBranchId, setSelectedBranchId] = useState<string>();
  const planRef = useRef(plan);
  useEffect(() => {
    planRef.current = plan;
  }, [plan]);

  function commitPlan(transform: (current: AdaptiveLearningPlan) => AdaptiveLearningPlan) {
    const current = planRef.current;
    if (!current) return;
    const next = transform(current);
    planRef.current = next;
    onChange(next);
  }

  async function generatePlan() {
    setGenerating(true);
    setMessage(undefined);
    setMessageTone("success");
    try {
      const response = await fetch("/api/adaptive-learning/outline", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenPBL-Role": "teacher" },
        body: JSON.stringify({ courseId, knowledgePoints, mainScenes }),
      });
      const payload = await response.json() as {
        plan?: AdaptiveLearningPlan;
        knowledgeGraph?: KnowledgeGraph;
        warning?: string;
        error?: string;
        persisted?: boolean;
        reviewSummary?: string;
      };
      if (!response.ok || !payload.plan || !payload.knowledgeGraph || !payload.persisted) {
        throw new Error(payload.error || "课程入口学习包没有完成原子保存");
      }
      onChange(payload.plan, payload.knowledgeGraph);
      setMessageTone("success");
      setMessage(payload.warning || `课程入口学习包已生成并保存。${payload.reviewSummary ? `独立审校：${payload.reviewSummary}` : ""}`);
    } catch (error) {
      setMessageTone("error");
      setMessage(error instanceof Error ? error.message : "生成失败，请稍后重试。");
    } finally {
      setGenerating(false);
    }
  }

  function patchPlan(patch: Partial<AdaptiveLearningPlan>) {
    commitPlan((current) => {
      const prerequisiteBranchBoundary = (branches: readonly AdaptiveBranchOutline[]) => JSON.stringify(
        branches
          .filter((branch) => branch.kind === "prerequisite")
          .map((branch) => ({
            id: branch.id,
            enabled: branch.enabled,
            title: branch.title,
            objective: branch.objective,
            keyPoints: branch.keyPoints,
            anchorKnowledgePointIds: branch.anchorKnowledgePointIds,
            prerequisiteKnowledgePointIds: branch.prerequisiteKnowledgePointIds,
            generationGuidance: branch.generationGuidance,
            trigger: branch.trigger,
          })),
      );
      const invalidatesPrerequisiteReview = [
        "prerequisiteKnowledgePoints", "prerequisiteAnalysis", "pretest",
      ].some((key) => key in patch)
        || ("branches" in patch
          && prerequisiteBranchBoundary(patch.branches ?? []) !== prerequisiteBranchBoundary(current.branches));
      return {
        ...current,
        ...patch,
        prerequisiteSemanticReview: invalidatesPrerequisiteReview
          ? undefined
          : current.prerequisiteSemanticReview,
        status: patch.status ?? "draft",
        updatedAt: new Date().toISOString(),
      };
    });
  }

  function patchBranch(id: string, patch: Partial<AdaptiveBranchOutline>) {
    if (!plan) return;
    const invalidatesResource = [
      "kind", "title", "objective", "keyPoints", "sceneType", "targetDurationSec",
      "generationGuidance", "noveltyStatement", "prerequisiteKnowledgePointIds",
    ].some((key) => key in patch);
    patchPlan({
      branches: plan.branches.map((branch) => branch.id === id ? {
        ...branch,
        ...patch,
        preparedResource: invalidatesResource && branch.preparedResource?.classroomId
          ? { ...branch.preparedResource, status: "stale", error: undefined }
          : invalidatesResource
            ? undefined
            : branch.preparedResource,
        status: "draft",
      } : branch),
    });
  }

  async function generateBranchResources(branchIds: readonly string[]) {
    const current = planRef.current;
    if (!current || !branchIds.length) return;
    if (current.prerequisiteSemanticReview?.status !== "passed") {
      setMessage("先修边界已经变化或尚未审校。请先重新生成完整个性化路径，通过独立审校后再生成资源。");
      return;
    }
    const targets = current.branches.filter((branch) => branchIds.includes(branch.id) && branch.enabled !== false);
    if (!targets.length) return;
    setGeneratingBranchIds((ids) => new Set([...ids, ...targets.map((branch) => branch.id)]));
    setMessage(`正在增量生成 ${targets.length} 份个性化资源；主课程和其他已就绪资源不会重新生成。`);
    commitPlan((latest) => ({
      ...latest,
      updatedAt: new Date().toISOString(),
      branches: latest.branches.map((branch) => targets.some((target) => target.id === branch.id)
        ? { ...branch, preparedResource: { ...branch.preparedResource, status: "generating", error: undefined } }
        : branch),
    }));

    let cursor = 0;
    let completed = 0;
    let failed = 0;
    async function worker() {
      while (cursor < targets.length) {
        const branch = targets[cursor++];
        const sourceSignature = adaptiveBranchGenerationSignature(branch);
        try {
          const generated = await generateAdaptiveClassroom({
            title: `${courseName} · ${branch.title}`,
            requirement: buildAdaptiveResourceRequirement(courseName, branch, current),
            stageKey: "ai-learning",
            requestRole: "teacher",
            scenes: [{
              title: branch.title,
              description: branch.objective,
              keyPoints: branch.keyPoints,
              type: branch.sceneType,
              targetDurationSec: branch.targetDurationSec,
              knowledgePointIds: branch.anchorKnowledgePointIds,
            }],
          });
          commitPlan((latest) => ({
            ...latest,
            updatedAt: new Date().toISOString(),
            branches: latest.branches.map((candidate) => {
              if (candidate.id !== branch.id) return candidate;
              const stillCurrent = adaptiveBranchGenerationSignature(candidate) === sourceSignature;
              return {
                ...candidate,
                preparedResource: {
                  status: stillCurrent ? "ready" : "stale",
                  classroomId: generated.classroomId,
                  scenesCount: generated.scenesCount,
                  generatedAt: new Date().toISOString(),
                  sourceSignature,
                },
              };
            }),
          }));
          completed += 1;
        } catch (cause) {
          failed += 1;
          const error = cause instanceof Error ? cause.message : "资源生成失败";
          commitPlan((latest) => ({
            ...latest,
            updatedAt: new Date().toISOString(),
            branches: latest.branches.map((candidate) => candidate.id === branch.id
              ? { ...candidate, preparedResource: { ...candidate.preparedResource, status: "failed", generatedAt: new Date().toISOString(), error } }
              : candidate),
          }));
        } finally {
          setGeneratingBranchIds((ids) => {
            const next = new Set(ids);
            next.delete(branch.id);
            return next;
          });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()));
    setMessage(failed
      ? `增量生成完成：${completed} 份成功，${failed} 份失败；失败资源可单独重试。`
      : `已仅重新生成 ${completed} 份个性化资源，主课程与其他资源保持不变。`);
  }

  function autoAssignBranches() {
    if (!plan) return;
    patchPlan({
      branches: plan.branches.map((branch) => ({
        ...branch,
        enabled: true,
        trigger: branch.defaultTrigger ?? branch.trigger,
        status: "draft",
      })),
    });
    setMessage("已按生成方案恢复默认插入位置。");
  }

  const studentScenes = mainScenes.filter(isStudentMainScene).sort(
    (left, right) => (left.order ?? 0) - (right.order ?? 0),
  );
  const displayKnowledgePoints = [
    ...knowledgePoints,
    ...(plan?.prerequisiteKnowledgePoints ?? []),
  ].filter((point, index, points) => points.findIndex((candidate) => candidate.id === point.id) === index);
  const quizIds = new Set(deriveMasteryAssessmentSceneIds(studentScenes));
  const pretestKnowledgePointIds = new Set(
    plan?.pretest.questions.flatMap((question) => question.knowledgePointIds) ?? [],
  );
  const coveredPrerequisiteIds = new Set(
    plan?.branches.flatMap((branch) =>
      (branch.trigger?.placement ?? (resourceKind(branch) === "prerequisite" ? "before-main-course" : "after-module")) === "before-main-course"
        ? branch.prerequisiteKnowledgePointIds ?? []
        : [],
    ) ?? [],
  );
  const missingPrerequisiteCoverage = [...pretestKnowledgePointIds].filter(
    (id) => !coveredPrerequisiteIds.has(id),
  );
  const coverageComplete = missingPrerequisiteCoverage.length === 0;
  const prerequisiteLoopComplete = plan
    ? hasCompleteAdaptivePrerequisiteLoop(plan, knowledgePoints.length)
    : false;
  const planQuality = plan
    ? evaluateAdaptiveLearningPlanQuality(plan, { knowledgePoints, mainScenes: studentScenes })
    : undefined;
  const invalidResources = plan?.branches.filter((branch) =>
    !adaptiveResourceAddsNovelContent(branch)
    || ((branch.trigger?.placement ?? (resourceKind(branch) === "prerequisite" ? "before-main-course" : "after-module")) === "after-module"
      && !(branch.trigger?.assessmentSceneIds ?? []).some((id) => quizIds.has(id))),
  ) ?? [];
  const issueCount =
    invalidResources.length
    + missingPrerequisiteCoverage.length
    + (planQuality?.issues.length ?? 0);
  const resourceGenerationTargets = plan?.branches.filter((branch) =>
    branch.enabled !== false && branch.preparedResource?.status !== "ready",
  ) ?? [];
  return (
    <section className="overflow-clip rounded-[8px] border border-stone-200 bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-200 px-5 py-4">
        <div className="min-w-0">
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-[var(--pbl-teacher)]">课程设计</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <h3 className="font-editorial text-xl font-semibold text-stone-950">个性化学习路径</h3>
              {plan?.status === "teacher-confirmed" && !invalidResources.length && coverageComplete && planQuality?.passed ? (
                <Status tone="ready">已随课程确认</Status>
              ) : !prerequisiteLoopComplete ? (
                <Status tone="warning">前序知识闭环待完善</Status>
              ) : planQuality && !planQuality.passed ? (
                <Status tone="warning">路径策略有 {planQuality.issues.length} 项待完善</Status>
              ) : planQuality?.warnings.length ? (
                <Status tone="warning">已达标 · {planQuality.warnings.length} 项优化建议</Status>
              ) : !coverageComplete ? (
                <Status tone="warning">
                  缺 {missingPrerequisiteCoverage.length} 个先决知识资源
                </Status>
              ) : invalidResources.length ? (
                <Status tone="warning">{invalidResources.length} 份资源待完善</Status>
              ) : (
                <span className="rounded-full border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--pbl-teacher)]">
                  可进入生成
                </span>
              )}
            </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {plan && resourceGenerationTargets.length > 0 ? (
            <button
              className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-[var(--pbl-teacher-border)] bg-white px-3.5 text-xs font-bold text-[var(--pbl-teacher)] transition hover:bg-[var(--pbl-teacher-soft)] disabled:opacity-50"
              disabled={generating || generatingBranchIds.size > 0}
              onClick={() => void generateBranchResources(resourceGenerationTargets.map((branch) => branch.id))}
              type="button"
            >
              {generatingBranchIds.size > 0 ? <CourseGenerationGlyph /> : <RotateCw size={14} />}
              仅生成已修改资源（{resourceGenerationTargets.length}）
            </button>
          ) : null}
          <button
            className="inline-flex h-9 items-center gap-2 rounded-[6px] bg-[var(--pbl-teacher)] px-3.5 text-xs font-bold text-white transition hover:brightness-95 disabled:opacity-50"
            disabled={generating || generatingBranchIds.size > 0 || knowledgePoints.length === 0}
            onClick={() => void generatePlan()}
            type="button"
          >
            {generating ? <CourseGenerationGlyph /> : <Sparkles size={14} />}
            {plan ? "按当前主课重新建模" : "生成个性化路径方案"}
          </button>
        </div>
      </div>

      {message ? (
        <div
          className={cn(
            "border-b px-5 py-3 text-xs leading-5",
            messageTone === "error"
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800",
          )}
          role={messageTone === "error" ? "alert" : "status"}
        >
          {message}
        </div>
      ) : null}

      {generating ? (
        <div className="fixed inset-0 z-[100] grid place-items-center bg-stone-950/40 p-4 backdrop-blur-md" role="dialog" aria-modal="true" aria-label="正在生成个性化学习路径">
          <div className="w-[760px] max-w-[94vw] overflow-hidden rounded-[22px] border border-white/30 bg-white shadow-[0_30px_90px_rgba(15,23,42,.28)]">
            <div className="h-1 bg-gradient-to-r from-transparent via-blue-700 to-transparent" />
            <div className="grid gap-5 p-5 md:grid-cols-[1.14fr_.86fr] md:p-6">
              <StageGenerationCardStack
                cards={[
                  {
                    id: "adaptive-main-scenes",
                    eyebrow: "本次主课",
                    title: `${studentScenes.length} 个学生页面`,
                    detail: "识别主课已经覆盖的知识与活动，避免重复生成。",
                    items: studentScenes.slice(0, 3).map((scene) => scene.title),
                    accent: "orange",
                  },
                  {
                    id: "adaptive-knowledge",
                    eyebrow: "真实知识点",
                    title: `${knowledgePoints.length} 个知识点`,
                    detail: "仅围绕本课程的知识图谱安排先修与拓展路径。",
                    items: knowledgePoints.slice(0, 3).map((point) => point.name),
                    accent: "blue",
                  },
                  {
                    id: "adaptive-assessment",
                    eyebrow: "判断依据",
                    title: `${quizIds.size} 个主课达标测`,
                    detail: "根据前测与模块掌握度决定是否插入额外资源。",
                    items: ["前测差距", "模块掌握度", "剩余学习时间"],
                    accent: "violet",
                  },
                  {
                    id: "adaptive-review",
                    eyebrow: "输出要求",
                    title: "可审核的个性化路径",
                    detail: "生成结果会保留插入位置、触发条件与新增价值说明。",
                    items: ["不重复主课", "位置明确", "教师可修改"],
                    accent: "green",
                  },
                ]}
                kind="adaptiveLearning"
              />
              <div className="flex flex-col justify-center">
                <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.14em] text-blue-700"><CourseGenerationGlyph />个性化路径生成中</p>
                <h3 className="mt-3 font-editorial text-2xl font-semibold text-stone-950">正在分析主课与学习分叉</h3>
                <p className="mt-2 text-sm leading-6 text-stone-500">系统会检查先决知识、主课达标测和内容重叠，再安排可由教师审核的学习路径。</p>
                <div className="mt-5 rounded-[10px] border border-stone-200 bg-stone-50 px-4 py-3 text-xs leading-5 text-stone-600">
                  当前使用 {knowledgePoints.length} 个真实知识点和 {studentScenes.length} 个主课页面作为生成依据。
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {!plan ? (
        <div className="grid min-h-44 place-items-center bg-stone-50/50 px-6 py-8 text-center">
          <div>
            <Layers3 className="mx-auto text-[var(--pbl-teacher)]" size={28} />
            <p className="mt-3 text-sm font-bold text-stone-800">先完成课程基本信息、知识图谱与主课大纲</p>
            <p className="mt-1 text-xs leading-5 text-stone-500">
              系统会按学段和知识阶梯生成真实先修能力，并为每项能力配套一道前测和一份 AI 知识回顾；不会用常识题或本课预习题凑数。
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-white">
          <div className="grid border-b border-stone-200 sm:grid-cols-2 xl:grid-cols-4">
            <OverviewMetric label="主课结构" value={`${studentScenes.length} 页`} detail={`${quizIds.size} 个主课达标测`} />
            <OverviewMetric label="课前诊断" value={plan.pretest.questions.length ? `${plan.pretest.questions.length} 题 · ${plan.pretest.estimatedMinutes} 分钟` : "尚未形成"} detail={plan.pretest.questions.length ? `覆盖 ${pretestKnowledgePointIds.size} 个必要先修知识` : "每门课至少需要 1 项真实先修诊断，请重新生成"} tone={prerequisiteLoopComplete ? "ready" : "warning"} />
            <OverviewMetric label="备课资源库" value={`${plan.branches.length} 份`} detail={`拓展候选建议 ${planQuality?.recommendedMin ?? 0}-${planQuality?.recommendedMax ?? 2} 份 · 单生最多 ${planQuality?.runtimeMaxPerStudent ?? 1} 份`} />
            <OverviewMetric
              label="审核结果"
              value={issueCount ? `${issueCount} 项待处理` : "可以生成"}
              detail={issueCount ? "展开黄色标记项目进行修改" : "进入课程生成时自动确认"}
              tone={issueCount ? "warning" : "ready"}
            />
          </div>

          <section className="border-b border-stone-200 bg-cyan-50/30 px-5 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.12em] text-cyan-800">先修边界分析</p>
                <p className="mt-1 text-xs leading-5 text-stone-600">{plan.prerequisiteAnalysis?.summary || "尚未完成逐知识点先修边界分析。"}</p>
              </div>
              <Status tone={plan.prerequisiteSemanticReview?.status === "passed" ? "ready" : "warning"}>
                {plan.prerequisiteSemanticReview?.status === "passed" ? "独立语义审校通过" : "需要重新生成并审校"}
              </Status>
            </div>
            {(plan.prerequisiteAnalysis?.decisions.length ?? 0) > 0 ? (
              <p className="mt-2 text-[10px] leading-4 text-stone-500">
                {plan.prerequisiteAnalysis!.decisions.filter((decision) => decision.decision === "diagnose-prerequisite").length} 个本课目标需要先修诊断；
                {plan.prerequisiteAnalysis!.decisions.filter((decision) => decision.decision !== "diagnose-prerequisite").length} 个目标由主课负责建立基础。
              </p>
            ) : null}
          </section>

          <section className="border-b border-stone-200 bg-violet-50/35 px-5 py-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.12em] text-violet-700">课程库建设 · 拓展机会评估</p>
                <p className="mt-1 text-xs leading-5 text-stone-600">{plan.enrichmentStrategy?.summary || "系统会建设丰富候选库，真实课堂再按学生证据只插入少量最匹配资源。"}</p>
              </div>
              <Status tone={planQuality?.passed ? "ready" : "warning"}>
                候选 {plan.branches.filter((branch) => branch.kind !== "prerequisite" && branch.enabled !== false).length} / 建议 {planQuality?.recommendedMin ?? 0}-{planQuality?.recommendedMax ?? 2} · 单生≤{planQuality?.runtimeMaxPerStudent ?? 1}
              </Status>
            </div>
            {(planQuality?.warnings.length ?? 0) > 0 ? (
              <p className="mt-2 text-[10px] leading-4 text-amber-700">优化建议：{planQuality!.warnings.join("；")}</p>
            ) : null}
            {(plan.enrichmentStrategy?.decisions.length ?? 0) > 0 ? (
              <div className="mt-2 grid gap-2 md:grid-cols-2">
                {plan.enrichmentStrategy!.decisions.slice(0, 4).map((decision) => (
                  <div className="rounded-[7px] border border-violet-100 bg-white px-3 py-2" key={decision.id}>
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-[11px] text-stone-800">{decision.title}</strong>
                      <span className={cn("text-[9px] font-bold", decision.decision === "selected" ? "text-emerald-700" : "text-stone-400")}>{decision.decision === "selected" ? "保留" : "不采用"}</span>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-stone-500">{decision.rationale}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="border-b border-stone-200 bg-stone-50/55">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div>
                <h4 className="flex items-center gap-2 text-sm font-bold text-stone-900">
                  <CircleGauge size={16} className="text-[var(--pbl-teacher)]" /> 运行规则
                </h4>
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold text-stone-700">
                <input
                  checked={plan.enabled}
                  onChange={(event) => patchPlan({ enabled: event.target.checked })}
                  type="checkbox"
                />
                启用个性化学习路径
              </label>
            </div>
            <div className="grid gap-3 border-t border-stone-100 px-5 py-3 sm:grid-cols-2">
              <CompactNumberField
                label="额外资源总预算"
                suffix="分钟"
                max={20}
                min={3}
                onChange={(value) => patchPlan({ timeBudgetMin: value })}
                value={plan.timeBudgetMin}
              />
              <CompactNumberField
                label="模块拓展掌握门槛"
                suffix="分及以上"
                max={100}
                min={60}
                onChange={(value) => patchPlan({ thresholds: { enrichmentMasteryMin: value } })}
                value={plan.thresholds.enrichmentMasteryMin ?? 80}
              />
            </div>
          </section>

          <CourseFlowModel
            branches={plan.branches}
            courseId={courseId}
            knowledgePoints={displayKnowledgePoints}
            mainScenes={studentScenes}
            onAutoAssign={autoAssignBranches}
            onChangeBranch={patchBranch}
            onGenerateBranch={(branchId) => void generateBranchResources([branchId])}
            onChangePretestQuestion={(questionId, prompt) => patchPlan({
              pretest: {
                ...plan.pretest,
                questions: plan.pretest.questions.map((question) =>
                  question.id === questionId ? { ...question, prompt } : question,
                ),
              },
            })}
            onSelectBranch={(branch) => setSelectedBranchId((current) => current === branch.id ? undefined : branch.id)}
            pretest={plan.pretest}
            selectedBranchId={selectedBranchId}
            generatingBranchIds={generatingBranchIds}
            threshold={plan.thresholds.enrichmentMasteryMin ?? 80}
          />
        </div>
      )}
    </section>
  );
}

function OverviewMetric({
  detail,
  label,
  tone = "neutral",
  value,
}: {
  detail: string;
  label: string;
  tone?: "neutral" | "ready" | "warning";
  value: string;
}) {
  return (
    <div className={cn(
      "border-b border-stone-100 bg-white px-5 py-3 sm:border-r xl:border-b-0",
      tone === "ready"
        ? "bg-emerald-50/35"
        : tone === "warning"
          ? "bg-amber-50/70"
          : "",
    )}>
      <p className="text-[10px] font-black uppercase tracking-[0.12em] text-stone-400">{label}</p>
      <strong className={cn(
        "mt-1 block text-lg",
        tone === "ready" ? "text-emerald-800" : tone === "warning" ? "text-amber-900" : "text-stone-950",
      )}>{value}</strong>
      <p className="mt-0.5 text-[10px] leading-4 text-stone-500">{detail}</p>
    </div>
  );
}

function ResourceEditor({
  branch,
  courseId,
  generating,
  knowledgePoints,
  mainScenes,
  onChange,
  onGenerate,
  onOpenChange,
  open,
  threshold,
}: {
  branch: AdaptiveBranchOutline;
  courseId?: string;
  generating?: boolean;
  knowledgePoints: KnowledgePoint[];
  mainScenes: AdaptiveMainScene[];
  onChange: (patch: Partial<AdaptiveBranchOutline>) => void;
  onGenerate?: () => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  threshold: number;
}) {
  const [showDesignPreview, setShowDesignPreview] = useState(false);
  const effectiveKind = resourceKind(branch);
  const prerequisite = effectiveKind === "prerequisite";
  const trigger = branch.trigger ?? {
    placement: prerequisite ? "before-main-course" as const : "after-module" as const,
    evidenceRule: prerequisite ? "pretest-gap" as const : "module-mastery" as const,
    minimumRemainingSec: branch.targetDurationSec,
  };
  const quizzes = mainScenes.filter((scene) => scene.type === "quiz");
  const noveltyValid = adaptiveResourceAddsNovelContent(branch);
  const linkedQuizTitle = quizzes.find((scene) =>
    (trigger.assessmentSceneIds ?? []).includes(scene.id),
  )?.title;
  const evidenceSummary = prerequisite
    ? `前测缺口 · ${knowledgeNames(branch.prerequisiteKnowledgePointIds, knowledgePoints)}`
    : `${linkedQuizTitle ?? "未关联主课达标测"} · ≥ ${trigger.scoreThreshold ?? threshold} 分`;
  return (
    <details
      className="group scroll-mt-24 bg-white"
      id={`adaptive-resource-${branch.id}`}
      onToggle={(event) => onOpenChange(event.currentTarget.open)}
      open={open}
    >
      <summary className="grid cursor-pointer list-none gap-3 px-4 py-3.5 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)_auto] md:items-center">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-[var(--pbl-teacher-soft)] px-1.5 py-0.5 text-[9px] font-black uppercase tracking-[0.12em] text-[var(--pbl-teacher)]">{resourceLabel(branch)}</span>
            <strong className="truncate text-sm text-stone-900">{branch.title}</strong>
          </span>
          <span className="mt-1 block truncate text-[10px] text-stone-500">{branch.noveltyStatement || "尚未说明相对主课的新增价值"}</span>
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[11px] font-semibold text-stone-700">{evidenceSummary}</span>
          <span className="mt-1 block text-[10px] text-stone-400">约 {Math.ceil(branch.targetDurationSec / 60)} 分钟 · 同播放器无感插入</span>
        </span>
        <span className="flex items-center justify-end gap-2">
          <Status tone={branch.preparedResource?.status === "ready" ? "ready" : branch.preparedResource?.status === "failed" ? "warning" : "draft"}>
            {branch.preparedResource?.status === "ready"
              ? `${branch.preparedResource.scenesCount ?? 1} 页成品`
              : branch.preparedResource?.status === "stale"
                ? "内容已修改"
                : branch.preparedResource?.status === "generating"
                  ? "生成中"
                  : branch.preparedResource?.status === "failed"
                    ? "生成失败"
                    : "待生成"}
          </Status>
          {!noveltyValid ? <Status tone="warning">需处理</Status> : null}
          <ChevronDown className="text-stone-400 transition group-open:rotate-180" size={17} />
        </span>
      </summary>
      <div className="grid gap-4 border-t border-stone-100 bg-stone-50/70 p-4 lg:grid-cols-2">
        <div className="space-y-3">
          <TextField label="资源标题" onChange={(value) => onChange({ title: value })} value={branch.title} />
          <TextArea label="教学目标" onChange={(value) => onChange({ objective: value })} value={branch.objective} />
          <label className="block text-[11px] font-bold text-stone-700">
            资源类型
            <select
              className="mt-1 h-9 w-full rounded-[6px] border border-stone-200 bg-white px-2 text-xs"
              onChange={(event) => {
                const kind = event.target.value as AdaptiveBranchOutline["kind"];
                const isPrerequisite = kind === "prerequisite";
                onChange({
                  kind,
                  trigger: {
                    ...trigger,
                    placement: isPrerequisite ? "before-main-course" : "after-module",
                    evidenceRule: isPrerequisite ? "pretest-gap" : "module-mastery",
                  },
                });
              }}
              value={branch.kind}
            >
              {Object.entries(RESOURCE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <TextArea
            label="相对主课新增价值（必填）"
            onChange={(value) => onChange({ noveltyStatement: value })}
            value={branch.noveltyStatement ?? ""}
          />
          <TextArea
            label="成品生成指导"
            onChange={(value) => onChange({ generationGuidance: value })}
            value={branch.generationGuidance ?? ""}
          />
        </div>
        <div className="space-y-3">
          <div className="rounded-[8px] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]/45 p-3">
            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--pbl-teacher)]">插入规则</p>
            <p className="mt-1 text-xs font-bold text-stone-900">
              {prerequisite
                ? "前测发现关联先决知识缺口 → 正式主课开始前连续插入"
                : `主课达标测中关联知识点达到 ${trigger.scoreThreshold ?? threshold} 分且时间充足 → 测验解析后连续插入`}
            </p>
            {!prerequisite ? (
              <label className="mt-3 block text-[11px] font-bold text-stone-700">
                关联主课达标测
                <select
                  className="mt-1 h-9 w-full rounded-[6px] border border-stone-200 bg-white px-2 text-xs"
                  onChange={(event) => onChange({
                    trigger: { ...trigger, assessmentSceneIds: event.target.value ? [event.target.value] : [] },
                  })}
                  value={trigger.assessmentSceneIds?.[0] ?? ""}
                >
                  <option value="">请选择主课达标测</option>
                  {quizzes.map((scene) => <option key={scene.id} value={scene.id}>{scene.title}</option>)}
                </select>
              </label>
            ) : (
              <p className="mt-2 text-[11px] text-stone-600">
                关联先决知识：{knowledgeNames(branch.prerequisiteKnowledgePointIds, knowledgePoints)}
              </p>
            )}
          </div>
          <NumberField
            label="资源时长（秒）"
            max={360}
            min={90}
            onChange={(value) => onChange({
              targetDurationSec: value,
              trigger: { ...trigger, minimumRemainingSec: Math.max(value, trigger.minimumRemainingSec) },
            })}
            value={branch.targetDurationSec}
          />
          {!prerequisite ? (
            <NumberField
              label="该资源掌握阈值（分）"
              max={100}
              min={60}
              onChange={(value) => onChange({
                trigger: { ...trigger, scoreThreshold: value },
              })}
              value={trigger.scoreThreshold ?? threshold}
            />
          ) : null}
          <div className="rounded-[8px] border border-stone-200 bg-stone-50 p-3 text-[11px] leading-5 text-stone-600">
            <strong className="text-stone-900">主课重叠审查：</strong>
            {(branch.mainCourseOverlapSceneIds?.length ?? 0) > 0
              ? branch.mainCourseOverlapSceneIds.map((id) => mainScenes.find((scene) => scene.id === id)?.title ?? "未找到的主课页面").join("、")
              : "未标记潜在重叠页；生成时仍会使用完整主课大纲进行去重。"}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="inline-flex h-9 items-center gap-2 rounded-[6px] border border-stone-300 bg-white px-3 text-xs font-bold text-stone-700 hover:bg-stone-100"
              onClick={() => setShowDesignPreview((value) => !value)}
              type="button"
            >
              <PlaySquare size={14} /> {showDesignPreview ? "收起设计预览" : "预览设计内容"}
            </button>
            {courseId && branch.preparedResource?.classroomId ? (
              <a
                className="inline-flex h-9 items-center gap-2 rounded-[6px] bg-stone-900 px-3 text-xs font-bold text-white"
                href={`/teacher/prepare/${courseId}/preview?adaptiveBranchId=${encodeURIComponent(branch.id)}`}
                target="_blank"
              >
                <PlaySquare size={14} /> {branch.preparedResource.status === "ready" ? "预览成品" : "预览旧版本"}
              </a>
            ) : null}
            <button
              className="inline-flex h-9 items-center gap-2 rounded-[6px] bg-[var(--pbl-teacher)] px-3 text-xs font-bold text-white disabled:opacity-50"
              disabled={generating}
              onClick={onGenerate}
              type="button"
            >
              {generating ? <CourseGenerationGlyph /> : <RotateCw size={14} />}
              {branch.preparedResource?.classroomId ? "重新生成本资源" : "生成本资源"}
            </button>
          </div>
          {showDesignPreview ? (
            <section className="rounded-[8px] border border-cyan-200 bg-cyan-50/60 p-3" aria-label={`${branch.title}设计内容预览`}>
              <p className="text-[10px] font-black uppercase tracking-[0.12em] text-cyan-800">生成前设计预览 · 约 {Math.ceil(branch.targetDurationSec / 60)} 分钟</p>
              <h5 className="mt-2 text-sm font-black text-stone-900">{branch.title}</h5>
              <p className="mt-1 text-xs leading-5 text-stone-700">{branch.objective}</p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] leading-5 text-stone-600">
                {branch.keyPoints.map((point) => <li key={point}>{point}</li>)}
              </ul>
              {branch.generationGuidance ? <p className="mt-2 border-t border-cyan-100 pt-2 text-[10px] leading-4 text-stone-500">生成指导：{branch.generationGuidance}</p> : null}
            </section>
          ) : null}
        </div>
      </div>
    </details>
  );
}

function CourseFlowModel({
  branches,
  courseId,
  generatingBranchIds,
  knowledgePoints = [],
  mainScenes,
  onAutoAssign,
  onChangeBranch,
  onChangePretestQuestion,
  onGenerateBranch,
  onSelectBranch,
  pretest,
  selectedBranchId,
  threshold = 80,
}: {
  branches: AdaptiveBranchOutline[];
  courseId?: string;
  generatingBranchIds?: ReadonlySet<string>;
  knowledgePoints?: KnowledgePoint[];
  mainScenes: AdaptiveMainScene[];
  onAutoAssign?: () => void;
  onChangeBranch?: (id: string, patch: Partial<AdaptiveBranchOutline>) => void;
  onChangePretestQuestion?: (questionId: string, prompt: string) => void;
  onGenerateBranch?: (id: string) => void;
  onSelectBranch?: (branch: AdaptiveBranchOutline) => void;
  pretest: AdaptiveLearningPlan["pretest"];
  selectedBranchId?: string;
  threshold?: number;
}) {
  const [draggedBranchId, setDraggedBranchId] = useState<string>();
  const [activeSlotId, setActiveSlotId] = useState<string>();
  const modules: Array<{
    checkpoint?: AdaptiveMainScene;
    resources: AdaptiveBranchOutline[];
    scenes: AdaptiveMainScene[];
  }> = [];
  let currentScenes: AdaptiveMainScene[] = [];
  mainScenes.forEach((scene) => {
    currentScenes.push(scene);
    if (scene.type !== "quiz") return;
    modules.push({
      checkpoint: scene,
      resources: branches.filter((branch) =>
        branch.enabled !== false
        &&
        (branch.trigger?.placement ?? (resourceKind(branch) === "prerequisite" ? "before-main-course" : "after-module")) === "after-module"
        && (branch.trigger?.assessmentSceneIds ?? []).includes(scene.id),
      ),
      scenes: currentScenes,
    });
    currentScenes = [];
  });
  if (currentScenes.length) {
    modules.push({ scenes: currentScenes, resources: [] });
  }
  const prerequisites = branches.filter((branch) =>
    branch.enabled !== false
    && (branch.trigger?.placement ?? (resourceKind(branch) === "prerequisite" ? "before-main-course" : "after-module")) === "before-main-course",
  );
  const pretestIds = new Set(pretest.questions.flatMap((question) => question.knowledgePointIds));
  const coveredPretestIds = new Set(prerequisites.flatMap((branch) => branch.prerequisiteKnowledgePointIds ?? []).filter((id) => pretestIds.has(id)));
  const optionalEnrichmentCount = modules.reduce((total, module) => total + module.resources.length, 0);
  function moveBranchToSlot(branchId: string, slot: CourseInsertionSlot) {
    const branch = branches.find((item) => item.id === branchId);
    if (!branch || !onChangeBranch) return;
    const prerequisite = slot.placement === "before-main-course";
    onChangeBranch(branchId, {
      defaultTrigger: branch.defaultTrigger ?? branch.trigger,
      enabled: true,
      kind: prerequisite ? "prerequisite" : resourceKind(branch) === "prerequisite" ? "extension" : resourceKind(branch),
      trigger: {
        ...branch.trigger,
        afterSceneId: slot.assessmentSceneId,
        assessmentSceneIds: slot.assessmentSceneId ? [slot.assessmentSceneId] : [],
        beforeSceneId: slot.beforeSceneId,
        evidenceRule: prerequisite ? "pretest-gap" : "module-mastery",
        minimumRemainingSec: branch.trigger?.minimumRemainingSec ?? branch.targetDurationSec,
        placement: slot.placement,
        scoreThreshold: prerequisite ? undefined : branch.trigger?.scoreThreshold ?? threshold,
      },
    });
    setDraggedBranchId(undefined);
    setActiveSlotId(undefined);
  }
  function moveBranchToLibrary(branchId: string) {
    if (!onChangeBranch) return;
    const branch = branches.find((item) => item.id === branchId);
    onChangeBranch(branchId, { defaultTrigger: branch?.defaultTrigger ?? branch?.trigger, enabled: false });
    setDraggedBranchId(undefined);
    setActiveSlotId(undefined);
  }
  return (
    <div className="bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 px-5 py-3 text-[10px]">
        <div className="flex flex-wrap items-center gap-4 font-semibold text-stone-500">
          <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-stone-900" /> 必经课程</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-cyan-600" /> 按条件插入</span>
          <span>点击课程点或资源查看详情</span>
        </div>
        <div className="flex gap-2">
          <Status tone={coveredPretestIds.size >= pretestIds.size ? "ready" : "warning"}>先决覆盖 {coveredPretestIds.size}/{pretestIds.size}</Status>
          <Status tone="ready">可选拓展 {optionalEnrichmentCount} 处</Status>
        </div>
      </div>
      <div className={cn("grid items-start", onChangeBranch && "lg:grid-cols-[minmax(0,3fr)_minmax(320px,2fr)]")}>
      <div className={cn("relative min-w-0 py-2 before:absolute before:bottom-6 before:left-[30px] before:top-7 before:w-px before:bg-stone-200 sm:before:left-[34px]", onChangeBranch && "lg:border-r lg:border-stone-200")}>
        <CourseMapRow
          activeSlotId={activeSlotId}
          courseId={courseId}
          draggedBranchId={draggedBranchId}
          index={1}
          main={<PretestCourseNode knowledgePoints={knowledgePoints} onChangeQuestion={onChangePretestQuestion} pretest={pretest} />}
          knowledgePoints={knowledgePoints}
          generatingBranchIds={generatingBranchIds}
          mainScenes={mainScenes}
          onChangeBranch={onChangeBranch}
          onGenerateBranch={onGenerateBranch}
          onDragEnd={() => { setDraggedBranchId(undefined); setActiveSlotId(undefined); }}
          onDragStart={setDraggedBranchId}
          onDropBranch={moveBranchToSlot}
          onSelectBranch={onSelectBranch}
          resources={prerequisites}
          selectedBranchId={selectedBranchId}
          slot={{ id: "before-main-course", label: "课前诊断之后、主题模块 01 之前", placement: "before-main-course", beforeSceneId: mainScenes[0]?.id }}
          threshold={threshold}
          onSlotEnter={setActiveSlotId}
        />
        {modules.map((module, index) => {
          const nextModule = modules[index + 1];
          const nextTitle = nextModule?.scenes.find((scene) => scene.type !== "quiz")?.title;
          const insertionLabel = module.checkpoint
            ? `“${module.checkpoint.title}”之后、${nextTitle ? `“${nextTitle}”之前` : "课程结束之前"}`
            : nextTitle ? `本模块之后、“${nextTitle}”之前` : "本模块之后、课程结束之前";
          return (
            <CourseMapRow
              activeSlotId={activeSlotId}
              courseId={courseId}
              draggedBranchId={draggedBranchId}
              index={index + 2}
              key={module.checkpoint?.id ?? module.scenes.map((scene) => scene.id).join("-")}
              knowledgePoints={knowledgePoints}
              generatingBranchIds={generatingBranchIds}
              main={<CourseModuleNode index={index + 1} knowledgePoints={knowledgePoints} module={module} />}
              mainScenes={mainScenes}
              onChangeBranch={onChangeBranch}
              onGenerateBranch={onGenerateBranch}
              onDragEnd={() => { setDraggedBranchId(undefined); setActiveSlotId(undefined); }}
              onDragStart={setDraggedBranchId}
              onDropBranch={moveBranchToSlot}
              onSelectBranch={onSelectBranch}
              resources={module.resources}
              selectedBranchId={selectedBranchId}
              slot={{
                assessmentSceneId: module.checkpoint?.id,
                beforeSceneId: nextModule?.scenes[0]?.id,
                id: `after-${module.checkpoint?.id ?? index}`,
                label: insertionLabel,
                placement: "after-module",
              }}
              threshold={threshold}
              onSlotEnter={setActiveSlotId}
            />
          );
        })}
        <div className="flex items-center gap-3 bg-emerald-50/60 px-5 py-4">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-emerald-600 text-xs font-black text-white">✓</span>
          <div><strong className="text-xs text-emerald-950">课程完成</strong><p className="mt-0.5 text-[10px] text-emerald-800">完成必经课程与实际触发的个性化内容</p></div>
        </div>
      </div>
      {onChangeBranch ? <ResourceWorkbench
        branches={branches}
        draggedBranchId={draggedBranchId}
        mainScenes={mainScenes}
        onAutoAssign={onAutoAssign}
        onChangeBranch={onChangeBranch}
        onDragEnd={() => { setDraggedBranchId(undefined); setActiveSlotId(undefined); }}
        onDragStart={setDraggedBranchId}
        onDropBranch={moveBranchToLibrary}
        onSelectBranch={onSelectBranch}
        selectedBranchId={selectedBranchId}
        threshold={threshold}
      /> : null}
      </div>
    </div>
  );
}

function CourseMapRow({
  activeSlotId,
  courseId,
  draggedBranchId,
  generatingBranchIds,
  index,
  knowledgePoints,
  main,
  mainScenes,
  onChangeBranch,
  onGenerateBranch,
  onDragEnd,
  onDragStart,
  onDropBranch,
  onSelectBranch,
  onSlotEnter,
  resources,
  selectedBranchId,
  slot,
  threshold,
}: {
  activeSlotId?: string;
  courseId?: string;
  draggedBranchId?: string;
  generatingBranchIds?: ReadonlySet<string>;
  index: number;
  knowledgePoints: KnowledgePoint[];
  main: ReactNode;
  mainScenes: AdaptiveMainScene[];
  onChangeBranch?: (id: string, patch: Partial<AdaptiveBranchOutline>) => void;
  onGenerateBranch?: (id: string) => void;
  onDragEnd: () => void;
  onDragStart: (branchId: string) => void;
  onDropBranch: (branchId: string, slot: CourseInsertionSlot) => void;
  onSelectBranch?: (branch: AdaptiveBranchOutline) => void;
  onSlotEnter: (slotId: string | undefined) => void;
  resources: AdaptiveBranchOutline[];
  selectedBranchId?: string;
  slot: CourseInsertionSlot;
  threshold: number;
}) {
  const selectedBranch = resources.find((branch) => branch.id === selectedBranchId);
  const slotActive = activeSlotId === slot.id;
  return (
    <section className="relative border-b border-stone-100 last:border-b-0">
      <div className="relative px-4 py-5 sm:px-5">
        <div className="relative pl-10">
          <span className="absolute left-0 top-1 grid h-7 w-7 place-items-center rounded-[7px] bg-stone-900 text-[10px] font-black text-white shadow-[0_3px_0_#d6d3d1]">{index}</span>
          {main}
        </div>
        <div className="ml-10 mt-3 space-y-2">
          {resources.map((branch, resourceIndex) => (
            <ResourceMapCard
              animationIndex={resourceIndex}
              branch={branch}
              dragEnabled={Boolean(onChangeBranch)}
              dragging={draggedBranchId === branch.id}
              key={branch.id}
              mainScenes={mainScenes}
              mode="inserted"
              onDragEnd={onDragEnd}
              onDragStart={onDragStart}
              onSelect={onSelectBranch}
              selected={selectedBranchId === branch.id}
              threshold={threshold}
            />
          ))}
          {!resources.length || draggedBranchId ? (
            <div
              aria-label={`资源插入槽：${slot.label}`}
              className={cn(
                "grid h-8 place-items-center rounded-[7px] border-2 border-dashed transition-all duration-200",
                slotActive
                  ? "h-12 scale-[1.01] border-cyan-600 bg-cyan-100 shadow-[0_0_0_4px_rgba(8,145,178,0.10)]"
                  : draggedBranchId ? "border-cyan-300 bg-cyan-50/70" : "border-stone-300 bg-stone-50/50",
              )}
              onDragEnter={(event) => { event.preventDefault(); onSlotEnter(slot.id); }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onSlotEnter(undefined); }}
              onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
              onDrop={(event) => {
                event.preventDefault();
                const branchId = draggedBranchId || event.dataTransfer.getData("text/plain");
                if (branchId) onDropBranch(branchId, slot);
              }}
            >
              <span className={cn("h-1.5 w-8 rounded-full transition-colors", slotActive ? "bg-cyan-600" : "bg-stone-300")} />
              <span className="sr-only">{slot.label}</span>
            </div>
          ) : null}
        </div>
      </div>
      {selectedBranch ? (
        <div className="border-t border-cyan-100 bg-cyan-50/25 px-4 py-4 sm:px-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[10px] font-bold text-cyan-800">当前资源完整设置</p>
            <button className="text-[10px] font-bold text-stone-500 hover:text-stone-900" onClick={() => onSelectBranch?.(selectedBranch)} type="button">收起</button>
          </div>
          <div className="overflow-hidden border border-stone-200 bg-white">
            <ResourceEditor
              branch={selectedBranch}
              courseId={courseId}
              generating={generatingBranchIds?.has(selectedBranch.id)}
              knowledgePoints={knowledgePoints}
              mainScenes={mainScenes}
              onChange={(patch) => onChangeBranch?.(selectedBranch.id, patch)}
              onGenerate={() => onGenerateBranch?.(selectedBranch.id)}
              onOpenChange={(open) => { if (!open) onSelectBranch?.(selectedBranch); }}
              open
              threshold={threshold}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ResourceWorkbench({
  branches,
  draggedBranchId,
  mainScenes,
  onAutoAssign,
  onChangeBranch,
  onDragEnd,
  onDragStart,
  onDropBranch,
  onSelectBranch,
  selectedBranchId,
  threshold,
}: {
  branches: AdaptiveBranchOutline[];
  draggedBranchId?: string;
  mainScenes: AdaptiveMainScene[];
  onAutoAssign?: () => void;
  onChangeBranch?: (id: string, patch: Partial<AdaptiveBranchOutline>) => void;
  onDragEnd: () => void;
  onDragStart: (branchId: string) => void;
  onDropBranch: (branchId: string) => void;
  onSelectBranch?: (branch: AdaptiveBranchOutline) => void;
  selectedBranchId?: string;
  threshold: number;
}) {
  const unusedBranches = branches.filter((branch) => branch.enabled === false);
  return (
    <aside
      aria-label="个性化资源工作台"
      className={cn(
        "min-w-0 bg-stone-50/70 p-4 transition-colors sm:p-5 lg:sticky lg:top-20 lg:flex lg:max-h-[calc(100vh-10rem)] lg:flex-col lg:self-start lg:overflow-hidden",
        draggedBranchId && "bg-cyan-50/70",
      )}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
      onDrop={(event) => {
        event.preventDefault();
        const branchId = draggedBranchId || event.dataTransfer.getData("text/plain");
        if (branchId) onDropBranch(branchId);
      }}
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-stone-200 pb-3">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.14em] text-cyan-700">个性化资源工作台</p>
          <h5 className="mt-1 text-sm font-bold text-stone-950">资源存放与课堂投放</h5>
          <p className="mt-1 text-[10px] leading-4 text-stone-500">拖入左侧插槽调整位置；拖回这里则暂不用于本课。</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="rounded-[6px] bg-white px-2 py-1 text-[9px] font-bold text-stone-600 shadow-sm">{branches.length - unusedBranches.length}/{branches.length} 已使用</span>
          <button className="rounded-[6px] border border-cyan-200 bg-cyan-50 px-2.5 py-1.5 text-[9px] font-bold text-cyan-800 transition hover:border-cyan-500 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40" disabled={!onAutoAssign || branches.length === 0} onClick={onAutoAssign} type="button">自动分配</button>
        </div>
      </div>
      <div className="mt-4 min-h-0 space-y-3 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain lg:pr-1">
        {unusedBranches.map((branch, index) => (
          <ResourceMapCard
            animationIndex={index}
            branch={branch}
            dragEnabled={Boolean(onChangeBranch)}
            dragging={draggedBranchId === branch.id}
            key={branch.id}
            mainScenes={mainScenes}
            mode="library"
            onDragEnd={onDragEnd}
            onDragStart={onDragStart}
            onSelect={onSelectBranch}
            selected={selectedBranchId === branch.id}
            threshold={threshold}
          />
        ))}
        {!unusedBranches.length ? (
          <div className="grid min-h-40 place-items-center rounded-[9px] border border-stone-200 bg-white/70 px-5 text-center">
            <div><strong className="text-xs text-stone-700">资源已全部放入主课</strong><p className="mt-1 text-[10px] leading-4 text-stone-400">从左侧拖回此区域，可暂时移出课程。</p></div>
          </div>
        ) : null}
      </div>
      {draggedBranchId ? (
        <div className="mt-4 rounded-[8px] border border-cyan-300 bg-white px-3 py-3 text-center text-[10px] font-bold text-cyan-800 shadow-inner">放回这里，暂停在课堂中使用</div>
      ) : null}
    </aside>
  );
}

export function AdaptiveCourseFlowPreview({
  mainScenes,
  onPreviewBranch,
  plan,
}: {
  mainScenes: AdaptiveMainScene[];
  onPreviewBranch?: (branch: AdaptiveBranchOutline) => void;
  plan: AdaptiveLearningPlan;
}) {
  return (
    <CourseFlowModel
      branches={plan.branches}
      mainScenes={mainScenes.filter(isStudentMainScene)}
      onSelectBranch={onPreviewBranch}
      pretest={plan.pretest}
      threshold={plan.thresholds.enrichmentMasteryMin ?? 80}
    />
  );
}

function PretestCourseNode({
  knowledgePoints,
  onChangeQuestion,
  pretest,
}: {
  knowledgePoints: KnowledgePoint[];
  onChangeQuestion?: (questionId: string, prompt: string) => void;
  pretest: AdaptiveLearningPlan["pretest"];
}) {
  if (pretest.questions.length === 0) {
    return (
      <div className="rounded-[9px] border border-amber-200 bg-amber-50/70 px-3.5 py-3 shadow-[0_4px_0_#fef3c7]">
        <span className="text-[9px] font-black uppercase tracking-[0.13em] text-amber-700">课程入口 · 方案不完整</span>
        <strong className="mt-1 block text-sm text-stone-950">尚未生成前序知识诊断</strong>
        <span className="mt-1 block text-[10px] leading-4 text-stone-600">每门课至少需要 1 项经审核的真实先修能力，以及对应的一道前测和一份知识回顾资源。请重新建模；系统不会用常识题凑数。</span>
      </div>
    );
  }
  return (
    <details className="group" open>
      <summary className="relative flex cursor-pointer list-none items-center justify-between gap-3 rounded-[9px] border border-amber-200 bg-amber-50/60 px-3.5 py-3 shadow-[0_4px_0_#fef3c7]">
        <span className="absolute -top-1.5 left-5 h-2 w-9 rounded-t-[4px] border border-b-0 border-amber-200 bg-amber-50" />
        <span className="absolute -top-1.5 right-5 h-2 w-9 rounded-t-[4px] border border-b-0 border-amber-200 bg-amber-50" />
        <span className="min-w-0">
          <span className="text-[9px] font-black uppercase tracking-[0.13em] text-amber-700">课程入口 · 诊断</span>
          <strong className="mt-1 block text-sm text-stone-950">{pretest.title || "课前诊断"}</strong>
          <span className="mt-1 block text-[10px] text-stone-500">{pretest.questions.length} 道题，用于判断是否需要先补足基础知识</span>
        </span>
        <ChevronDown className="shrink-0 text-stone-400 transition group-open:rotate-180" size={17} />
      </summary>
      <div className="mt-2 space-y-2 pl-3 sm:pl-5">
        {pretest.questions.slice(0, 5).map((question, index) => (
          <label className="relative block rounded-[8px] border border-amber-100 bg-white px-3 py-2.5 shadow-[0_3px_0_#f5f5f4]" key={question.id}>
            <span className="absolute -top-1 left-7 h-1.5 w-8 rounded-t-[3px] border border-b-0 border-amber-100 bg-white" />
            <span className="flex flex-wrap items-center justify-between gap-2 text-[9px] font-bold text-stone-400">
              <span><span>诊断题 {index + 1}</span> · {question.type === "matching" ? "匹配" : question.type === "true-false" ? "判断" : "单选"}</span>
              <span>关联：{knowledgeNames(question.knowledgePointIds, knowledgePoints)}</span>
            </span>
            {onChangeQuestion ? (
              <textarea className="mt-1.5 min-h-14 w-full resize-y rounded-[6px] border border-stone-200 bg-stone-50/60 px-2.5 py-2 text-[11px] leading-5 text-stone-800 outline-none focus:border-stone-400" onChange={(event) => onChangeQuestion(question.id, event.target.value)} value={question.prompt} />
            ) : (
              <span className="mt-1.5 block text-[11px] leading-5 text-stone-800">{question.prompt}</span>
            )}
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {question.type === "matching"
                ? (question.matchingPairs ?? []).map((pair) => (
                    <span className="rounded bg-stone-50 px-2 py-1 text-[10px] text-stone-600" key={`${pair.left}-${pair.right}`}>{pair.left} → {pair.right}</span>
                  ))
                : question.options.map((option, optionIndex) => (
                    <span className={cn("rounded px-2 py-1 text-[10px]", optionIndex === question.correctOptionIndex ? "bg-emerald-50 font-bold text-emerald-800" : "bg-stone-50 text-stone-600")} key={`${question.id}-option-${optionIndex}`}>{option}</span>
                  ))}
            </div>
            {question.rationale ? <p className="mt-2 text-[10px] leading-4 text-stone-500">判分依据：{question.rationale}</p> : null}
          </label>
        ))}
      </div>
    </details>
  );
}

function CourseModuleNode({
  index,
  knowledgePoints,
  module,
}: {
  index: number;
  knowledgePoints: KnowledgePoint[];
  module: { checkpoint?: AdaptiveMainScene; resources: AdaptiveBranchOutline[]; scenes: AdaptiveMainScene[] };
}) {
  const lessonScene = module.scenes.find((scene) => scene.type !== "quiz");
  const title = lessonScene?.title ?? `知识模块 ${index}`;
  return (
    <article>
      <div className="relative flex flex-wrap items-start justify-between gap-2 rounded-[9px] border border-stone-300 bg-stone-50 px-3.5 py-3 shadow-[0_4px_0_#e7e5e4]">
        <span className="absolute -top-1.5 left-5 h-2 w-9 rounded-t-[4px] border border-b-0 border-stone-300 bg-stone-50" />
        <span className="absolute -top-1.5 right-5 h-2 w-9 rounded-t-[4px] border border-b-0 border-stone-300 bg-stone-50" />
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.13em] text-stone-400">主题模块 {String(index).padStart(2, "0")}</p>
          <h6 className="mt-1 text-sm font-bold leading-5 text-stone-950">{title}</h6>
        </div>
        <span className="rounded-[5px] bg-white px-2 py-1 text-[9px] font-bold text-stone-500 shadow-sm">{module.scenes.length} 个课程点</span>
      </div>
      <ol className="mt-2 space-y-2 pl-3 sm:pl-5">
        {module.scenes.map((scene, sceneIndex) => (
          <li className="relative" key={scene.id}>
            <ScenePoint index={sceneIndex + 1} knowledgePoints={knowledgePoints} scene={scene} />
          </li>
        ))}
      </ol>
    </article>
  );
}

function ScenePoint({ index, knowledgePoints, scene }: { index: number; knowledgePoints: KnowledgePoint[]; scene: AdaptiveMainScene }) {
  const isQuiz = scene.type === "quiz";
  const isInteractive = scene.type === "interactive" || scene.type === "interaction";
  return (
    <details className={cn("group relative rounded-[8px] border bg-white shadow-[0_3px_0_rgba(214,211,209,0.8)] transition hover:-translate-y-px hover:shadow-[0_4px_0_rgba(168,162,158,0.7)]", isQuiz ? "border-stone-400" : isInteractive ? "border-blue-200" : "border-stone-200")}>
      <span className={cn("absolute -top-1 left-7 h-1.5 w-8 rounded-t-[3px] border border-b-0 bg-white", isQuiz ? "border-stone-400" : isInteractive ? "border-blue-200" : "border-stone-200")} />
      <summary className="flex cursor-pointer list-none items-start gap-2.5 px-3 py-2.5">
        <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-[6px]", isQuiz ? "bg-stone-900 text-white" : isInteractive ? "bg-blue-50 text-blue-700" : "bg-stone-100 text-stone-600")}>
          {isQuiz ? <FileQuestion size={12} /> : isInteractive ? <MousePointer2 size={12} /> : <PlaySquare size={12} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-[9px] font-bold text-stone-400">步骤 {String(index).padStart(2, "0")} · {isQuiz ? "主课达标测" : isInteractive ? "课堂互动" : "课程内容"}</span>
          <strong className="mt-0.5 block text-[11px] leading-4 text-stone-800">{scene.title}</strong>
        </span>
        <ChevronDown className="mt-1 shrink-0 text-stone-300 transition group-open:rotate-180" size={13} />
      </summary>
      <div className="border-t border-stone-100 px-3 py-2.5 pl-11 text-[10px] leading-4 text-stone-600">
        <p><strong className="text-stone-800">具体内容：</strong>{scene.title}</p>
        <p className="mt-1"><strong className="text-stone-800">关联知识：</strong>{knowledgeNames(scene.knowledgePointIds ?? [], knowledgePoints)}</p>
      </div>
    </details>
  );
}

function ResourceMapCard({ animationIndex = 0, branch, dragEnabled, dragging, mainScenes, mode, onDragEnd, onDragStart, onSelect, selected, threshold }: {
  animationIndex?: number;
  branch: AdaptiveBranchOutline;
  dragEnabled: boolean;
  dragging: boolean;
  mainScenes: AdaptiveMainScene[];
  mode: "inserted" | "library";
  onDragEnd: () => void;
  onDragStart: (branchId: string) => void;
  onSelect?: (branch: AdaptiveBranchOutline) => void;
  selected: boolean;
  threshold: number;
}) {
  const inserted = mode === "inserted";
  const enabled = branch.enabled !== false;
  const prerequisite = resourceKind(branch) === "prerequisite";
  const linkedQuiz = mainScenes.find((scene) => branch.trigger?.assessmentSceneIds?.includes(scene.id));
  const placement = prerequisite ? "课前诊断后" : `${linkedQuiz?.title ?? "主课达标测"}后`;
  const condition = prerequisite ? "发现先决知识缺口时插入" : `达到 ${branch.trigger?.scoreThreshold ?? threshold} 分且时间充足时插入`;
  return (
    <button
      aria-expanded={selected}
      aria-label={dragEnabled ? `${branch.title}，${enabled ? "已用于本课" : "暂未使用"}，可拖动调整插入位置` : branch.title}
      className={cn(
        "relative w-full rounded-[8px] border bg-white text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-cyan-400 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700 motion-reduce:transform-none",
        inserted ? "resource-block-arrival px-3 py-2.5 shadow-[0_5px_16px_rgba(20,90,105,0.08)]" : "px-3.5 py-3 shadow-[0_8px_24px_rgba(20,90,105,0.07)]",
        dragEnabled && "cursor-grab active:cursor-grabbing",
        selected ? "border-cyan-700 bg-cyan-50 ring-1 ring-inset ring-cyan-200" : enabled ? "border-cyan-200" : "border-stone-200 bg-stone-100/70 opacity-75",
        dragging && "z-20 rotate-1 scale-[1.03] border-cyan-600 opacity-55 shadow-xl",
      )}
      draggable={dragEnabled}
      style={inserted ? { animationDelay: `${2000 + animationIndex * 140}ms` } : undefined}
      onDragEnd={onDragEnd}
      onDragStart={(event) => {
        if (!dragEnabled) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", branch.id);
        onDragStart(branch.id);
      }}
      onClick={() => onSelect?.(branch)}
      type="button"
    >
      {inserted ? <span className="absolute -left-1.5 top-1/2 h-7 w-2 -translate-y-1/2 rounded-l-[4px] border border-r-0 border-cyan-200 bg-white" /> : null}
      <span className="absolute -top-1.5 left-5 h-2.5 w-8 rounded-t-[4px] border border-b-0 border-cyan-200 bg-white" />
      <span className="absolute -top-1.5 right-5 h-2.5 w-8 rounded-t-[4px] border border-b-0 border-cyan-200 bg-white" />
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <GripVertical className="text-stone-300" size={13} />
          <span className={cn("rounded-full px-2 py-1 text-[9px] font-black", prerequisite ? "bg-amber-100 text-amber-900" : "bg-cyan-100 text-cyan-900")}>{resourceLabel(branch)}</span>
        </span>
        <span className={cn("text-[9px] font-semibold", enabled ? "text-stone-400" : "text-stone-500")}>{mode === "library" ? (enabled ? "已插入主课" : "暂未使用") : "主线中的个性化积木"} · 约 {Math.ceil(branch.targetDurationSec / 60)} 分钟</span>
      </span>
      <strong className="mt-2 block text-xs leading-5 text-stone-950">{branch.title}</strong>
      {!inserted ? <span className="mt-1.5 block text-[10px] leading-4 text-stone-600"><strong className="text-stone-800">作用：</strong>{branch.objective}</span> : null}
      <span className="mt-2 block border-t border-cyan-100 pt-2 text-[9px] leading-4 text-stone-500">
        {!inserted ? <><strong className="text-stone-700">当前位置：</strong>{enabled ? placement : "右侧资源工作台"}<br /></> : null}
        <strong className="text-stone-700">触发条件：</strong>{condition}
      </span>
      {!inserted ? <span className="mt-2 flex items-center justify-between text-[9px] font-bold text-cyan-800">
        {selected ? "已展开完整详情" : "查看完整内容"}
        <ChevronDown className={cn("transition", selected && "rotate-180")} size={14} />
      </span> : null}
    </button>
  );
}

function CompactNumberField({
  label,
  max,
  min,
  onChange,
  suffix,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  suffix: string;
  value: number;
}) {
  return (
    <label className="flex items-center justify-between gap-3 border-l-2 border-stone-200 pl-3 text-[11px] font-bold text-stone-700">
      <span>{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          className="h-8 w-16 rounded-[6px] border border-stone-200 bg-white px-2 text-right text-xs font-bold text-stone-900"
          max={max}
          min={min}
          onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))}
          type="number"
          value={value}
        />
        <span className="text-[10px] font-medium text-stone-500">{suffix}</span>
      </span>
    </label>
  );
}

function TextField({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label className="block text-[11px] font-bold text-stone-700">
      {label}
      <input className="mt-1 h-9 w-full rounded-[6px] border border-stone-200 px-3 text-xs" onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  );
}

function TextArea({ label, onChange, value }: { label: string; onChange: (value: string) => void; value: string }) {
  return (
    <label className="block text-[11px] font-bold text-stone-700">
      {label}
      <textarea className="mt-1 min-h-20 w-full resize-y rounded-[6px] border border-stone-200 px-3 py-2 text-xs leading-5" onChange={(event) => onChange(event.target.value)} value={value} />
    </label>
  );
}

function NumberField({ label, max, min, onChange, value }: { label: string; max: number; min: number; onChange: (value: number) => void; value: number }) {
  return (
    <label className="block text-[11px] font-bold text-stone-700">
      {label}
      <input
        className="mt-1 h-9 w-full rounded-[6px] border border-stone-200 px-3 text-xs"
        max={max}
        min={min}
        onChange={(event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min)))}
        type="number"
        value={value}
      />
    </label>
  );
}

function Status({ children, tone }: { children: React.ReactNode; tone: "ready" | "warning" | "draft" }) {
  return (
    <span className={cn(
      "rounded-full px-2 py-0.5 text-[10px] font-bold",
      tone === "ready" ? "bg-emerald-100 text-emerald-800" : tone === "warning" ? "bg-amber-100 text-amber-900" : "bg-stone-100 text-stone-600",
    )}>{children}</span>
  );
}

function isStudentMainScene(scene: AdaptiveMainScene): boolean {
  return scene.stageKey === "ai-learning" || scene.audience === "student";
}

function knowledgeNames(ids: string[] | undefined, points: KnowledgePoint[]): string {
  if (!ids?.length) return "未关联";
  return ids.map((id) => points.find((point) => point.id === id)?.name ?? "未命名知识点").join("、");
}
