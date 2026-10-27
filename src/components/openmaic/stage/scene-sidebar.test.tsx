import { useCallback, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneSidebar } from './scene-sidebar';

const mocks = vi.hoisted(() => ({
  setCurrentSceneId: vi.fn(),
  push: vi.fn(),
  state: {
    scenes: [
      { id: 'intro', title: '课程导入', type: 'slide', content: { type: 'slide', canvas: {} } },
      { id: 'explanation', title: '完整概念与教学解释', type: 'slide', content: { type: 'slide', canvas: {} } },
      { id: 'quiz', title: '随堂检测', type: 'quiz', content: { type: 'quiz', questions: [] } },
    ],
    currentSceneId: 'explanation',
    generatingOutlines: [],
    generationStatus: 'idle',
  },
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@openmaic/lib/store', () => ({
  useStageStore: Object.assign(() => ({ ...mocks.state, setCurrentSceneId: mocks.setCurrentSceneId }), {
    use: { failedOutlines: () => [] },
  }),
  useCanvasStore: { use: { viewportSize: () => 1000, viewportRatio: () => 16 / 9 } },
}));
vi.mock('@openmaic/lib/store/stage', () => ({ PENDING_SCENE_ID: 'pending' }));
vi.mock('@openmaic/lib/hooks/use-i18n', () => {
  const labels: Record<string, string> = {
    'generation.backToHome': '回到首页',
    'classroomComplete.reviewTitle': '学习回顾',
  };
  return { useI18n: () => ({ t: (key: string) => labels[key] ?? key }) };
});
vi.mock('@openmaic/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => <div>
  <button type="button">缩略图内播放</button>
  <a href="#thumbnail-preview">缩略图内链接</a>
</div> }));
vi.mock('@openmaic/components/slide-renderer/components/ThumbnailInteractive', () => ({ ThumbnailInteractive: () => null }));
vi.mock('@/hooks/use-display-scale', () => ({ useDisplayScale: () => 1 }));
vi.mock('@/components/brand/coteach-logo', () => ({ CoTeachLogoMark: () => null }));

let narrow = false;
const mediaListeners = new Set<() => void>();

function Harness({ initiallyCollapsed = true, onSceneSelect, onCollapseChange, isCourseComplete = false, conditionalOpener = false }: {
  initiallyCollapsed?: boolean;
  onSceneSelect?: (sceneId: string) => void;
  onCollapseChange?: (collapsed: boolean) => void;
  isCourseComplete?: boolean;
  conditionalOpener?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const handleCollapse = useCallback((next: boolean) => {
    onCollapseChange?.(next);
    setCollapsed(next);
  }, [onCollapseChange]);
  return <div>
    <SceneSidebar collapsed={collapsed} onCollapseChange={handleCollapse} onSceneSelect={onSceneSelect} isCourseComplete={isCourseComplete} />
    <div>
      {(!conditionalOpener || collapsed) && <button type="button" data-course-directory-toggle aria-expanded={!collapsed} onClick={() => setCollapsed(false)}>展开页面目录</button>}
      <button type="button">课程其他操作</button>
    </div>
  </div>;
}

function openDirectory() {
  const toggle = screen.getByRole('button', { name: '展开页面目录' });
  toggle.focus();
  fireEvent.click(toggle);
  return toggle;
}

beforeEach(() => {
  narrow = false;
  mediaListeners.clear();
  vi.clearAllMocks();
  vi.stubGlobal('matchMedia', () => ({
    get matches() { return narrow; },
    addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
  }));
  // jsdom has no layout; model visible controls so the dialog's focus trap can run.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    return (this.closest('[data-course-directory][aria-hidden="true"]') ? [] : [new DOMRect(0, 0, 100, 44)]) as unknown as DOMRectList;
  });
});

