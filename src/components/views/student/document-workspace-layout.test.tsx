import { act, fireEvent, render, screen } from '@testing-library/react';
import { createElement, startTransition, useEffect, useLayoutEffect, useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiMemberLauncher } from '@/components/editor/ai-member-launcher';
import { OpenPblEditorProvider } from '@/components/editor/openpbl-editor-context';
import {
  DocumentWorkspaceLayout,
  documentWorkspaceSplit,
  useDocumentWorkspaceLayout,
  type DocumentWorkspaceController,
} from './document-workspace-layout';

const environment = vi.hoisted(() => ({ reducedMotion: false, imageLoaded: true, avatarMeasured: true, completeFlight: null as (() => void) | null }));
vi.mock('motion/react', () => ({
  useReducedMotion: () => environment.reducedMotion,
  motion: {
    div: ({ animate, initial, transition, onAnimationComplete, ...props }: ComponentProps<'div'> & {
      animate?: unknown;
      initial?: unknown;
      transition?: unknown;
      onAnimationComplete?: () => void;
    }) => {
      void animate; void initial; void transition;
      if (onAnimationComplete) environment.completeFlight = onAnimationComplete;
      return <div {...props} />;
    },
  },
}));
vi.mock('next/image', () => ({
  default: ({ fill, ...props }: ComponentProps<'img'> & { fill?: boolean }) => {
    void fill;
    return createElement('img', props);
  },
}));

let workspaceWidth = 1280;
let workspaceTop = 100;
let currentWorkspace: DocumentWorkspaceController;
let editorMounts = 0;
let memberMounts = 0;
const resizeCallbacks = new Set<ResizeObserverCallback>();
const storageKey = (studentId: string) => `openpbl:document-workspace:split:v1:${encodeURIComponent(studentId)}`;

function Editor({ workspace }: { workspace: DocumentWorkspaceController }) {
  const [draft, setDraft] = useState('尚未保存的文档');
  useEffect(() => { editorMounts += 1; }, []);
  return <OpenPblEditorProvider value={{ aiMember: workspace.aiMemberControls, openAiMember: workspace.openMember }}>
    <AiMemberLauncher />
    <textarea aria-label="文档草稿" onChange={event => setDraft(event.target.value)} value={draft} />
    <p contentEditable data-slate-editor="true" data-testid="selected-document-text" suppressContentEditableWarning tabIndex={0}>学生已经写好的项目依据与观察记录。</p>
  </OpenPblEditorProvider>;
}

function Member({ workspace: { aiMemberControls: { panelId }, memberHeadingRef, memberAvatarRef, closeMember, revealDocument } }: { workspace: DocumentWorkspaceController }) {
  const [draft, setDraft] = useState('');
  useEffect(() => { memberMounts += 1; }, []);
  return <section aria-label="组员工作区" id={panelId}>
    <h2 ref={memberHeadingRef} tabIndex={-1}>项目组员</h2>
    <span ref={memberAvatarRef}>{createElement('img', { alt: '', src: '/openmaic/avatars/ai-teammate.webp' })}</span>
    <div data-testid="message-scroll">此前的对话内容</div>
    <textarea aria-label="组员草稿" onChange={event => setDraft(event.target.value)} value={draft} />
    <button onClick={closeMember}>收起组员</button>
    <button onClick={revealDocument}>查看文档</button>
  </section>;
}

function Harness({ studentId = 'student-1' }: { studentId?: string }) {
  const workspace = useDocumentWorkspaceLayout(studentId, 0);
  useLayoutEffect(() => { currentWorkspace = workspace; });
  return <DocumentWorkspaceLayout controller={workspace} editor={<Editor workspace={workspace} />} member={<Member workspace={workspace} />} />;
}

function resize(width: number, windowEvent = false) {
  workspaceWidth = width;
  act(() => {
    if (windowEvent) window.dispatchEvent(new Event('resize'));
    else resizeCallbacks.forEach(callback => callback([], {} as ResizeObserver));
  });
}

function finishFlight() {
  const flight = document.querySelector('[data-ai-member-flight]');
  if (flight) act(() => { environment.completeFlight?.(); });
  act(() => { vi.advanceTimersByTime(20); });
}

function openMember() {
  fireEvent.click(screen.getByRole('button', { name: '唤醒 AI 组员' }));
  finishFlight();
}

