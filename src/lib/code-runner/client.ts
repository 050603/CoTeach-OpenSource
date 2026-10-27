import type { CodeArtifact } from "@/lib/ai-collaboration/code-artifact";

export type CodeRunnerDiagnostic = {
  filePath: string;
  line: number;
  column?: number;
  severity: "warning" | "error";
  message: string;
};

export type CodeRunnerResult = {
  status: "success" | "failed" | "timeout";
  phase: "compile" | "run";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  diagnostics: CodeRunnerDiagnostic[];
};

export class CodeRunnerUnavailableError extends Error {
  constructor(message = "代码运行服务尚未就绪。") {
    super(message);
    this.name = "CodeRunnerUnavailableError";
  }
}

export async function executeCodeArtifact(input: {
  artifact: CodeArtifact;
  stdin: string;
  signal?: AbortSignal;
}): Promise<CodeRunnerResult> {
  const runnerUrl = process.env.CODE_RUNNER_URL?.trim();
  const token = process.env.CODE_RUNNER_TOKEN?.trim();
  if (!runnerUrl || !token) throw new CodeRunnerUnavailableError();
  const timeoutSignal = AbortSignal.timeout(15_000);
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, timeoutSignal]);
  let response: Response;
  try {
    response = await fetch(`${runnerUrl.replace(/\/+$/, "")}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ artifact: input.artifact, stdin: input.stdin }),
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (timeoutSignal.aborted) {
      return {
        status: "timeout",
        phase: "run",
        exitCode: null,
        stdout: "",
        stderr: "运行服务响应超时。",
        durationMs: 15_000,
        diagnostics: [],
      };
    }
    throw new CodeRunnerUnavailableError(error instanceof Error ? error.message : undefined);
  }
  const payload = await response.json().catch(() => null) as (CodeRunnerResult & { message?: string }) | null;
  if (!response.ok || !payload) {
    throw new CodeRunnerUnavailableError(payload?.message || `运行服务返回 ${response.status}`);
  }
  return payload;
}
