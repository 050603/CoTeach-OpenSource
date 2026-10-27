import {
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  Eye,
  FileQuestion,
  Gauge,
  Layers3,
  PlayCircle,
  Route,
  Sparkles,
} from "lucide-react";
import type {
  AdaptiveBranchOutline,
  AdaptiveLearningPlan,
  OpenMaicSceneOutlineSnapshot,
} from "@/lib/session/types";
import { cn } from "@/lib/utils";

const RESOURCE_LABEL: Record<AdaptiveBranchOutline["kind"], string> = {
  prerequisite: "先修知识回顾",
  "worked-example": "新例题",
  application: "应用练习",
  extension: "拓展思考",
};

type ResourceTone = "foundation" | "enrichment";

export function CoursePublishPathPreview({
  mainScenes,
  onPreviewBranch,
  plan,
}: {
  mainScenes: ReadonlyArray<OpenMaicSceneOutlineSnapshot>;
  onPreviewBranch?: (branch: AdaptiveBranchOutline) => void;
  plan: AdaptiveLearningPlan;
}) {
  const activeBranches = plan.branches.filter((branch) => branch.enabled !== false);
  const foundationBranches = activeBranches.filter((branch) => branch.kind === "prerequisite");
  const enrichmentBranches = activeBranches.filter((branch) => branch.kind !== "prerequisite");
  const assessmentScenes = mainScenes.filter((scene) => scene.type === "quiz");
  const readyResources = activeBranches.filter(
    (branch) => branch.preparedResource?.status === "ready" && branch.preparedResource.classroomId,
  ).length;
  const runtimeMax = plan.enrichmentStrategy?.runtimeMaxPerStudent;

  return (
    <section className="overflow-hidden rounded-[14px] border border-[var(--pbl-border)] bg-white shadow-[var(--shadow-soft)]">
      <header className="relative overflow-hidden border-b border-[var(--pbl-border)] bg-[radial-gradient(circle_at_92%_0%,rgba(219,234,254,0.75),transparent_34%),linear-gradient(120deg,#ffffff_0%,#fbfdff_100%)] px-5 py-5 sm:px-6">
        <div aria-hidden className="absolute bottom-0 left-20 right-0 h-px bg-gradient-to-r from-transparent via-blue-200 to-transparent" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-[10px] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]">
              <Route size={19} />
            </span>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--pbl-teacher)]">学生路径预览</p>
              <h2 className="mt-1 font-editorial text-xl font-semibold text-[var(--pbl-text-strong)]">个性化学习路径</h2>
              <p className="mt-1.5 max-w-3xl text-xs leading-5 text-[var(--pbl-text-muted)]">
                依据课前诊断与主课达标结果，为每位学生选择必要的补足或拓展资源。
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold">
            <span className={cn(
              "rounded-full border px-2.5 py-1",
              plan.enabled
                ? "border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)] text-[var(--pbl-success)]"
                : "border-[var(--pbl-warning-border)] bg-[var(--pbl-warning-soft)] text-[var(--pbl-warning)]",
            )}>{plan.enabled ? "路径已启用" : "路径未启用"}</span>
            <span className="rounded-full border border-[var(--pbl-border)] bg-white px-2.5 py-1 text-[var(--pbl-text-muted)]">
              {readyResources}/{activeBranches.length} 份资源就绪
            </span>
          </div>
        </div>
      </header>

      <div className="px-4 py-5 sm:px-6 sm:py-6">
        <div className="grid gap-2 lg:grid-cols-[1fr_auto_1fr_auto_1.15fr_auto_1fr] lg:items-stretch">
          <FlowStep
            detail={`${plan.pretest.questions.length} 道题 · 约 ${plan.pretest.estimatedMinutes || 1} 分钟`}
            icon={<FileQuestion size={17} />}
            index="01"
            title={plan.pretest.title || "课前诊断"}
            tone="amber"
          />
          <FlowArrow />
          <FlowStep
            detail={foundationBranches.length ? `${foundationBranches.length} 份资源按知识缺口选用` : "当前未配置补足资源"}
            icon={<Layers3 size={17} />}
            index="02"
            title="必要时补足先修知识"
            tone="blue"
          />
          <FlowArrow />
          <FlowStep
            detail={`${mainScenes.length} 个学习页面 · ${assessmentScenes.length} 次达标检测`}
            icon={<BookOpenCheck size={17} />}
            index="03"
            title="进入完整主课程"
            tone="teacher"
          />
          <FlowArrow />
          <FlowStep
            detail={enrichmentBranches.length
              ? `${enrichmentBranches.length} 份候选资源${runtimeMax ? ` · 每人至多 ${runtimeMax} 份` : ""}`
              : "当前未配置拓展资源"}
            icon={<Sparkles size={17} />}
            index="04"
            title="达标后选择拓展"
            tone="violet"
          />
        </div>

        <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <ResourceGroup
            branches={foundationBranches}
            empty="当前课程未设置课前补足资源。"
            eyebrow="课前诊断后"
            mainScenes={mainScenes}
            onPreviewBranch={onPreviewBranch}
            title="先修知识补足"
            tone="foundation"
          />
          <ResourceGroup
            branches={enrichmentBranches}
            empty="当前课程未设置达标后的拓展资源。"
            eyebrow="完成主课后"
            mainScenes={mainScenes}
            onPreviewBranch={onPreviewBranch}
            title="达标拓展"
            tone="enrichment"
          />
        </div>

        <footer className="mt-5 grid gap-3 rounded-[10px] border border-[var(--pbl-border)] bg-[var(--pbl-surface-soft)]/55 px-4 py-3 sm:grid-cols-3">
          <PathRule
            icon={<Gauge size={15} />}
            label="拓展门槛"
            value={`主课达标率 ≥ ${plan.thresholds.enrichmentMasteryMin ?? 80}%`}
          />
          <PathRule
            icon={<Clock3 size={15} />}
            label="课程预算"
            value={`${plan.timeBudgetMin} 分钟内动态安排`}
          />
          <PathRule
            icon={<CheckCircle2 size={15} />}
            label="发布状态"
            value={plan.status === "teacher-confirmed" ? "路径规则已由教师确认" : "路径规则仍待教师确认"}
          />
        </footer>
      </div>
    </section>
  );
}

