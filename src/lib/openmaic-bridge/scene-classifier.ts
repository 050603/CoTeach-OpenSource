/**
 * 场景分类器：将 OpenMAIC 生成的场景拆分为
 * - 学生知识点教学场景（slide/quiz/interactive，不含引入）
 * - 教师授课资源场景（课程引入 slide + PBL 题目讲解）
 *
 * 分类规则：
 * 1. type === 'pbl' → 教师资源（PBL 题目讲解）
 * 2. 前 1-2 个 slide 且标题含引入关键词 → 教师资源（课程引入）
 * 3. 其余 → 学生知识点教学场景
 */

import type { Scene } from "@openmaic/lib/types/stage";
import type { TeacherResourceScene } from "@/lib/session/types";
import { classifyTeacherResourceGeneration } from "@/lib/teacher-resources/facilitation-scaffolds";
import {
  hasPblRoutingMetadata,
  isStudentAiLearningScene,
} from "@openmaic/lib/pbl/scene-routing";

// 引入场景标题关键词（中英文）
const INTRO_KEYWORDS = [
  "教师资源-课程引入",
  "教师资源",
  "引入",
  "导入",
  "开篇",
  "开场",
  "前言",
  "背景",
  "介绍",
  "简介",
  "概述",
  "概览",
  "课程开始",
  "introduction",
  "intro",
  "overview",
  "welcome",
  "opening",
  "getting started",
  "background",
];

const PBL_RESOURCE_KEYWORDS = [
  "教师资源-pbl项目布置",
  "教师资源-pbl 项目布置",
  "pbl项目布置",
  "pbl 项目布置",
  "项目布置",
  "项目介绍",
  "驱动问题讲解",
  "pbl topic",
  "project brief",
];

const TEACHER_RESOURCE_KEYWORDS = ["教师资源", "teacher resource"];

export interface SceneClassificationResult {
  /** 学生知识点教学场景（保留在学生 AI 授知课堂） */
  studentScenes: Scene[];
  /** 教师授课资源场景（课程引入 + PBL 题目讲解） */
  teacherScenes: Scene[];
  /** 教师资源场景的元数据（含讲稿提取） */
  teacherResourceMeta: TeacherResourceScene[];
}

/**
 * 判断场景是否为课程引入
 * 只检查前 2 个 slide 场景（引入通常在开头）
 */
function isIntroductionScene(scene: Scene, slideIndex: number): boolean {
  if (scene.type !== "slide") return false;
  if (slideIndex > 1) return false; // 只看前 2 个 slide
  const title = (scene.title ?? "").toLowerCase();
  return INTRO_KEYWORDS.some((kw) => title.includes(kw.toLowerCase()));
}

function isPblResourceScene(scene: Scene): boolean {
  const title = (scene.title ?? "").toLowerCase();
  return PBL_RESOURCE_KEYWORDS.some((kw) => title.includes(kw.toLowerCase()));
}

function isExplicitTeacherResource(scene: Scene): boolean {
  const title = (scene.title ?? "").toLowerCase();
  return TEACHER_RESOURCE_KEYWORDS.some((kw) => title.includes(kw.toLowerCase()));
}

function extractStageKey(scene: Scene): string | undefined {
  if (typeof scene.stageKey === "string" && scene.stageKey.trim()) {
    return scene.stageKey.trim();
  }
  const title = scene.title ?? "";
  const match = title.match(/(?:阶段|stage)\s*[:：]\s*([a-z0-9_-]+)/i);
  return match?.[1];
}

/**
 * 从场景的 actions 中提取讲稿文本
 * speech action 的 content/summary 是讲解文本
 */
function extractScript(scene: Scene): string | undefined {
  const actions = scene.actions;
  if (!Array.isArray(actions) || actions.length === 0) return undefined;

  const speechTexts: string[] = [];
  for (const action of actions) {
    // speech action 含 content/summary/text 字段
    const a = action as { type?: string; content?: string; summary?: string; text?: string };
    if (a.type === "speech" || a.type === "speak" || a.type === "narrate") {
      const text = a.content ?? a.summary ?? a.text;
      if (typeof text === "string" && text.trim()) {
        speechTexts.push(text.trim());
      }
    }
  }

  return speechTexts.length > 0 ? speechTexts.join("\n\n") : undefined;
}

/**
 * 从场景内容中提取描述和要点
 */
function extractOutline(scene: Scene): { description: string; keyPoints: string[] } {
  const content = scene.content as {
    description?: string;
    keyPoints?: string[];
    elements?: Array<{ text?: string; content?: string; type?: string }>;
  } | undefined;

  const description =
    content?.description ??
    scene.title ??
    "";

  // 从 content.elements 提取文本作为 keyPoints
  const keyPoints: string[] = [];
  if (content?.keyPoints && Array.isArray(content.keyPoints)) {
    keyPoints.push(...content.keyPoints.filter((p): p is string => typeof p === "string"));
  }
  if (content?.elements) {
    for (const el of content.elements) {
      if (el.type === "text" && typeof el.text === "string" && el.text.trim()) {
        keyPoints.push(el.text.trim());
      }
    }
  }

  return { description, keyPoints: keyPoints.slice(0, 8) };
}

