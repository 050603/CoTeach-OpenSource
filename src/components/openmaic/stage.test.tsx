import { forwardRef, useImperativeHandle, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Stage } from './stage';

const mocks = vi.hoisted(() => ({
  preload: vi.fn(),
  teardown: vi.fn(),
  setMode: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
}));
const scene = { id: 'scene-1', title: '课程第一页' };
vi.mock('@openmaic/lib/store', () => ({
  useStageStore: (selector?: (state: unknown) => unknown) => {
    const state = {
      mode: 'playback', setMode: mocks.setMode, scenes: [scene], currentSceneId: scene.id,
      generatingOutlines: [], stage: { id: 'classroom-1' }, getCurrentScene: () => scene,
    };
    return selector ? selector(state) : state;
  },
}));
vi.mock('@openmaic/lib/config/feature-flags', () => ({ isMaicEditorEnabled: () => true }));
vi.mock('@openmaic/components/edit/LazyEditChromeRoot', () => ({
  preloadEditChrome: mocks.preload, LazyEditChromeRoot: () => <div>教师编辑器</div>,
}));
vi.mock('@openmaic/components/edit/PlaybackChromeRoot', () => ({
  PlaybackChromeRoot: forwardRef(function PlaybackMock({ onEnterProMode }: { onEnterProMode: () => void }, ref) {
    useImperativeHandle(ref, () => ({ teardown: mocks.teardown }));
    return <button type="button" onClick={onEnterProMode}>当前课堂</button>;
  }),
}));
vi.mock('@openmaic/components/edit/use-edit-mode-lock', () => ({
  useEditModeLock: () => ({ acquire: mocks.acquire, release: mocks.release }),
}));
vi.mock('@openmaic/components/edit/MultiTabEditConflictPrompt', () => ({ MultiTabEditConflictPrompt: () => null }));
vi.mock('@openmaic/components/scene-renderers/InteractiveIframeHost', () => ({ InteractiveIframeHost: () => null }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  motion: { div: ({ children }: { children: ReactNode }) => <div>{children}</div> },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preload.mockResolvedValue(undefined);
  mocks.teardown.mockResolvedValue(undefined);
  mocks.acquire.mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('student playback editor boundary', () => {
  it('does not request teacher editing code during student playback', () => {
    render(<Stage experience="student-course" />);
    expect(screen.getByRole('button', { name: '当前课堂' })).toBeInTheDocument();
    expect(mocks.preload).not.toHaveBeenCalled();
  });

  it('keeps playback running until the editor is ready and ignores duplicate entry clicks', async () => {
    let finishLoad!: () => void;
    mocks.preload.mockImplementationOnce(() => new Promise<void>((resolve) => { finishLoad = resolve; }));
    render(<Stage />);
    fireEvent.click(screen.getByRole('button', { name: '当前课堂' }));
    fireEvent.click(screen.getByRole('button', { name: '当前课堂' }));
    expect(screen.getByRole('status')).toHaveTextContent('正在加载课堂编辑器');
    expect(mocks.preload).toHaveBeenCalledOnce();
    expect(mocks.teardown).not.toHaveBeenCalled();
    await act(async () => finishLoad());
    expect(mocks.teardown).toHaveBeenCalledOnce();
    expect(mocks.setMode).toHaveBeenCalledExactlyOnceWith('edit');
  });

  it('releases the editing lock on a failed import and can retry without losing playback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.preload.mockRejectedValueOnce(new Error('network failure'));
    render(<Stage />);
    mocks.release.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '当前课堂' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('当前课堂仍可继续使用');
    expect(mocks.teardown).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.setMode).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(mocks.setMode).toHaveBeenCalledWith('edit'));
  });

  it('does not download editing assets when another tab holds the lock', () => {
    mocks.acquire.mockReturnValue(false);
    render(<Stage />);
    fireEvent.click(screen.getByRole('button', { name: '当前课堂' }));
    expect(mocks.preload).not.toHaveBeenCalled();
    expect(mocks.teardown).not.toHaveBeenCalled();
  });
});