afterEach(async () => {
  cleanup();
  await act(async () => undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('scene directory review navigation', () => {
  it('mounts previews only while the directory is open', () => {
    render(<Harness />);
    expect(screen.queryByText('缩略图内链接')).toBeNull();
    openDirectory();
    expect(screen.getAllByText('缩略图内链接')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '收起页面目录' }));
    expect(screen.queryByText('缩略图内链接')).toBeNull();
  });

  it.each(['Enter', ' '])('selects an arbitrary page with %j while keeping the desktop navigation open', (key) => {
    const onSceneSelect = vi.fn();
    const onCollapseChange = vi.fn();
    render(<Harness initiallyCollapsed={false} onSceneSelect={onSceneSelect} onCollapseChange={onCollapseChange} />);
    const navigation = screen.getByRole('navigation', { name: '页面目录' });
    expect(navigation).not.toHaveAttribute('aria-modal');
    expect(within(navigation).getByRole('button', { name: '第 2 页：完整概念与教学解释' })).toHaveAttribute('aria-current', 'page');
    const target = within(navigation).getByRole('button', { name: '第 3 页：随堂检测' });
    target.focus();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    fireEvent(target, event);
    expect(event.defaultPrevented).toBe(true);
    expect(onSceneSelect).toHaveBeenCalledExactlyOnceWith('quiz');
    expect(mocks.setCurrentSceneId).not.toHaveBeenCalled();
    expect(onCollapseChange).not.toHaveBeenCalled();
    expect(navigation).toBeVisible();
  });

  it('falls back to the stage selection action when no caller selection callback is supplied', () => {
    render(<Harness initiallyCollapsed={false} />);
    fireEvent.click(screen.getByRole('button', { name: '第 1 页：课程导入' }));
    expect(mocks.setCurrentSceneId).toHaveBeenCalledExactlyOnceWith('intro');
  });

  it('keeps thumbnail controls out of directory navigation while the page selection stays accessible', () => {
    const onSceneSelect = vi.fn();
    render(<Harness initiallyCollapsed={false} onSceneSelect={onSceneSelect} />);
    const navigation = screen.getByRole('navigation', { name: '页面目录' });
    expect(within(navigation).queryByRole('button', { name: '缩略图内播放' })).toBeNull();
    expect(within(navigation).queryByRole('link')).toBeNull();
    const thumbnailControls = within(navigation).getAllByRole('button', { name: '缩略图内播放', hidden: true });
    expect(thumbnailControls).toHaveLength(2);
    thumbnailControls.forEach((control) => expect(control.closest('[inert]')).toHaveAttribute('aria-hidden', 'true'));
    const page = within(navigation).getByRole('button', { name: '第 1 页：课程导入' });
    page.focus();
    expect(page).toHaveFocus();
    fireEvent.keyDown(page, { key: 'Enter' });
    expect(onSceneSelect).toHaveBeenCalledExactlyOnceWith('intro');
  });

  it.each(['click', 'Enter', ' '])('closes the narrow dialog after %s selection and restores the directory opener', async (interaction) => {
    narrow = true;
    const onSceneSelect = vi.fn();
    const onCollapseChange = vi.fn();
    render(<Harness onSceneSelect={onSceneSelect} onCollapseChange={onCollapseChange} />);
    expect(screen.queryByRole('dialog', { name: '页面目录' })).toBeNull();
    const toggle = openDirectory();
    const dialog = screen.getByRole('dialog', { name: '页面目录' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: '第 2 页：完整概念与教学解释' })).toHaveFocus();
    const target = within(dialog).getByRole('button', { name: '第 1 页：课程导入' });
    if (interaction === 'click') fireEvent.click(target);
    else fireEvent.keyDown(target, { key: interaction });
    expect(onSceneSelect).toHaveBeenCalledExactlyOnceWith('intro');
    expect(onCollapseChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.queryByRole('dialog', { name: '页面目录' })).toBeNull();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('closes on Escape without selecting a page and returns keyboard focus to the opener', async () => {
    narrow = true;
    const onSceneSelect = vi.fn();
    render(<Harness onSceneSelect={onSceneSelect} />);
    const toggle = openDirectory();
    const current = screen.getByRole('button', { name: '第 2 页：完整概念与教学解释' });
    fireEvent.keyDown(current, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '页面目录' })).toBeNull();
    expect(onSceneSelect).not.toHaveBeenCalled();
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it.each(['selection', 'Escape'])('focuses the newly mounted opener after %s closes a dialog whose original opener was removed', async (closeAction) => {
    narrow = true;
    const onSceneSelect = vi.fn();
    render(<Harness conditionalOpener onSceneSelect={onSceneSelect} />);
    const originalToggle = openDirectory();
    expect(originalToggle).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '展开页面目录' })).toBeNull();
    const current = screen.getByRole('button', { name: '第 2 页：完整概念与教学解释' });
    expect(current).toHaveFocus();
    if (closeAction === 'selection') {
      fireEvent.click(screen.getByRole('button', { name: '第 1 页：课程导入' }));
      expect(onSceneSelect).toHaveBeenCalledExactlyOnceWith('intro');
    } else {
      fireEvent.keyDown(current, { key: 'Escape' });
      expect(onSceneSelect).not.toHaveBeenCalled();
    }
    expect(screen.queryByRole('dialog', { name: '页面目录' })).toBeNull();
    const replacementToggle = screen.getByRole('button', { name: '展开页面目录' });
    expect(replacementToggle).not.toBe(originalToggle);
    expect(replacementToggle).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(replacementToggle).toHaveFocus());
  });

  it('wraps Tab and Shift+Tab between the first and last controls in the narrow dialog', () => {
    narrow = true;
    render(<Harness />);
    openDirectory();
    const dialog = screen.getByRole('dialog', { name: '页面目录' });
    const controls = within(dialog).getAllByRole('button');
    const first = controls[0];
    const last = controls.at(-1)!;
    expect(last).toHaveAccessibleName('第 3 页：随堂检测');
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(first).toHaveFocus();
  });

  it('wraps keyboard focus past inert controls inside the final page thumbnail', () => {
    narrow = true;
    const original = mocks.state.scenes;
    mocks.state.scenes = original.slice(0, 2);
    try {
      render(<Harness />);
      openDirectory();
      const first = within(screen.getByRole('dialog', { name: '页面目录' })).getAllByRole('button')[0];
      const last = screen.getByRole('button', { name: '第 2 页：完整概念与教学解释' });
      first.focus();
      fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
      expect(last).toHaveFocus();
      fireEvent.keyDown(last, { key: 'Tab' });
      expect(first).toHaveFocus();
    } finally {
      mocks.state.scenes = original;
    }
  });

  it('returns to the completion review entry through the same narrow-screen selection path', async () => {
    narrow = true;
    const onSceneSelect = vi.fn();
    render(<Harness isCourseComplete onSceneSelect={onSceneSelect} />);
    const toggle = openDirectory();
    fireEvent.click(screen.getByRole('button', { name: /学习回顾/ }));
    expect(onSceneSelect).toHaveBeenCalledExactlyOnceWith('pending');
    expect(screen.queryByRole('dialog', { name: '页面目录' })).toBeNull();
    await waitFor(() => expect(toggle).toHaveFocus());
  });

  it('keeps focus inside an initially open narrow dialog after responsive setup settles', async () => {
    narrow = true;
    render(<Harness initiallyCollapsed={false} />);
    await act(async () => undefined);
    expect(screen.getByRole('dialog', { name: '页面目录' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: '第 2 页：完整概念与教学解释' })).toHaveFocus();
  });

  it('updates desktop navigation to a focused dialog at the narrow breakpoint without restoring focus outside it', async () => {
    render(<Harness initiallyCollapsed={false} />);
    expect(screen.getByRole('navigation', { name: '页面目录' })).toBeInTheDocument();
    screen.getByRole('button', { name: '课程其他操作' }).focus();
    await act(async () => {
      narrow = true;
      mediaListeners.forEach((listener) => listener());
    });
    expect(screen.getByRole('dialog', { name: '页面目录' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: '第 2 页：完整概念与教学解释' })).toHaveFocus();
  });
});
