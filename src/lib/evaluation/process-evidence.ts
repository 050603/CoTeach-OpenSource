import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { verifiedKnowledgeLectureScoreRate } from "@/lib/knowledge-lecture";
import type { KnowledgeLectureAttempt } from "@/lib/session/types";
import type { PblProcessEvidence } from "./process-contract";
import { listAiInteractionEvents } from "@/lib/ai-collaboration/audit-read";

export const processObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const processHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function plain(value: unknown, limit = 3500): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Sample across the entire timeline within each kind, retaining first and latest evidence. */
export function selectProcessEvidence(evidence: PblProcessEvidence[], perKind = 24): PblProcessEvidence[] {
  const byKind = new Map<string, PblProcessEvidence[]>();
  for (const item of evidence) {
    const rows = byKind.get(item.kind) ?? []; rows.push(item); byKind.set(item.kind, rows);
  }
  return [...byKind.values()].flatMap(rows => {
    const sorted = rows.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
    if (sorted.length <= perKind) return sorted;
    return Array.from({ length: perKind }, (_, i) => ({ ...sorted[Math.round(i * (sorted.length - 1) / (perKind - 1))],
      limitations: [...sorted[Math.round(i * (sorted.length - 1) / (perKind - 1))].limitations, `本类共 ${sorted.length} 条记录，本报告按时间抽取 ${perKind} 条`] }));
  }).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
}

