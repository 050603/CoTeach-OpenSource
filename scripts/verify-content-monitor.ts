/** Fixed synthetic model acceptance. Does not create courses or write classroom records. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONTENT_MONITOR_ACCEPTANCE_CASES } from "./lib/content-monitor-acceptance-fixtures";

async function main() {
  if (!process.argv.includes("--real-model")) {
    console.log("真实模型验收：pnpm exec tsx scripts/verify-content-monitor.ts --real-model [--deployment-secrets]。使用当前环境配置或显式读取部署密钥；仅使用固定合成样例，不写课堂记录；结果保存到 .openpbl-runtime/content-monitor。");
    return;
  }
  if (process.argv.includes("--deployment-secrets")) {
    const directory = process.env.OPENPBL_SECRET_DIR || path.resolve("deploy/secrets");
    for (const [key, file] of [["DATABASE_URL", "database_url.txt"], ["PROVIDER_ENCRYPTION_KEY", "provider_encryption_key.txt"]]) {
      process.env[key] = (await readFile(path.join(directory, file), "utf8")).trim();
    }
  }
  const { installEnvironmentHttpProxy } = await import("../src/lib/network/environment-http-proxy");
  installEnvironmentHttpProxy();
  const { initializeServerProviderConfig } = await import("../src/lib/openmaic/server/provider-config");
  await initializeServerProviderConfig();
  const { classifyDocumentPaste } = await import("../src/lib/project-practice/content-monitor-policy");
  const { callLLM } = await import("../src/lib/llm/client");
  const { prisma, providerPrisma } = await import("../src/lib/db/client");
  const directory = path.resolve(".openpbl-runtime/content-monitor", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "fixed-cases.json"), JSON.stringify(CONTENT_MONITOR_ACCEPTANCE_CASES, null, 2));
  const results: Array<Record<string, unknown>> = [];
  try {
    for (const sample of CONTENT_MONITOR_ACCEPTANCE_CASES) {
      const start = performance.now();
      try {
        const result = await classifyDocumentPaste({ ...sample, knownSources: [...sample.knownSources] }, {
          generate: async (messages, signal) => {
            const response = await callLLM(messages, { jsonMode: true, abortSignal: signal, lightweightScreening: true, maxOutputTokens: 1800, maxTransientRetries: 0 });
            await writeFile(path.join(directory, `${sample.id}.json`), JSON.stringify({ messages, response }, null, 2));
            return response;
          },
        });
        const passed = sample.expected === "unflagged" ? ["clear", "exempt"].includes(result.outcome) : result.outcome === sample.expected;
        results.push({ id: sample.id, expected: sample.expected, result, passed, durationMs: Math.round(performance.now() - start) });
        console.log(JSON.stringify(results.at(-1)));
      } catch (error) {
        results.push({ id: sample.id, expected: sample.expected, result: { outcome: "incomplete" }, passed: false,
          errorType: error instanceof Error ? error.name : "UnknownError", durationMs: Math.round(performance.now() - start) });
        console.log(JSON.stringify(results.at(-1)));
      }
      await writeFile(path.join(directory, "results.json"), JSON.stringify({ fixtureVersion: 1, results }, null, 2));
    }
    console.log(`结果：${results.filter(row => row.passed).length}/${results.length}；${directory}`);
    if (results.some(row => !row.passed)) process.exitCode = 1;
  } finally { await Promise.all([prisma.$disconnect(), providerPrisma.$disconnect()]); }
}
main().catch(error => { console.error(error instanceof Error ? error.name : "VerificationError"); process.exitCode = 1; });
