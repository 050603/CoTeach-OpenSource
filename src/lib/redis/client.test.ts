import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("redis", () => ({ createClient: mocks.createClient }));

import {
  __resetRedisClientForTests,
  getRedisClient,
} from "./client";

describe("Redis client connection coordination", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:6399");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    __resetRedisClientForTests();
  });

  afterEach(() => {
    __resetRedisClientForTests();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("bounds concurrent callers on one shared connection attempt", async () => {
    const pending = new Promise<never>(() => undefined);
    const fakeClient = {
      isOpen: true,
      isReady: false,
      connect: vi.fn(() => pending),
      destroy: vi.fn(),
      quit: vi.fn(),
      on: vi.fn(),
    };
    mocks.createClient.mockReturnValue(fakeClient);

    const first = getRedisClient();
    const second = getRedisClient();
    await vi.advanceTimersByTimeAsync(2_500);

    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(fakeClient.connect).toHaveBeenCalledTimes(1);
  });
});
