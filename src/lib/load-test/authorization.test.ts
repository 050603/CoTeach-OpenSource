import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeLoadTestRequest } from "./authorization";

describe("load-test control plane authorization", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is invisible outside explicitly enabled production environments", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ENABLE_LOAD_TEST_API", "true");
    const response = authorizeLoadTestRequest(new Request("https://example.test"));
    expect(response?.status).toBe(404);
  });

  it("requires the exact bearer token", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENABLE_LOAD_TEST_API", "true");
    vi.stubEnv("LOAD_TEST_ADMIN_TOKEN", "a".repeat(32));
    const rejected = authorizeLoadTestRequest(new Request("https://example.test", {
      headers: { authorization: `Bearer ${"b".repeat(32)}` },
    }));
    expect(rejected?.status).toBe(401);
    const accepted = authorizeLoadTestRequest(new Request("https://example.test", {
      headers: { authorization: `Bearer ${"a".repeat(32)}` },
    }));
    expect(accepted).toBeNull();
  });
});
