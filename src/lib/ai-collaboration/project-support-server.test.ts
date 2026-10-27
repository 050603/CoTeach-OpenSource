import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  memoryFindMany: vi.fn(),
  retrievalFindMany: vi.fn(),
  searchTextbookEvidence: vi.fn(),
  searchLibraryTextbookEvidence: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    aiSupportRecord: { findMany: mocks.memoryFindMany },
    textbookRetrievalItem: { findMany: mocks.retrievalFindMany },
  },
}));
vi.mock("@/lib/textbook/service", () => ({
  searchTextbookEvidence: mocks.searchTextbookEvidence,
  searchLibraryTextbookEvidence: mocks.searchLibraryTextbookEvidence,
}));

import { listProjectMemories, PROJECT_MEMORY_READ_TIMEOUT_MS, PROJECT_RETRIEVAL_TIMEOUT_MS, resolveProjectSupportContext } from "./project-support-server";

function course(bound = true): Course {
  return {
    id: "course-1",
    content: {
      textbookSelections: bound ? [{ revisionId: "revision-1", primary: true, sectionIds: [] }] : [],
      knowledgePoints: [{ id: "kp-1", name: "边界值分析" }],
    },
    aiLearningProgress: {},
  } as unknown as Course;
}

const hit = (id: string, lexicalRank: number | null = 1) => ({ retrievalItemId: id, score: 0.03, lexicalRank, semanticRank: 1 });
const record = (id: string) => ({
  id,
  content: "边界值分析需要覆盖有效边界与无效边界。",
  revision: { textbook: { title: "软件测试基础" } },
  section: { path: "第三章/边界值分析", title: "边界值分析" },
});

const input = (bound = true) => ({
  course: course(bound),
  studentId: "student-1",
  participationId: "participation-1",
  message: "边界值分析方法是什么？",
  history: [] as Array<{ role: "user" | "assistant"; content: string }>,
  allowRetrieval: true,
});

