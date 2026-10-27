import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodeDraft } from "./use-code-draft";
import { documentDraftKey, readDocumentDrafts, writeDocumentDraft } from "@/lib/browser/document-draft";

const scope = "course:student:make:code:python";
describe("confirmed code saves", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());
  it("serializes formal submission and advances the next edit to the archived revision", async () => {
    let complete!: (value: { submissionVersion: number }) => void;
    const commit = vi.fn(() => new Promise<{ submissionVersion: number }>(resolve => { complete = resolve; }));
    const persist = vi.fn().mockResolvedValue({ id: "code", version: 3 });
    const { result, rerender } = renderHook(({ content }) => useCodeDraft({ scope, content, initial: { id: "code", version: 1, content: "original" }, enabled: true, restore: vi.fn(), persist }), { initialProps: { content: "original" } });
    let finalizing!: Promise<boolean>;
    await act(async () => { finalizing = result.current.finalize(commit); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(commit).toHaveBeenCalledWith({ id: "code", version: 1, content: "original" });
    rerender({ content: "new edit" });
    let saving!: Promise<boolean>;
    await act(async () => { saving = result.current.save(); await Promise.resolve(); });
    expect(persist).not.toHaveBeenCalled();
    await act(async () => { complete({ submissionVersion: 2 }); await finalizing; await saving; });
    expect(persist).toHaveBeenCalledWith("new edit", "code", 2, expect.any(String), undefined);
    expect(result.current.status).toBe("saved");
  });
  it("retries an unacknowledged formal submission with the same saved version", async () => {
    const commit = vi.fn().mockRejectedValueOnce(new Error("lost acknowledgement")).mockResolvedValueOnce({ submissionVersion: 2 });
    const persist = vi.fn();
    const { result } = renderHook(() => useCodeDraft({ scope, content: "code", initial: { id: "code", version: 1, content: "code" }, enabled: true, restore: vi.fn(), persist }));
    await act(async () => { expect(await result.current.finalize(commit)).toBe(false); });
    await act(async () => { expect(await result.current.finalize(commit)).toBe(true); });
    expect(commit.mock.calls.map(call => call[0].version)).toEqual([1, 1]); expect(persist).not.toHaveBeenCalled();
  });
  it("keeps a failed save durable and retries identical content without claiming success", async () => {
    const persist = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: "code", version: 2 });
    const { result, rerender } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "server" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "server" } });
    rerender({ content: "edited" });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(result.current.status).toBe("error");
    expect(readDocumentDrafts(scope)[0]).toMatchObject({ content: "edited", expectedVersion: 1 });
    await act(async () => { expect(await result.current.save()).toBe(true); });
    expect(result.current.status).toBe("saved");
    expect(persist.mock.calls.map(call => call.slice(0, 3))).toEqual([["edited", "code", 1], ["edited", "code", 1]]);
    expect(persist.mock.calls[0][3]).toBe(persist.mock.calls[1][3]);
    expect(readDocumentDrafts(scope)).toEqual([]);
  });
  it("does not borrow a newer revision from another tab's server refresh", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ version, content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version, content: version === 1 ? "original" : "other tab" },
      enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { version: 1, content: "original" } });
    rerender({ version: 2, content: "my edit" });
    await act(async () => { await result.current.save(); });
    expect(persist).toHaveBeenCalledWith("my edit", "code", 1, expect.any(String), undefined);
    expect(result.current.status).toBe("error");
  });
  it("serializes edits and preserves the new content when an old acknowledgement arrives", async () => {
    let complete!: (value: { id: string; version: number }) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValueOnce({ id: "code", version: 3 });
    const { result, rerender } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "original" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "original" } });
    rerender({ content: "first" });
    let first!: Promise<boolean>;
    await act(async () => { first = result.current.save(); await Promise.resolve(); });
    expect(result.current.status).toBe("saving");
    rerender({ content: "second" });
    let second!: Promise<boolean>;
    await act(async () => { second = result.current.save(); await Promise.resolve(); });
    expect(persist).toHaveBeenCalledTimes(1);
    await act(async () => { complete({ id: "code", version: 2 }); await first; await second; });
    expect(persist.mock.calls.map(call => call.slice(0, 3))).toEqual([["first", "code", 1], ["second", "code", 2]]);
    expect(result.current.status).toBe("saved");
  });
  it("keeps current typing durable when an older queued snapshot starts and fails", async () => {
    let finish!: (value: undefined) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(undefined);
    const { result, rerender } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "original" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "original" } });
    rerender({ content: "first snapshot" });
    let first!: Promise<boolean>; let second!: Promise<boolean>;
    await act(async () => { first = result.current.save(); await Promise.resolve(); });
    rerender({ content: "queued snapshot" });
    await act(async () => { second = result.current.save(); await Promise.resolve(); });
    rerender({ content: "new typing before refresh" });
    expect(readDocumentDrafts(scope)[0].content).toBe("new typing before refresh");
    await act(async () => { finish(undefined); await first; await second; });
    expect(persist.mock.calls.map(call => call.slice(0, 3))).toEqual([
      ["first snapshot", "code", 1], ["queued snapshot", "code", 1],
    ]);
    expect(result.current.status).toBe("error");
    expect(readDocumentDrafts(scope)[0]).toMatchObject({ content: "new typing before refresh", expectedVersion: 1 });
  });
  it("does not mark newer typing saved when an older queued duplicate is skipped", async () => {
    let finish!: (value: { id: string; version: number }) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "original" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "original" } });
    rerender({ content: "first snapshot" });
    let first!: Promise<boolean>; let duplicate!: Promise<boolean>;
    await act(async () => { first = result.current.save(); duplicate = result.current.save(); await Promise.resolve(); });
    rerender({ content: "new typing before refresh" });
    await act(async () => { finish({ id: "code", version: 2 }); await first; await duplicate; });
    expect(persist).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("unsaved");
    expect(readDocumentDrafts(scope)[0]).toMatchObject({ content: "new typing before refresh", expectedVersion: 2 });
  });
  it("restores unsent drafts but retains conflicting drafts for explicit review", () => {
    const restore = vi.fn();
    writeDocumentDraft({ key: documentDraftKey(scope), scope, content: "unsent", expectedVersion: 2, updatedAt: 2 });
    writeDocumentDraft({ key: documentDraftKey(scope), scope, content: "old tab", expectedVersion: 1, updatedAt: 1 });
    const { result } = renderHook(() => useCodeDraft({ scope, content: "server", initial: { id: "code", version: 2, content: "server" },
      enabled: true, restore, persist: vi.fn() }));
    expect(restore).toHaveBeenCalledWith("unsent");
    expect(result.current.error).toContain("冲突");
    expect(readDocumentDrafts(scope)).toHaveLength(2);
  });
  it("ignores a previous scope's delayed save acknowledgement", async () => {
    let complete!: (value: { id: string; version: number }) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const { result, rerender } = renderHook(({ currentScope, content }) => useCodeDraft({ scope: currentScope, content,
      initial: { id: currentScope, version: 1, content: "server" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { currentScope: scope, content: "server" } });
    rerender({ currentScope: scope, content: "my code" });
    let saving!: Promise<boolean>;
    await act(async () => { saving = result.current.save(); await Promise.resolve(); });
    rerender({ currentScope: "another-classroom", content: "server" });
    await act(async () => { complete({ id: scope, version: 2 }); expect(await saving).toBe(false); });
    expect(result.current.status).toBe("saved");
    expect(readDocumentDrafts(scope)[0].content).toBe("my code");
  });
  it("keeps the recovered editor content through initialization and autosave", async () => {
    writeDocumentDraft({ key: documentDraftKey(scope), scope, submissionId: "code", content: "recovered", expectedVersion: 2, updatedAt: 2 });
    const persist = vi.fn().mockResolvedValue({ id: "code", version: 3 });
    const { result } = renderHook(() => {
      const [content, setContent] = useState("server");
      const draft = useCodeDraft({ scope, content, initial: { id: "code", version: 2, content: "server" }, enabled: true, restore: setContent, persist });
      return { content, draft };
    });
    expect(result.current.content).toBe("recovered");
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(result.current.content).toBe("recovered");
    expect(persist).toHaveBeenCalledWith("recovered", "code", 2, expect.any(String), expect.any(String));
    expect(result.current.draft.status).toBe("saved");
  });
});

