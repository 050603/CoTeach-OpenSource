import { afterEach, describe, expect, it, vi } from "vitest";
import { COURSE_COVER_GENERATION_SPEC, buildCourseCoverPrompt, requestCourseCoverImage } from "./course-cover";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function streamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

describe("course cover image request boundary", () => {
  it("sends only the planned scene, not the curriculum or planner explanation", () => {
    const plan = {
      topicSummary: "人工智能教育教学理论与方法：建构主义与项目式教学",
      visualAnchor: "师范生通过分类活动理解学习反馈，而非泛化的科技场景",
      sceneDescription: "An East Asian trainee teacher sorts illustrated sample cards beside a compact learning model, moving one misclassified card into its matching cluster. The continuous tabletop scene has a calm background.",
    };
    const prompt = buildCourseCoverPrompt(plan);
    expect(prompt).toContain(plan.sceneDescription);
    expect(prompt).not.toContain(plan.topicSummary);
    expect(prompt).not.toContain(plan.visualAnchor);
    expect(prompt).not.toMatch(/课程名称|课堂封面任务|例如|根系|桥梁|topicSummary|sceneDescription/);
    expect(prompt).toContain("Absolutely no text");
    expect(prompt).toContain("gouache");
    expect(prompt).toContain("edge-to-edge artwork");
    expect(COURSE_COVER_GENERATION_SPEC).toMatchObject({ aspectRatio: "16:9", promptExtend: false });
    expect(COURSE_COVER_GENERATION_SPEC.negativePrompt.length).toBeLessThanOrEqual(500);
  });

  it("keeps the final image request within the provider prompt limit", () => {
    expect(buildCourseCoverPrompt({
      topicSummary: "不发送给图片模型".repeat(50),
      visualAnchor: "不发送给图片模型".repeat(50),
      sceneDescription: "a".repeat(1500),
    }).length).toBeLessThanOrEqual(2400);
  });

  it("uses the authenticated pipeline instead of sending a client image prompt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      coverImageUrl: "/api/openmaic/classroom-media/template-cover-course-1/media/cover.webp",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestCourseCoverImage({ id: "course-1", name: "人工智能教育" }))
      .resolves.toContain("template-cover-course-1");
    expect(fetchMock).toHaveBeenCalledWith("/api/courses/course-1/cover", {
      method: "POST", headers: { Accept: "application/x-ndjson" }, signal: undefined,
    });
  });

  it("waits beyond the gateway idle limit and reads a result split across chunks", async () => {
    vi.useFakeTimers();
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { output = controller; },
    }), { headers: { "Content-Type": "application/x-ndjson" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const settled = vi.fn();
    const result = requestCourseCoverImage({ id: "course-1", name: "课程" }).then(url => { settled(); return url; });
    output.enqueue(encoder.encode('{"type":"pending"}\n'));
    await vi.advanceTimersByTimeAsync(75_000);
    expect(settled).not.toHaveBeenCalled();
    output.enqueue(encoder.encode('{"type":"pending"}\n{"type":"com'));
    output.enqueue(encoder.encode('plete","coverImageUrl":"/cover.webp"}\n'));
    output.close();
    await expect(result).resolves.toBe("/cover.webp");
  });

  it("surfaces the specific generation error sent after streaming has started", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse([
      '{"type":"pending"}\n',
      JSON.stringify({ type: "error", code: "COURSE_COVER_TIMEOUT", status: 504, message: "图片生成超时，请重试或改用本地图片" }),
    ])));
    await expect(requestCourseCoverImage({ id: "course-1", name: "课程" }))
      .rejects.toThrow("图片生成超时，请重试或改用本地图片");
  });

  it("does not treat a disconnected stream as successful generation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamResponse(['{"type":"pending"}\n'])));
    await expect(requestCourseCoverImage({ id: "course-1", name: "课程" }))
      .rejects.toThrow("封面生成连接已中断");
  });

  it("cancels a pending stream when the caller aborts", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { "Content-Type": "application/x-ndjson" },
    })));
    const controller = new AbortController();
    const result = requestCourseCoverImage({ id: "course-1", name: "课程" }, controller.signal);
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(false));
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves JSON authorization errors before streaming starts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ message: "没有权限" }, { status: 403 })));
    await expect(requestCourseCoverImage({ id: "course-1", name: "课程" })).rejects.toThrow("没有权限");
  });
});