describe("resolveProjectSupportContext", () => {
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.memoryFindMany.mockResolvedValue([]);
    mocks.searchTextbookEvidence.mockResolvedValue({ hits: [hit("item-1")] });
    mocks.searchLibraryTextbookEvidence.mockResolvedValue({ hits: [] });
    mocks.retrievalFindMany.mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve(where.id.in.map((id) => record(id))));
  });

  it("uses sufficient course evidence without querying the whole library", async () => {
    const result = await resolveProjectSupportContext(input());
    expect(result.retrievalStatus).toBe("textbook-supported");
    expect(result.sources).toEqual([expect.objectContaining({ id: "textbook:item-1", title: "软件测试基础" })]);
    expect(mocks.searchLibraryTextbookEvidence).not.toHaveBeenCalled();
  });

  it("accepts semantically matched evidence without a lexical rank", async () => {
    mocks.searchTextbookEvidence.mockResolvedValue({ hits: [hit("item-1", null)] });
    const result = await resolveProjectSupportContext(input());
    expect(result.sources).toHaveLength(1);
    expect(mocks.searchLibraryTextbookEvidence).toHaveBeenCalledOnce();
  });

  it("searches the library when course evidence is insufficient", async () => {
    mocks.searchTextbookEvidence.mockResolvedValue({ hits: [] });
    mocks.searchLibraryTextbookEvidence.mockResolvedValue({ hits: [hit("item-2")] });
    const result = await resolveProjectSupportContext(input());
    expect(mocks.searchTextbookEvidence).toHaveBeenCalledBefore(mocks.searchLibraryTextbookEvidence);
    expect(result.sources).toEqual([expect.objectContaining({ id: "textbook:item-2" })]);
  });

  it("searches the library directly when no course textbook is bound", async () => {
    mocks.searchLibraryTextbookEvidence.mockResolvedValue({ hits: [hit("item-2")] });
    const result = await resolveProjectSupportContext(input(false));
    expect(mocks.searchTextbookEvidence).not.toHaveBeenCalled();
    expect(result.sources).toHaveLength(1);
  });

  it("keeps answering context available when course evidence retrieval fails", async () => {
    mocks.searchTextbookEvidence.mockRejectedValue(new Error("search unavailable"));
    const result = await resolveProjectSupportContext(input());
    expect(mocks.searchLibraryTextbookEvidence).toHaveBeenCalled();
    expect(result.sources).toEqual([]);
    expect(result.retrievalStatus).toBe("unavailable");
    expect(result.promptContext).toContain("正常运用模型知识");
    expect(result.promptContext).not.toContain("联网搜索服务尚未配置");
  });

  it("widens the search for current facts while keeping textbook context optional", async () => {
    mocks.searchLibraryTextbookEvidence.mockResolvedValue({ hits: [hit("item-2")] });
    const result = await resolveProjectSupportContext({ ...input(), message: "当前版本的 API 规范是什么？" });
    expect(mocks.searchLibraryTextbookEvidence).toHaveBeenCalledOnce();
    expect(result.sources.map((source) => source.id)).toEqual(["textbook:item-1", "textbook:item-2"]);
  });

  it("uses recent student context for an elliptical follow-up", async () => {
    const result = await resolveProjectSupportContext({
      ...input(),
      message: "这个怎么做？",
      history: [{ role: "user", content: "我在做边界值分析。" }],
    });
    expect(mocks.searchTextbookEvidence).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.stringMatching(/边界值分析.*这个怎么做/),
    }));
    expect(result.sources).toHaveLength(1);
  });

  it.each(["统一标题编号，不改正文。", "修正这段里的错别字。", "把已有记录排成表格，数值不变。", "这些怎么排成表格？", "这个标题怎么编号？"])("does not retrieve for a new local task after an earlier research question: %s", async (message) => {
    const result = await resolveProjectSupportContext({
      ...input(), message, history: [{ role: "user", content: "请查找边界值分析的最新资料。" }],
    });
    expect(result.retrievalStatus).toBe("not-needed");
    expect(mocks.searchTextbookEvidence).not.toHaveBeenCalled();
    expect(mocks.searchLibraryTextbookEvidence).not.toHaveBeenCalled();
  });

  it.each(["先查找参考资料，再整理格式。", "核验当前版本的 API 规范。", "请核实这个说法。", "请查证一下。", "边界值分析"])("preserves retrieval when the current request needs evidence: %s", async (message) => {
    const result = await resolveProjectSupportContext({
      ...input(), message, history: [{ role: "user", content: "统一标题编号。" }],
    });
    expect(mocks.searchTextbookEvidence).toHaveBeenCalledOnce();
    expect(result.retrievalStatus).toBe("textbook-supported");
  });

  it("bases help depth on the student's actual request and reported attempt", async () => {
    const result = await resolveProjectSupportContext({
      ...input(false),
      message: "我已经按三天记录了用水量，但周二突然增加；怎样区分异常值和真实变化？",
      history: [
        { role: "user", content: "准备比较三天用水量。" },
        { role: "assistant", content: "先按时间记录。" },
      ],
      allowRetrieval: false,
    });
    expect(result.promptContext).toContain("周二突然增加");
    expect(result.promptContext).toContain("解释可能原因及如何验证");
    expect(result.promptContext).not.toContain("第 1 层");
  });

  it("continues without optional memories when their read never settles", async () => {
    vi.useFakeTimers();
    mocks.memoryFindMany.mockImplementation(() => new Promise(() => {}));
    const result = resolveProjectSupportContext({ ...input(), allowRetrieval: false });
    await vi.advanceTimersByTimeAsync(PROJECT_MEMORY_READ_TIMEOUT_MS);
    expect((await result).promptContext).toContain("尚无项目记忆");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts retrieval alongside memory and shares their elapsed wait without extending either deadline", async () => {
    vi.useFakeTimers();
    mocks.memoryFindMany.mockImplementation(() => new Promise(() => {}));
    mocks.searchTextbookEvidence.mockImplementation(() => new Promise(() => {}));
    const result = resolveProjectSupportContext(input());
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.memoryFindMany).toHaveBeenCalledOnce();
    expect(mocks.searchTextbookEvidence).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(PROJECT_RETRIEVAL_TIMEOUT_MS);
    const context = await result;
    expect(context).toMatchObject({ sources: [], retrievalStatus: "unavailable" });
    expect(context.promptContext).toContain("尚无项目记忆");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds stalled evidence retrieval and does not continue from a late response", async () => {
    vi.useFakeTimers();
    let finish!: (value: { hits: ReturnType<typeof hit>[] }) => void;
    mocks.searchTextbookEvidence.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = resolveProjectSupportContext(input());
    await vi.advanceTimersByTimeAsync(PROJECT_RETRIEVAL_TIMEOUT_MS);
    expect(await result).toMatchObject({ sources: [], retrievalStatus: "unavailable" });
    finish({ hits: [hit("late")] });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.retrievalFindMany).not.toHaveBeenCalled();
    expect(mocks.searchLibraryTextbookEvidence).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves real course sources when optional library retrieval times out", async () => {
    vi.useFakeTimers();
    mocks.searchTextbookEvidence.mockResolvedValue({ hits: [hit("item-1", null)] });
    mocks.searchLibraryTextbookEvidence.mockImplementation(() => new Promise(() => {}));
    const result = resolveProjectSupportContext(input());
    await vi.advanceTimersByTimeAsync(PROJECT_RETRIEVAL_TIMEOUT_MS);
    expect(await result).toMatchObject({ sources: [expect.objectContaining({ id: "textbook:item-1" })], retrievalStatus: "textbook-supported" });
  });

  it("propagates cancellation promptly while an optional memory read hangs", async () => {
    vi.useFakeTimers();
    mocks.memoryFindMany.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = resolveProjectSupportContext({ ...input(), signal: controller.signal });
    const rejected = expect(result).rejects.toThrow("task cancelled");
    controller.abort(new Error("task cancelled"));
    await rejected;
    expect(mocks.searchTextbookEvidence).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("propagates cancellation during textbook retrieval without library fallback", async () => {
    vi.useFakeTimers();
    mocks.searchTextbookEvidence.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = resolveProjectSupportContext({ ...input(), signal: controller.signal });
    const rejected = expect(result).rejects.toThrow("task cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.searchTextbookEvidence).toHaveBeenCalled();
    controller.abort(new Error("task cancelled"));
    await rejected;
    expect(mocks.searchLibraryTextbookEvidence).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not begin optional reads for an already cancelled task", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(listProjectMemories("participation-1", { signal: controller.signal })).rejects.toThrow("already cancelled");
    expect(mocks.memoryFindMany).not.toHaveBeenCalled();
  });
});
