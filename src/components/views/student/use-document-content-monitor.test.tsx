import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundedFetch } from '@/lib/browser/bounded-fetch';
import type { ContentMonitorEvent } from '@/lib/project-practice/content-monitor-contract';
import { useDocumentContentMonitor } from './use-document-content-monitor';

vi.mock('@/lib/browser/bounded-fetch', () => ({ boundedFetch: vi.fn() }));
const fetchMock = vi.mocked(boundedFetch);
const text = '这是学生粘贴的完整项目核心方案与分析。'.repeat(30);
const base = { courseId: 'course-a', studentId: 'student-a', enabled: true, documentHtml: `<p>${text}</p>` };
const reminder = (id = 'event-a'): ContentMonitorEvent => ({
  id, studentId: 'student-a', studentName: '同学', createdAt: '2026-10-25T00:00:00.000Z',
  pastedCharacters: text.length, excerpt: text.slice(0, 50), requirementQuote: '请比较方案并提出结论。',
  reason: '粘贴内容包含完整分析。', status: 'pending', contentState: 'unknown', history: [],
});
const response = (value: unknown) => Response.json(value);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); fetchMock.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

describe('student paste monitoring lifecycle', () => {
  it('does no work when disabled and ordinary document changes never submit checks', async () => {
    fetchMock.mockResolvedValue(response({ events: [] }));
    const view = renderHook(props => useDocumentContentMonitor(props), { initialProps: { ...base, enabled: false } });
    act(() => view.result.current.onPaste({ text, beforeText: '' }));
    view.rerender({ ...base, enabled: false, documentHtml: `<p>编辑${text}</p>` });
    await tick(); expect(fetchMock).not.toHaveBeenCalled();
    view.rerender({ ...base, enabled: true }); await tick();
    view.rerender({ ...base, enabled: true, documentHtml: `<p>AI 插入${text}</p>` }); await tick();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it('posts a real paste after the editor updates, then reminds and acknowledges once', async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        return response({ requestId: body.requestId, status: 'flagged', event: reminder() });
      }
      if (String(url).includes('/events?')) return response({ events: [] });
      return response({ event: { ...reminder(), acknowledgedAt: '2026-10-25T00:00:01.000Z' } });
    });
    const view = renderHook(props => useDocumentContentMonitor(props), { initialProps: { ...base, documentHtml: '<p>原文</p>' } });
    await tick();
    act(() => view.result.current.onPaste({ text, beforeText: '原文', blockId: 'block-a' }));
    view.rerender(base); await tick();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(post[1]!.body as string)).toMatchObject({ courseId: 'course-a', documentText: `${text}\n`, fragments: [{ text, beforeText: '原文', blockId: 'block-a' }] });
    expect(view.result.current.event?.id).toBe('event-a');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    act(() => view.result.current.dismiss()); await tick(); expect(view.result.current.event).toBeNull();
    act(() => view.result.current.onPaste({ text, beforeText: '' })); await tick();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('retries an ambiguous post with the same request identifier', async () => {
    let posts = 0;
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method !== 'POST') return response({ events: [] });
      if (++posts === 1) throw new TypeError('offline');
      const body = JSON.parse(init.body as string);
      return response({ requestId: body.requestId, status: 'clear' });
    });
    const view = renderHook(() => useDocumentContentMonitor(base)); await tick();
    act(() => view.result.current.onPaste({ text, beforeText: '' })); await tick(); await tick(2_000);
    const payloads = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => JSON.parse(init!.body as string));
    expect(payloads).toHaveLength(2); expect(payloads[0].requestId).toBe(payloads[1].requestId);
    expect(view.result.current.event).toBeNull();
  });

  it('restores only current unacknowledged personal reminders and persists the shown identity', async () => {
    const events = [reminder(), { ...reminder('other-student'), studentId: 'student-b' }, { ...reminder('already-read'), acknowledgedAt: '2026-10-25' }, { ...reminder('removed'), excerpt: '已删除片段', contentState: 'removed' }, { ...reminder('dismissed'), status: 'dismissed' }];
    fetchMock.mockImplementation(async (_url, init) => response(init?.method ? {} : { events }));
    const first = renderHook(() => useDocumentContentMonitor(base)); await tick();
    expect(first.result.current.event?.id).toBe('event-a'); first.unmount();
    const second = renderHook(() => useDocumentContentMonitor(base)); await tick();
    expect(second.result.current.event).toBeNull();
  });

  it('fences late responses after a classroom change or teacher disable', async () => {
    const read = deferred<Response>();
    fetchMock.mockImplementation(async url => String(url).includes('course-a') ? read.promise : response({ events: [] }));
    const view = renderHook(props => useDocumentContentMonitor(props), { initialProps: base });
    view.rerender({ ...base, courseId: 'course-b' }); await tick();
    await act(async () => read.resolve(response({ events: [reminder()] })));
    expect(view.result.current.event).toBeNull();
    act(() => view.result.current.onPaste({ text, beforeText: '' }));
    view.rerender({ ...base, courseId: 'course-b', enabled: false }); await tick();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('saves optional explanations separately and retains the reminder when saving fails', async () => {
    let fail = true;
    fetchMock.mockImplementation(async (_url, init) => {
      if (!init?.method) return response({ events: [reminder()] });
      const body = JSON.parse(init.body as string);
      if (body.action === 'explain' && fail) return new Response(null, { status: 503 });
      return response({ event: { ...reminder(), acknowledgedAt: '2026-10-25T00:00:01.000Z', studentSource: body.source, studentExplanation: body.explanation } });
    });
    const view = renderHook(() => useDocumentContentMonitor(base)); await tick();
    await expect(view.result.current.explain('own-draft', '这是我之前写的草稿。')).rejects.toThrow('暂未保存');
    expect(view.result.current.event).not.toBeNull(); fail = false;
    await act(async () => view.result.current.explain('own-draft', '这是我之前写的草稿。'));
    expect(view.result.current.event).toBeNull();
  });

  it('does not accept an HTTP success with a wrong explanation receipt', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (!init?.method) return response({ events: [reminder()] });
      return response({ event: { ...reminder(), acknowledgedAt: '2026-10-25T00:00:01.000Z' } });
    });
    const view = renderHook(() => useDocumentContentMonitor(base)); await tick();
    await expect(view.result.current.explain('quotation', '这段话来自已注明的资料。')).rejects.toThrow('尚未确认保存');
    expect(view.result.current.event?.id).toBe('event-a');
  });

  it('rechecks queued excerpts against edits and dismisses the actual visible event', async () => {
    const second = { ...reminder('event-b'), excerpt: '第二段核心方案' };
    const third = { ...reminder('event-c'), excerpt: '第三段核心方案' };
    fetchMock.mockImplementation(async (_url, init) => response(init?.method ? {} : { events: [reminder(), second, third] }));
    const view = renderHook(props => useDocumentContentMonitor(props), { initialProps: { ...base, documentHtml: `<p>${text}第二段核心方案第三段核心方案</p>` } });
    await tick(); expect(view.result.current.event?.id).toBe('event-a');
    view.rerender({ ...base, documentHtml: `<p>${text}第三段核心方案</p>` });
    act(() => view.result.current.dismiss()); await tick(); expect(view.result.current.event?.id).toBe('event-c');
    act(() => view.result.current.dismiss()); await tick(); expect(view.result.current.event).toBeNull();
  });

  it('removes processed queued events on refresh but preserves the displayed dialog after its own ack', async () => {
    const queued = [reminder('event-b'), reminder('event-c'), reminder('event-d'), reminder('event-e')];
    let events = [reminder(), ...queued];
    fetchMock.mockImplementation(async (_url, init) => {
      if (!init?.method) return response({ events });
      return response({ event: { ...reminder(), acknowledgedAt: '2026-10-25T00:00:01.000Z' } });
    });
    const view = renderHook(() => useDocumentContentMonitor(base)); await tick();
    expect(view.result.current.event?.id).toBe('event-a');
    events = [
      { ...reminder(), acknowledgedAt: '2026-10-25T00:00:01.000Z' },
      { ...queued[0], status: 'dismissed' },
      { ...queued[1], status: 'reviewed' },
      { ...queued[2], acknowledgedAt: '2026-10-25T00:00:02.000Z' },
      { ...queued[3], reason: '已更新的任务关系说明。' },
    ];
    await tick(20_000);
    expect(view.result.current.event?.id).toBe('event-a');
    act(() => view.result.current.dismiss()); await tick();
    expect(view.result.current.event).toMatchObject({ id: 'event-e', reason: '已更新的任务关系说明。' });
    act(() => view.result.current.dismiss()); await tick(); expect(view.result.current.event).toBeNull();
  });

  it('submits the applied Plate snapshot even when the outer HTML still contains the old draft', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method !== 'POST') return response({ events: [] });
      return response({ requestId: JSON.parse(init.body as string).requestId, status: 'clear' });
    });
    const view = renderHook(() => useDocumentContentMonitor({ ...base, documentHtml: '<p>旧草稿</p>' })); await tick();
    const documentText = `旧草稿\n${text}`;
    act(() => view.result.current.onPaste({ text, beforeText: '旧草稿', documentText })); await tick();
    const submitted = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(submitted[1]!.body as string).documentText).toBe(documentText);
  });

  it('keeps existing core answers as context only when pasting mixed old and new content', async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method !== 'POST') return response({ events: [] });
      return response({ requestId: JSON.parse(init.body as string).requestId, status: 'clear' });
    });
    const existingCore = '已有的核心结论'.repeat(80), background = '新增背景资料'.repeat(50);
    const documentText = `${existingCore}\n${background}`;
    const view = renderHook(() => useDocumentContentMonitor({ ...base, documentHtml: `<p>${existingCore}</p>` })); await tick();
    act(() => view.result.current.onPaste({ text: documentText, beforeText: existingCore, documentText })); await tick();
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    const body = JSON.parse(request[1]!.body as string);
    expect(body.fragments.map((fragment: { text: string }) => fragment.text)).toEqual([background]);
    expect(body.documentText).toBe(documentText);
  });

  it('finds a reminder excerpt after Plate has rendered numbered Markdown as list text', async () => {
    const excerpt = '1. 先收集原始数据并说明采样过程。\n2. 再比较方案的效果和适用条件。';
    fetchMock.mockImplementation(async (_url, init) => response(init?.method ? {} : { events: [{ ...reminder(), excerpt }] }));
    const view = renderHook(() => useDocumentContentMonitor({ ...base, documentHtml: '<p>先收集原始数据并说明采样过程。</p><p>再比较方案的效果和适用条件。</p>' }));
    await tick();
    expect(view.result.current.event?.id).toBe('event-a');
  });
});
