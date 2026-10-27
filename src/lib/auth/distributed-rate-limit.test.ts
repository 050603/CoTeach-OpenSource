import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRedisClient: vi.fn(),
}));

vi.mock("@/lib/redis/client", () => ({
  getRedisClient: mocks.getRedisClient,
}));

import {
  __resetDistributedRateLimitsForTests,
  checkDistributedRateLimit,
  resetDistributedRateLimit,
} from "./distributed-rate-limit";

describe("distributed rate-limit availability fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDistributedRateLimitsForTests();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("uses a bounded local limiter when a Redis command fails", async () => {
    mocks.getRedisClient.mockResolvedValue({
      eval: vi.fn().mockRejectedValue(new Error("redis down")),
    });
    const options = {
      namespace: "test",
      key: "student-1",
      limit: 1,
      windowSeconds: 60,
    };

    await expect(checkDistributedRateLimit(options)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(checkDistributedRateLimit(options)).resolves.toMatchObject({
      allowed: false,
    });
  });

  it("does not fail a successful login while Redis reconnects during reset", async () => {
    mocks.getRedisClient.mockResolvedValue({
      del: vi.fn().mockRejectedValue(new Error("redis down")),
    });

    await expect(resetDistributedRateLimit("login", "ip:teacher")).resolves.toBeUndefined();
  });
});
