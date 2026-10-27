import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const HOST = process.env.CODE_RUNNER_HOST?.trim() || "127.0.0.1";
const PORT = Number(process.env.CODE_RUNNER_PORT || 3101);
const TOKEN = process.env.CODE_RUNNER_TOKEN?.trim() || "";
const BWRAP = process.env.CODE_RUNNER_BWRAP?.trim() || "/usr/bin/bwrap";
const MAX_REQUEST_BYTES = 240_000;
const MAX_OUTPUT_BYTES = 64_000;
const MAX_FILES = 16;
const MAX_TOTAL_CODE = 160_000;
const COMPILE_TIMEOUT_MS = 7_000;
const RUN_TIMEOUT_MS = 6_000;

if (!TOKEN) {
  console.error("[code-runner] CODE_RUNNER_TOKEN is required");
  process.exit(1);
}

function safeToken(value) {
  const provided = Buffer.from(value || "");
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function safePath(value, language) {
  if (typeof value !== "string" || !value || value.length > 240) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes("..")) return false;
  if (!/^[\p{L}\p{N}_./ -]+$/u.test(value)) return false;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith("../")) return false;
  const lower = value.toLowerCase();
  return language === "python"
    ? lower.endsWith(".py")
    : lower.endsWith(".c") || lower.endsWith(".h");
}

function parseArtifact(value) {
  if (!value || typeof value !== "object") throw new Error("代码项目格式不正确。");
  const language = value.language;
  if (language !== "python" && language !== "c") throw new Error("不支持的代码语言。");
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES) {
    throw new Error("代码文件数量不符合运行限制。");
  }
  let total = 0;
  const seen = new Set();
  const files = value.files.map((file) => {
    if (!file || typeof file !== "object" || typeof file.content !== "string") {
      throw new Error("代码文件格式不正确。");
    }
    if (!safePath(file.path, language) || seen.has(file.path)) {
      throw new Error("代码文件路径不安全或重复。");
    }
    seen.add(file.path);
    total += Buffer.byteLength(file.content, "utf8");
    if (total > MAX_TOTAL_CODE) throw new Error("代码项目超过单次运行大小限制。");
    return { id: String(file.id || file.path), path: file.path, content: file.content };
  });
  const activeFile = files.find((file) => file.id === value.activeFileId) || files[0];
  return { language, files, activeFile };
}

function sandboxArgs(workspace, command) {
  return [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-net",
    "--unshare-ipc",
    "--unshare-uts",
    "--clearenv",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", workspace, "/workspace",
    "--chdir", "/workspace",
    "--setenv", "HOME", "/tmp",
    "--setenv", "PATH", "/usr/bin:/bin",
    "/usr/bin/prlimit",
    "--cpu=4",
    "--as=1073741824",
    "--nproc=64",
    "--nofile=64",
    "--fsize=10485760",
    "--",
    ...command,
  ];
}

function runSandbox(workspace, command, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(BWRAP, sandboxArgs(workspace, command), {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: {},
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    const terminate = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const collect = (kind, chunk) => {
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        outputExceeded = true;
        terminate();
        return;
      }
      const selected = chunk.subarray(0, remaining);
      outputBytes += selected.length;
      if (kind === "stdout") stdout += selected.toString("utf8");
      else stderr += selected.toString("utf8");
      if (selected.length < chunk.length) {
        outputExceeded = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (outputExceeded) stderr += "\n输出超过 64 KB，运行已停止。";
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.stdin.end(stdin || "");
  });
}

function diagnosticsFrom(language, stderr) {
  const diagnostics = [];
  if (language === "c") {
    const pattern = /(?:^|\n)([^:\n]+):(\d+):(\d+):\s+(warning|error):\s+([^\n]+)/g;
    for (const match of stderr.matchAll(pattern)) {
      diagnostics.push({
        filePath: match[1].replace(/^\/workspace\//, ""),
        line: Number(match[2]),
        column: Number(match[3]),
        severity: match[4],
        message: match[5].trim(),
      });
    }
    return diagnostics.slice(0, 40);
  }
  const tracePattern = /File "\/workspace\/([^"]+)", line (\d+)/g;
  const locations = [...stderr.matchAll(tracePattern)];
  if (locations.length) {
    const last = locations.at(-1);
    const message = stderr.trim().split("\n").at(-1) || "Python 运行错误";
    diagnostics.push({
      filePath: last[1],
      line: Number(last[2]),
      severity: "error",
      message,
    });
  }
  return diagnostics;
}

