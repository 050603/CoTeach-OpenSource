// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
vi.mock("node:fs/promises", { spy: true });
import { writeUploadFile } from "./write-upload-file";

let directory: string;
beforeEach(async () => { vi.clearAllMocks(); directory = await fs.mkdtemp(path.join(os.tmpdir(), "openpbl-upload-writer-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const streamed = (bytes: Uint8Array<ArrayBuffer>, size = bytes.byteLength) => ({ size,
  stream: () => new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
});

it("writes exact immutable File bytes and a complete SHA without arrayBuffer materialization", async () => {
  const bytes = Buffer.alloc(230_017, 97); bytes[bytes.length - 1] = 98;
  const file = new File([bytes], "work.txt");
  const materialize = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("whole-file arrayBuffer must not be used"));
  const location = path.join(directory, "file.txt");
  expect(await writeUploadFile(file, location, { maxBytes: 300_000, checkForNul: true }))
    .toEqual({ size: bytes.length, sha256: digest(bytes), containsNul: false });
  expect(materialize).not.toHaveBeenCalled();
  expect(await fs.readFile(location)).toEqual(bytes);
  expect((await fs.stat(location)).mode & 0o777).toBe(0o600);
});

it("splits a large incoming chunk into at most64KiB writes and completes partial filesystem writes", async () => {
  const location = path.join(directory, "partial.bin");
  const handle = await fs.open(location, "wx", 0o600); const write = handle.write.bind(handle);
  const lengths: number[] = [];
  Object.assign(handle, { write: async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
    lengths.push(length); return write(buffer, offset, Math.min(length, 8191), position);
  } });
  vi.mocked(fs.open).mockResolvedValueOnce(handle);
  const bytes = Buffer.alloc(180_013, 41); bytes[bytes.length - 1] = 42;
  const result = await writeUploadFile(streamed(bytes), location, { maxBytes: 200_000 });
  expect(Math.max(...lengths)).toBeLessThanOrEqual(64 * 1024);
  expect(lengths.length).toBeGreaterThan(3);
  expect(result.sha256).toBe(digest(bytes)); expect(await fs.readFile(location)).toEqual(bytes);
  await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
});

it("does not pull further source bytes while the current filesystem write is backpressured", async () => {
  const location = path.join(directory, "backpressure.bin");
  const handle = await fs.open(location, "wx", 0o600); const write = handle.write.bind(handle);
  let release!: () => void; let writing!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { writing = resolve; });
  let first = true; let pulls = 0;
  Object.assign(handle, { write: async (buffer: Uint8Array, offset: number, length: number, position: number | null) => {
    if (first) { first = false; writing(); await blocked; }
    return write(buffer, offset, length, position);
  } });
  vi.mocked(fs.open).mockResolvedValueOnce(handle);
  const file = { size: 128 * 1024, stream: () => new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
    pulls++; if (pulls <= 2) controller.enqueue(new Uint8Array(64 * 1024).fill(pulls)); else controller.close();
  } }, { highWaterMark: 0 }) };
  const pending = writeUploadFile(file, location, { maxBytes: file.size });
  try { await started; expect(pulls).toBe(1); } finally { release(); }
  expect((await pending).size).toBe(file.size);
  expect(pulls).toBe(3);
});

it("checks NUL through the end and does not add UTF8 validation to the existing text contract", async () => {
  const bytes = Buffer.alloc(128 * 1024 + 1, 255); bytes[bytes.length - 1] = 0;
  const result = await writeUploadFile(streamed(bytes), path.join(directory, "nul.txt"), { maxBytes: bytes.length, checkForNul: true });
  expect(result.containsNul).toBe(true); expect(result.sha256).toBe(digest(bytes));
  expect((await writeUploadFile(streamed(new Uint8Array([255, 254])), path.join(directory, "legacy.txt"),
    { maxBytes: 10, checkForNul: true })).containsNul).toBe(false);
});

it("accepts the exact byte limit and rejects empty, oversize, shortened or extended content without partial files", async () => {
  const bytes = Buffer.alloc(128 * 1024, 1);
  expect((await writeUploadFile(streamed(bytes), path.join(directory, "boundary"), { maxBytes: bytes.length })).size).toBe(bytes.length);
  const cases = [
    { source: streamed(new Uint8Array()), limit: 10, code: "FILE_TOO_LARGE" },
    { source: streamed(bytes), limit: bytes.length - 1, code: "FILE_TOO_LARGE" },
    { source: streamed(new Uint8Array(8), 4), limit: 6, code: "FILE_TOO_LARGE" },
    { source: streamed(new Uint8Array(8), 4), limit: 10, code: "UPLOAD_INCOMPLETE" },
    { source: streamed(new Uint8Array(2), 4), limit: 10, code: "UPLOAD_INCOMPLETE" },
  ];
  for (const [index, item] of cases.entries()) {
    const location = path.join(directory, `invalid-${index}`);
    await expect(writeUploadFile(item.source, location, { maxBytes: item.limit })).rejects.toMatchObject({ code: item.code });
    await expect(fs.stat(location)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it("cancels a pending source read and removes its own file when the client disconnects", async () => {
  let reading!: () => void; const started = new Promise<void>(resolve => { reading = resolve; });
  const cancel = vi.fn();
  const file = { size: 10, stream: () => new ReadableStream<Uint8Array<ArrayBuffer>>({ pull() { reading(); }, cancel }, { highWaterMark: 0 }) };
  const controller = new AbortController(); const location = path.join(directory, "aborted");
  const pending = writeUploadFile(file, location, { maxBytes: 10, signal: controller.signal });
  const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await started; controller.abort(); await failure;
  expect(cancel).toHaveBeenCalledTimes(1);
  await expect(fs.stat(location)).rejects.toMatchObject({ code: "ENOENT" });
  const handle = await vi.mocked(fs.open).mock.results.at(-1)!.value;
  await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
});

it("cleans source and disk failures, including a writer making no progress", async () => {
  const broken = { size: 4, stream: () => new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.error(new Error("source-failed")); } }) };
  const sourcePath = path.join(directory, "source-error");
  await expect(writeUploadFile(broken, sourcePath, { maxBytes: 10 })).rejects.toThrow("source-failed");
  await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  for (const failure of ["disk-full", "zero-write"]) {
    const location = path.join(directory, failure); const handle = await fs.open(location, "wx", 0o600);
    Object.assign(handle, { write: async (buffer: Uint8Array) => {
      if (failure === "disk-full") throw new Error("ENOSPC");
      return { bytesWritten: 0, buffer };
    } });
    vi.mocked(fs.open).mockResolvedValueOnce(handle);
    await expect(writeUploadFile(streamed(new Uint8Array(4)), location, { maxBytes: 10 })).rejects.toThrow();
    await expect(fs.stat(location)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
  }
});

it("never deletes an existing destination when exclusive creation fails", async () => {
  const location = path.join(directory, "owned-by-another-upload"); await fs.writeFile(location, "retain existing bytes");
  await expect(writeUploadFile(streamed(new Uint8Array(4)), location, { maxBytes: 10 })).rejects.toMatchObject({ code: "EEXIST" });
  expect(await fs.readFile(location, "utf8")).toBe("retain existing bytes");
});
