// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getCourse: vi.fn(),
  updateCourse: vi.fn(),
  generate: vi.fn(),
  upload: vi.fn(),
}));

vi.mock("@/lib/platform/template-access", () => ({
  authorizeTemplateRequest: mocks.authorize,
}));
vi.mock("@/lib/session/server-store", () => ({
  getCourse: mocks.getCourse,
  updateCourse: mocks.updateCourse,
}));
vi.mock("@/lib/course-cover-server", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/course-cover-server")>();
  return {
    ...original,
    generateCourseCoverImageOnServer: mocks.generate,
    persistUploadedCourseCover: mocks.upload,
  };
});

import { POST, PUT } from "./route";
import {
  CourseCoverGenerationError,
  CourseCoverProviderUnavailableError,
} from "@/lib/course-cover-server";

const context = { params: Promise.resolve({ courseId: "template-1" }) };
const course = { id: "template-1", name: "校园雨水花园", version: 7 };

function request(method: "POST" | "PUT", file?: File, streaming = false, signal?: AbortSignal) {
  const body = method === "PUT" ? new FormData() : undefined;
  if (body && file) body.append("file", file);
  return new Request("https://app.test/api/courses/template-1/cover", {
    method,
    headers: { origin: "https://app.test", "x-request-id": "request-1", ...(streaming ? { Accept: "application/x-ndjson" } : {}) },
    body,
    signal,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue("teacher-1");
  mocks.getCourse.mockResolvedValue(course);
  mocks.generate.mockResolvedValue("/api/openmaic/classroom-media/template-cover-template-1/media/classroom-cover-v7.webp");
  mocks.upload.mockResolvedValue("/api/openmaic/classroom-media/template-cover-template-1/media/classroom-cover-upload-v7.webp");
  mocks.updateCourse.mockImplementation(async (_id, updater) => updater(course));
});

afterEach(() => vi.useRealTimers());

describe("classroom cover route", () => {
  it("generates, normalizes and persists a classroom cover", async () => {
    const response = await POST(request("POST"), context);

    expect(response.status).toBe(200);
    expect(mocks.generate).toHaveBeenCalledWith(
      course,
      "template-cover-template-1",
      expect.any(AbortSignal),
      expect.stringMatching(/^classroom-cover-v7-[0-9a-f-]{36}$/),
    );
    expect(mocks.updateCourse).toHaveBeenCalledWith(
      "template-1",
      expect.any(Function),
      { actor: { id: "teacher-1", role: "teacher" } },
    );
    await expect(response.json()).resolves.toMatchObject({
      coverImageUrl: expect.stringContaining("classroom-cover-v7.webp"),
    });
  });

  it("accepts an uploaded classroom cover", async () => {
    const file = new File(["image"], "cover.jpg", { type: "image/jpeg" });
    const response = await PUT(request("PUT", file), context);

    expect(response.status).toBe(200);
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ name: "cover.jpg" }),
      "template-cover-template-1",
      expect.stringMatching(/^classroom-cover-upload-v7-[0-9a-f-]{36}$/),
    );
  });

  it("flushes heartbeats throughout a generation lasting more than 60 seconds, then saves before completing", async () => {
    vi.useFakeTimers();
    let finishGeneration!: (url: string) => void;
    mocks.generate.mockReturnValue(new Promise<string>(resolve => { finishGeneration = resolve; }));
    const response = await POST(request("POST", undefined, true), context);
    expect(response.headers.get("Content-Type")).toContain("application/x-ndjson");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    expect(response.headers.get("Cache-Control")).toContain("no-transform");
    const reader = response.body!.getReader();
    const decode = (chunk: ReadableStreamReadResult<Uint8Array>) => JSON.parse(new TextDecoder().decode(chunk.value));
    expect(decode(await reader.read())).toEqual({ type: "pending" });
    for (let elapsed = 0; elapsed < 75_000; elapsed += 15_000) {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(decode(await reader.read())).toEqual({ type: "pending" });
    }
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    expect(mocks.generate.mock.calls[0][2].aborted).toBe(false);
    finishGeneration("/generated-cover.webp");
    expect(decode(await reader.read())).toEqual({ type: "complete", coverImageUrl: "/generated-cover.webp" });
    expect(mocks.updateCourse).toHaveBeenCalledOnce();
    expect(await reader.read()).toMatchObject({ done: true });
    expect(vi.getTimerCount()).toBe(0);
    reader.releaseLock();
  });

  it("streams an actionable failure without replacing the current cover", async () => {
    mocks.generate.mockRejectedValue(new CourseCoverProviderUnavailableError());
    const response = await POST(request("POST", undefined, true), context);
    const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    expect(events).toEqual([
      { type: "pending" },
      expect.objectContaining({ type: "error", code: "COURSE_COVER_PROVIDER_UNAVAILABLE", status: 503, message: expect.stringContaining("配置图片模型") }),
    ]);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it.each(["request", "reader"])("stops generation and clears the heartbeat on %s cancellation", async (source) => {
    vi.useFakeTimers();
    let finishGeneration!: (url: string) => void;
    mocks.generate.mockReturnValue(new Promise<string>(resolve => { finishGeneration = resolve; }));
    const controller = new AbortController();
    const response = await POST(request("POST", undefined, true, controller.signal), context);
    const reader = response.body!.getReader();
    await reader.read();
    if (source === "request") controller.abort();
    else await reader.cancel();
    expect(mocks.generate.mock.calls[0][2].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    finishGeneration("/cancelled-cover.webp");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
    expect(await reader.read()).toMatchObject({ done: true });
    reader.releaseLock();
  });

  it.each([false, true])("preserves authorization failures (streaming: %s)", async (streaming) => {
    mocks.authorize.mockResolvedValue(new Response(null, { status: 403 }));
    expect((await POST(request("POST", undefined, streaming), context)).status).toBe(403);
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("returns an actionable error when AI image generation is not configured", async () => {
    mocks.generate.mockRejectedValue(new CourseCoverProviderUnavailableError());
    const response = await POST(request("POST"), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "COURSE_COVER_PROVIDER_UNAVAILABLE",
      message: expect.stringContaining("配置图片模型，或上传本地图片"),
    });
  });

  it("returns a specific Qwen model configuration error", async () => {
    mocks.generate.mockRejectedValue(new CourseCoverGenerationError(
      "COURSE_COVER_MODEL_INCOMPATIBLE",
      "当前图片模型配置不兼容，请在教师设置中重新选择可用的图片模型",
      503,
      new Error("Qwen Image generation failed (400): invalid model"),
    ));
    const response = await POST(request("POST"), context);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "COURSE_COVER_MODEL_INCOMPATIBLE",
      message: expect.stringContaining("图片模型配置不兼容"),
    });
  });

  it("rejects an upload without a file", async () => {
    const response = await PUT(request("PUT"), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "FILE_REQUIRED" });
  });
});
