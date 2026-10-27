import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { publishMonacoRuntime, verifyMonacoRuntimeArtifact } from "./monaco-static-runtime.mjs";
import { HTTP_UPSTREAM_POLICY } from "./lib/http-upstream-policy.mjs";
import { verifyCourseReadWorkerRuntime } from "./check-course-read-worker.mjs";
import { materializeCourseReadPrismaRuntime } from "./lib/course-read-worker-artifact.mjs";
import { hasProductionLock, runProductionTask } from "./run-production-task.mjs";
import { retainPdfRuntimeVersions, snapshotProductionAssets, verifyBuildAssetSnapshot, verifyProductionAssets, verifyReleaseReady, writeReleaseAssetManifest, writeReleaseReady } from "./lib/production-assets.mjs";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/run-next-production.mjs <build|prepare|start|typegen> [...args]");
  process.exit(1);
}

if (!hasProductionLock() && ["build", "prepare", "typegen"].includes(args[0])) {
  const result = await runProductionTask(["next", ...args]);
  process.exit(result.code);
}

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const distDir = process.env.NEXT_DIST_DIR?.trim() || ".next-build";
let executableArgs = [nextBin, ...args];
const childEnv = { ...process.env, NEXT_DIST_DIR: distDir };

let preparedForStart;
if (args[0] === "start") {
  // Release the preparation lock before starting the long-lived server. Only
  // pass its immutable path across that boundary; never re-read staging.
  const result = await runProductionTask(["next", "prepare", "--json"], true);
  if (result.code) process.exit(result.code);
  preparedForStart = JSON.parse(result.stdout.trim().split('\n').at(-1));
  childEnv.PORT ||= "3000";
  childEnv.HOSTNAME ||= "0.0.0.0";
  childEnv.KEEP_ALIVE_TIMEOUT ||= String(HTTP_UPSTREAM_POLICY.serverKeepAliveMs);
  executableArgs = [preparedForStart.serverFile];
}

if (args[0] === "prepare") {
  const standaloneDir = path.resolve(distDir, "standalone");
  const sourceServerFile = path.join(standaloneDir, "server.js");
  try {
    await access(sourceServerFile);
  } catch {
    console.error(`Production build not found in ${distDir}; run pnpm build first.`);
    process.exit(1);
  }

  const workerManifest = JSON.parse(await readFile(path.join(standaloneDir, "workers/docx-converter-manifest.json"), "utf8"));
  const workerBytes = await readFile(path.join(standaloneDir, "workers/docx-converter.cjs"));
  if (workerManifest.protocol !== 1 || workerManifest.sha256 !== createHash("sha256").update(workerBytes).digest("hex")) throw new Error("Incomplete DOCX worker release artifact");
  const readWorkerManifest = await verifyCourseReadWorkerRuntime(standaloneDir);
  const monacoManifest = await verifyMonacoRuntimeArtifact(path.resolve(distDir));
  const assetManifest = await verifyBuildAssetSnapshot(process.cwd(), distDir);

  const buildId = (await readFile(path.resolve(distDir, "BUILD_ID"), "utf8")).trim();
  const releaseDir = path.resolve(".openpbl-runtime", "releases", buildId);
  const releaseServerFile = path.join(releaseDir, "server.js");
  const releaseReadyFile = path.join(releaseDir, ".release-ready");
  let newlyPrepared = false;
  try {
    await access(releaseReadyFile);
  } catch {
    await rm(releaseDir, { recursive: true, force: true });
    await mkdir(releaseDir, { recursive: true });
    const runtimeDataDirectories = [".openpbl-data", ".openpbl-runtime"].map((name) =>
      path.join(standaloneDir, name),
    );
    await cp(standaloneDir, releaseDir, {
      recursive: true,
      force: true,
      // Keep pnpm's relative links inside the immutable release. Resolving
      // them while copying would point the live server back at .next-build,
      // which the next build removes.
      verbatimSymlinks: true,
      // Next's standalone trace can include local runtime data. Those files
      // are mutable and already mounted through explicit absolute paths below;
      // copying them into an immutable release races active uploads/audio.
      filter: (source) => !runtimeDataDirectories.some(
        (directory) => source === directory || source.startsWith(`${directory}${path.sep}`),
      ),
    });
    await cp(path.resolve(distDir, "public"), path.join(releaseDir, "public"), {
      recursive: true,
      force: true,
    });
    await cp(path.resolve(distDir, "static"), path.join(releaseDir, distDir, "static"), {
      recursive: true,
      force: true,
    });
    await retainPdfRuntimeVersions(process.cwd(), releaseDir);
    await writeReleaseAssetManifest(releaseDir, distDir, assetManifest);
    newlyPrepared = true;
  }

  await verifyProductionAssets(releaseDir, distDir, assetManifest);
  const releasedManifest = JSON.parse(await readFile(path.join(releaseDir, "workers/docx-converter-manifest.json"), "utf8"));
  const releasedWorker = await readFile(path.join(releaseDir, "workers/docx-converter.cjs"));
  if (releasedManifest.sha256 !== workerManifest.sha256 || releasedManifest.sha256 !== createHash("sha256").update(releasedWorker).digest("hex")) throw new Error("Immutable release DOCX worker does not match its build");
  await verifyCourseReadWorkerRuntime(releaseDir, readWorkerManifest);
  await verifyMonacoRuntimeArtifact(path.join(releaseDir, distDir), monacoManifest);
  // Publish readiness only after every dependency and copied byte is checked.
  // A failed prepare must never become a pin/fallback candidate.
  if (newlyPrepared) await writeReleaseReady(releaseDir, distDir);
  await verifyReleaseReady(releaseDir, distDir, buildId);

  // Prepare the immutable release before restarting the service. Its startup
  // probes can take long enough for another build to clear the staging folder.
  // The service can then recover the new completed release, not an older one.
  if (args[0] === "prepare") {
    console.log(args.includes("--json") ? JSON.stringify({ buildId, serverFile: releaseServerFile }) : `Prepared production release: ${buildId}`);
    process.exit(0);
  }

  childEnv.PORT ||= "3000";
  childEnv.HOSTNAME ||= "0.0.0.0";
  childEnv.KEEP_ALIVE_TIMEOUT ||= String(HTTP_UPSTREAM_POLICY.serverKeepAliveMs);
  executableArgs = [releaseServerFile];
}

const child = spawn(process.execPath, executableArgs, {
  cwd: process.cwd(),
  env: childEnv,
  detached: true,
  stdio: "inherit",
});
const stopChild = signal => {
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
};
const interruptChild = () => stopChild('SIGINT');
const terminateChild = () => stopChild('SIGTERM');
process.once('SIGINT', interruptChild);
process.once('SIGTERM', terminateChild);

child.on("error", (error) => {
  console.error(`Could not start Next.js: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", async (code, signal) => {
  process.off('SIGINT', interruptChild);
  process.off('SIGTERM', terminateChild);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
  if (code === 0 && args[0] === "build") {
    try {
      // NFT may flatten @prisma/client while retaining its generated peer in
      // pnpm's traced tree. Normalize from that standalone tree, never source.
      await materializeCourseReadPrismaRuntime(path.resolve(distDir, "standalone"));
      const manifest = await publishMonacoRuntime({ distDir: path.resolve(distDir) });
      console.log(`Monaco browser runtime verified and published: ${manifest.version}/${manifest.treeSha256} (${manifest.fileCount} files)`);
      await snapshotProductionAssets(process.cwd(), distDir);
    } catch (error) {
      console.error(`Could not finalize production runtime artifacts: ${error.message}`);
      process.exitCode = 1;
    }
  }
});
