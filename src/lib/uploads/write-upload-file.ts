import { createHash } from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";

const WRITE_CHUNK_BYTES = 64 * 1024;

export class UploadFileWriteError extends Error {
  constructor(readonly code: "FILE_TOO_LARGE" | "UPLOAD_INCOMPLETE") {
    super(code);
  }
}

/** Exclusively creates an unregistered file in the caller's upload directory.
 * The caller owns a successful result; failures remove only files created here.
 * Each write completes before reading further, with no whole-file byte copy.
 */
export async function writeUploadFile(
  file: Pick<File, "size" | "stream">,
  targetPath: string,
  options: { maxBytes: number; checkForNul?: boolean; signal?: AbortSignal },
): Promise<{ size: number; sha256: string; containsNul: boolean }> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) throw new TypeError("Invalid upload byte limit");
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > options.maxBytes) throw new UploadFileWriteError("FILE_TOO_LARGE");
  options.signal?.throwIfAborted();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let created = false;
  let complete = false;
  const cancel = () => { void reader?.cancel(options.signal?.reason).catch(() => undefined); };
  try {
    handle = await open(/* turbopackIgnore: true */ targetPath, "wx", 0o600);
    created = true;
    options.signal?.throwIfAborted();
    reader = file.stream().getReader();
    options.signal?.addEventListener("abort", cancel, { once: true });
    const hash = createHash("sha256");
    let size = 0;
    let containsNul = false;
    while (true) {
      options.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      options.signal?.throwIfAborted();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += WRITE_CHUNK_BYTES) {
        options.signal?.throwIfAborted();
        const chunk = value.subarray(offset, offset + WRITE_CHUNK_BYTES);
        size += chunk.byteLength;
        if (size > options.maxBytes) throw new UploadFileWriteError("FILE_TOO_LARGE");
        if (size > file.size) throw new UploadFileWriteError("UPLOAD_INCOMPLETE");
        hash.update(chunk);
        if (options.checkForNul && !containsNul && chunk.includes(0)) containsNul = true;
        let written = 0;
        while (written < chunk.byteLength) {
          const result = await handle.write(chunk, written, chunk.byteLength - written, null);
          if (result.bytesWritten <= 0 || result.bytesWritten > chunk.byteLength - written) throw new Error("Upload file write made invalid progress");
          written += result.bytesWritten;
          options.signal?.throwIfAborted();
        }
      }
    }
    if (size !== file.size) throw new UploadFileWriteError("UPLOAD_INCOMPLETE");
    await handle.close();
    handle = undefined;
    const info = await stat(/* turbopackIgnore: true */ targetPath);
    if (!info.isFile() || info.size !== size) throw new UploadFileWriteError("UPLOAD_INCOMPLETE");
    options.signal?.throwIfAborted();
    const sha256 = hash.digest("hex");
    complete = true;
    return { size, sha256, containsNul };
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader?.releaseLock();
    await handle?.close().catch(() => undefined);
    if (created && !complete) await unlink(/* turbopackIgnore: true */ targetPath).catch(() => undefined);
  }
}
