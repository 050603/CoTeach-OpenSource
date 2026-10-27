import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isMainThread, Worker } from "node:worker_threads";
import { resolveCourseReadWorkerConfig, type CourseReadWorkerConfig } from "./course-read-worker-config";
import { courseReadRequestValidationStatus, courseReadResultToResponse, type CourseReadExecuteMessage, type CourseReadOperation,
  isCourseReadWorkerResult, isCourseReadWorkerStats, type CourseReadWorkerMessage, type CourseReadWorkerStats } from "./course-read-worker-protocol";
import { beginProgressTiming, captureWorkerProgressTimings, timeProgress } from "@/lib/observability/progress-request-timing";

const MAX_WAITING = 256, MAX_ACTIVE = 16, START_MS = 20_000, WAIT_MS = 10_000, EXECUTION_MS = 20_000;
type Thread = Pick<Worker, "on" | "postMessage" | "terminate" | "ref" | "unref">;
export type CourseReadWorkerSample = CourseReadWorkerStats & { generation: number };
type Job = { message: CourseReadExecuteMessage; queuedAt: number; settled: boolean;
  timer: ReturnType<typeof setTimeout>; resolve: (response: Response) => void; reject: (error: Error) => void;
  recordTimings: ReturnType<typeof captureWorkerProgressTimings>;
  finishQueue: ReturnType<typeof beginProgressTiming>;
  signal?: AbortSignal; abort?: () => void };
type Slot = { index: number; worker: Thread; ready: boolean; failed: boolean; jobs: Map<number, Job>;
  generation: number; termination?: Promise<boolean>;
  startup: ReturnType<typeof setTimeout>; startResolve: () => void; startReject: (error: Error) => void;
  stats?: { id: number; resolve: (value: CourseReadWorkerSample | null) => void; timer: ReturnType<typeof setTimeout> } };
function unavailable(code = "COURSE_READ_UNAVAILABLE") {
  return Object.assign(new Error("课堂读取暂不可用，请稍后重试。"), { code });
}
function cancelled() { return new DOMException("Request aborted", "AbortError"); }

/** These threads receive no provider settings, writer credentials, storage or Redis secrets. */
export function courseReadThreadEnvironment(config: CourseReadWorkerConfig, env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  if (!config.workerDatabaseUrl) throw unavailable();
  const result: NodeJS.ProcessEnv = { NODE_ENV: "production", TZ: env.TZ || "UTC", NODE_PATH: "",
    DATABASE_URL: config.workerDatabaseUrl, PROVIDER_CONFIG_DATABASE_URL: "", REDIS_URL: "",
    OPENPBL_COURSE_READ_WORKERS: "0", OPENPBL_INTERNAL_COURSE_READ_THREAD: "1" };
  for (const name of ["JWT_SECRET", "PUBLIC_BASE_URL", "AUTH_COOKIE_SECURE", "AUTH_COOKIE_SAME_SITE"]) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  return result;
}

async function verifyArtifact(): Promise<void> {
  // Fixed release-relative paths deliberately avoid a configurable glob in Next's file tracer.
  const manifest = JSON.parse(await readFile(path.join(process.cwd(), "workers", "course-read-worker-manifest.json"), "utf8"));
  const bytes = await readFile(path.join(process.cwd(), "workers", "course-read-worker.cjs"));
  if (manifest.protocol !== 1 || manifest.file !== "course-read-worker.cjs" || manifest.target !== "node22"
    || manifest.bytes !== bytes.length || manifest.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
    throw unavailable("COURSE_READ_ARTIFACT_INVALID");
  }
}

/** Bounded admission belongs to the parent; an aborted in-flight read retains its slot until it really ends. */
export class CourseReadWorkerPool {
  private slots: Slot[] = [];
  private waiting: Job[] = [];
  private nextId = 0;
  private starting?: Promise<void>;
  private initialized = false;
  private stopping = false;
  private failed = false;
  private restarts: number[] = [];
  private restartCount = 0;
  private generation = 0;
  private failures = 0;
  private shutdown?: Promise<void>;
  private sampling?: Promise<(CourseReadWorkerSample | null)[]>;
  constructor(readonly config: CourseReadWorkerConfig, private dependencies: {
    create?: (index: number, env: NodeJS.ProcessEnv) => Thread; verify?: () => Promise<void>; env?: Readonly<Record<string, string | undefined>>;
  } = {}) {}

