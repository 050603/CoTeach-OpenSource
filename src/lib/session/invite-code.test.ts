import { describe, expect, it } from "vitest";
import { isValidInviteCode, normalizeInviteCode } from "./invite-code";

describe("invite code normalization", () => {
  it("removes pasted ASCII and Unicode whitespace before validation", () => {
    expect(normalizeInviteCode(" a2k\u00a09 q p ")).toBe("A2K9QP");
    expect(isValidInviteCode("A2K 9QP")).toBe(true);
  });
});
