// LLM error class hierarchy.
// All errors extend Error and preserve the original message/stack where applicable.
// The route layer maps each error to a specific HTTP status + errorCode so the
// client can show a targeted Chinese message instead of a generic failure toast.

/**
 * Thrown when no model / endpoint / api key is configured.
 * The UI should prompt the user to open the settings page.
 */
export class LlmNotConfiguredError extends Error {
  constructor() {
    super("LLM_NOT_CONFIGURED");
    this.name = "LlmNotConfiguredError";
  }
}

/**
 * Thrown when the upstream returns 429. Carries the cooldown hint so the
 * caller can surface "retry in N seconds" without re-parsing headers.
 */
export class LlmRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, detail = "") {
    super(`LLM 调用触发限流，${Math.ceil(retryAfterMs / 1000)} 秒后再试${detail ? `：${detail}` : ""}`);
    this.name = "LlmRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Thrown when the request exceeds its standard or long-generation deadline.
 * Distinct from a caller-initiated abort so the UI can say "timeout" instead
 * of "cancelled".
 */
export class LlmTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs = 60_000) {
    super(`LLM 调用超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
    this.name = "LlmTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when the upstream rejects `response_format: { type: "json_object" }`.
 * The UI should suggest switching to a model that supports JSON mode.
 */
export class LlmJsonModeUnsupportedError extends Error {
  readonly upstreamSummary: string;

  constructor(upstreamSummary = "") {
    const suffix = upstreamSummary ? `：${upstreamSummary}` : "";
    super(`当前模型不支持 JSON 模式${suffix}`);
    this.name = "LlmJsonModeUnsupportedError";
    this.upstreamSummary = upstreamSummary;
  }
}

/**
 * Thrown when a streaming response accumulates too many malformed chunks,
 * indicating the stream is corrupted rather than merely noisy.
 */
export class LlmStreamCorruptedError extends Error {
  readonly malformedChunkCount: number;

  constructor(malformedChunkCount: number) {
    super(`LLM 流式响应损坏：收到 ${malformedChunkCount} 个无法解析的 chunk`);
    this.name = "LlmStreamCorruptedError";
    this.malformedChunkCount = malformedChunkCount;
  }
}

/**
 * Thrown when the upstream returns a 2xx response with no content.
 */
export class LlmEmptyResponseError extends Error {
  constructor() {
    super("LLM 返回为空");
    this.name = "LlmEmptyResponseError";
  }
}

/**
 * Generic upstream failure. Carries the HTTP status (when available) and a
 * SHORT upstream summary (max ~200 chars). The full response body is never
 * attached so logs / SSE events cannot leak upstream payloads.
 */
export class LlmCallFailedError extends Error {
  readonly status: number | undefined;
  readonly upstreamSummary: string;

  constructor(
    message: string,
    opts?: { status?: number; upstreamSummary?: string; cause?: unknown },
  ) {
    super(message);
    this.name = "LlmCallFailedError";
    this.status = opts?.status;
    this.upstreamSummary = opts?.upstreamSummary ?? "";
    if (opts?.cause !== undefined) {
      // `Error.cause` is part of ES2022; assign via bracket access so we do
      // not depend on the compiled lib target.
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

/**
 * Thrown when an LLM payload is structurally parseable but missing too many
 * operational fields (e.g. a teaching-outline section with >3 absent role
 * fields). Subclasses `LlmCallFailedError` so the generic route handler still
 * returns `LLM_CALL_FAILED` if a more specific handler is absent.
 */
export class LlmOutputIncompleteError extends LlmCallFailedError {
  readonly missingFields: string[];

  constructor(missingFields: string[], context: string) {
    super(`LLM_OUTPUT_INCOMPLETE: ${context} 缺少字段（${missingFields.join("、")}）`, {
      upstreamSummary: `缺少字段：${missingFields.join("、")}`,
    });
    this.name = "LlmOutputIncompleteError";
    this.missingFields = missingFields;
  }
}
