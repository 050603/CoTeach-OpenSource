import { Counter, Gauge } from "prom-client";
import { getOrCreateRegisteredMetric, register } from "@/lib/observability/metrics";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";

export const SMALL_RUNTIME_ASSET_MAX_BYTES = 512 * 1024;
export type LocalRuntimeAsset = { filePath: string; size: number; identity: string };
export type RuntimeAsset = Uint8Array | LocalRuntimeAsset;
type CacheEvent = "hit" | "miss" | "join" | "eviction";

/** Public package bodies only. Both entry count and retained bytes are bounded;
 * callers must include the fresh file identity and runtime version in the key.
 */
export function createRuntimeAssetBodyCache(options: {
  maxEntries: number; maxBytes: number; maxAssetBytes: number;
  onEvent?: (event: CacheEvent) => void;
}) {
  const entries = new Map<string, Uint8Array>();
  const reads = new Map<string, Promise<Uint8Array>>();
  let bytes = 0;
  return {
    snapshot: () => ({ entries: entries.size, bytes, inFlight: reads.size }),
    read(key: string, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key); entries.set(key, cached);
        options.onEvent?.("hit"); return Promise.resolve(cached);
      }
      const existing = reads.get(key);
      if (existing) { options.onEvent?.("join"); return existing; }
      options.onEvent?.("miss");
      const promise = Promise.resolve().then(load).then(value => {
        if (options.maxEntries < 1 || value.byteLength > Math.min(options.maxAssetBytes, options.maxBytes)) return value;
        // Keep an exact allocation, rather than retaining a pooled Buffer slab.
        const retained = Uint8Array.from(value);
        entries.set(key, retained); bytes += retained.byteLength;
        while (entries.size > options.maxEntries || bytes > options.maxBytes) {
          const oldest = entries.keys().next().value!;
          bytes -= entries.get(oldest)!.byteLength; entries.delete(oldest);
          options.onEvent?.("eviction");
        }
        return retained;
      });
      reads.set(key, promise);
      const clear = () => { if (reads.get(key) === promise) reads.delete(key); };
      void promise.then(clear, clear);
      return promise;
    },
  };
}

const scope = globalThis as typeof globalThis & {
  __openpblRuntimeAssetReads?: Map<string, Promise<RuntimeAsset | null>>;
  __openpblRuntimeAssetLocations?: Map<string, Promise<LocalRuntimeAsset | null>>;
  __openpblRuntimeAssetBodiesV1?: ReturnType<typeof createRuntimeAssetBodyCache>;
};
const pending = scope.__openpblRuntimeAssetReads ??= new Map();
const locations = scope.__openpblRuntimeAssetLocations ??= new Map();
const bodyEvents = getOrCreateRegisteredMetric(register, "openpbl_runtime_asset_body_cache_events_total", () => new Counter({
  name: "openpbl_runtime_asset_body_cache_events_total", help: "Bounded public runtime body cache events.", labelNames: ["event"],
}));
const smallBodies = scope.__openpblRuntimeAssetBodiesV1 ??= createRuntimeAssetBodyCache({
  maxEntries: 256, maxBytes: 8 * 1024 * 1024, maxAssetBytes: SMALL_RUNTIME_ASSET_MAX_BYTES,
  onEvent(event) { bodyEvents.inc({ event }); },
});
getOrCreateRegisteredMetric(register, "openpbl_runtime_asset_body_cache_bytes", () => new Gauge({
  name: "openpbl_runtime_asset_body_cache_bytes", help: "Retained public runtime body bytes, bounded at 8 MiB; excludes active response streams.",
  collect() { this.set(smallBodies.snapshot().bytes); },
}));
getOrCreateRegisteredMetric(register, "openpbl_runtime_asset_body_cache_entries", () => new Gauge({
  name: "openpbl_runtime_asset_body_cache_entries", help: "Retained public runtime body entries, bounded at 256.",
  collect() { this.set(smallBodies.snapshot().entries); },
}));
const activeReads = () => pending.size + locations.size + smallBodies.snapshot().inFlight;
const inFlight = getOrCreateRegisteredMetric(register, "openpbl_runtime_asset_reads_active", () => new Gauge({
  name: "openpbl_runtime_asset_reads_active", help: "In-flight public runtime body reads, fetches and metadata lookups.",
  collect() { this.set(activeReads()); },
}));
const joined = getOrCreateRegisteredMetric(register, "openpbl_runtime_asset_reads_joined_total", () => new Counter({
  name: "openpbl_runtime_asset_reads_joined_total", help: "Runtime asset requests sharing an existing read or fetch.",
}));

