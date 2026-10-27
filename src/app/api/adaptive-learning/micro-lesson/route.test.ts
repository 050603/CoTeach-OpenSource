import { beforeEach, describe, expect, it, vi } from "vitest";

const { callLLM, getCourse } = vi.hoisted(() => ({
  callLLM: vi.fn(),
  getCourse: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  isAuthConfigured: () => false,
  readAuthFromRequest: vi.fn(),
}));

vi.mock("@/lib/llm/client", () => ({
  callLLM,
  parseLLMJson: vi.fn(),
}));

vi.mock("@/lib/session/server-store", () => ({
  getCourse,
}));

import { POST } from "./route";

function request(message: string, stageKey = "proposal") {
  return new Request("http://localhost/api/adaptive-learning/micro-lesson", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      courseId: "course-1",
      studentId: "student-1",
      stageKey,
      message,
    }),
  });
}

describe("POST /api/adaptive-learning/micro-lesson", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCourse.mockResolvedValue({
      id: "course-1",
      name: "桥梁项目",
      drivingQuestion: "如何设计一座稳定的桥？",
      submissions: [],
    });
    callLLM.mockRejectedValue(new Error("provider unavailable"));
  });

  it("falls back to a systematic lesson for the knowledge-corner request", async () => {
    const response = await POST(request(
      "请围绕这个问题解释概念、补充背景，并给出可继续查证的资料线索：为什么拱形结构更稳定",
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decision).toMatchObject({
      decision: "systematic-lesson",
      topic: "为什么拱形结构更稳定",
    });
  });

  it("keeps an ordinary project action in normal companion chat", async () => {
    const response = await POST(request("帮我把小组任务分成三步"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.decision.decision).toBe("brief-answer");
  });

  it("supports micro lessons in later companion stages but not the first two stages", async () => {
    const showcaseResponse = await POST(request("为什么这个证据能够支持结论？", "showcase"));
    const aiLearningResponse = await POST(request("为什么这个证据能够支持结论？", "ai-learning"));

    expect(showcaseResponse.status).toBe(200);
    expect(aiLearningResponse.status).toBe(400);
  });
});
