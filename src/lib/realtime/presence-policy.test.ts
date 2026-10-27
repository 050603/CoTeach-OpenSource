import { describe, expect, it } from "vitest";
import {
  PRESENCE_SNAPSHOT_INTERVAL_MS,
  shouldReadPresence,
} from "./presence-policy";

describe("presence synchronization policy", () => {
  it("uses a lower snapshot frequency for student clients", () => {
    expect(PRESENCE_SNAPSHOT_INTERVAL_MS.student).toBeGreaterThan(
      PRESENCE_SNAPSHOT_INTERVAL_MS.teacher,
    );
  });

  it("does not read presence while a tab is hidden", () => {
    expect(shouldReadPresence("visible")).toBe(true);
    expect(shouldReadPresence("hidden")).toBe(false);
  });
});