function FlowStep({
  detail,
  icon,
  index,
  title,
  tone,
}: {
  detail: string;
  icon: React.ReactNode;
  index: string;
  title: string;
  tone: "amber" | "blue" | "teacher" | "violet";
}) {
  return (
    <article className={cn(
      "min-w-0 rounded-[10px] border px-3.5 py-3.5",
      tone === "amber" && "border-amber-200 bg-amber-50/65",
      tone === "blue" && "border-sky-200 bg-sky-50/65",
      tone === "teacher" && "border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]",
      tone === "violet" && "border-violet-200 bg-violet-50/65",
    )}>
      <div className="flex items-center justify-between gap-3">
        <span className={cn(
          "grid size-8 place-items-center rounded-[8px] bg-white shadow-sm",
          tone === "amber" && "text-amber-700",
          tone === "blue" && "text-sky-700",
          tone === "teacher" && "text-[var(--pbl-teacher)]",
          tone === "violet" && "text-violet-700",
        )}>{icon}</span>
        <span className="text-[10px] font-bold tabular-nums text-stone-400">{index}</span>
      </div>
      <h3 className="mt-3 text-sm font-bold leading-5 text-stone-900">{title}</h3>
      <p className="mt-1 text-[11px] leading-5 text-stone-500">{detail}</p>
    </article>
  );
}

function FlowArrow() {
  return (
    <span aria-hidden className="hidden items-center text-stone-300 lg:flex">
      <ArrowRight size={16} />
    </span>
  );
}