beforeEach(() => {
  vi.useFakeTimers();
  environment.reducedMotion = false;
  environment.imageLoaded = true;
  environment.avatarMeasured = true;
  environment.completeFlight = null;
  workspaceWidth = 1280;
  workspaceTop = 100;
  editorMounts = 0;
  memberMounts = 0;
  resizeCallbacks.clear();
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe() { resizeCallbacks.add(this.callback); }
    disconnect() { resizeCallbacks.delete(this.callback); }
    unobserve() {}
  });
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  });
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockImplementation(() => environment.imageLoaded ? 64 : 0);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.matches('[data-document-workspace]') || this.parentElement?.matches('[data-document-workspace]')) {
      return DOMRect.fromRect({ x: 40, y: workspaceTop, width: workspaceWidth, height: 600 });
    }
    if (this.tagName === 'SPAN' && this.querySelector('img') && environment.avatarMeasured) {
      return DOMRect.fromRect({ x: this.closest('[data-ai-member-pane]') ? workspaceWidth - 220 : 48, y: 110, width: 32, height: 32 });
    }
    return DOMRect.fromRect();
  });
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('document workspace readable columns', () => {
  it('retains an operable surface when a short viewport initially places the workspace below the fold', () => {
    workspaceWidth = 700;
    workspaceTop = 260;
    environment.reducedMotion = true;
    vi.stubGlobal('innerHeight', 180);
    vi.stubGlobal('visualViewport', undefined);
    const view = render(<Harness />);
    const frame = view.container.querySelector('[data-document-workspace]');
    expect(frame).toHaveStyle({ height: '160px' });
    expect(screen.getByRole('button', { name: '唤醒 AI 组员' })).toBeVisible();
    expect(screen.getByRole('button', { name: '唤醒 AI 组员' })).toBeEnabled();
    openMember();
    expect(screen.getByRole('region', { name: '组员工作区' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '收起组员' }));
    finishFlight();
    expect(screen.getByRole('button', { name: '唤醒 AI 组员' })).toBeVisible();
    expect(screen.getByLabelText('文档草稿')).toHaveValue('尚未保存的文档');
  });

  it('switches at the combined minimum width including the draggable separator', () => {
    expect(documentWorkspaceSplit(727, 2 / 3)).toBeNull();
    expect(documentWorkspaceSplit(728, 2 / 3)).toEqual({ editor: 400, member: 320, available: 720 });
  });

  it.each([728, 768, 1024, 1440])('keeps both columns readable at %ipx even for extreme preferences', width => {
    for (const ratio of [0.01, 2 / 3, 0.99]) {
      const split = documentWorkspaceSplit(width, ratio)!;
      expect(split.editor).toBeGreaterThanOrEqual(400);
      expect(split.member).toBeGreaterThanOrEqual(320);
      expect(split.editor + split.member + 8).toBe(width);
    }
  });

  it('adjusts with the keyboard, exposes reachable limits and resets the preferred ratio', () => {
    render(<Harness />);
    openMember();
    const divider = screen.getByRole('separator', { name: '调整文档与 AI 组员的宽度' });
    fireEvent.keyDown(divider, { key: 'ArrowLeft' });
    expect(Number(localStorage.getItem(storageKey('student-1')))).toBeCloseTo(2 / 3 - 0.02);
    fireEvent.keyDown(divider, { key: 'ArrowRight' });
    expect(Number(localStorage.getItem(storageKey('student-1')))).toBeCloseTo(2 / 3);
    fireEvent.keyDown(divider, { key: 'Home' });
    expect(currentWorkspace.split?.editor).toBe(400);
    expect(Number(divider.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(Number(divider.getAttribute('aria-valuemin')));
    fireEvent.keyDown(divider, { key: 'End' });
    expect(currentWorkspace.split?.member).toBeCloseTo(320);
    expect(Number(divider.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(divider.getAttribute('aria-valuemax')));
    fireEvent.doubleClick(divider);
    expect(Number(localStorage.getItem(storageKey('student-1')))).toBeCloseTo(2 / 3);
    expect(divider).toHaveAttribute('aria-valuetext', '文档 67%，组员 33%');
  });

  it('resizes immediately while dragging and persists only when the drag finishes', () => {
    render(<Harness />);
    openMember();
    const divider = screen.getByRole('separator');
    const captured = new Set<number>();
    const release = vi.fn((id: number) => captured.delete(id));
    Object.defineProperties(divider, {
      setPointerCapture: { value: (id: number) => captured.add(id) },
      hasPointerCapture: { value: (id: number) => captured.has(id) },
      releasePointerCapture: { value: release },
    });
    fireEvent.pointerDown(divider, { pointerId: 7, button: 0, clientX: 800 });
    fireEvent.pointerMove(divider, { pointerId: 7, clientX: 40 + 4 + 1272 * 0.55 });
    expect(currentWorkspace.dragging).toBe(true);
    expect(currentWorkspace.split!.editor / currentWorkspace.split!.available).toBeCloseTo(0.55);
    expect(localStorage.getItem(storageKey('student-1'))).toBeNull();
    fireEvent.pointerMove(divider, { pointerId: 7, clientX: 0 });
    expect(currentWorkspace.split?.editor).toBe(400);
    fireEvent.pointerMove(divider, { pointerId: 7, clientX: 3000 });
    expect(currentWorkspace.split?.member).toBeCloseTo(320);
    fireEvent.pointerUp(divider, { pointerId: 7, clientX: 40 + 4 + 1272 * 0.6 });
    expect(currentWorkspace.dragging).toBe(false);
    expect(Number(localStorage.getItem(storageKey('student-1')))).toBeCloseTo(0.6);
    expect(release).toHaveBeenCalledWith(7);
  });

  it('restores local preferences separately for each student identity', () => {
    localStorage.setItem(storageKey('student / A'), '0.59');
    localStorage.setItem(storageKey('student / B'), '0.7');
    const view = render(<Harness studentId="student / A" />);
    openMember();
    expect(currentWorkspace.split!.editor / currentWorkspace.split!.available).toBeCloseTo(0.59);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    view.rerender(<Harness studentId="student / B" />);
    act(() => { vi.advanceTimersByTime(20); });
    expect(currentWorkspace.split!.editor / currentWorkspace.split!.available).toBeCloseTo(0.7);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    view.rerender(<Harness studentId="student / A" />);
    act(() => { vi.advanceTimersByTime(20); });
    expect(currentWorkspace.split!.editor / currentWorkspace.split!.available).toBeCloseTo(0.61);
    expect(Number(localStorage.getItem(storageKey('student / B')))).toBeCloseTo(0.68);
  });

  it('temporarily clamps or switches narrow layouts without overwriting the saved ratio', () => {
    workspaceWidth = 1440;
    localStorage.setItem(storageKey('student-1'), '0.7');
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const view = render(<Harness />);
    openMember();
    resize(728);
    expect(currentWorkspace.split).toEqual({ editor: 400, member: 320, available: 720 });
    expect(screen.getByRole('separator')).toBeVisible();
    resize(727);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(view.container.querySelector('[data-document-pane]')).not.toBeVisible();
    expect(screen.getByRole('region', { name: '组员工作区' })).toBeVisible();
    resize(1440);
    expect(currentWorkspace.split!.editor / currentWorkspace.split!.available).toBeCloseTo(0.7);
    expect(view.container.querySelector('[data-document-pane]')).toBeVisible();
    expect(localStorage.getItem(storageKey('student-1'))).toBe('0.7');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('document workspace lifecycle and avatar handoff', () => {
  it('keeps both panes mounted and retains drafts, selection and scrolling through narrow switches', () => {
    workspaceWidth = 700;
    const view = render(<Harness />);
    const documentDraft = screen.getByLabelText('文档草稿');
    const memberDraft = screen.getByLabelText('组员草稿');
    const documentPane = view.container.querySelector<HTMLElement>('[data-document-pane]')!;
    const messageScroll = screen.getByTestId('message-scroll');
    fireEvent.change(documentDraft, { target: { value: '尚未保存的补充依据' } });
    fireEvent.change(memberDraft, { target: { value: '请核对我的观察数据' } });
    documentPane.scrollTop = 240;
    messageScroll.scrollTop = 85;
    const text = screen.getByTestId('selected-document-text').firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 8);
    window.getSelection()?.addRange(range);
    const selected = window.getSelection()?.toString();
    openMember();
    expect(documentPane).not.toBeVisible();
    expect(screen.getByLabelText('文档草稿')).toBe(documentDraft);
    expect(screen.getByLabelText('组员草稿')).toBe(memberDraft);
    expect(screen.getByRole('heading', { name: '项目组员' })).toHaveFocus();
    documentPane.scrollTop = 0;
    window.getSelection()?.removeAllRanges();
    fireEvent.click(screen.getByRole('button', { name: '查看文档' }));
    finishFlight();
    expect(documentPane).toBeVisible();
    expect(documentPane.scrollTop).toBe(240);
    expect(window.getSelection()?.toString()).toBe(selected);
    expect(documentDraft).toHaveValue('尚未保存的补充依据');
    expect(screen.getByTestId('selected-document-text')).toHaveFocus();
    openMember();
    expect(memberDraft).toHaveValue('请核对我的观察数据');
    expect(messageScroll.scrollTop).toBe(85);
    fireEvent.click(screen.getByRole('button', { name: '收起组员' }));
    finishFlight();
    expect(editorMounts).toBe(1);
    expect(memberMounts).toBe(1);
  });

  it('uses one flying avatar, ignores repeated toggles, and settles on viewport interruption', () => {
    const view = render(<Harness />);
    act(() => { currentWorkspace.openMember(); currentWorkspace.openMember(); currentWorkspace.closeMember(); });
    expect(currentWorkspace.phase).toBe('opening');
    expect(document.querySelectorAll('[data-ai-member-flight="opening"]')).toHaveLength(1);
    expect(view.container.querySelector('[data-ai-member-flight]')).toBeNull();
    expect(screen.getByRole('button', { name: '唤醒 AI 组员' })).toBeDisabled();
    resize(1100, true);
    expect(currentWorkspace.phase).toBe('open');
    expect(document.querySelector('[data-ai-member-flight]')).toBeNull();
    act(() => { currentWorkspace.closeMember(); currentWorkspace.closeMember(); currentWorkspace.openMember(); });
    expect(currentWorkspace.phase).toBe('closing');
    expect(document.querySelectorAll('[data-ai-member-flight="closing"]')).toHaveLength(1);
    resize(1000, true);
    finishFlight();
    expect(currentWorkspace.phase).toBe('closed');
    expect(document.querySelector('[data-ai-member-flight]')).toBeNull();
    expect(screen.getByRole('button', { name: '唤醒 AI 组员' })).toHaveFocus();
  });

  it.each(['opening', 'closing'] as const)('waits for the %s commit before restoring focus when a frame runs during concurrent work', transition => {
    render(<Harness />);
    if (transition === 'closing') {
      openMember();
      fireEvent.click(screen.getByRole('button', { name: '收起组员' }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: '唤醒 AI 组员' }));
    }
    const target = transition === 'opening'
      ? screen.getByRole('heading', { name: '项目组员' })
      : document.querySelector<HTMLButtonElement>('button[aria-label="唤醒 AI 组员"]')!;
    const focus = vi.spyOn(target, 'focus');
    if (transition === 'closing') expect(target).toBeDisabled();
    act(() => {
      startTransition(() => { currentWorkspace.completeTransition(); });
      // React has not committed the stable phase inside this act scope. The
      // former completion callback could already consume its focus frame here.
      vi.advanceTimersByTime(20);
      expect(currentWorkspace.phase).toBe(transition);
      expect(focus).not.toHaveBeenCalled();
    });
    expect(currentWorkspace.phase).toBe(transition === 'opening' ? 'open' : 'closed');
    if (transition === 'closing') expect(target).toBeEnabled();
    act(() => { vi.advanceTimersByTime(20); });
    expect(target).toBeVisible();
    expect(target).toHaveFocus();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('finishes even when the browser never reports animation completion', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '唤醒 AI 组员' }));
    expect(currentWorkspace.phase).toBe('opening');
    act(() => { vi.advanceTimersByTime(500); });
    expect(currentWorkspace.phase).toBe('open');
    expect(document.querySelector('[data-ai-member-flight]')).toBeNull();
  });

  it.each(['reduced motion', 'unloaded avatar', 'unmeasured avatar'] as const)('keeps open and close functional with %s', condition => {
    environment.reducedMotion = condition === 'reduced motion';
    environment.imageLoaded = condition !== 'unloaded avatar';
    environment.avatarMeasured = condition !== 'unmeasured avatar';
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '唤醒 AI 组员' }));
    expect(currentWorkspace.phase).toBe('open');
    expect(document.querySelector('[data-ai-member-flight]')).toBeNull();
    finishFlight();
    expect(screen.getByRole('heading', { name: '项目组员' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '收起组员' }));
    expect(currentWorkspace.phase).toBe('closed');
    finishFlight();
    expect(screen.getByRole('button', { name: '唤醒 AI 组员' })).toHaveFocus();
  });
});
