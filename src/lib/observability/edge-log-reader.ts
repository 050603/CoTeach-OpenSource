import { constants } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

const ROUTES = new Set([
  "/api/server-providers", "/api/courses", "/api/openmaic/classroom", "/api/openmaic/progress",
  "/api/learning-events", "/api/ai-collaboration/code", "/api/ai-collaboration/document", "/api/ai-collaboration/memory",
  ...["state", "events", "projection", "presence", "public-discussion", "actions"].map(name => `/api/courses/:courseId/${name}`),
]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"]);
const GAP_WINDOW_MS = 5 * 60_000;
export type EdgeOperation = "read" | "write" | "projection" | "realtime" | "mixed-ai" | "protocol" | "other";
export type EdgeObservation = {
  method: string; route: string; operation: EdgeOperation; status: number; seconds: number; completedAtMs: number;
};
export type EdgeLogSnapshot = {
  configured: boolean; initialized: boolean; collectionAvailable: number; state: string;
  startedAtMs: number | null; refreshedAtMs: number | null; lastRecordAtMs: number | null;
  backlogBytes: number; records: number; invalidRecords: number; gaps: number; rotations: number;
  lastGapAtMs: number | null;
};
type ReaderOptions = { maxBytes?: number; maxLineBytes?: number; now?: () => number;
  openReadOnly?: (file: string, flags: number) => Promise<FileHandle> };

/** Bound waiting on optional monitoring I/O, not the OS operation itself.
 * The work promise remains owned/single-flight and handles late completion.
 * JS event-loop starvation can delay the timer; this is not a hard wall SLA.
 */
export async function waitForEdgeOperation<T>(work: Promise<T>, unavailable: () => void,
  timeoutMs = 500): Promise<{ completed: boolean; value?: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reported = false;
  const fail = () => { if (!reported) { reported = true; unavailable(); } };
  try {
    return await Promise.race([
      work.then(value => ({ completed: true, value }), () => { fail(); return { completed: false }; }),
      new Promise<{ completed: boolean }>(resolve => {
        timer = setTimeout(() => { fail(); resolve({ completed: false }); }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function edgeOperation(method: string, route: string): EdgeOperation {
  if (method === "GET" || method === "HEAD") {
    if (route.endsWith("/projection")) return "projection";
    if (route.endsWith("/events")) return "realtime";
    return "read";
  }
  if (method === "OPTIONS") return "protocol";
  if (method === "POST" && ["/api/openmaic/progress", "/api/learning-events"].includes(route)) return "write";
  if (method === "POST" && route === "/api/courses/:courseId/actions") return "write";
  if (["PUT", "DELETE"].includes(method) && route.endsWith("/presence")) return "write";
  return route.startsWith("/api/ai-collaboration/") ? "mixed-ai" : "other";
}

export function parseEdgeObservation(line: string): EdgeObservation | undefined {
  let row: Record<string, unknown>;
  try { row = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
  if (!row || row.version !== 1 || typeof row.route !== "string" || !ROUTES.has(row.route)
    || typeof row.method !== "string" || !METHODS.has(row.method)
    || !Number.isInteger(row.status) || Number(row.status) < 100 || Number(row.status) > 599
    || typeof row.requestSeconds !== "string" || !/^(?:0|[1-9]\d*)\.\d{3}$/.test(row.requestSeconds)
    || typeof row.atSeconds !== "string" || !/^[1-9]\d*\.\d{3}$/.test(row.atSeconds)) return undefined;
  const seconds = Number(row.requestSeconds);
  const [epochSeconds, epochMillis] = row.atSeconds.split(".");
  const completedAtMs = Number(epochSeconds) * 1000 + Number(epochMillis);
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(completedAtMs) || completedAtMs <= 0) return undefined;
  return { method: row.method, route: row.route, operation: edgeOperation(row.method, row.route),
    status: Number(row.status), seconds, completedAtMs };
}

/** The scope begins at initialize()'s current EOF, before application readiness.
 * Existing history is deliberately outside this counter lifetime. No request
 * headers are used as clocks. Each refresh reads at most maxBytes, keeps at
 * most one partial line, and holds at most one read-only file descriptor.
 */
export class EdgeLogReader {
  private handle: FileHandle | undefined;
  private fileKey: string | undefined;
  private offset = 0;
  private pending = Buffer.alloc(0);
  private discardUntilNewline = false;
  private refreshing: Promise<EdgeLogSnapshot> | undefined;
  private initializing: Promise<EdgeLogSnapshot> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private data: EdgeLogSnapshot;
  private readonly file: string | undefined;
  private readonly observe: (row: EdgeObservation) => void;
  private readonly options: ReaderOptions;

  constructor(file: string | undefined, observe: (row: EdgeObservation) => void,
    options: ReaderOptions = {}) {
    this.file = file; this.observe = observe; this.options = options;
    this.data = { configured: Boolean(file), initialized: false, collectionAvailable: Number.NaN, state: "unconfigured",
      startedAtMs: null, refreshedAtMs: null, lastRecordAtMs: null, backlogBytes: 0,
      records: 0, invalidRecords: 0, gaps: 0, rotations: 0, lastGapAtMs: null };
  }
  snapshot(): EdgeLogSnapshot { return { ...this.data }; }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private gap(): void { this.data.gaps++; this.data.lastGapAtMs = this.now(); }
  markUnavailable(): void {
    if (this.closed) return;
    this.gap(); this.data.collectionAvailable = 0; this.data.state = "unknown-timeout";
  }
  private async openCurrent(fromEnd: boolean): Promise<boolean> {
    if (!this.file || !path.isAbsolute(this.file)) throw new Error("edge_log_requires_absolute_path");
    const handle = await (this.options.openReadOnly ?? open)(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) throw new Error("edge_log_not_regular_file");
      const offset = fromEnd ? stats.size : 0; let discardUntilNewline = false;
      if (fromEnd && offset > 0) {
        const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, offset - 1);
        discardUntilNewline = byte[0] !== 10;
      }
      if (this.closed) { await handle.close(); return false; }
      this.handle = handle; this.fileKey = `${stats.dev}:${stats.ino}`;
      this.offset = offset; this.pending = Buffer.alloc(0); this.discardUntilNewline = discardUntilNewline;
      return true;
    } catch (error) { await handle.close(); throw error; }
  }
  initialize(): Promise<EdgeLogSnapshot> {
    if (!this.data.configured || this.data.initialized || this.closed) return Promise.resolve(this.snapshot());
    this.initializing ??= this.establishBaseline().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }
  private async establishBaseline(): Promise<EdgeLogSnapshot> {
    const gapsBefore = this.data.gaps;
    const baselineRequestedAtMs = this.now();
    try {
      if (!await this.openCurrent(true)) return this.snapshot();
      if (this.closed) return this.snapshot();
      this.data.initialized = true; this.data.startedAtMs = baselineRequestedAtMs;
      // A timed-out baseline excludes an unknown startup interval. Mark that
      // interval at actual completion too, even when the I/O stalled >5min.
      if (this.data.gaps > gapsBefore) { this.gap(); this.data.collectionAvailable = 0; this.data.state = "unknown-gap-window"; }
      else { this.data.collectionAvailable = 1; this.data.state = "healthy-idle"; }
    } catch { if (!this.closed) { this.data.collectionAvailable = 0; this.data.state = "unknown-open"; } }
    return this.snapshot();
  }
  private consume(bytes: Buffer): void {
    let data = Buffer.concat([this.pending, bytes]); this.pending = Buffer.alloc(0);
    if (this.discardUntilNewline) {
      const newline = data.indexOf(10);
      if (newline < 0) return;
      data = data.subarray(newline + 1); this.discardUntilNewline = false;
    }
    let start = 0; const maxLine = this.options.maxLineBytes ?? 4096;
    for (;;) {
      const newline = data.indexOf(10, start);
      if (newline < 0) break;
      const line = data.subarray(start, newline); start = newline + 1;
      const row = line.length <= maxLine ? parseEdgeObservation(line.toString("utf8")) : undefined;
      if (!row) { this.data.invalidRecords++; this.gap(); continue; }
      this.observe(row); this.data.records++; this.data.lastRecordAtMs = row.completedAtMs;
    }
    const partial = data.subarray(start);
    if (partial.length > maxLine) { this.data.invalidRecords++; this.gap(); this.discardUntilNewline = true; }
    else this.pending = Buffer.from(partial);
  }
  private async readAvailable(budget: number): Promise<number> {
    const handle = this.handle;
    if (!handle) return 0;
    const stats = await handle.stat();
    if (stats.size < this.offset) {
      this.gap(); this.offset = 0; this.pending = Buffer.alloc(0); this.discardUntilNewline = false;
    }
    const size = Math.min(budget, Math.max(0, stats.size - this.offset));
    if (size > 0) {
      const bytes = Buffer.alloc(size); const { bytesRead } = await handle.read(bytes, 0, size, this.offset);
      if (bytesRead !== size) this.gap();
      this.offset += bytesRead; if (!this.closed) this.consume(bytes.subarray(0, bytesRead));
    }
    this.data.backlogBytes = Math.max(0, (await handle.stat()).size - this.offset);
    return size;
  }
  refresh(): Promise<EdgeLogSnapshot> {
    if (this.closed) return Promise.resolve(this.snapshot());
    this.refreshing ??= this.collect().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async collect(): Promise<EdgeLogSnapshot> {
    if (!this.data.configured) return this.snapshot();
    const maxBytes = this.options.maxBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error("edge_log_invalid_read_budget");
    try {
      if (!this.data.initialized) {
        // Missing startup baseline is an explicit gap, not replayed history or 0.
        await this.initialize();
        if (this.closed) return this.snapshot();
        this.gap(); if (!this.data.initialized) return this.snapshot();
      }
      let budget = maxBytes;
      const current = await stat(this.file!);
      if (`${current.dev}:${current.ino}` !== this.fileKey) {
        budget -= await this.readAvailable(budget);
        if (this.data.backlogBytes === 0) {
          // The old FD can receive late Nginx writes around reopen. Do not
          // advertise lossless rotation without an acknowledgement protocol.
          this.gap(); this.data.rotations++;
          await this.handle?.close(); this.handle = undefined;
          if (!await this.openCurrent(false)) return this.snapshot();
        } else {
          this.data.state = "backlogged-rotation"; this.data.collectionAvailable = 0;
          this.data.refreshedAtMs = this.now(); return this.snapshot();
        }
      }
      await this.readAvailable(budget);
      if (this.closed) return this.snapshot();
      this.data.refreshedAtMs = this.now();
      const gapInWindow = this.data.lastGapAtMs !== null && this.now() - this.data.lastGapAtMs < GAP_WINDOW_MS;
      const incomplete = this.pending.length > 0 || this.discardUntilNewline;
      this.data.collectionAvailable = this.data.backlogBytes === 0 && !gapInWindow && !incomplete ? 1 : 0;
      this.data.state = this.data.backlogBytes > 0 ? "backlogged" : gapInWindow ? "unknown-gap-window"
        : incomplete ? "incomplete-line" : this.data.records ? "healthy-observed" : "healthy-idle";
    } catch {
      if (!this.closed) { this.gap(); this.data.collectionAvailable = 0; this.data.state = "unknown-read"; }
    }
    return this.snapshot();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.data.collectionAvailable = this.data.configured ? 0 : Number.NaN; this.data.state = "closed";
    this.closing = (async () => {
      await this.refreshing?.catch(() => undefined);
      const handle = this.handle; this.handle = undefined; await handle?.close();
      // openCurrent owns a not-yet-returned FD and closes it on late completion
      // after closed=true. Do not create a second open or lose that promise.
    })();
    return this.closing;
  }
}