/** Only immutable public runtime assets use this map. Never join private media
 * or authorization reads. Failed reads are removed so the next request retries.
 */
export function coalesceRuntimeAssetRead(key: string, read: () => Promise<RuntimeAsset | null>): Promise<RuntimeAsset | null> {
  const existing = pending.get(key);
  if (existing) { joined.inc(); return existing; }
  const promise = Promise.resolve().then(read);
  pending.set(key, promise);
  inFlight.set(activeReads());
  const clear = () => { if (pending.get(key) === promise) pending.delete(key); inFlight.set(activeReads()); };
  void promise.then(clear, clear);
  return promise;
}

/** Only the runtime route's validated package/cache roots may use this lookup.
 * Concurrent requests share metadata work, while each slow client gets its own
 * byte-bounded stream. Completed locations are not cached: a later request
 * always validates the current file before using a retained body or validator.
 */
export function locateLocalRuntimeAsset(root: string, parts: string[]): Promise<LocalRuntimeAsset | null> {
  const base = path.resolve(root); const filePath = path.resolve(base, ...parts);
  if (!filePath.startsWith(`${base}${path.sep}`)) return Promise.resolve(null);
  const existing = locations.get(filePath);
  if (existing) { joined.inc(); return existing; }
  const lookup = Promise.resolve().then(async () => {
    try {
      const info = await stat(/* turbopackIgnore: true */ filePath, { bigint: true });
      const size = Number(info.size);
      return info.isFile() && Number.isSafeInteger(size) ? { filePath, size, identity: fileIdentity(info) } : null;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  });
  locations.set(filePath, lookup); inFlight.set(activeReads());
  const clear = () => { if (locations.get(filePath) === lookup) locations.delete(filePath); inFlight.set(activeReads()); };
  void lookup.then(clear, clear);
  return lookup;
}

function fileIdentity(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function changedAsset(): Error & { code: string } {
  return Object.assign(new Error("Public runtime file changed during its read"), { code: "RUNTIME_ASSET_CHANGED" });
}

export function runtimeAssetEtag(asset: LocalRuntimeAsset, version: string): string {
  // Weak because this describes file identity, not a hash of the response body.
  const digest = createHash("sha256").update(JSON.stringify([version, asset.filePath, asset.identity])).digest("base64url");
  return `W/"${digest}"`;
}

/** GET/HEAD use weak comparison. Parse the complete field before accepting a
 * match: quoted commas are legal, while malformed lists must never yield 304.
 */
export function runtimeAssetMatchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const value = header.replace(/^[ \t]+|[ \t]+$/g, "");
  if (value === "*") return true;
  const opaque = etag.startsWith("W/") ? etag.slice(2) : etag;
  let index = 0; let matched = false;
  while (index < value.length) {
    while (value[index] === " " || value[index] === "\t" || value[index] === ",") index++;
    if (index === value.length) break;
    if (value.startsWith("W/", index)) index += 2;
    const start = index;
    if (value[index++] !== '"') return false;
    while (index < value.length && value[index] !== '"') {
      const code = value.charCodeAt(index++);
      if (!(code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff))) return false;
    }
    if (value[index++] !== '"') return false;
    matched ||= value.slice(start, index) === opaque;
    while (value[index] === " " || value[index] === "\t") index++;
    if (index < value.length && value[index++] !== ",") return false;
  }
  return matched;
}

/** Only the validated public runtime route uses this shared body cache. Read a
 * bounded allocation, verifying the opened file before and after, so a package
 * replacement cannot store new bytes under the previous file's identity.
 */
export function readSmallRuntimeAsset(asset: LocalRuntimeAsset, version: string): Promise<Uint8Array> {
  if (asset.size > SMALL_RUNTIME_ASSET_MAX_BYTES) throw new RangeError("Large runtime assets must be streamed");
  const key = JSON.stringify([version, asset.filePath, asset.identity]);
  return smallBodies.read(key, async () => {
    const file = await open(/* turbopackIgnore: true */ asset.filePath, "r");
    try {
      if (fileIdentity(await file.stat({ bigint: true })) !== asset.identity) throw changedAsset();
      const bytes = new Uint8Array(asset.size); let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
        if (result.bytesRead === 0) throw changedAsset();
        offset += result.bytesRead;
      }
      if (fileIdentity(await file.stat({ bigint: true })) !== asset.identity) throw changedAsset();
      return bytes;
    } finally { await file.close(); }
  });
}
