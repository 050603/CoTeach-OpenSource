import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './use-theme';

function ThemeControl() {
  const { resolvedTheme, setTheme } = useTheme();
  return <button onClick={() => setTheme('dark')}>{resolvedTheme}</button>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('document theme ownership', () => {
  it('restores the light host page after leaving a dark classroom', () => {
    localStorage.setItem('theme', 'dark');
    const classroom = render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    expect(document.documentElement).toHaveClass('dark');
    classroom.unmount();
    expect(document.documentElement).not.toHaveClass('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('restores an existing host theme after a light resource player closes', () => {
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'light');
    const classroom = render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    expect(document.documentElement).not.toHaveClass('dark');
    classroom.unmount();
    expect(document.documentElement).toHaveClass('dark');
  });

  it('keeps another mounted resource player themed when the earlier player closes', () => {
    localStorage.setItem('theme', 'dark');
    const first = render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    const second = render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    first.unmount();
    expect(document.documentElement).toHaveClass('dark');
    second.unmount();
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('restores the remaining player when an overlapping light player closes', () => {
    localStorage.setItem('theme', 'dark');
    const first = render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    localStorage.setItem('theme', 'light');
    const second = render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    expect(document.documentElement).not.toHaveClass('dark');
    second.unmount();
    expect(document.documentElement).toHaveClass('dark');
    first.unmount();
    expect(document.documentElement).not.toHaveClass('dark');
  });
});

describe('classroom theme with restricted browser storage', () => {
  it('renders the classroom when preference reads are blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError'); });
    render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    expect(screen.getByRole('button', { name: 'light' })).toBeVisible();
  });

  it('keeps theme controls working when preference writes are blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'QuotaExceededError'); });
    render(<ThemeProvider><ThemeControl /></ThemeProvider>);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button', { name: 'dark' })).toBeVisible();
    expect(document.documentElement).toHaveClass('dark');
  });
});