it('preserves edits made while an explicit conflict adoption is waiting and saves them against its confirmed revision', async () => {
  localStorage.clear();
  let finish!: (value: { id: string; version: number; content: string }) => void;
  const restore = vi.fn(); const persist = vi.fn().mockResolvedValue({ id: 'code', version: 4 });
  const { result, rerender } = renderHook(({ content }) => useCodeDraft({ scope, content,
    initial: { id: 'code', version: 1, content: 'original' }, enabled: true, restore, persist,
  }), { initialProps: { content: 'selected local' } });
  let resolving!: Promise<boolean>;
  await act(async () => { resolving = result.current.resolveConflict(() => new Promise(resolve => { finish = resolve; })); });
  rerender({ content: 'new typing while resolving' });
  await act(async () => { finish({ id: 'code', version: 3, content: 'selected local' }); await resolving; });
  expect(restore).not.toHaveBeenCalled(); expect(result.current.status).toBe('unsaved');
  expect(readDocumentDrafts(scope)).toEqual(expect.arrayContaining([expect.objectContaining({ content: 'new typing while resolving', expectedVersion: 3 })]));
  await act(async () => { await result.current.save(); });
  expect(persist).toHaveBeenLastCalledWith('new typing while resolving', 'code', 3, expect.any(String), undefined);
});

