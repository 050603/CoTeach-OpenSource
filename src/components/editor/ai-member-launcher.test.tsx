import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, createRef, type ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiMemberLauncher } from './ai-member-launcher';
import { OpenPblEditorProvider, type AiMemberPhase } from './openpbl-editor-context';

vi.mock('next/image', () => ({ default: (props: ComponentProps<'img'>) => createElement('img', props) }));

afterEach(() => { window.getSelection()?.removeAllRanges(); });

it.each([false, true])('always opens the teammate sidebar with a document selection present=%s', selected => {
  const open = vi.fn();
  render(<OpenPblEditorProvider value={{ openAiMember: open }}>
    <p data-testid="document">已经写好的项目依据</p>
    <AiMemberLauncher />
  </OpenPblEditorProvider>);
  if (selected) {
    const range = document.createRange();
    range.selectNodeContents(screen.getByTestId('document'));
    window.getSelection()?.addRange(range);
  }
  const entry = screen.getByRole('button', { name: '唤醒 AI 组员' });
  expect(screen.getByText('点击唤醒组员')).toBeVisible();
  expect(entry).toHaveAttribute('aria-expanded', 'false');
  const avatar = entry.querySelector('img');
  expect(avatar).toHaveAttribute('src', '/openmaic/avatars/ai-teammate.webp');
  expect(avatar).toHaveAttribute('alt', '');
  expect(fireEvent.mouseDown(entry)).toBe(false);
  fireEvent.click(entry);
  expect(open).toHaveBeenCalledOnce();
  expect(window.getSelection()?.toString()).toBe(selected ? '已经写好的项目依据' : '');
});

it('provides source anchors, removes the launcher after opening, and restores it after closing', () => {
  const open = vi.fn();
  const avatarRef = createRef<HTMLSpanElement>();
  const launcherRef = createRef<HTMLButtonElement>();
  const entry = (phase: AiMemberPhase) => <OpenPblEditorProvider value={{ openAiMember: open, aiMember: {
    phase, panelId: 'teammate-panel', avatarRef, launcherRef,
  } }}><AiMemberLauncher /></OpenPblEditorProvider>;
  const view = render(entry('closed'));
  expect(launcherRef.current).toBe(screen.getByRole('button', { name: '唤醒 AI 组员' }));
  expect(avatarRef.current?.querySelector('img')).toBeTruthy();
  expect(launcherRef.current).toHaveAttribute('aria-controls', 'teammate-panel');
  view.rerender(entry('opening'));
  expect(launcherRef.current).toBeDisabled();
  expect(launcherRef.current).toHaveAttribute('aria-expanded', 'true');
  expect(avatarRef.current).not.toBeVisible();
  view.rerender(entry('open'));
  expect(screen.queryByRole('button', { name: '唤醒 AI 组员', hidden: true })).toBeNull();
  expect(launcherRef.current).toBeNull();
  expect(avatarRef.current).toBeNull();
  view.rerender(entry('closing'));
  expect(screen.queryByRole('button', { name: '唤醒 AI 组员' })).toBeNull();
  expect(launcherRef.current).toBeDisabled();
  expect(avatarRef.current?.querySelector('img')).toBeTruthy();
  if (launcherRef.current) fireEvent.click(launcherRef.current);
  expect(open).not.toHaveBeenCalled();
  view.rerender(entry('closed'));
  expect(screen.getByRole('button', { name: '唤醒 AI 组员' })).toBeVisible();
  expect(launcherRef.current).not.toBeDisabled();
});

it('omits the entry when the editor has no teammate sidebar callback', () => {
  render(<OpenPblEditorProvider value={{}}><AiMemberLauncher /></OpenPblEditorProvider>);
  expect(screen.queryByRole('button')).toBeNull();
});
