import { describe, expect, it } from "vitest";
import {
  GENERATION_HEARTBEAT_STALE_AFTER_MS,
  isGenerationHeartbeatStale,
} from "./heartbeat";

const now = Date.parse("2026-08-24T07:12:38.713Z");

describe("isGenerationHeartbeatStale", () => {
  it("marks a running task as stale after the recovery threshold", () => {
    expect(isGenerationHeartbeatStale({
      status: "running",
      lastHeartbeatAt: "2026-08-24T06:42:38.713Z",
    }, now)).toBe(true);
  });

  it("keeps a recently heartbeating running task live", () => {
    expect(isGenerationHeartbeatStale({
      status: "running",
      lastHeartbeatAt: new Date(now - GENERATION_HEARTBEAT_STALE_AFTER_MS + 1).toISOString(),
    }, now)).toBe(false);
  });

  it("does not treat queued or intentionally paused tasks as disconnected", () => {
    const oldHeartbeat = "2026-08-24T05:12:38.713Z";
    expect(isGenerationHeartbeatStale({ status: "queued", lastHeartbeatAt: oldHeartbeat }, now)).toBe(false);
    expect(isGenerationHeartbeatStale({ status: "paused", lastHeartbeatAt: oldHeartbeat }, now)).toBe(false);
  });

  it("falls back to the last update for older tasks without heartbeat data", () => {
    expect(isGenerationHeartbeatStale({
      status: "running",
      lastHeartbeatAt: null,
      updatedAt: "2026-08-24T05:12:38.713Z",
    }, now)).toBe(true);
  });
});
