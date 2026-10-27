import { afterEach, describe, expect, it, vi } from "vitest";
import { generateAdaptiveClassroom } from "./adaptive-learning-client";

function generationInput(overrides: Partial<Parameters<typeof generateAdaptiveClassroom>[0]> = {}) {
  return {
    title: "即时微课",
    requirement: "解释测试主题",
    stageKey: "proposal" as const,
    scenes: [{
      title: "测试主题",
      description: "解释核心概念",
      keyPoints: ["要点"],
      targetDurationSec: 120,
    }],
    ...overrides,
  };
}

function streamResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode([...events, ""].join("\n\n")));
      controller.close();
    },
  }), { status: 200 });
}

describe("adaptive classroom generation lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("announces startup only after the generation stream reports real progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      'data: {"type":"progress","progress":12,"message":"已开始生成"}',
      'data: {"type":"done","id":"classroom-1","scenesCount":1}',
    ])));
    const lifecycle: string[] = [];

    const result = await generateAdaptiveClassroom(generationInput({
      onStarted: () => { lifecycle.push("started"); },
      onProgress: () => { lifecycle.push("progress"); },
    }));

    expect(result).toEqual({ classroomId: "classroom-1", scenesCount: 1 });
    expect(lifecycle).toEqual(["started", "progress"]);
  });

  it("does not announce startup when generation is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const onStarted = vi.fn();

    await expect(generateAdaptiveClassroom(generationInput({ onStarted })))
      .rejects.toThrow("微课生成失败（HTTP 503）");
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("does not announce startup when an accepted stream fails before progress", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse([
      'data: {"type":"error","details":"provider unavailable"}',
    ])));
    const onStarted = vi.fn();

    await expect(generateAdaptiveClassroom(generationInput({ onStarted })))
      .rejects.toThrow("provider unavailable");
    expect(onStarted).not.toHaveBeenCalled();
  });

  it("publishes the classroom id before waiting for durable narration audio", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/openmaic/generate") {
        return streamResponse([
          'data: {"type":"progress","progress":90,"message":"课堂内容已生成"}',
          'data: {"type":"done","id":"classroom-audio","scenesCount":2}',
        ]);
      }
      const pollCount = fetchMock.mock.calls.filter(([value]) => String(value).includes("/api/openmaic/classroom?")).length;
      return Response.json({
        success: true,
        classroom: {
          assetGeneration: { status: pollCount === 1 ? "running" : "completed" },
          scenes: [{
            ttsPolicy: "target-duration",
            actions: [{ type: "speech", text: "讲解", ...(pollCount > 1 ? { audioUrl: "/audio.mp3" } : {}) }],
          }],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const lifecycle: string[] = [];

    const result = await generateAdaptiveClassroom(generationInput({
      waitForAssets: true,
      assetPollIntervalMs: 0,
      onClassroomCreated: ({ classroomId }) => { lifecycle.push(`saved:${classroomId}`); },
      onProgress: ({ message }) => lifecycle.push(message),
    }));

    expect(result.classroomId).toBe("classroom-audio");
    expect(lifecycle).toContain("saved:classroom-audio");
    expect(lifecycle).toContain("知知正在生成并检查讲解音频");
    expect(lifecycle.indexOf("saved:classroom-audio")).toBeLessThan(
      lifecycle.indexOf("知知正在生成并检查讲解音频"),
    );
  });
});
