type PendingRead = {
  controller: AbortController;
  promise: Promise<Uint8Array>;
  consumers: number;
  settled: boolean;
};

/** Immutable playable WAV bytes only; authorization must precede every lookup.
 * File identity belongs in the key. Each reader owns its abort signal, so one
 * student leaving cannot cancel another student's shared disk read.
 */
export function createClassroomMediaCache(options: { maxBytes: number; maxEntries: number }) {
  const entries = new Map<string, Uint8Array>();
  const pending = new Map<string, PendingRead>();
  let retainedBytes = 0;

  return {
    snapshot: () => ({ bytes: retainedBytes, entries: entries.size, pending: pending.size }),
    read(key: string, load: (signal: AbortSignal) => Promise<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
      if (signal.aborted) return Promise.reject(signal.reason);
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return Promise.resolve(cached);
      }
      let read = pending.get(key);
      if (!read) {
        const controller = new AbortController();
        const next: PendingRead = { controller, consumers: 0, settled: false, promise: undefined! };
        next.promise = Promise.resolve().then(() => load(controller.signal)).then(value => {
          // Count backing storage, including nested WAV views and Buffer slabs.
          // Oversized files are shared while loading but never retained.
          const bytes = value.buffer.byteLength;
          if (!controller.signal.aborted && options.maxEntries > 0 && bytes <= options.maxBytes) {
            entries.set(key, value);
            retainedBytes += bytes;
            while (entries.size > options.maxEntries || retainedBytes > options.maxBytes) {
              const oldest = entries.keys().next().value!;
              retainedBytes -= entries.get(oldest)!.buffer.byteLength;
              entries.delete(oldest);
            }
          }
          return value;
        });
        const finish = () => {
          next.settled = true;
          if (pending.get(key) === next) pending.delete(key);
        };
        void next.promise.then(finish, finish);
        pending.set(key, next);
        read = next;
      }
      const shared = read;
      shared.consumers++;
      return new Promise((resolve, reject) => {
        let released = false;
        const release = () => {
          if (released) return false;
          released = true;
          signal.removeEventListener('abort', abort);
          shared.consumers--;
          if (!shared.settled && shared.consumers === 0) {
            if (pending.get(key) === shared) pending.delete(key);
            shared.controller.abort();
          }
          return true;
        };
        const abort = () => { if (release()) reject(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        shared.promise.then(
          value => { if (release()) resolve(value); },
          error => { if (release()) reject(error); },
        );
        if (signal.aborted) abort();
      });
    },
  };
}