it('ignores a conflict resolution ACK after the editor has switched scope', async () => {
  localStorage.clear();
  let finish!: (value: { id: string; version: number; content: string }) => void;
  const restore = vi.fn();
  const { result, rerender } = renderHook(({ currentScope, content }) => useCodeDraft({ scope: currentScope, content,
    initial: { id: currentScope, version: 1, content }, enabled: true, restore, persist: vi.fn(),
  }), { initialProps: { currentScope: scope, content: 'old scope' } });
  let resolving!: Promise<boolean>;
  await act(async () => { resolving = result.current.resolveConflict(() => new Promise(resolve => { finish = resolve; })); });
  rerender({ currentScope: 'different-course', content: 'new scope' });
  await act(async () => { finish({ id: 'old-code', version: 3, content: 'old scope acknowledged' }); expect(await resolving).toBe(false); });
  expect(restore).not.toHaveBeenCalled(); expect(result.current.status).toBe('saved');
});

function captureRecoveryDownloads() {
  const downloads: string[] = [];
  const NativeBlob = globalThis.Blob;
  vi.stubGlobal('Blob', class extends NativeBlob {
    constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
      super(parts, options); downloads.push((parts ?? []).join(''));
    }
  });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return 'blob:recovery-fixture'; }
    static revokeObjectURL() {}
  });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return { downloads, click };
}

for (const storage of ['empty', 'older', 'unreadable'] as const) {
  it(`downloads current code memory when ${storage} local storage cannot retain typing`, async () => {
    localStorage.clear(); vi.useFakeTimers();
    const capture = captureRecoveryDownloads();
    const { result, rerender, unmount } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: 'code', version: 1, content: 'server' }, enabled: true, restore: vi.fn(), persist: vi.fn(),
    }), { initialProps: { content: 'server' } });
    if (storage !== 'empty') writeDocumentDraft({ key: documentDraftKey(scope), scope,
      submissionId: 'code', expectedVersion: 1, content: 'older durable B', updatedAt: 1 });
    const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    const denied = storage === 'unreadable' ? vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); }) : undefined;
    try {
      rerender({ content: 'latest code C' });
      expect(result.current.error).toContain('浏览器无法保存');
      act(() => result.current.download());
      const recovery = JSON.parse(capture.downloads.at(-1)!);
      expect(recovery).toMatchObject({ schemaVersion: 1, current: { source: 'memory', scope,
        submissionId: 'code', expectedVersion: 1, content: 'latest code C' } });
      expect(recovery.persisted).toEqual(storage === 'older'
        ? [expect.objectContaining({ source: 'local-storage', content: 'older durable B', expectedVersion: 1 })] : []);
      expect(capture.click).toHaveBeenCalledOnce();
    } finally { unmount(); denied?.mockRestore(); quota.mockRestore(); capture.click.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); }
  });
}

