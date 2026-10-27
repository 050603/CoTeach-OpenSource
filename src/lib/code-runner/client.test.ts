import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodeArtifact } from "@/lib/ai-collaboration/code-artifact";
import {
  CodeRunnerUnavailableError,
  executeCodeArtifact,
} from "@/lib/code-runner/client";

const originalUrl = process.env.CODE_RUNNER_URL;
const originalToken = process.env.CODE_RUNNER_TOKEN;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalUrl === undefined) delete process.env.CODE_RUNNER_URL;
  else process.env.CODE_RUNNER_URL = originalUrl;
  if (originalToken === undefined) delete process.env.CODE_RUNNER_TOKEN;
  else process.env.CODE_RUNNER_TOKEN = originalToken;
});

describe("code runner client", () => {
  it("does not fall back to spawning code when the isolated service is missing", async () => {
    delete process.env.CODE_RUNNER_URL;
    delete process.env.CODE_RUNNER_TOKEN;
    await expect(executeCodeArtifact({ artifact: createCodeArtifact("python"), stdin: "" }))
      .rejects.toBeInstanceOf(CodeRunnerUnavailableError);
  });

  it("forwards a bounded artifact to the authenticated loopback runner", async () => {
    process.env.CODE_RUNNER_URL = "http://127.0.0.1:3101";
    process.env.CODE_RUNNER_TOKEN = "secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status: "success",
      phase: "run",
      exitCode: 0,
      stdout: "ok\n",
      stderr: "",
      durationMs: 12,
      diagnostics: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const result = await executeCodeArtifact({ artifact: createCodeArtifact("python"), stdin: "input\n" });

    expect(result.stdout).toBe("ok\n");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3101/execute", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer secret" }),
    }));
  });
});