function ResourceGroup({
  branches,
  empty,
  eyebrow,
  mainScenes,
  onPreviewBranch,
  title,
  tone,
}: {
  branches: AdaptiveBranchOutline[];
  empty: string;
  eyebrow: string;
  mainScenes: ReadonlyArray<OpenMaicSceneOutlineSnapshot>;
  onPreviewBranch?: (branch: AdaptiveBranchOutline) => void;
  title: string;
  tone: ResourceTone;
}) {
  return (
    <section>
      <div className="flex items-end justify-between gap-3 border-b border-[var(--pbl-border)] pb-3">
        <div>
          <p className={cn(
            "text-[10px] font-bold uppercase tracking-[0.15em]",
            tone === "foundation" ? "text-sky-700" : "text-violet-700",
          )}>{eyebrow}</p>
          <h3 className="mt-1 font-editorial text-lg font-semibold text-[var(--pbl-text-strong)]">{title}</h3>
        </div>
        <span className="text-[11px] font-semibold text-[var(--pbl-text-subtle)]">{branches.length} 份资源</span>
      </div>
      {branches.length ? (
        <div className="mt-3 space-y-3">
          {branches.map((branch) => (
            <ResourceCard
              branch={branch}
              key={branch.id}
              mainScenes={mainScenes}
              onPreviewBranch={onPreviewBranch}
              tone={tone}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-[9px] border border-dashed border-[var(--pbl-border-strong)] px-4 py-6 text-center text-xs text-[var(--pbl-text-subtle)]">
          {empty}
        </div>
      )}
    </section>
  );
}

function ResourceCard({
  branch,
  mainScenes,
  onPreviewBranch,
  tone,
}: {
  branch: AdaptiveBranchOutline;
  mainScenes: ReadonlyArray<OpenMaicSceneOutlineSnapshot>;
  onPreviewBranch?: (branch: AdaptiveBranchOutline) => void;
  tone: ResourceTone;
}) {
  const prepared = branch.preparedResource;
  const canPreview = Boolean(prepared?.classroomId);
  const linkedSceneIds = branch.trigger?.assessmentSceneIds ?? [];
  const linkedSceneNames = linkedSceneIds
    .map((id) => mainScenes.find((scene) => scene.id === id)?.title)
    .filter((title): title is string => Boolean(title));
  const status = resourceStatus(branch);
  const trigger = branch.kind === "prerequisite"
    ? `诊断发现 ${Math.max(1, branch.prerequisiteKnowledgePointIds.length)} 项相关知识缺口时启用`
    : `达标率达到 ${branch.trigger?.scoreThreshold ?? 80}%${branch.trigger?.minimumRemainingSec ? `，且剩余至少 ${Math.ceil(branch.trigger.minimumRemainingSec / 60)} 分钟` : ""}`;

  return (
    <article className="rounded-[10px] border border-[var(--pbl-border)] bg-white px-4 py-4 shadow-[0_4px_16px_rgba(41,37,36,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-bold",
              tone === "foundation" ? "bg-sky-100 text-sky-800" : "bg-violet-100 text-violet-800",
            )}>{RESOURCE_LABEL[branch.kind]}</span>
            <span className={cn("text-[10px] font-semibold", status.className)}>{status.label}</span>
          </div>
          <h4 className="mt-2 text-sm font-bold leading-5 text-stone-900">{branch.title}</h4>
          <p className="mt-1 text-xs leading-5 text-stone-500">{branch.objective}</p>
        </div>
        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-stone-400">{durationLabel(branch.targetDurationSec)}</span>
      </div>

      <dl className="mt-3 grid gap-2 rounded-[8px] bg-[var(--pbl-surface-soft)]/65 px-3 py-2.5 text-[11px] leading-5 sm:grid-cols-[72px_1fr]">
        <dt className="font-semibold text-stone-400">触发条件</dt>
        <dd className="text-stone-700">{trigger}</dd>
        {linkedSceneNames.length ? (
          <>
            <dt className="font-semibold text-stone-400">判断节点</dt>
            <dd className="text-stone-700">{linkedSceneNames.join("、")}</dd>
          </>
        ) : null}
      </dl>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-stone-400">
          <PlayCircle size={12} /> {branch.sceneType === "interactive" ? "互动学习资源" : "讲解学习资源"}
          {prepared?.scenesCount ? ` · ${prepared.scenesCount} 页` : ""}
        </span>
        {canPreview && onPreviewBranch ? (
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-[6px] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)] px-3 text-[11px] font-bold text-[var(--pbl-teacher)] transition hover:bg-white"
            onClick={() => onPreviewBranch(branch)}
            type="button"
          >
            <Eye size={13} /> 查看课堂实景
          </button>
        ) : null}
      </div>
    </article>
  );
}

function PathRule({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 text-[var(--pbl-teacher)]">{icon}</span>
      <div>
        <p className="text-[10px] font-semibold text-[var(--pbl-text-subtle)]">{label}</p>
        <p className="mt-0.5 text-xs font-semibold text-[var(--pbl-text)]">{value}</p>
      </div>
    </div>
  );
}

function resourceStatus(branch: AdaptiveBranchOutline): { className: string; label: string } {
  if (branch.preparedResource?.status === "ready" && branch.preparedResource.classroomId) {
    return { className: "text-[var(--pbl-success)]", label: "资源已就绪" };
  }
  if (branch.preparedResource?.status === "generating") {
    return { className: "text-[var(--pbl-teacher)]", label: "资源生成中" };
  }
  if (branch.preparedResource?.status === "stale") {
    return { className: "text-[var(--pbl-warning)]", label: "资源需更新" };
  }
  if (branch.preparedResource?.status === "failed") {
    return { className: "text-rose-700", label: "资源生成失败" };
  }
  return branch.status === "teacher-confirmed"
    ? { className: "text-stone-500", label: "规则已确认" }
    : { className: "text-[var(--pbl-warning)]", label: "规则待确认" };
}

function durationLabel(seconds: number): string {
  if (!seconds) return "未估时";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `${minutes} 分钟`;
}
