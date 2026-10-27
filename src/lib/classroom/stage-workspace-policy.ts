import type {
  StageWorkspaceAccess,
  StageWorkspaceMode,
  StageWorkspacePolicy,
} from "@/lib/session/types";

export const DEFAULT_STAGE_WORKSPACE_POLICY: Readonly<StageWorkspacePolicy> = {
  access: "companions-only",
  defaultMode: "companions",
};

// AI 授知继续使用原专用课堂；其余五个阶段默认进入沉浸任务舱。
const COMPANION_STAGE_KEYS = new Set(["proposal", "make"]);

export function stageSupportsCompanionWorkspace(stageKey: string | undefined): boolean {
  return Boolean(stageKey && COMPANION_STAGE_KEYS.has(stageKey));
}

const VALID_ACCESS = new Set<StageWorkspaceAccess>([
  "task-only",
  "companions-only",
  "student-choice",
]);

export function normalizeStageWorkspacePolicy(
  policy?: Partial<StageWorkspacePolicy> | null,
): StageWorkspacePolicy {
  const access = policy?.access && VALID_ACCESS.has(policy.access)
    ? policy.access
    : DEFAULT_STAGE_WORKSPACE_POLICY.access;
  const defaultMode = policy?.defaultMode === "task" || policy?.defaultMode === "companions"
    ? policy.defaultMode
    : DEFAULT_STAGE_WORKSPACE_POLICY.defaultMode;

  if (access === "task-only") return { access, defaultMode: "task" };
  if (access === "companions-only") return { access, defaultMode: "companions" };
  return { access, defaultMode };
}

export function getStageWorkspacePolicy(
  _policies: Record<string, StageWorkspacePolicy> | undefined,
  stageKey: string | undefined,
): StageWorkspacePolicy {
  return stageSupportsCompanionWorkspace(stageKey)
    ? { access: "companions-only", defaultMode: "companions" }
    : { access: "task-only", defaultMode: "task" };
}

export function resolveStageWorkspaceMode(
  policy: StageWorkspacePolicy,
  studentPreference?: StageWorkspaceMode,
): StageWorkspaceMode {
  const normalized = normalizeStageWorkspacePolicy(policy);
  if (normalized.access === "task-only") return "task";
  if (normalized.access === "companions-only") return "companions";
  return studentPreference === "task" || studentPreference === "companions"
    ? studentPreference
    : normalized.defaultMode;
}

export function updateStageWorkspacePolicy(
  policies: Record<string, StageWorkspacePolicy> | undefined,
  stageKey: string,
  patch: Partial<StageWorkspacePolicy>,
): Record<string, StageWorkspacePolicy> {
  void patch;
  return {
    ...(policies ?? {}),
    [stageKey]: getStageWorkspacePolicy(undefined, stageKey),
  };
}
