import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Scene } from '@openmaic/lib/types/stage';

const mocks = vi.hoisted(() => ({ preload: vi.fn() }));
vi.mock('@openmaic/lib/edit/preload-editor', () => ({ preloadEditor: mocks.preload }));
vi.mock('./EditChromeRoot', () => ({
  EditChromeRoot: ({ scene, courseId }: { scene: Scene; courseId?: string }) => <div>编辑 {scene.title} {courseId}</div>,
}));

const scene = { id: 'slide-1', title: '课程第一页' } as Scene;

beforeEach(() => {
  vi.resetModules();
  mocks.preload.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('on-demand teacher editor', () => {
  it('does not preload authoring assets until the editor is requested', async () => {
    const { LazyEditChromeRoot } = await import('./LazyEditChromeRoot');
    expect(mocks.preload).not.toHaveBeenCalled();
    render(<LazyEditChromeRoot scene={scene} isEditable courseId="course-1" />);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载课堂编辑器');
    expect(await screen.findByText('编辑 课程第一页 course-1')).toBeInTheDocument();
    expect(mocks.preload).toHaveBeenCalledOnce();
  });

  it('shares an in-flight preload and lets a failed attempt retry', async () => {
    mocks.preload.mockRejectedValueOnce(new Error('chunk download failed'));
    const { LazyEditChromeRoot, preloadEditChrome } = await import('./LazyEditChromeRoot');
    const first = preloadEditChrome();
    expect(preloadEditChrome()).toBe(first);
    await expect(first).rejects.toThrow('chunk download failed');
    mocks.preload.mockRejectedValueOnce(new Error('still offline'));
    render(<LazyEditChromeRoot scene={scene} isEditable />);
    expect(await screen.findByRole('alert')).toHaveTextContent('检查网络后重试');
    fireEvent.click(screen.getByRole('button', { name: '重新加载编辑器' }));
    expect(await screen.findByText('编辑 课程第一页')).toBeInTheDocument();
    expect(mocks.preload).toHaveBeenCalledTimes(3);
  });

  it('bounds a stalled chunk wait and keeps a return-to-classroom action available', async () => {
    vi.useFakeTimers();
    let finishLate!: () => void;
    mocks.preload.mockImplementationOnce(() => new Promise<void>((resolve) => { finishLate = resolve; }));
    const { LazyEditChromeRoot } = await import('./LazyEditChromeRoot');
    const onExit = vi.fn();
    render(<LazyEditChromeRoot scene={scene} isEditable onToggleEditMode={onExit} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByRole('alert')).toHaveTextContent('加载超时');
    expect(screen.getByRole('button', { name: '重新加载编辑器' })).toBeEnabled();
    await act(async () => finishLate());
    expect(screen.getByRole('alert')).toHaveTextContent('加载超时');
    expect(screen.queryByText('编辑 课程第一页')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '返回课堂' }));
    expect(onExit).toHaveBeenCalledOnce();
  });
});
