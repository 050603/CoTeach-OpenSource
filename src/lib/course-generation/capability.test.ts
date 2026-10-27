import { afterEach, describe, expect, it, vi } from "vitest";
import { isBackgroundCourseGenerationEnabled } from "./capability";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("background course generation capability", () => {
  it("is disabled by default during local development", () => {
    vi.stubEnv("COURSE_GENERATION_BACKGROUND_ENABLED", "");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/openpbl");
    expect(isBackgroundCourseGenerationEnabled()).toBe(false);
  });

  it("is enabled by default on a production server with PostgreSQL", () => {
    vi.stubEnv("COURSE_GENERATION_BACKGROUND_ENABLED", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://postgres/openpbl");
    expect(isBackgroundCourseGenerationEnabled()).toBe(true);
  });

  it("honors the explicit environment override", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_URL", "postgresql://postgres/openpbl");
    vi.stubEnv("COURSE_GENERATION_BACKGROUND_ENABLED", "false");
    expect(isBackgroundCourseGenerationEnabled()).toBe(false);
  });
});