it('keeps the storage error and exports current code after an older ACK cannot retain newer typing', async () => {
  localStorage.clear(); vi.useFakeTimers();
  const capture = captureRecoveryDownloads();
  let finish!: (saved: { id: string; version: number }) => void;
  const persist = vi.fn(() => new Promise<{ id: string; version: number }>(resolve => { finish = resolve; }));
  const { result, rerender, unmount } = renderHook(({ content }) => useCodeDraft({ scope, content,
    initial: { id: 'code', version: 1, content: 'server' }, enabled: true, restore: vi.fn(), persist,
  }), { initialProps: { content: 'server' } });
  rerender({ content: 'sent A' });
  let saving!: Promise<boolean>;
  await act(async () => { saving = result.current.save(); });
  const quota = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  try {
    rerender({ content: 'unsent C' });
    await act(async () => { finish({ id: 'code', version: 2 }); expect(await saving).toBe(true); });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('浏览器无法保存');
    act(() => result.current.download());
    expect(JSON.parse(capture.downloads.at(-1)!)).toMatchObject({ current: { source: 'memory', scope,
      submissionId: 'code', expectedVersion: 2, content: 'unsent C' } });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('浏览器无法保存');
    expect(persist).toHaveBeenCalledOnce();
  } finally { unmount(); quota.mockRestore(); capture.click.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); }
});


