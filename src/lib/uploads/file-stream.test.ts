// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
vi.mock("node:fs/promises", { spy: true });
import { parseByteRange, streamFileBytes } from "./file-stream";
import { register } from "@/lib/observability/metrics";

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpbl-file-stream-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
const nextTurn = () => new Promise(resolve => setTimeout(resolve, 20));

describe("byte-bounded application file streams", () => {
  it("streams exact full and partial file contents", async () => {
    const file = path.join(directory, "data.bin"); const content = Buffer.alloc(200_000, 42); await fs.writeFile(file, content);
    expect(Buffer.from(await new Response(await streamFileBytes(file)).arrayBuffer())).toEqual(content);
    const range = await streamFileBytes(file, { start: 123, end: 65_537 });
    expect(Buffer.from(await new Response(range).arrayBuffer())).toEqual(content.subarray(123, 65_538));
  });

  it("limits read-ahead for an unconsumed large body and releases the fd on cancellation", async () => {
    const file = path.join(directory, "large.bin"); await fs.writeFile(file, Buffer.alloc(8 * 1024 * 1024));
    const handle = await fs.open(file, "r");
    const create = vi.spyOn(handle, "createReadStream");
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    const body = await streamFileBytes(file);
    await nextTurn();
    const source = create.mock.results[0].value;
    expect(source.bytesRead).toBeLessThanOrEqual(3 * 64 * 1024);
    expect(source.destroyed).toBe(false);
    await body.cancel(); await nextTurn();
    expect(source.closed).toBe(true);
    const metric = await register.getSingleMetric("openpbl_file_streams_active")!.get();
    expect(metric.values[0].value).toBe(0);
  });

  it("aborts a disconnected client and exposes missing files before a response is returned", async () => {
    const file = path.join(directory, "abort.bin"); await fs.writeFile(file, Buffer.alloc(1024 * 1024));
    const controller = new AbortController();
    const body = await streamFileBytes(file, { signal: controller.signal });
    controller.abort();
    await expect(new Response(body).arrayBuffer()).rejects.toMatchObject({ name: "AbortError" });
    await nextTurn();
    await expect(streamFileBytes(path.join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("shared HTTP byte range parsing", () => {
  it.each(["bytes=-1", "bytes=0-", "bytes=0-0"])("rejects %s against an empty file", range => {
    expect(parseByteRange(range, 0)).toBeNull();
  });
  it("keeps suffix and clamped ranges and rejects multiple or unsafe ranges", () => {
    expect(parseByteRange("BYTES=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(parseByteRange("bytes=8-99", 10)).toEqual({ start: 8, end: 9 });
    expect(parseByteRange("bytes=0-1,3-4", 10)).toBeNull();
    expect(parseByteRange("bytes=9007199254740992-", 10)).toBeNull();
  });
});
