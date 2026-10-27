import { afterEach, describe, expect, it, vi } from "vitest";
import { readDisplayScale } from "./use-display-scale";

describe("readDisplayScale", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the 16px desktop baseline", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ fontSize: "16px" } as CSSStyleDeclaration);
    expect(readDisplayScale()).toBe(1);
  });

  it("reports the proportional 4K scale from the root font size", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ fontSize: "32px" } as CSSStyleDeclaration);
    expect(readDisplayScale()).toBe(2);
  });

  it("never shrinks pixel-measured classroom rails below the desktop baseline", () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ fontSize: "14px" } as CSSStyleDeclaration);
    expect(readDisplayScale()).toBe(1);
  });
});
