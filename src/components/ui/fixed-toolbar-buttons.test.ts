import { describe, expect, it } from "vitest";
import { getToolbarOverflowIds } from "./fixed-toolbar-buttons";

describe("responsive Plate toolbar overflow", () => {
  it("moves a contiguous group suffix into More until the toolbar fits", () => {
    expect(getToolbarOverflowIds(
      ["history", "format", "table", "mode"],
      [60, 100, 200, 80],
      300,
      40,
    )).toEqual(["table", "mode"]);
  });

  it("keeps every group visible when the toolbar has enough room", () => {
    expect(getToolbarOverflowIds(
      ["history", "format"],
      [60, 100],
      200,
      40,
    )).toEqual([]);
  });

  it("keeps the More button available even at the narrowest width", () => {
    expect(getToolbarOverflowIds(
      ["history", "format"],
      [60, 100],
      30,
      40,
    )).toEqual(["history", "format"]);
  });
});