export function processVersionChange(before: string, after: string): string {
  if (before === after) return "内容未变化；保存次数不代表迭代。";
  let start = 0; while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0; while (end < before.length - start && end < after.length - start && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return `修改前：${plain(before.slice(Math.max(0, start - 100), before.length - end + 100), 1600)}\n修改后：${plain(after.slice(Math.max(0, start - 100), after.length - end + 100), 1600)}`;
}

export async function readProcessEvidence(participationId: string) {
  const snapshotAt = new Date().toISOString();
  const participation = await prisma.classroomParticipation.findUnique({ where: { id: participationId }, include: {
    enrollment: { select: { userId: true, offeringId: true, user: { select: { displayName: true } } } },
    instance: { include: { templateVersion: { select: { snapshot: true } } } },
  } });
  if (!participation) throw new Error("PROCESS_PARTICIPATION_NOT_FOUND");
  const studentId = participation.enrollment.userId;
  const [workspace, messages, interactions, learningInteractions, saves, artifacts, showcases, reflections, selfEvaluations, submissions] = await Promise.all([
    prisma.studentProjectWorkspace.findUnique({ where: { participationId }, select: { projectState: true } }),
    prisma.aiMessage.findMany({ where: { conversation: { participationId, userId: studentId, metadata: { path: ["feature"], equals: "lecture-chat" } } }, include: { conversation: { select: { title: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 201 }),
    listAiInteractionEvents({ courseId: participation.instanceId, studentId, stageKey: "make", limit: 300 }),
    listAiInteractionEvents({ courseId: participation.instanceId, studentId, stageKey: "ai-learning", limit: 300 }),
    prisma.domainEvent.findMany({ where: { participationId, classroomInstanceId: participation.instanceId, actorId: studentId,
      eventType: "COURSE_ACTION", payload: { path: ["action", "type"], equals: "UPSERT_SUBMISSION" } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 151 }),
    prisma.artifactVersion.findMany({ where: { artifact: { participationId }, status: "SUBMITTED" }, include: { artifact: { select: { title: true, type: true } } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 51 }),
    prisma.showcasePresentation.findMany({ where: { participationId }, orderBy: { createdAt: "asc" }, take: 30 }),
    prisma.reflection.findMany({ where: { participationId, authorId: studentId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.evaluation.findMany({ where: { participationId, evaluatorId: studentId, type: "PBL_SELF", result: { path: ["status"], equals: "submitted" } }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.domainEvent.findMany({ where: { participationId, actorId: studentId, classroomInstanceId: participation.instanceId,
      eventType: { in: ["document_version_submitted", "code_version_submitted"] } }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  const evidence: PblProcessEvidence[] = [];
  const progress = processObject(processObject(workspace?.projectState).aiLearningProgress);
  const attempts = Array.isArray(progress.knowledgeLectureAttempts) ? progress.knowledgeLectureAttempts as KnowledgeLectureAttempt[] : [];
  for (const attempt of attempts) evidence.push({ id: `quiz:${attempt.id}`, kind: "quiz", stageKey: "ai-learning", occurredAt: attempt.submittedAt,
    title: "知识小测原始作答", actor: "student", content: plain({ scoreRate: verifiedKnowledgeLectureScoreRate(attempt) ?? null, questions: attempt.questions.map(q => ({
      questionId: q.questionId, prompt: q.prompt, options: q.options, matchingOptions: q.matchingOptions,
      studentAnswer: q.rawAnswer ?? q.answer, authoredReferenceAnswer: q.referenceAnswer,
      serverGrading: attempt.gradingSource === "server" && q.gradingStatus === "graded" ? { earned: q.earned, points: q.points, feedback: q.feedback } : null,
    })) }, 10000),
    relatedEvidenceIds: [], limitations: verifiedKnowledgeLectureScoreRate(attempt) === undefined ? ["评分未核验或尚未完成，不能当作已确认成绩"] : [] });
  for (const row of messages.slice(0, 200)) evidence.push({ id: `message:${row.id}`, kind: "learning-dialogue", stageKey: "ai-learning", occurredAt: row.createdAt.toISOString(),
    title: row.conversation.title ?? "学习问答", actor: row.role === "assistant" ? "ai" : "student", content: plain(row.content), relatedEvidenceIds: [], limitations: row.role === "assistant" ? ["AI 回答不代表学生已理解或接受"] : [] });
  for (const row of [...interactions.events, ...learningInteractions.events]) {
    const payload = processObject(row.payload);
    const learning = row.stageKey === "ai-learning";
    evidence.push({ id: `interaction:${row.id}`, kind: learning ? "learning-dialogue" : "practice-dialogue", stageKey: row.stageKey, occurredAt: row.createdAt,
      title: `${learning ? "学习追问" : "实践协作"}：${row.eventType}`, actor: row.actorRole === "ai" ? "ai" : row.actorRole === "student" ? "student" : "system",
      content: plain({ content: row.content, requestId: row.requestId, sourceRequestId: payload.sourceRequestId, decision: payload.decision, contributionId: payload.contributionId, reason: payload.reason, replacement: payload.replacement }),
      relatedEvidenceIds: [], limitations: ["操作或决定记录本身不能证明作品已保存，也不能证明其理由来自学生独立判断"] });
  }
  const previousVersions = new Map<string, { id: string; content: string }>();
  for (const row of saves.slice(0, 150).reverse()) {
    const actionPayload = processObject(processObject(processObject(row.payload).action).payload);
    const submission = processObject(actionPayload.submission);
    const content = typeof submission.content === "string" ? submission.content : "";
    const stageKey = String(submission.stageKey ?? "make");
    const id = `save:${row.id}`;
    const versionKey = `${stageKey}:${submission.id ?? submission.type ?? "default"}`;
    const previous = previousVersions.get(versionKey);
    const provenance = processObject(actionPayload.verifiedAiRevision);
    const linked = provenance.status === "verified" && typeof provenance.eventId === "string" ? `interaction:${provenance.eventId}` : undefined;
    evidence.push({ id, kind: "saved-version", stageKey, occurredAt: row.createdAt.toISOString(), title: `已保存版本 ${submission.version ?? ""}`,
      actor: "student", content: previous ? processVersionChange(previous.content, content) : plain(content),
      relatedEvidenceIds: [previous?.id, linked].filter((v): v is string => !!v),
      limitations: ["仅包含已保存内容；内容变化不自动证明质量改善", ...(linked ? ["服务端已核验请求归属和保存前后版本；来源由编辑操作申报，不证明每处变化均来自AI或学生独立完成"] : ["AI 来源关联未确认，不因相邻对话推断改动来源"])] });
    previousVersions.set(versionKey, { id, content });
  }
  for (const row of artifacts.slice(0, 50)) evidence.push({ id: `artifact:${row.id}`, kind: "artifact", stageKey: "make", occurredAt: (row.submittedAt ?? row.createdAt).toISOString(),
    title: `${row.artifact.title} · 正式版本 ${row.sequence}`, actor: "student", content: row.sourceHtml ? plain(row.sourceHtml, 6000) : `文件类型 ${row.artifact.type}，仅有文件信息，未读取正文。`, relatedEvidenceIds: [],
    limitations: ["最终成果不等于独立完成过程", ...(!row.sourceHtml ? ["未读取文件正文，不能评价内容质量"] : [])] });
  for (const row of showcases) evidence.push({ id: `showcase:${row.id}`, kind: "presentation", stageKey: "showcase", occurredAt: row.createdAt.toISOString(),
    title: "汇报记录", actor: "system", content: `状态：${row.status}；作品版本：${row.artifactVersionId ?? "未关联"}`, relatedEvidenceIds: [], limitations: ["未记录现场表达或答辩正文，不能据此评价表达能力"] });
  for (const row of reflections) evidence.push({ id: `reflection:${row.id}`, kind: "reflection", stageKey: "reflection", occurredAt: row.createdAt.toISOString(),
    title: "学生反思", actor: "student", content: plain(row.content), relatedEvidenceIds: [], limitations: ["学生自述，应与实际记录交叉核对"] });
  for (const row of selfEvaluations) {
    const answers = processObject(processObject(row.result).answers);
    evidence.push({ id: `self:${row.id}`, kind: "reflection", stageKey: "reflection", occurredAt: String(processObject(row.result).updatedAt ?? row.createdAt.toISOString()), title: "已提交的个人自评",
      actor: "student", content: plain({ evidence: answers.evidence, learning: answers.learning, plan: answers.plan }), relatedEvidenceIds: [], limitations: ["学生自述，应与实际记录交叉核对；自评分数不作为AI评分依据"] });
  }
  for (const row of submissions) {
    const payload = processObject(row.payload);
    const artifactVersionId = payload.artifactVersionId ?? payload.versionId;
    if (typeof payload.revisionNote !== "string" || !payload.revisionNote.trim()) continue;
    evidence.push({ id: `revision-note:${row.id}`, kind: "reflection", stageKey: "make", occurredAt: row.createdAt.toISOString(), title: "正式提交的修改说明",
      actor: "student", content: plain(payload.revisionNote), relatedEvidenceIds: typeof artifactVersionId === "string" ? [`artifact:${artifactVersionId}`] : [], limitations: ["学生自述的修改理由，需要与保存版本核对"] });
  }
  const gaps = [messages.length > 200 ? "学习问答仅读取最近 200 条" : "", interactions.nextCursor ? "实践协作仅读取最近 300 条" : "", learningInteractions.nextCursor ? "学习追问审计仅读取最近 300 条" : "",
    saves.length > 150 ? "草稿仅读取最近 150 个保存版本" : "", artifacts.length > 50 ? "正式作品仅读取最近 50 个版本" : ""].filter(Boolean);
  const selected = selectProcessEvidence(evidence);
  const design = processObject(processObject(participation.instance.templateVersion.snapshot).design);
  const context = { name: design.name, drivingQuestion: design.drivingQuestion, learningObjectives: design.learningObjectives };
  const runtime = processObject(participation.instance.runtimeConfig);
  const stageKey = ["launch", "ai-learning", "make", "showcase", "reflection"][Number(runtime.currentStageIndex ?? 0)] ?? "launch";
  return { participationId, instanceId: participation.instanceId, studentId, offeringId: participation.enrollment.offeringId, snapshotAt,
    name: participation.enrollment.user.displayName, context, stageKey, contractVersion: runtime.evaluationContractVersion,
    status: participation.instance.status, evidence: selected, gaps, evidenceThrough: selected.at(-1)?.occurredAt ?? null,
    fingerprint: processHash({ version: 1, context, stageKey, evidence: selected, gaps }) };
}