describe("reverting to the confirmed code snapshot", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("removes only its exact unsent transient draft, so reload cannot restore a reverted tab", async () => {
    const persist = vi.fn();
    const initial = { id: "code", version: 2, content: "helper selected" };
    const view = renderHook(({ content }) => useCodeDraft({ scope, content, initial,
      enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: initial.content } });
    view.rerender({ content: "main selected" });
    const own = readDocumentDrafts(scope)[0];
    const foreign = { ...own, key: documentDraftKey(scope), content: "other tab", expectedVersion: 1 };
    writeDocumentDraft(foreign);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    view.rerender({ content: initial.content });
    expect(readDocumentDrafts(scope)).toEqual([foreign]);
    expect(view.result.current.status).toBe("saved");
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(persist).not.toHaveBeenCalled();
    view.unmount();
    const restore = vi.fn();
    const next = renderHook(() => useCodeDraft({ scope, content: initial.content, initial,
      enabled: true, restore, persist }));
    expect(restore).not.toHaveBeenCalled();
    expect(readDocumentDrafts(scope)).toEqual([foreign]);
    next.unmount();
  });

  it("retains reverted A while B is in flight and automatically saves A after B's real ACK", async () => {
    let finish!: (saved: { id: string; version: number }) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ id: "code", version: 3 });
    const { result, rerender, unmount } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "A" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "A" } });
    rerender({ content: "B" });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    rerender({ content: "A" });
    expect(readDocumentDrafts(scope)[0]).toMatchObject({ content: "A", expectedVersion: 1 });
    await act(async () => { finish({ id: "code", version: 2 }); await Promise.resolve(); });
    expect(result.current.status).toBe("unsaved");
    expect(readDocumentDrafts(scope)[0]).toMatchObject({ content: "A", expectedVersion: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(persist.mock.calls.map(call => call.slice(0, 3))).toEqual([["B", "code", 1], ["A", "code", 2]]);
    expect(persist.mock.calls[0][3]).toBe(persist.mock.calls[1][3]);
    expect(result.current.status).toBe("saved");
    expect(readDocumentDrafts(scope)).toEqual([]);
    unmount();
  });

  it("counts a queued snapshot before its first microtask and preserves a later revert", async () => {
    let finish!: (saved: { id: string; version: number }) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ id: "code", version: 3 });
    const { result, rerender, unmount } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "A" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "A" } });
    rerender({ content: "B" });
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    rerender({ content: "A" });
    expect(readDocumentDrafts(scope)[0].content).toBe("A");
    await act(async () => { await Promise.resolve(); });
    await act(async () => { finish({ id: "code", version: 2 }); await pending; });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(persist.mock.calls.map(call => call.slice(0, 3))).toEqual([["B", "code", 1], ["A", "code", 2]]);
    expect(result.current.status).toBe("saved");
    unmount();
  });

  it("does not skip reverted A after an ambiguous B failure; the provider must reconcile the original queue", async () => {
    let fail!: (saved: undefined) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { fail = resolve; }))
      .mockResolvedValueOnce({ id: "code", version: 3 });
    const { result, rerender, unmount } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "A" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "A" } });
    rerender({ content: "B" });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    await act(async () => { fail(undefined); await Promise.resolve(); });
    expect(result.current.status).toBe("error");
    rerender({ content: "A" });
    expect(readDocumentDrafts(scope)[0]).toMatchObject({ content: "A", expectedVersion: 1 });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    // The hook must not invent version 2: the provider owns original-ID replay
    // and advancement from its exact receipt before saving this current A.
    expect(persist.mock.calls.map(call => call.slice(0, 3))).toEqual([["B", "code", 1], ["A", "code", 1]]);
    expect(persist.mock.calls[1][3]).toBe(persist.mock.calls[0][3]);
    expect(result.current.status).toBe("saved");
    unmount();
  });

  it("keeps a replacement record even when it reused this editor's key", () => {
    const persist = vi.fn();
    const { rerender, unmount } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "A" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "A" } });
    rerender({ content: "B" });
    const own = readDocumentDrafts(scope)[0];
    const replacement = { ...own, submissionId: "other-submission", expectedVersion: 7 };
    writeDocumentDraft(replacement);
    rerender({ content: "A" });
    expect(readDocumentDrafts(scope)).toEqual([replacement]);
    expect(persist).not.toHaveBeenCalled();
    unmount();
  });

  it("retains the recovered original while removing only the current editor's unsent revert", () => {
    const original = { key: documentDraftKey(scope), scope, submissionId: "code",
      expectedVersion: 1, content: "recovered B", updatedAt: 1 };
    writeDocumentDraft(original);
    const { result, unmount } = renderHook(() => {
      const [content, setContent] = useState("A");
      const draft = useCodeDraft({ scope, content, initial: { id: "code", version: 1, content: "A" },
        enabled: true, restore: setContent, persist: vi.fn() });
      return { content, setContent, draft };
    });
    expect(result.current.content).toBe("recovered B");
    act(() => result.current.setContent("A"));
    expect(readDocumentDrafts(scope)).toEqual([original]);
    expect(result.current.draft.status).toBe("saved");
    unmount();
  });

  it("does not hide a failed exact cleanup or delete any durable request", () => {
    const { result, rerender, unmount } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "A" }, enabled: true, restore: vi.fn(), persist: vi.fn(),
    }), { initialProps: { content: "A" } });
    rerender({ content: "B" });
    const own = readDocumentDrafts(scope)[0];
    const durableKey = "openpbl:submission-save:v1:student:fixture";
    localStorage.setItem(durableKey, JSON.stringify({ requestId: "immutable", content: "B" }));
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("denied", "SecurityError"); });
    rerender({ content: "A" });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("无法清理");
    expect(readDocumentDrafts(scope)).toEqual([own]);
    expect(JSON.parse(localStorage.getItem(durableKey)!)).toEqual({ requestId: "immutable", content: "B" });
    remove.mockRestore();
    unmount();
  });
});


