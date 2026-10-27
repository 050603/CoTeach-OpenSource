import type { ShowcaseEventPayload } from "./types";

type Listener = (payload: ShowcaseEventPayload) => void;

const listenersByCourse = new Map<string, Set<Listener>>();

/** Browser-local fan-out for showcase events received by the shared session socket. */
export function subscribeShowcasePresentation(
  courseId: string,
  listener: Listener,
): () => void {
  const listeners = listenersByCourse.get(courseId) ?? new Set<Listener>();
  listeners.add(listener);
  listenersByCourse.set(courseId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByCourse.delete(courseId);
  };
}

export function emitShowcasePresentation(
  courseId: string,
  payload: ShowcaseEventPayload,
): void {
  const listeners = listenersByCourse.get(courseId);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch (error) {
      console.error("[showcase] realtime listener failed", error);
    }
  }
}

export function __resetShowcaseRealtimeForTests(): void {
  listenersByCourse.clear();
}

