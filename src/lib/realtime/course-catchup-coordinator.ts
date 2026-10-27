type Options = {
  isCurrent: () => boolean;
  hasCursor: () => boolean;
  seed: () => Promise<boolean>;
  catchUp: () => Promise<void>;
  onRefreshed: () => void;
  onError: (error: unknown) => void;
};

/** One course/identity epoch; only in-flight work is shared, never its result.
 * A transport recovery after an event read started requires a trailing catch-up.
 * Recovery during the initial snapshot can use the catch-up after that snapshot.
 */
export function createCourseCatchUpCoordinator(options: Options) {
  let running: Promise<void> | undefined;
  let requestedFreshness = 0;
  let disposed = false;
  const current = () => !disposed && options.isCurrent();

  async function execute() {
    try {
      if (!current()) return;
      if (!options.hasCursor()) {
        if (!await options.seed() || !current()) return;
        // An ordinary initial poll only seeds. A concurrent subscription/focus
        // also needs durable events, now starting at the acknowledged cursor.
        if (requestedFreshness === 0) { options.onRefreshed(); return; }
      }
      let captured: number;
      do {
        captured = requestedFreshness;
        await options.catchUp();
        if (!current()) return;
        // A later recovery must not be acknowledged by an older event query.
      } while (captured !== requestedFreshness);
      options.onRefreshed();
    } catch (error) {
      if (current()) options.onError(error);
    }
  }

  return {
    request(requireFreshCatchUp = false): Promise<void> {
      if (!current()) return Promise.resolve();
      if (requireFreshCatchUp) requestedFreshness += 1;
      if (running) return running;
      const job = Promise.resolve().then(execute).finally(() => {
        if (running === job) running = undefined;
      });
      running = job;
      return job;
    },
    dispose() { disposed = true; },
  };
}
