import type { SceneOutline } from "@/lib/openmaic/types/generation";
import { ensureTeachingToolPlans } from "@/lib/openmaic/generation/teaching-tool-plan";

export type AdaptiveGenerationProgress = {
  progress: number;
  message: string;
};

type ClassroomAssetStatus = "running" | "completed" | "partial-failure";

function hasPreparedNarration(classroom: {
  scenes?: Array<{
    ttsPolicy?: string;
    actions?: Array<{ type?: string; text?: string; audioUrl?: string }>;
  }>;
}): boolean {
  const narratedScenes = classroom.scenes?.filter((scene) => scene.ttsPolicy === "target-duration") ?? [];
  if (!narratedScenes.length) return false;
  const speech = narratedScenes.flatMap((scene) =>
    (scene.actions ?? []).filter((action) => action.type === "speech" && action.text?.trim()),
  );
  return speech.length > 0 && speech.every((action) => Boolean(action.audioUrl));
}

function waitForPollInterval(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = globalThis.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

export async function waitForAdaptiveClassroomAssets(input: {
  classroomId: string;
  signal?: AbortSignal;
  intervalMs?: number;
  maxAttempts?: number;
  onProgress?: (progress: AdaptiveGenerationProgress) => void;
}): Promise<void> {
  const intervalMs = input.intervalMs ?? 3_000;
  const maxAttempts = input.maxAttempts ?? 100;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
    const response = await fetch(
      `/api/openmaic/classroom?id=${encodeURIComponent(input.classroomId)}`,
      { cache: "no-store", signal: input.signal },
    );
    if (response.ok) {
      const payload = await response.json() as {
        success?: boolean;
        classroom?: {
          scenes?: Array<{
            ttsPolicy?: string;
            actions?: Array<{ type?: string; text?: string; audioUrl?: string }>;
          }>;
          assetGeneration?: { status?: ClassroomAssetStatus; failures?: Array<{ type: string; error: string }> };
        };
      };
      const classroom = payload.classroom;
      const assets = classroom?.assetGeneration;
      // Inspect the durable scene snapshot as well as the bookkeeping flag.
      // This recovers classrooms created by older builds that never wrote an
      // assetGeneration status, and avoids trusting a stale completed marker.
      if (classroom && hasPreparedNarration(classroom)) return;
      if (assets?.status === "partial-failure") {
        const ttsFailure = assets.failures?.find((failure) => failure.type === "tts");
        throw new Error(ttsFailure?.error || "微课语音生成失败，请重新制作");
      }
      if (assets?.status === "completed") {
        throw new Error("微课讲解音频不完整，请重新制作");
      }
    }
    input.onProgress?.({ progress: 96, message: "知知正在生成并检查讲解音频" });
    await waitForPollInterval(intervalMs, input.signal);
  }
  throw new Error("微课语音准备超时，请稍后重新制作");
}

export async function generateAdaptiveClassroom(input: {
  title: string;
  requirement: string;
  stageKey: "ai-learning" | "proposal" | "make" | "showcase" | "reflection";
  scenes: Array<{
    title: string;
    description: string;
    keyPoints: string[];
    type?: "slide" | "interactive";
    targetDurationSec: number;
    knowledgePointIds?: string[];
  }>;
  signal?: AbortSignal;
  requestRole?: "student" | "teacher";
  onStarted?: () => void | Promise<void>;
  onClassroomCreated?: (result: { classroomId: string; scenesCount: number }) => void | Promise<void>;
  onProgress?: (progress: AdaptiveGenerationProgress) => void;
  waitForAssets?: boolean;
  assetPollIntervalMs?: number;
  assetPollAttempts?: number;
}): Promise<{ classroomId: string; scenesCount: number }> {
  const outlines: SceneOutline[] = ensureTeachingToolPlans(input.scenes.map((scene, index) => ({
    id: `adaptive-${Date.now().toString(36)}-${index + 1}`,
    type: scene.type ?? "slide",
    title: scene.title,
    description: scene.description,
    keyPoints: scene.keyPoints,
    teachingObjective: scene.description,
    estimatedDuration: scene.targetDurationSec,
    targetDurationSec: scene.targetDurationSec,
    order: index,
    stageKey: input.stageKey,
    stageLabel:
      input.stageKey === "ai-learning"
        ? "知识讲授"
        : input.stageKey === "proposal"
          ? "方案构思"
          : input.stageKey === "make"
            ? "项目实践"
            : input.stageKey === "showcase"
              ? "成果汇报"
              : "学习反思",
    audience: "student",
    generationPurpose: "knowledge-teaching",
    detailKind: "knowledge-explanation",
    knowledgePointIds: scene.knowledgePointIds ?? [],
    ttsPolicy: "target-duration",
    resourceTypes: scene.type === "interactive" ? ["interactive-demo"] : ["ppt"],
    narrationMode: "embedded-segment",
  })));
  const response = await fetch("/api/openmaic/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenPBL-Role": input.requestRole ?? "student",
    },
    body: JSON.stringify({
      requirement: input.requirement,
      courseTitle: input.title,
      sceneOutlines: outlines,
      enableTTS: true,
    }),
    signal: input.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`微课生成失败（HTTP ${response.status}）`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: { classroomId: string; scenesCount: number } | undefined;
  let started = false;
  const announceStarted = async () => {
    if (started) return;
    started = true;
    await input.onStarted?.();
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(6)) as {
        type?: string;
        progress?: number;
        message?: string;
        id?: string;
        scenesCount?: number;
        details?: string;
      };
      if (event.type === "progress") {
        await announceStarted();
        input.onProgress?.({
          progress: event.progress ?? 0,
          message: event.message ?? "正在生成",
        });
      } else if (event.type === "done" && event.id) {
        await announceStarted();
        result = { classroomId: event.id, scenesCount: event.scenesCount ?? outlines.length };
      } else if (event.type === "error") {
        throw new Error(event.details || "微课生成失败");
      }
    }
  }
  if (!result) throw new Error("微课生成未返回课堂资源");
  await input.onClassroomCreated?.(result);
  if (input.waitForAssets) {
    await waitForAdaptiveClassroomAssets({
      classroomId: result.classroomId,
      signal: input.signal,
      intervalMs: input.assetPollIntervalMs,
      maxAttempts: input.assetPollAttempts,
      onProgress: input.onProgress,
    });
  }
  return result;
}