  initialize(): Promise<void> {
    if (!this.config.enabled) return Promise.resolve();
    if (this.stopping || this.failed) return Promise.reject(unavailable());
    return this.starting ??= (async () => {
      await (this.dependencies.verify ?? verifyArtifact)();
      try {
        if (this.stopping || this.failed) throw unavailable();
        await Promise.all(Array.from({ length: this.config.count }, (_, index) => this.spawn(index)));
        if (this.failed || this.stopping) throw unavailable();
        this.initialized = true;
      } catch {
        this.failed = true;
        await Promise.all(this.slots.map(slot => this.terminate(slot)));
        throw unavailable();
      }
    })();
  }

  private spawn(index: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.stopping || this.failed) { reject(unavailable()); return; }
      let worker: Thread;
      try {
        const env = courseReadThreadEnvironment(this.config, this.dependencies.env ?? process.env);
        worker = this.dependencies.create ? this.dependencies.create(index, env)
          : new Worker(path.join(process.cwd(), "workers", "course-read-worker.cjs"), {
            execArgv: [], workerData: { role: "course-read", protocol: 1 }, env,
            resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 },
          });
      } catch { reject(unavailable()); return; }
      const slot: Slot = { index, generation: ++this.generation, worker, ready: false, failed: false, jobs: new Map(), startResolve: resolve, startReject: reject,
        startup: setTimeout(() => this.fail(slot), START_MS) };
      this.slots[index] = slot;
      worker.on("error", () => this.fail(slot));
      worker.on("exit", () => { if (!this.stopping) this.fail(slot); });
      worker.on("message", (message: CourseReadWorkerMessage) => this.receive(slot, message));
    });
  }

  private receive(slot: Slot, message: CourseReadWorkerMessage): void {
    if (slot.failed || this.slots[slot.index] !== slot) return;
    if (!message || typeof message !== "object") { this.fail(slot); return; }
    if (message.type === "ready" && message.protocol === 1 && !slot.ready) {
      clearTimeout(slot.startup); slot.ready = true; slot.worker.unref(); slot.startResolve(); this.dispatch(); return;
    }
    if (message.type === "closed" && this.stopping) return;
    if (message.type === "stats") {
      if (slot.stats?.id === message.id) {
        clearTimeout(slot.stats.timer); slot.stats.resolve(isCourseReadWorkerStats(message) ? { ...message, generation: slot.generation } : null); slot.stats = undefined;
      }
      // A timed-out diagnostic response is not a failed business read.
      return;
    }
    if (message.type !== "result" && message.type !== "error") { this.fail(slot); return; }
    const job = slot.jobs.get(message.id);
    if (!job) { this.fail(slot); return; }
    slot.jobs.delete(message.id); clearTimeout(job.timer);
    if (message.type === "result") {
      try {
        if (!isCourseReadWorkerResult(message)) throw unavailable();
        const response = courseReadResultToResponse(message);
        this.settle(job, undefined, response, [...message.phaseSpans, {
          phase: "course-read-execution", sequence: message.phaseSpans.length, startMs: 0, endMs: message.executionMs, outcome: "ok",
        }]);
      } catch { this.settle(job, unavailable()); this.fail(slot); }
    } else {
      if (message.code !== "COURSE_READ_FAILED") { this.settle(job, unavailable()); this.fail(slot); return; }
      this.failures++; this.settle(job, unavailable("COURSE_READ_FAILED"));
    }
    if (!slot.jobs.size) slot.worker.unref();
    this.dispatch();
  }

  private settle(job: Job, error?: Error, response?: Response, spans?: Parameters<ReturnType<typeof captureWorkerProgressTimings>>[0]): void {
    if (job.settled) return;
    job.settled = true;
    job.finishQueue(error ? "error" : "ok");
    if (job.abort) job.signal?.removeEventListener("abort", job.abort);
    if (error) job.reject(error);
    else { if (spans) job.recordTimings(spans); job.resolve(response!); }
  }

  private terminate(slot: Slot): Promise<boolean> {
    return slot.termination ??= this.terminateThread(slot);
  }

  private async terminateThread(slot: Slot): Promise<boolean> {
    slot.ready = false; slot.failed = true; clearTimeout(slot.startup);
    slot.startReject(unavailable());
    if (slot.stats) { clearTimeout(slot.stats.timer); slot.stats.resolve(null); slot.stats = undefined; }
    // Bound the HTTP wait immediately. Capacity is retained until actual thread
    // termination, so this rejection never authorizes overlapping replacement work.
    for (const job of slot.jobs.values()) { clearTimeout(job.timer); this.settle(job, unavailable()); }
    try { await slot.worker.terminate(); }
    catch {
      this.failed = true; this.rejectWaiting();
      // Retain the active inventory: failure to terminate is not proof a query stopped.
      return false;
    }
    slot.jobs.clear(); return true;
  }

  private fail(slot: Slot): void {
    if (slot.failed || this.slots[slot.index] !== slot) return;
    slot.failed = true; slot.ready = false; this.failures++; clearTimeout(slot.startup); slot.startReject(unavailable());
    void this.terminate(slot).then(async terminated => {
      if (!terminated || !this.initialized || this.stopping || this.failed) return;
      const now = performance.now(); this.restarts = this.restarts.filter(at => now - at < 60_000);
      if (this.restarts.length >= 3) { this.failed = true; this.rejectWaiting(); return; }
      this.restarts.push(now); this.restartCount++;
      try { await this.spawn(slot.index); this.dispatch(); }
      catch { this.failed = true; this.rejectWaiting(); }
    });
    if (!this.initialized) this.rejectWaiting();
    this.dispatch();
  }

  private rejectWaiting(): void {
    for (const job of this.waiting.splice(0)) { clearTimeout(job.timer); this.settle(job, unavailable()); }
  }

  private dispatch(): void {
    if (this.stopping || this.failed) return;
    while (this.waiting.length) {
      const slot = this.slots.filter(value => value.ready && !value.failed && value.jobs.size < MAX_ACTIVE)
        .sort((a, b) => a.jobs.size - b.jobs.size || a.index - b.index)[0];
      if (!slot) return;
      const job = this.waiting.shift()!;
      clearTimeout(job.timer);
      if (job.settled || job.signal?.aborted) { this.settle(job, cancelled()); continue; }
      job.finishQueue("ok");
      slot.jobs.set(job.message.id, job); slot.worker.ref();
      job.timer = setTimeout(() => this.fail(slot), EXECUTION_MS);
      try { slot.worker.postMessage(job.message); } catch { this.fail(slot); }
    }
  }

  async execute(operation: CourseReadOperation, request: Request, courseId?: string): Promise<Response> {
    if (request.method !== "GET") throw unavailable("COURSE_READ_METHOD_INVALID");
    if (request.signal.aborted) throw cancelled();
    const message: CourseReadExecuteMessage = { type: "execute", id: 1, operation, url: request.url,
      headers: [...request.headers], ...(courseId !== undefined ? { courseId } : {}) };
    const invalidStatus = courseReadRequestValidationStatus(message);
    if (invalidStatus !== null) return Response.json({ code: "COURSE_READ_REQUEST_INVALID", message: "课堂读取请求不合法或超出大小限制。" }, {
      status: invalidStatus, headers: { "Cache-Control": "private, no-store" },
    });
    await this.initialize();
    if (!this.config.enabled || this.failed || this.stopping) throw unavailable();
    if (request.signal.aborted) throw cancelled();
    if (this.waiting.length >= MAX_WAITING) throw unavailable("COURSE_READ_BUSY");
    return new Promise<Response>((resolve, reject) => {
      const job: Job = { message: { ...message, id: ++this.nextId }, queuedAt: performance.now(), settled: false,
        resolve, reject, recordTimings: captureWorkerProgressTimings(), finishQueue: beginProgressTiming("course-read-queue"), signal: request.signal, timer: setTimeout(() => {
          const index = this.waiting.indexOf(job);
          if (index !== -1) { this.waiting.splice(index, 1); this.settle(job, unavailable("COURSE_READ_BUSY")); }
        }, WAIT_MS) };
      job.abort = () => {
        const index = this.waiting.indexOf(job);
        if (index !== -1) { this.waiting.splice(index, 1); clearTimeout(job.timer); }
        this.settle(job, cancelled());
      };
      request.signal.addEventListener("abort", job.abort, { once: true });
      this.waiting.push(job); this.dispatch();
    });
  }

  health() {
    const ready = this.slots.filter(slot => slot.ready && !slot.failed).length;
    return { ok: !this.config.enabled || this.initialized && !this.failed && !this.stopping && ready === this.config.count,
      enabled: this.config.enabled, target: this.config.count, ready, queued: this.waiting.length,
      oldestSeconds: this.waiting.length ? Math.max(0, (performance.now() - this.waiting[0].queuedAt) / 1000) : 0,
      active: this.slots.reduce((sum, slot) => sum + slot.jobs.size, 0), restarts: this.restartCount, failures: this.failures };
  }

  sample(): Promise<(CourseReadWorkerSample | null)[]> {
    if (this.sampling) return this.sampling;
    return this.sampling = Promise.all(this.slots.map(slot => new Promise<CourseReadWorkerSample | null>(resolve => {
      if (!slot.ready || slot.failed || this.stopping) { resolve(null); return; }
      const id = ++this.nextId;
      slot.stats = { id, resolve, timer: setTimeout(() => { slot.stats = undefined; resolve(null); }, 1000) };
      try { slot.worker.postMessage({ type: "stats", id }); }
      catch { clearTimeout(slot.stats.timer); slot.stats = undefined; resolve(null); }
    }))).finally(() => { this.sampling = undefined; });
  }

  stop(): Promise<void> {
    return this.shutdown ??= (async () => {
      this.stopping = true; this.rejectWaiting();
      for (const slot of this.slots) { try { slot.worker.postMessage({ type: "shutdown" }); } catch { /* terminate below */ } }
      const deadline = performance.now() + 5000;
      while (!this.failed && this.slots.some(slot => slot.jobs.size) && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const terminated = await Promise.all(this.slots.map(slot => this.terminate(slot)));
      if (terminated.some(value => !value)) throw unavailable();
    })();
  }
}

declare global { var __openPblCourseReadWorkerPool: CourseReadWorkerPool | undefined; }
export function getCourseReadWorkerPool(): CourseReadWorkerPool {
  if (!isMainThread) throw unavailable("COURSE_READ_NESTED_POOL");
  return globalThis.__openPblCourseReadWorkerPool ??= new CourseReadWorkerPool(resolveCourseReadWorkerConfig());
}
export async function initializeCourseReadWorkers(): Promise<void> { await getCourseReadWorkerPool().initialize(); }
export async function stopCourseReadWorkers(): Promise<void> { await globalThis.__openPblCourseReadWorkerPool?.stop(); }
export function courseReadWorkerHealth() { return getCourseReadWorkerPool().health(); }
export async function dispatchCourseRead(operation: CourseReadOperation, request: Request, courseId?: string): Promise<Response | null> {
  const pool = getCourseReadWorkerPool();
  if (request.method !== "GET" || !pool.config.enabled) return null;
  try { return await timeProgress("course-read-worker", () => pool.execute(operation, request, courseId)); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return Response.json({ code: "COURSES_UNAVAILABLE", message: "无法读取课堂，请稍后重试" }, {
      status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "1" },
    });
  }
}