describe("reverted code across reload", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it.each([true, false])("reconciles current A after B ACK and reload into older A with confirmation marker %s", async requiresConfirmation => {
    let finish!: (saved: { id: string; version: number }) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ id: "code", version: 3 });
    const initial = { id: "code", version: 1, content: "A" };
    const first = renderHook(({ content }) => useCodeDraft({ scope, content, initial,
      enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "A" } });
    first.rerender({ content: "B" });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    first.rerender({ content: "A" });
    await act(async () => { finish({ id: "code", version: 2 }); await Promise.resolve(); });
    // retry has rerendered the original debounce effect, but A's next 900ms
    // has not elapsed. Pending B has settled and A is based on its real ACK.
    const retained = readDocumentDrafts(scope)[0];
    expect(retained).toMatchObject({ content: "A", expectedVersion: 2 });
    expect(first.result.current.status).toBe("unsaved");
    first.unmount();
    // Both current marked records and older unmarked records carry the same
    // proven version 2. Neither may be mistaken for the stale GET's A1.
    writeDocumentDraft({ ...retained, requiresConfirmation });
    const restore = vi.fn();
    const second = renderHook(() => useCodeDraft({ scope, content: "A", initial,
      enabled: true, restore, persist }));
    expect(restore).toHaveBeenCalledWith("A");
    expect(second.result.current.status).toBe("unsaved");
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(persist.mock.calls.map(call => call.slice(0, 3))).toEqual([["B", "code", 1], ["A", "code", 2]]);
    expect(persist.mock.calls[1][4]).toBe(retained.key);
    expect(second.result.current.status).toBe("saved");
    expect(readDocumentDrafts(scope)).toEqual([]);
    second.unmount();
  });

  it("reconciles marked A even when the initial snapshot is A, and does not restore its acknowledged original on a second reload", async () => {
    const original = { key: documentDraftKey(scope), scope, submissionId: "code",
      expectedVersion: 1, content: "A", updatedAt: 1, requiresConfirmation: true };
    writeDocumentDraft(original);
    // The real provider, rather than this hook, owns B's original-ID replay and
    // its ACK advancing 1->2 before A is committed at 3. See integration plan.
    const persist = vi.fn().mockResolvedValue({ id: "code", version: 3 });
    const restore = vi.fn();
    const first = renderHook(() => useCodeDraft({ scope, content: "A",
      initial: { id: "code", version: 1, content: "A" }, enabled: true, restore, persist }));
    expect(restore).toHaveBeenCalledWith("A");
    expect(first.result.current.status).toBe("unsaved");
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(persist).toHaveBeenCalledWith("A", "code", 1, expect.any(String), original.key);
    expect(first.result.current.status).toBe("saved");
    expect(readDocumentDrafts(scope)).toEqual([]);
    first.unmount();
    const secondRestore = vi.fn();
    const second = renderHook(() => useCodeDraft({ scope, content: "A",
      initial: { id: "code", version: 3, content: "A" }, enabled: true, restore: secondRestore, persist }));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(secondRestore).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledOnce();
    second.unmount();
  });

  it("does not roll a retained confirmed baseline backwards after same-content reconciliation of an older server version", async () => {
    const original = { key: documentDraftKey(scope), scope, submissionId: "code",
      expectedVersion: 2, content: "A", updatedAt: 1 };
    writeDocumentDraft(original);
    const persist = vi.fn().mockResolvedValue({ id: "code", version: 1 });
    const { result, unmount } = renderHook(() => useCodeDraft({ scope, content: "A",
      initial: { id: "code", version: 1, content: "A" }, enabled: true, restore: vi.fn(), persist }));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(persist).toHaveBeenCalledWith("A", "code", 2, expect.any(String), original.key);
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("早于本机已确认版本");
    expect(readDocumentDrafts(scope)).toEqual(expect.arrayContaining([
      original, expect.objectContaining({ content: "A", expectedVersion: 2, requiresConfirmation: true }),
    ]));
    unmount();
  });

  it("never removes a recovered original that another tab changed before the matching ACK", async () => {
    const original = { key: documentDraftKey(scope), scope, submissionId: "code",
      expectedVersion: 1, content: "A", updatedAt: 1, requiresConfirmation: true };
    writeDocumentDraft(original);
    let finish!: (saved: { id: string; version: number }) => void;
    const persist = vi.fn(() => new Promise<{ id: string; version: number }>(resolve => { finish = resolve; }));
    const { result, unmount } = renderHook(() => useCodeDraft({ scope, content: "A",
      initial: { id: "code", version: 1, content: "A" }, enabled: true, restore: vi.fn(), persist }));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    const replacement = { ...original, content: "other tab C", updatedAt: 2 };
    writeDocumentDraft(replacement);
    await act(async () => { finish({ id: "code", version: 3 }); await Promise.resolve(); });
    expect(result.current.status).toBe("saved");
    expect(readDocumentDrafts(scope)).toEqual([replacement]);
    unmount();
  });

  it("accepts a canonical same-content identity at the retained version without inventing +1 or reviving the old original", async () => {
    const original = { key: documentDraftKey(scope), scope, submissionId: "old-id",
      expectedVersion: 2, content: "A", updatedAt: 1 };
    writeDocumentDraft(original);
    const persist = vi.fn().mockResolvedValue({ id: "canonical-id", version: 2 });
    const first = renderHook(() => useCodeDraft({ scope, content: "A",
      initial: { id: "old-id", version: 1, content: "A" }, enabled: true, restore: vi.fn(), persist }));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(persist).toHaveBeenCalledWith("A", "old-id", 2, expect.any(String), original.key);
    expect(first.result.current.status).toBe("saved");
    expect(readDocumentDrafts(scope)).toEqual([]);
    const capture = captureRecoveryDownloads();
    try {
      act(() => first.result.current.download());
      expect(JSON.parse(capture.downloads.at(-1)!)).toMatchObject({
        current: { submissionId: "canonical-id", expectedVersion: 2, content: "A" },
      });
    } finally { capture.click.mockRestore(); vi.unstubAllGlobals(); first.unmount(); }
    const restore = vi.fn();
    const second = renderHook(() => useCodeDraft({ scope, content: "A",
      initial: { id: "canonical-id", version: 2, content: "A" }, enabled: true, restore, persist }));
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(restore).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledOnce();
    second.unmount();
  });

  it("preserves an older marked edit as an explicit conflict without borrowing a newer snapshot revision", async () => {
    const original = { key: documentDraftKey(scope), scope, submissionId: "code",
      expectedVersion: 1, content: "A", updatedAt: 1, requiresConfirmation: true };
    writeDocumentDraft(original);
    const persist = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() => {
      const [content, setContent] = useState("B");
      const draft = useCodeDraft({ scope, content, initial: { id: "code", version: 2, content: "B" },
        enabled: true, restore: setContent, persist });
      return { content, draft };
    });
    expect(result.current.content).toBe("B");
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(persist).not.toHaveBeenCalled();
    expect(result.current.draft.error).toContain("冲突");
    expect(readDocumentDrafts(scope)).toEqual([original]);
    unmount();
  });

  it("keeps reverted A downloadable when storage fails during B's late acknowledgement", async () => {
    let finish!: (saved: { id: string; version: number }) => void;
    const persist = vi.fn(() => new Promise<{ id: string; version: number }>(resolve => { finish = resolve; }));
    const { result, rerender, unmount } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "A" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "A" } });
    rerender({ content: "B" });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    const quota = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    rerender({ content: "A" });
    await act(async () => { finish({ id: "code", version: 2 }); await Promise.resolve(); });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toContain("浏览器无法保存");
    const capture = captureRecoveryDownloads();
    try {
      act(() => result.current.download());
      expect(JSON.parse(capture.downloads.at(-1)!)).toMatchObject({
        current: { source: "memory", scope, content: "A", expectedVersion: 2 },
      });
      expect(persist).toHaveBeenCalledOnce();
    } finally { capture.click.mockRestore(); vi.unstubAllGlobals(); quota.mockRestore(); unmount(); }
  });
});