function publicOutput(value) {
  return value.replaceAll("/workspace/", "");
}

async function execute(artifact, stdin) {
  const workspace = await mkdtemp(path.join(tmpdir(), "openpbl-code-run-"));
  const startedAt = Date.now();
  try {
    for (const file of artifact.files) {
      const target = path.join(workspace, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, { encoding: "utf8", mode: 0o600 });
    }

    if (artifact.language === "python") {
      const entry = artifact.files.find((file) => file.path === "main.py")?.path
        || artifact.activeFile.path
        || artifact.files[0].path;
      const projectBootstrap = "import runpy,sys;sys.path.insert(0,'/workspace');runpy.run_path(sys.argv[1],run_name='__main__')";
      const result = await runSandbox(
        workspace,
        ["/usr/bin/python3", "-I", "-B", "-c", projectBootstrap, entry],
        stdin,
        RUN_TIMEOUT_MS,
      );
      const stderr = publicOutput(result.stderr);
      return {
        status: result.timedOut ? "timeout" : result.code === 0 ? "success" : "failed",
        phase: "run",
        exitCode: result.timedOut ? null : result.code,
        stdout: publicOutput(result.stdout),
        stderr,
        durationMs: Date.now() - startedAt,
        diagnostics: diagnosticsFrom("python", result.stderr),
      };
    }

    const sources = artifact.files.filter((file) => file.path.toLowerCase().endsWith(".c"));
    if (!sources.length) throw new Error("C 语言项目至少需要一个 .c 文件。");
    const compile = await runSandbox(
      workspace,
      ["/usr/bin/gcc", "-std=c17", "-Wall", "-Wextra", "-pedantic", ...sources.map((file) => file.path), "-o", ".openpbl-program"],
      "",
      COMPILE_TIMEOUT_MS,
    );
    const compileStderr = publicOutput(compile.stderr);
    const compileDiagnostics = diagnosticsFrom("c", compile.stderr);
    if (compile.timedOut || compile.code !== 0) {
      return {
        status: compile.timedOut ? "timeout" : "failed",
        phase: "compile",
        exitCode: compile.timedOut ? null : compile.code,
        stdout: publicOutput(compile.stdout),
        stderr: compileStderr,
        durationMs: Date.now() - startedAt,
        diagnostics: compileDiagnostics,
      };
    }
    const result = await runSandbox(workspace, ["./.openpbl-program"], stdin, RUN_TIMEOUT_MS);
    return {
      status: result.timedOut ? "timeout" : result.code === 0 ? "success" : "failed",
      phase: "run",
      exitCode: result.timedOut ? null : result.code,
      stdout: publicOutput(result.stdout),
      stderr: [compileStderr, publicOutput(result.stderr)].filter(Boolean).join("\n"),
      durationMs: Date.now() - startedAt,
      diagnostics: [...compileDiagnostics, ...diagnosticsFrom("c", result.stderr)].slice(0, 40),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function json(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || request.url !== "/execute") {
    json(response, 404, { error: "NOT_FOUND" });
    return;
  }
  if (!safeToken(request.headers.authorization)) {
    json(response, 401, { error: "UNAUTHORIZED" });
    return;
  }
  let bytes = 0;
  const chunks = [];
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      json(response, 413, { error: "REQUEST_TOO_LARGE", message: "代码项目超过运行限制。" });
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", async () => {
    if (response.writableEnded) return;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const artifact = parseArtifact(body.artifact);
      const stdin = typeof body.stdin === "string" ? body.stdin.slice(0, 32_000) : "";
      json(response, 200, await execute(artifact, stdin));
    } catch (error) {
      console.error("[code-runner] execution failed", error instanceof Error ? error.message : error);
      json(response, 400, {
        error: "EXECUTION_REJECTED",
        message: error instanceof Error ? error.message : "运行请求无效。",
      });
    }
  });
});

server.requestTimeout = 20_000;
server.headersTimeout = 5_000;
server.listen(PORT, HOST, () => {
  console.log(`[code-runner] listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
