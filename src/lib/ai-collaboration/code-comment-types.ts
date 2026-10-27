import type { CodeAiChangeSet } from "@/lib/ai-collaboration/code-policy";

export type CodeAiComment = {
  id: string;
  role: "student" | "assistant";
  content: string;
  createdAt: string;
};

export type CodeAiCommentThread = {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  severity: "notice" | "warning" | "error";
  title: string;
  quotedCode: string;
  comments: CodeAiComment[];
  createdAt: string;
  readAt?: string;
  resolvedAt?: string;
  reviewVersion?: number;
};

export type CodeAiCommentReplyResult = {
  kind: "discussion" | "review" | "change-proposal" | "boundary";
  message: string;
  changeSet?: CodeAiChangeSet;
};
