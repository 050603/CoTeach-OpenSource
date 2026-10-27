import { callLLM, parseLLMJson } from "@/lib/llm/client";
import { DURABLE_GENERATION_TRANSIENT_RETRIES } from "@/lib/llm/request-policy";

type ModelCall = typeof callLLM;

export type CourseDesignStageEditInput<T> = {
  label: string;
  current: unknown;
  issues: readonly string[];
  fixedConstraints: unknown;
  outputSchema: unknown;
  abortSignal?: AbortSignal;
  modelCall?: ModelCall;
  maxAttempts?: number;
  preserveValueOnMalformedEdit?: T;
  parse: (value: unknown) => T;
};

export function buildCourseDesignStageEditMessages(
  input: Omit<CourseDesignStageEditInput<unknown>, "abortSignal" | "modelCall" | "parse">,
) {
  return [
    {
      role: "system" as const,
      content: `你是模拟资深教师的课程设计编辑 Agent。独立审校已经完成，你现在必须直接编辑当前阶段数据，使其可以进入下一阶段。

工作规则：
1. 这是对现有结果的定向编辑，不是重新生成首稿，也不能只返回意见、解释或建议。
2. 只修改审校问题涉及的字段及其必要关联；保留已经正确的内容，保留稳定 ID、顺序和上下游引用。
3. fixedConstraints 中的教师要求和上游约束不可修改。
4. 返回完整 revised 数据，系统将直接规范化、复审并保存。

只返回严格 JSON：{ "summary": "完成了哪些修订", "revised": 完整修订稿 }。`,
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        stage: input.label,
        fixedConstraints: input.fixedConstraints,
        reviewIssues: input.issues,
        current: input.current,
        requiredOutput: input.outputSchema,
      }),
    },
  ];
}

export async function editCourseDesignStage<T>(
  input: CourseDesignStageEditInput<T>,
): Promise<T> {
  const modelCall = input.modelCall ?? callLLM;
  const maxAttempts = Math.max(1, Math.min(5, input.maxAttempts ?? 3));
  let previousResponse = "";
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await modelCall(
        attempt === 0
          ? buildCourseDesignStageEditMessages(input)
          : buildCourseDesignStageRepairMessages(input, previousResponse, lastError),
        {
          jsonMode: true,
          abortSignal: input.abortSignal,
          requestClass: "standard",
          maxTransientRetries: DURABLE_GENERATION_TRANSIENT_RETRIES,
        },
      );
      previousResponse = response;
      const parsed = parseLLMJson<Record<string, unknown>>(response);
      if (!("revised" in parsed)) {
        throw new Error(`${input.label}编辑 Agent 未返回完整 revised 数据`);
      }
      return input.parse(parsed.revised);
    } catch (error) {
      if (input.abortSignal?.aborted) throw error;
      lastError = error;
    }
  }
  if (input.preserveValueOnMalformedEdit !== undefined) return input.preserveValueOnMalformedEdit;
  const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "未知结构错误");
  throw new Error(`${input.label}编辑 Agent 连续 ${maxAttempts} 次未返回可用数据：${detail}`, { cause: lastError });
}

function buildCourseDesignStageRepairMessages<T>(
  input: CourseDesignStageEditInput<T>,
  previousResponse: string,
  error: unknown,
) {
  const validationError = error instanceof Error ? error.message : String(error ?? "未知结构错误");
  return [
    {
      role: "system" as const,
      content: `你是课程设计结构修复 Agent。上一次编辑结果未通过结构解析；这只是阶段内格式修复，不得放弃任务、不得返回解释、不得省略原有正确字段。

请以 current 为完整底稿，结合 requiredOutput 重新返回全部字段。必须保留 current 中已存在的数组、稳定 ID、评价维度、页面和引用；如果上一次回复遗漏字段，应从 current 原样补回。只返回严格 JSON：{ "summary": "修复内容", "revised": 完整可保存数据 }。`,
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        stage: input.label,
        fixedConstraints: input.fixedConstraints,
        originalReviewIssues: input.issues,
        validationError,
        current: input.current,
        invalidPreviousResponse: previousResponse,
        requiredOutput: input.outputSchema,
      }),
    },
  ];
}
