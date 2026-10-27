import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { companionThreadId } from "@/lib/companion/scoped-message-batch";
import type { DocumentAiComment, DocumentAiCommentThread } from "./document-comment-types";

type Identity = {
  courseId: string; studentId: string; participationId: string;
  stageKey: string; workspaceKind: string; threadStageKey: string;
};
type Receipt = { taskId: string; requestId: unknown; responseRequestId: unknown;
  threadId: string; responseThreadId: unknown; question: unknown; answer: unknown };
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const time = (comment: unknown) => {
  const at = object(comment).createdAt;
  return typeof at === "string" ? Date.parse(at) : NaN;
};

/** Only an apparent same-millisecond inversion needs historical receipts.
 * New messages retain their distinct request/completion times and do no query.
 */
export async function restoreDocumentCommentReplyOrder(input: Identity, threads: DocumentAiCommentThread[],
  db: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma): Promise<DocumentAiCommentThread[]> {
  const suspect = threads.filter(thread => {
    const assistantTimes = new Set<number>();
    return thread.comments.some(comment => {
      const at = time(comment);
      if (!Number.isFinite(at)) return false;
      if (comment.role === "assistant") assistantTimes.add(at);
      return comment.role === "student" && assistantTimes.has(at);
    });
  });
  if (!suspect.length) return threads;
  const ids = [...new Set(suspect.map(thread => thread.id))];
  // Project only the immutable receipt's last question/answer, not its entire
  // accumulated transcript. All identity predicates are server-bound values.
  const receipts = await db.$queryRaw<Receipt[]>`
    SELECT t.id AS "taskId", t.input->>'requestId' AS "requestId",
      t.output#>>'{response,requestId}' AS "responseRequestId",
      t.input->>'conversationId' AS "threadId",
      t.output#>>'{response,commentThread,id}' AS "responseThreadId",
      (t.output #> '{response,commentThread,comments}') -> -2 AS question,
      (t.output #> '{response,commentThread,comments}') -> -1 AS answer
    FROM "AiTask" t
    JOIN "AiConversation" c ON c.id = t."conversationId"
    JOIN "ClassroomParticipation" p ON p.id = c."participationId"
    JOIN "Enrollment" e ON e.id = p."enrollmentId"
    JOIN "ClassroomInstance" i ON i.id = p."instanceId"
    JOIN "Activity" a ON a.id = i."activityId"
    JOIN "Chapter" ch ON ch.id = a."chapterId"
    WHERE t."taskType" = 'DOCUMENT_COLLABORATION' AND t.status = 'COMPLETED'
      AND t."createdById" = ${input.studentId} AND c."userId" = ${input.studentId}
      AND c."participationId" = ${input.participationId} AND p."instanceId" = ${input.courseId}
      AND e."userId" = ${input.studentId} AND c."offeringId" = e."offeringId"
      AND t."offeringId" = e."offeringId" AND ch."offeringId" = e."offeringId"
      AND c.id = ${companionThreadId(input.courseId, input.studentId, input.threadStageKey)}
      AND c.metadata->>'legacyStageKey' = ${input.threadStageKey}
      AND t.input->>'participationId' = ${input.participationId}
      AND t.input->>'stageKey' = ${input.stageKey} AND t.input->>'workspaceKind' = ${input.workspaceKind}
      AND t.input->>'intent' = 'comment-reply'
      AND t.input->>'conversationId' IN (${Prisma.join(ids)})`;
  type Pair = { threadId: string; question: DocumentAiComment; answer: DocumentAiComment };
  const pairs: Pair[] = [];
  for (const receipt of receipts) {
    const thread = suspect.find(item => item.id === receipt.threadId);
    const question = object(receipt.question); const answer = object(receipt.answer);
    if (!thread || typeof receipt.requestId !== "string" || !receipt.requestId
      || receipt.responseRequestId !== receipt.requestId || receipt.responseThreadId !== thread.id
      || question.role !== "student" || answer.role !== "assistant" || question.id === answer.id
      || !Number.isFinite(time(question)) || time(question) !== time(answer)) continue;
    const savedQuestion = thread.comments.find(comment => comment.id === question.id);
    const savedAnswer = thread.comments.find(comment => comment.id === answer.id);
    if (!savedQuestion || !savedAnswer || savedQuestion.role !== "student" || savedAnswer.role !== "assistant"
      || savedQuestion.content !== question.content || savedAnswer.content !== answer.content
      || time(savedQuestion) !== time(question) || time(savedAnswer) !== time(answer)) continue;
    pairs.push({ threadId: thread.id, question: savedQuestion, answer: savedAnswer });
  }
  if (!pairs.length) return threads;
  // Multiple receipts claiming the same message are ambiguous, even if their
  // proposed order agrees. Never guess or mutate an old timestamp to resolve it.
  const claims = new Map<string, number>();
  for (const pair of pairs) for (const message of [pair.question, pair.answer]) {
    claims.set(message.id, (claims.get(message.id) ?? 0) + 1);
  }
  return threads.map(thread => {
    let comments = thread.comments;
    for (const pair of pairs) {
      if (pair.threadId !== thread.id || claims.get(pair.question.id) !== 1 || claims.get(pair.answer.id) !== 1) continue;
      const question = comments.findIndex(comment => comment.id === pair.question.id);
      const answer = comments.findIndex(comment => comment.id === pair.answer.id);
      if (question < 0 || answer < 0 || question <= answer) continue;
      if (comments === thread.comments) comments = [...comments];
      [comments[answer], comments[question]] = [comments[question], comments[answer]];
    }
    return comments === thread.comments ? thread : { ...thread, comments };
  });
}
