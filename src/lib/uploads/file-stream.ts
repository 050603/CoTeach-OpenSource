import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { Gauge } from "prom-client";
import { getOrCreateRegisteredMetric, register } from "@/lib/observability/metrics";

const BUFFER_BYTES = 64 * 1024;
const active = getOrCreateRegisteredMetric(register, "openpbl_file_streams_active", () => new Gauge({
  name: "openpbl_file_streams_active", help: "Application file streams not yet closed, including canceled client downloads.",
}));

export function parseByteRange(header: string, totalSize: number): { start: number; end: number } | null {
  if (!Number.isSafeInteger(totalSize) || totalSize <= 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, totalSize - suffix), end: totalSize - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : totalSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= totalSize || end < start) return null;
  return { start, end: Math.min(end, totalSize - 1) };
}

/** Open before returning the Response so missing/unreadable files remain HTTP
 * errors. Both Node and Web queues are byte-bounded. The adapter's default
 * size=1 would otherwise treat its 64 KiB high-water mark as 65,536 chunks.
 * Reader cancellation and client disconnect both close the underlying fd.
 */
export async function streamFileBytes(
  filePath: string,
  options: { start?: number; end?: number; signal?: AbortSignal } = {},
): Promise<ReadableStream<Uint8Array>> {
  const file = await open(/* turbopackIgnore: true */ filePath, "r");
  try {
    const source = file.createReadStream({ ...options, autoClose: true, highWaterMark: BUFFER_BYTES });
    active.inc();
    source.once("close", () => active.dec());
    return Readable.toWeb(source, {
      strategy: { highWaterMark: BUFFER_BYTES, size: (chunk: Uint8Array) => chunk.byteLength },
    }) as ReadableStream<Uint8Array>;
  } catch (error) {
    await file.close();
    throw error;
  }
}
