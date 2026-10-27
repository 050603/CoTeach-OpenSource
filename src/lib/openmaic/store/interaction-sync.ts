/**
 * Interaction state sync store for projected interactive scenes.
 *
 * When the teacher projects an interactive scene and manipulates it (clicks
 * buttons, drags sliders, etc.) inside the sandboxed iframe, the bridge script
 * injected by `patchHtmlForIframe` broadcasts those interactions as
 * `{ __maicInteractive: true, kind: 'state-broadcast', state }` postMessages.
 *
 * `InteractiveIframeHost` (mounted in the teacher's Stage) listens for those
 * messages from the active scene's iframe and writes them here. The teacher's
 * `TeacherStageResources` subscribes to this store and forwards the latest
 * state into `TeacherResourceProjection.interactionState` via `setUiState`.
 *
 * On the student side, `StudentProjectedTeacherResource` reads
 * `projection.interactionState` and feeds it to `OpenMaicResourcePlayer`,
 * which sends `{ __maicInteractive: true, kind: 'apply-state', state }` into
 * the student's iframe via the widget-iframe messaging store. The bridge
 * script inside that iframe then applies the state to matching elements.
 *
 * The store is keyed by sceneId so multiple interactive scenes can coexist
 * without cross-talk. Only the active scene's state is forwarded.
 */

import { create } from "zustand";

type InteractionSyncState = {
  /** Latest interaction state per sceneId, written by the iframe host. */
  states: Record<string, Record<string, unknown>>;
  /** Monotonic version per sceneId; bumped on every update so subscribers can dedup. */
  versions: Record<string, number>;
  /** Record a state broadcast from a scene's iframe. */
  broadcast: (sceneId: string, state: Record<string, unknown>) => void;
  /** Read the latest state for a scene (or null if none). */
  getState: (sceneId: string) => Record<string, unknown> | null;
  /** Clear state for a scene (e.g. on scene switch / unmount). */
  clear: (sceneId: string) => void;
};

export const useInteractionSyncStore = create<InteractionSyncState>((set, get) => ({
  states: {},
  versions: {},
  broadcast: (sceneId, state) =>
    set((s) => ({
      states: { ...s.states, [sceneId]: state },
      versions: {
        ...s.versions,
        [sceneId]: (s.versions[sceneId] ?? 0) + 1,
      },
    })),
  getState: (sceneId) => get().states[sceneId] ?? null,
  clear: (sceneId) =>
    set((s) => {
      if (!s.states[sceneId]) return {};
      const states = { ...s.states };
      delete states[sceneId];
      const versions = { ...s.versions };
      delete versions[sceneId];
      return { states, versions };
    }),
}));
