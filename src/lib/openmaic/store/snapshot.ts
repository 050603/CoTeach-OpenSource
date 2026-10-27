import { create } from 'zustand';
import { db, type Snapshot } from '@openmaic/lib/utils/database';
import { useStageStore } from './stage';

export interface SnapshotState {
  snapshotCursor: number;
  snapshotLength: number;
  canUndo: () => boolean;
  canRedo: () => boolean;
  setSnapshotCursor: (cursor: number) => void;
  setSnapshotLength: (length: number) => void;
  initSnapshotDatabase: () => Promise<void>;
  addSnapshot: () => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const HISTORY_LIMIT = 20;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function capture(): Snapshot {
  const stage = useStageStore.getState();
  return { slides: copy(stage.scenes), index: stage.getSceneIndex(stage.currentSceneId ?? '') };
}

/** Serialize history commands so quick edits and undo clicks cannot race the
 * database. Replacing a bounded timeline is atomic and keeps its cursor aligned
 * with the committed rows, including when a storage write fails. */
export const useSnapshotStore = create<SnapshotState>((set, get) => {
  let pending: Promise<void> = Promise.resolve();
  const enqueue = (command: () => Promise<void>) => {
    const result = pending.then(command);
    pending = result.catch(() => undefined);
    return result;
  };
  const read = () => db.snapshots.orderBy('id').toArray();
  const write = async (timeline: Snapshot[]) => {
    await db.snapshots.clear();
    await db.snapshots.bulkAdd(timeline.map(({ index, slides }) => ({ index, slides })));
  };
  const travel = (offset: number) => enqueue(async () => {
    const cursor = get().snapshotCursor + offset;
    if (cursor < 0 || cursor >= get().snapshotLength) return;
    const saved = (await read())[cursor];
    if (!saved) return;
    const slides = copy(saved.slides);
    const selected = slides[Math.max(0, Math.min(saved.index, slides.length - 1))];
    const stage = useStageStore.getState();
    stage.setScenes(slides);
    stage.setCurrentSceneId(selected?.id ?? null);
    set({ snapshotCursor: cursor });
  });

  return {
    snapshotCursor: -1,
    snapshotLength: 0,
    canUndo: () => get().snapshotCursor > 0,
    canRedo: () => get().snapshotCursor + 1 < get().snapshotLength,
    setSnapshotCursor: snapshotCursor => set({ snapshotCursor }),
    setSnapshotLength: snapshotLength => set({ snapshotLength }),
    initSnapshotDatabase: () => {
      const first = capture();
      return enqueue(async () => {
        await db.transaction('rw', db.snapshots, () => write([first]));
        set({ snapshotCursor: 0, snapshotLength: 1 });
      });
    },
    addSnapshot: () => {
      // Capture at invocation, before a later edit can change the live scene.
      const next = capture();
      return enqueue(async () => {
        let length = 0;
        await db.transaction('rw', db.snapshots, async () => {
          const history = (await read()).slice(0, get().snapshotCursor + 1);
          const previous = history.at(-1);
          if (previous) previous.index = next.index;
          const timeline = [...history, next].slice(-HISTORY_LIMIT);
          await write(timeline);
          length = timeline.length;
        });
        set({ snapshotCursor: length - 1, snapshotLength: length });
      });
    },
    undo: () => travel(-1),
    redo: () => travel(1),
  };
});
