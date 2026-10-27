import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '@openmaic/lib/utils/database';
import type { Scene } from '@openmaic/lib/types/stage';

const fixture = vi.hoisted(() => ({ rows: [] as Snapshot[], scenes: [] as Scene[], selected: null as string | null,
  failWrite: false, nextId: 1 }));
vi.mock('@openmaic/lib/utils/database', () => {
  const snapshots = {
    orderBy: () => ({ toArray: async () => structuredClone(fixture.rows) }),
    clear: async () => { fixture.rows = []; },
    bulkAdd: async (rows: Snapshot[]) => {
      if (fixture.failWrite) throw new Error('storage full');
      fixture.rows.push(...structuredClone(rows).map(row => ({ ...row, id: fixture.nextId++ })));
    },
  };
  return { db: { snapshots, transaction: async (_mode: string, _table: unknown, operation: () => Promise<void>) => {
    const before = structuredClone(fixture.rows);
    try { await operation(); } catch (error) { fixture.rows = before; throw error; }
  } } };
});
vi.mock('./stage', () => ({ useStageStore: { getState: () => ({
  scenes: fixture.scenes, currentSceneId: fixture.selected,
  getSceneIndex: (id: string) => fixture.scenes.findIndex(scene => scene.id === id),
  setScenes: (scenes: Scene[]) => { fixture.scenes = scenes; },
  setCurrentSceneId: (id: string | null) => { fixture.selected = id; },
}) } }));
import { useSnapshotStore } from './snapshot';

const state = () => useSnapshotStore.getState();
function edit(title: string, selected = 'two') {
  fixture.scenes = [{ id: 'one', title }, { id: 'two', title }] as Scene[];
  fixture.selected = selected;
}

beforeEach(async () => {
  fixture.failWrite = false;
  fixture.rows = [];
  edit('initial');
  await state().initSnapshotDatabase();
});

describe('editor history persistence', () => {
  it('restores scene contents and focus, and discards redo after a new edit', async () => {
    edit('first'); await state().addSnapshot();
    edit('second', 'one'); await state().addSnapshot();
    await state().undo();
    expect(fixture.scenes[0].title).toBe('first');
    expect(fixture.selected).toBe('one');
    expect(state().canRedo()).toBe(true);
    edit('replacement'); await state().addSnapshot();
    expect(state().canRedo()).toBe(false);
    await state().undo(); await state().redo();
    expect(fixture.scenes[0].title).toBe('replacement');
    expect(fixture.rows.map(row => row.slides[0].title)).toEqual(['initial', 'first', 'replacement']);
  });

  it('captures rapid commands in order and bounds persisted history to 20 entries', async () => {
    const writes: Promise<void>[] = [];
    for (let index = 1; index <= 25; index++) { edit(`edit-${index}`); writes.push(state().addSnapshot()); }
    await Promise.all(writes);
    expect(fixture.rows).toHaveLength(20);
    expect(fixture.rows[0].slides[0].title).toBe('edit-6');
    await Promise.all([state().undo(), state().undo()]);
    expect(fixture.scenes[0].title).toBe('edit-23');
    expect(state().snapshotCursor).toBe(17);
  });

  it('keeps committed history when storage fails and accepts a later command', async () => {
    edit('failed'); fixture.failWrite = true;
    await expect(state().addSnapshot()).rejects.toThrow('storage full');
    expect(state().snapshotCursor).toBe(0);
    expect(fixture.rows[0].slides[0].title).toBe('initial');
    fixture.failWrite = false; edit('recovered'); await state().addSnapshot();
    expect(state().snapshotLength).toBe(2);
    await state().undo();
    expect(fixture.scenes[0].title).toBe('initial');
  });

  it('starts a fresh editor session without stale snapshots and handles an empty scene list', async () => {
    edit('other-session'); await state().initSnapshotDatabase();
    expect(fixture.rows).toHaveLength(1);
    expect(state().canUndo()).toBe(false);
    fixture.scenes = []; fixture.selected = null; await state().addSnapshot();
    await state().undo(); await state().redo();
    expect(fixture.scenes).toEqual([]);
    expect(fixture.selected).toBeNull();
  });
});
