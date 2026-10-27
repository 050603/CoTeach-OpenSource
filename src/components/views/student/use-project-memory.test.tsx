import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useEffect } from 'react';
import type { ProjectMemoryEntry } from '@/lib/ai-collaboration/project-support-types';
import { useProjectMemory } from './use-project-memory';

const entry = (content: string): ProjectMemoryEntry => ({ id: content, content, kind: 'open-question', stageKey: 'make', sourceMessageIds: [], createdAt: '', updatedAt: '' });
const input = { courseId: 'course', studentId: 'student', enabled: true };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('project memory read ownership', () => {
  it('keeps immediate reading as the default and exposes a real refresh in deferred mode', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ memories: [entry('default')] })); vi.stubGlobal('fetch', fetch);
    const first = renderHook(() => useProjectMemory(input));
    await act(async () => undefined);
    expect(first.result.current.memories).toEqual([entry('default')]); expect(fetch).toHaveBeenCalledTimes(1);
    first.unmount(); fetch.mockClear();
    const second = renderHook(() => useProjectMemory({ ...input, initialRead: 'deferred' }));
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(Response.json({ memories: [entry('fallback')] }));
    await act(async () => second.result.current.refresh());
    expect(second.result.current.memories).toEqual([entry('fallback')]); expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('fences old reads, replacements and mutation acknowledgements across A -> B -> A', async () => {
    const read = deferred<Response>(), mutation = deferred<Response>();
    const fetch = vi.fn().mockReturnValueOnce(read.promise).mockReturnValueOnce(mutation.promise); vi.stubGlobal('fetch', fetch);
    const view = renderHook(({ courseId }) => useProjectMemory({ ...input, courseId, initialRead: 'deferred' }), { initialProps: { courseId: 'A' } });
    const oldReplace = view.result.current.replaceMemories;
    let pending!: Promise<void>;
    act(() => { pending = view.result.current.refresh(); view.result.current.updateMemory('memory', 'old'); });
    view.rerender({ courseId: 'B' }); view.rerender({ courseId: 'A' });
    act(() => view.result.current.replaceMemories([entry('current')]));
    await act(async () => { read.resolve(Response.json({ memories: [entry('old read')] })); mutation.resolve(Response.json({ memories: [entry('old mutation')] })); await pending; oldReplace([entry('old history')]); });
    expect(view.result.current.memories).toEqual([entry('current')]);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('aborts a parent-cancelled refresh and ignores a late body after unmount', async () => {
    const body = deferred<unknown>(); const fetch = vi.fn().mockResolvedValue({ ok: true, json: () => body.promise }); vi.stubGlobal('fetch', fetch);
    const view = renderHook(() => useProjectMemory({ ...input, initialRead: 'deferred' }));
    const controller = new AbortController(); let pending!: Promise<void>;
    act(() => { pending = view.result.current.refresh(controller.signal); });
    await act(async () => undefined); controller.abort(); view.unmount();
    await act(async () => { body.resolve({ memories: [entry('late')] }); await pending; });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(view.result.current.memories).toEqual([]);
  });

  it('preserves update/delete/clear requests and results without an initial GET', async () => {
    const fetch = vi.fn().mockImplementation(async (_url, init) => Response.json({ memories: init.method === 'DELETE' ? [] : [entry(JSON.parse(init.body).action)] })); vi.stubGlobal('fetch', fetch);
    const view = renderHook(() => useProjectMemory({ ...input, initialRead: 'deferred' }));
    await act(async () => view.result.current.updateMemory('memory', 'edited'));
    expect(view.result.current.memories).toEqual([entry('update')]);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: 'update', courseId: 'course', studentId: 'student', memoryId: 'memory', content: 'edited' });
    await act(async () => view.result.current.deleteMemory('memory'));
    expect(view.result.current.memories).toEqual([]); expect(fetch.mock.calls[1][0]).toContain('memoryId=memory');
    await act(async () => view.result.current.clearMemories());
    expect(view.result.current.memories).toEqual([entry('clear')]);
    expect(fetch.mock.calls.map(call => call[1].method)).toEqual(['PATCH', 'DELETE', 'PATCH']);
  });

  it('ignores the first StrictMode lifetime even when its aborted fetch resolves last', async () => {
    const first = deferred<Response>(); const fetch = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(Response.json({ memories: [entry('second')] })); vi.stubGlobal('fetch', fetch);
    const view = renderHook(() => {
      const memory = useProjectMemory({ ...input, initialRead: 'deferred' });
      const refresh = memory.refresh;
      useEffect(() => { void refresh(); }, [refresh]);
      return memory;
    }, { wrapper: StrictMode });
    await act(async () => undefined);
    await act(async () => first.resolve(Response.json({ memories: [entry('first')] })));
    expect(view.result.current.memories).toEqual([entry('second')]);
  });
});
