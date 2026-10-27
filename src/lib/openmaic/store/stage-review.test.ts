import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStageStore } from './stage';
import { createBlankSlideScene } from '@openmaic/lib/edit/slide-defaults';

const storage = vi.hoisted(() => ({ saveStageData: vi.fn(async () => undefined) }));
vi.mock('@openmaic/lib/utils/stage-storage', () => storage);

beforeEach(() => {
  vi.useFakeTimers();
  useStageStore.getState().clearStore();
  storage.saveStageData.mockClear();
});
afterEach(() => {
  vi.clearAllTimers();
  useStageStore.getState().clearStore();
  vi.useRealTimers();
});

describe('review storage isolation', () => {
  it('keeps review navigation in memory and restores persistence only after clearing review state', async () => {
    useStageStore.setState({ persistenceReadOnly: true });
    useStageStore.getState().setStage({ id: 'review-course', name: '已结束课程', createdAt: 1, updatedAt: 1 });
    const first = createBlankSlideScene('review-course', '第一页', 0);
    const second = createBlankSlideScene('review-course', '第二页', 1);
    useStageStore.getState().setScenes([first, second]);
    useStageStore.getState().setCurrentSceneId(second.id);
    expect(useStageStore.getState().currentSceneId).toBe(second.id);
    expect(await useStageStore.getState().saveToStorage()).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(storage.saveStageData).not.toHaveBeenCalled();

    // A pending debounce from the last review page must see an empty store.
    useStageStore.getState().setCurrentSceneId(first.id);
    useStageStore.getState().clearStore();
    expect(useStageStore.getState().persistenceReadOnly).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(storage.saveStageData).not.toHaveBeenCalled();

    useStageStore.getState().setStage({ id: 'live-course', name: '学习中的课程', createdAt: 1, updatedAt: 1 });
    const live = createBlankSlideScene('live-course', '学习页面', 0);
    useStageStore.getState().setScenes([live]);
    await vi.advanceTimersByTimeAsync(600);
    expect(storage.saveStageData).toHaveBeenCalledExactlyOnceWith('live-course', expect.objectContaining({ currentSceneId: live.id }));
  });
});
