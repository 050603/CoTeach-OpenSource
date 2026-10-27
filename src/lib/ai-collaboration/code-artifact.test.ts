import { describe, expect, it } from "vitest";
import {
  createCodeArtifact,
  normalizeCodeFileName,
  parseCodeArtifact,
  serializeCodeArtifact,
} from "./code-artifact";

describe("code artifact", () => {
  it("round-trips an isolated Python draft", () => {
    const artifact = createCodeArtifact("python");
    expect(parseCodeArtifact(serializeCodeArtifact(artifact), "python")).toEqual(artifact);
    expect(parseCodeArtifact(serializeCodeArtifact(artifact), "c")).toBeNull();
  });

  it("falls back to the first file when the active file no longer exists", () => {
    const artifact = createCodeArtifact("c");
    const parsed = parseCodeArtifact(JSON.stringify({ ...artifact, activeFileId: "missing" }), "c");
    expect(parsed?.activeFileId).toBe("main");
  });

  it("normalizes safe language-specific file names", () => {
    expect(normalizeCodeFileName("utils", "python")).toBe("utils.py");
    expect(normalizeCodeFileName("src/helper.c", "c")).toBe("src/helper.c");
    expect(normalizeCodeFileName("include/helper.h", "c")).toBe("include/helper.h");
    expect(normalizeCodeFileName("../secret", "python")).toBeNull();
  });
});
