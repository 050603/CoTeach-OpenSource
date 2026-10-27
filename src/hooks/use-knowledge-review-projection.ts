"use client";

import { useEffect, useState } from "react";
import type { PlaybackSyncState } from "@openmaic/components/stage-experience";
import type { Scene } from "@openmaic/lib/types/stage";
import { knowledgeProjection, knowledgeProjectionPlayback } from "@/lib/classroom/knowledge-review";
import { ownsProjection, projectionClientId } from "@/lib/realtime/projection-controller";
import type { ProjectionStateSnapshot } from "@/lib/realtime/projection-state";
import type { Course, TeacherResourceProjection } from "@/lib/session/types";
import { boundedFetch } from "@/lib/browser/bounded-fetch";
import { useSession } from "@/lib/session/store";

type Intent = { projection: TeacherResourceProjection | null; baseline: number; sequence: number };

/** Projection writes stay in the shared controller; preview state never enters it. */
export function useKnowledgeReviewProjection(course: Course, active: boolean) {
  const { setUiState, addActivity } = useSession();
  const projection = course.uiState?.teacherResourceProjection;
  const controlsProjection = ownsProjection(course.uiState);
  const needsTakeover = Boolean(course.uiState?.projectionController && !controlsProjection);
  const [intent, setIntent] = useState<Intent>();
  const [receipt, setReceipt] = useState<{ sequence: number; error?: string }>({ sequence: 0 });

  function issue(next: TeacherResourceProjection | null, takeover = false) {
    setIntent((previous) => ({ projection: next, baseline: course.uiState?.projectionVersion ?? 0, sequence: (previous?.sequence ?? 0) + 1 }));
    setUiState(course.id, { teacherResourceProjection: next }, ...(takeover ? [{ takeover: true }] : []));
  }

  useEffect(() => {
    if (!intent || !active || receipt.sequence === intent.sequence) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 10_000;
    let lastError = "尚未确认学生端投屏状态，请重试";
    async function confirm() {
      try {
        const response = await boundedFetch(`/api/courses/${encodeURIComponent(course.id)}/projection`, {
          cache: "no-store", headers: { "X-OpenPBL-Role": "teacher" },
          signal: controller.signal,
        }, 2_500);
        if (!response.ok) throw new Error(`投屏状态确认失败（HTTP ${response.status}）`);
        const snapshot = await response.json() as ProjectionStateSnapshot;
        if (controller.signal.aborted) return;
        if (snapshot.courseId !== course.id) throw new Error("投屏状态所属课堂不匹配，请重试");
        const target = intent!.projection;
        const remote = snapshot.teacherResourceProjection;
        const matches = target ? remote?.sceneId === target.sceneId && remote.classroomId === target.classroomId
          && remote.startedAt === target.startedAt && (remote.mode ?? "forced") === target.mode : !remote;
        if (snapshot.projectionVersion > intent!.baseline && matches && (!target || snapshot.projectionController?.clientId === projectionClientId())) {
          setReceipt({ sequence: intent!.sequence });
          return;
        }
        if (snapshot.projectionVersion > intent!.baseline && snapshot.projectionController
          && snapshot.projectionController.clientId !== projectionClientId()) {
          setReceipt({ sequence: intent!.sequence, error: "投屏控制权已由其他教师窗口接管" });
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        lastError = error instanceof Error ? error.message : "投屏状态确认失败";
      }
      if (Date.now() >= deadline) setReceipt({ sequence: intent!.sequence, error: lastError });
      else timer = setTimeout(() => void confirm(), 500);
    }
    timer = setTimeout(() => void confirm(), 300);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [course.id, active, intent, receipt.sequence]);

  function project(scene: Scene, mode: "forced" | "optional") {
    if (course.status !== "teaching" || !course.aiLearningClassroomId) return;
    issue(knowledgeProjection(course.aiLearningClassroomId, scene, mode, projection), needsTakeover);
    addActivity(course.id, "投屏全班补讲页面", scene.title);
  }

  function stop() {
    if (!controlsProjection) return;
    issue(null);
    addActivity(course.id, "停止全班补讲页面投屏", projection?.title);
  }

  function syncPlayback(state: Omit<PlaybackSyncState, "version">) {
    if (!active || !controlsProjection || !projection || state.snapshot.sceneId !== projection.sceneId) return;
    setUiState(course.id, { teacherResourceProjection: knowledgeProjectionPlayback(projection, state) });
  }

  return { projection, controlsProjection, needsTakeover, project, stop, syncPlayback,
    pending: Boolean(intent && receipt.sequence !== intent.sequence),
    error: intent && receipt.sequence === intent.sequence ? receipt.error : undefined,
    confirmed: Boolean(intent && receipt.sequence === intent.sequence && !receipt.error),
    canRetry: Boolean(intent && (!needsTakeover || intent.projection)),
    retry: () => { if (intent && (!needsTakeover || intent.projection)) issue(intent.projection, needsTakeover); },
  };
}
