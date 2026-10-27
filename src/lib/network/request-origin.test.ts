import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedBrowserOrigin } from "./request-origin";

describe("browser origin validation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts the configured canonical origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_BASE_URL", "https://school.example");
    expect(isAllowedBrowserOrigin({ origin: "https://school.example", host: "internal:3000" })).toBe(true);
  });

  it("accepts the actual proxy host during a controlled server migration", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_BASE_URL", "http://172.16.1.10");
    expect(isAllowedBrowserOrigin({
      origin: "http://172.16.1.20:8080",
      host: "172.16.1.20:8080",
      forwardedProto: "http",
    })).toBe(true);
  });

  it("rejects a cross-origin request even when a canonical address exists", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_BASE_URL", "https://school.example");
    expect(isAllowedBrowserOrigin({
      origin: "https://attacker.example",
      host: "school.example",
      forwardedProto: "https",
    })).toBe(false);
  });
});

