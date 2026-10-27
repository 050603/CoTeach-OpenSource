import { afterEach, describe, expect, it, vi } from "vitest";
import {
  crossedResourceProgressThresholds,
  resourceEventIdempotencyKey,
  createLearningEvent,
  postLearningEvents,
} from "./telemetry";

afterEach(() => vi.unstubAllGlobals());

describe("learning batch receipts", () => {
  const events = ["one", "two"].map(id => ({ ...createLearningEvent("heartbeat", { courseId: "course", studentId: "student", stageKey: "learn" }), id }));
  const batch = { courseId: "course", studentId: "student", events };
  it.each([{}, { acceptedIds: ["one"] }, { acceptedIds: ["one", "other"] }, { acceptedIds: ["one", "one"] }, { acceptedIds: ["one", "two", "other"] }])("rejects a successful HTTP response with an incomplete or unrelated receipt: %j", async receipt => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(receipt)));
    await expect(postLearningEvents(batch)).rejects.toThrow("回执不完整");
  });
  it("requires completed HTTP 200 and explicit IDs, permits receipt order changes and preserves the request body", async () => {
    const fetch = vi.fn(async () => Response.json({ acceptedIds: ["two", "one"] }, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    await expect(postLearningEvents(batch)).rejects.toThrow("回执不完整");
    fetch.mockImplementation(async () => Response.json({ acceptedIds: ["two", "one"] }));
    await postLearningEvents(batch);
    expect(fetch.mock.calls).toHaveLength(2);
    expect(fetch).toHaveBeenLastCalledWith("/api/learning-events", expect.objectContaining({ body: JSON.stringify(batch) }));
  });
  it("marks a retry without changing its immutable event body or treating the hint as a receipt", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ acceptedIds: ["two", "one"] }));
    vi.stubGlobal("fetch", fetch);
    await postLearningEvents(batch);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has("X-OpenPBL-Learning-Replay")).toBe(false);
    await postLearningEvents(batch, { replay: true });
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("X-OpenPBL-Learning-Replay")).toBe("1");
    expect(fetch.mock.calls[1][1]?.body).toBe(JSON.stringify(batch));
    fetch.mockImplementation(async () => Response.json({ acceptedIds: ["one"] }));
    await expect(postLearningEvents(batch, { replay: true })).rejects.toThrow("回执不完整");
  });
});

describe("resource telemetry thresholds", () => {
  it("emits only coarse thresholds and never regresses", () => {
    expect(crossedResourceProgressThresholds(0, 24)).toEqual([]);
    expect(crossedResourceProgressThresholds(0, 26)).toEqual([25]);
    expect(crossedResourceProgressThresholds(26, 76)).toEqual([50, 75]);
    expect(crossedResourceProgressThresholds(76, 100)).toEqual([100]);
    expect(crossedResourceProgressThresholds(90, 40)).toEqual([]);
  });

  it("keeps student and projection records independently idempotent", () => {
    const studentKey = resourceEventIdempotencyKey("course", "student", "resource", "progress", 50);
    const projectionKey = resourceEventIdempotencyKey("course", "student", "resource", "progress", 50, "teacher-projection");
    expect(studentKey).toBe("resource:course:student:resource:student:progress:50");
    expect(projectionKey).not.toBe(studentKey);
    expect(resourceEventIdempotencyKey("course", "student", "resource", "open")).toBe(
      resourceEventIdempotencyKey("course", "student", "resource", "open"),
    );
  });
});