/**
 * 分类场景：拆分为学生场景和教师资源场景
 */
export function classifyScenes(
  scenes: Scene[],
  options: { pblMode?: boolean } = {},
): SceneClassificationResult {
  const studentScenes: Scene[] = [];
  const teacherScenes: Scene[] = [];
  const teacherResourceMeta: TeacherResourceScene[] = [];

  // New PBL courses must fail closed: only a scene with the complete explicit
  // student route can enter the AI classroom. The fallback classifier remains
  // available for non-PBL/legacy OpenMAIC classrooms.
  const pblMode = options.pblMode ?? scenes.some(hasPblRoutingMetadata);

  // 跟踪 slide 序号（仅用于判断引入）
  let slideIndex = 0;

  for (const scene of scenes) {
    if (pblMode) {
      if (isStudentAiLearningScene(scene)) {
        studentScenes.push(scene);
      } else {
        teacherScenes.push(scene);
        const outline = extractOutline(scene);
        const generation = classifyTeacherResourceGeneration(scene.title ?? "");
        teacherResourceMeta.push({
          id: scene.id,
          role: scene.stageKey === "launch"
            ? "introduction"
            : scene.stageKey === "showcase"
              ? "pbl-topic"
              : "teaching-aid",
          stageKey: extractStageKey(scene),
          stageLabel: scene.stageLabel,
          activityId: scene.activityId,
          resourceTypes: scene.resourceTypes,
          title: scene.title ?? `场景 ${scene.order + 1}`,
          type: scene.type,
          description: outline.description,
          keyPoints: outline.keyPoints,
          script: extractScript(scene),
          audience: scene.audience,
          generationPurpose: scene.generationPurpose,
          companionIds: scene.companionIds,
          companionPrompt: scene.companionPrompt,
          parentActivityId: scene.parentActivityId,
          detailKind: scene.detailKind,
          targetDurationSec: scene.targetDurationSec,
          segmentIndex: scene.segmentIndex,
          segmentCount: scene.segmentCount,
          segmentRole: scene.segmentRole,
          segmentGroupId: scene.segmentGroupId,
          ttsPolicy: scene.ttsPolicy,
          generationMode:
            scene.generationPurpose === "facilitation-scaffold" ||
            scene.generationPurpose === "companion-guidance"
              ? "dynamic-scaffold"
              : generation.mode,
          ...(generation.mode === "dynamic-scaffold" ? { scaffoldKind: generation.kind } : {}),
        });
      }

      if (scene.type === "slide") slideIndex++;
      continue;
    }

    const explicitlyStudent = scene.audience === "student";
    const explicitlyTeacher = scene.audience === "teacher";
    const isPbl = !explicitlyStudent && (scene.type === "pbl" || isPblResourceScene(scene));
    const isIntro = !explicitlyStudent && isIntroductionScene(scene, slideIndex);
    const isTeacherResource = explicitlyTeacher || (!explicitlyStudent && isExplicitTeacherResource(scene));

    if (isPbl || isIntro || isTeacherResource) {
      teacherScenes.push(scene);
      const outline = extractOutline(scene);
      const generation = classifyTeacherResourceGeneration(scene.title ?? "");
      teacherResourceMeta.push({
        id: scene.id,
        role: isIntro
          ? "introduction"
          : isPbl
            ? "pbl-topic"
            : "teaching-aid",
        stageKey: extractStageKey(scene),
        stageLabel: scene.stageLabel,
        activityId: scene.activityId,
        resourceTypes: scene.resourceTypes,
        title: scene.title ?? `Scene ${scene.order + 1}`,
        type: scene.type,
        description: outline.description,
        keyPoints: outline.keyPoints,
        script: extractScript(scene),
        audience: scene.audience,
        generationPurpose: scene.generationPurpose,
        companionIds: scene.companionIds,
        companionPrompt: scene.companionPrompt,
        parentActivityId: scene.parentActivityId,
        detailKind: scene.detailKind,
        targetDurationSec: scene.targetDurationSec,
        segmentIndex: scene.segmentIndex,
        segmentCount: scene.segmentCount,
        segmentRole: scene.segmentRole,
        segmentGroupId: scene.segmentGroupId,
        ttsPolicy: scene.ttsPolicy,
        generationMode:
          scene.generationPurpose === "facilitation-scaffold" ||
          scene.generationPurpose === "companion-guidance"
            ? "dynamic-scaffold"
            : generation.mode,
        ...(generation.mode === "dynamic-scaffold" ? { scaffoldKind: generation.kind } : {}),
      });
    } else {
      studentScenes.push(scene);
    }

    if (scene.type === "slide") slideIndex++;
  }

  if (studentScenes.length === 0) {
    throw new Error("AI 生成结果未包含可供学生学习的核心知识点场景，请调整大纲后重新生成。");
  }

  return { studentScenes, teacherScenes, teacherResourceMeta };
}
