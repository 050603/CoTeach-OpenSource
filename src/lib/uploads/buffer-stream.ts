const CHUNK_BYTES = 64 * 1024;

/** Stream an immutable byte view without Response's BufferSource body copy.
 * Both chunk size and queue capacity are measured in bytes. A regular stream
 * intentionally avoids the buffer transfer/detachment of type: "bytes", so
 * concurrent ranges can safely share the normalized source. The caller must
 * keep these bytes immutable until all consumers finish.
 */
export function streamBufferBytes(
  bytes: Uint8Array,
  options: { start?: number; end?: number; signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  let offset = options.start ?? 0;
  const limit = options.end === undefined ? bytes.byteLength : options.end + 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(limit)
    || offset < 0 || limit > bytes.byteLength || limit < offset
    || (offset === limit && (options.start !== undefined || options.end !== undefined))) {
    throw new RangeError('Invalid buffer byte range');
  }
  let source: Uint8Array | undefined = bytes;
  const { signal } = options;
  let onAbort: () => void;
  const release = () => {
    source = undefined;
    signal?.removeEventListener('abort', onAbort);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        release();
        controller.error(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (offset === limit) { release(); controller.close(); }
    },
    pull(controller) {
      if (!source) return;
      const next = Math.min(offset + CHUNK_BYTES, limit);
      controller.enqueue(source.subarray(offset, next));
      offset = next;
      if (offset === limit) { release(); controller.close(); }
    },
    cancel() { release(); },
  }, { highWaterMark: CHUNK_BYTES, size: chunk => chunk.byteLength });
}
