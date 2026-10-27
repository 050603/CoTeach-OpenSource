// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ version: vi.fn(), images: vi.fn(), destroy: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("node:fs/promises", () => ({ readFile: async () => new Uint8Array([1, 2, 3]) }));
vi.mock("@/lib/db/client", () => ({ prisma: { artifactVersion: { findFirst: mocks.version } } }));
vi.mock("./persistence", () => ({ showcaseStore: { loadCourse: async () => ({ content: {} }) } }));
vi.mock("./recommendation-service", () => ({ showcaseAnalysisContext: () => ({ contextFingerprint: "context" }) }));
vi.mock("unpdf", () => ({ getDocumentProxy: async () => ({ numPages: 1, destroy: mocks.destroy }), extractText: async () => ({ text: ["这是一份包含对照数据和实验结论的完整作品，结论可供核查。"] }), extractImages: mocks.images }));
import { loadShowcaseRecommendationSnapshot } from "./recommendation-analysis";
const task = { schemaVersion: 2 as const, analysisVersion: 2, courseId: "c", studentId: "s", artifactVersionId: "v", artifactKind: "pdf" as const, contextFingerprint: "context", requirements: "", dimensions: [] };
beforeEach(() => { vi.clearAllMocks(); mocks.version.mockResolvedValue({ sha256: "binary-one", fileAsset: { storageKey: "work.pdf", deletedAt: null } }); mocks.images.mockResolvedValue([{ width: 1, height: 1, channels: 3, key: "image-one", data: new Uint8Array([10, 20, 30]) }]); });
it("reuses PDF text and image identity across metadata/style changes, but detects changed images", async () => {
  const first = await loadShowcaseRecommendationSnapshot(task);
  mocks.version.mockResolvedValue({ sha256: "binary-two", fileAsset: { storageKey: "work.pdf", deletedAt: null } });
  mocks.images.mockResolvedValueOnce([{ width: 1, height: 1, channels: 3, key: "renumbered-object", data: new Uint8Array([10, 20, 30]) }]);
  expect((await loadShowcaseRecommendationSnapshot(task)).fingerprint).toBe(first.fingerprint);
  mocks.images.mockResolvedValueOnce([{ width: 1, height: 1, channels: 3, key: "image-one", data: new Uint8Array([30, 20, 10]) }]);
  expect((await loadShowcaseRecommendationSnapshot(task)).fingerprint).not.toBe(first.fingerprint);
  expect(mocks.destroy).toHaveBeenCalledTimes(3);
});
it("rejects files outside the upload store and preserves version scope", async () => {
  mocks.version.mockResolvedValueOnce({ fileAsset: { storageKey: "../private.pdf", deletedAt: null } });
  await expect(loadShowcaseRecommendationSnapshot(task)).rejects.toThrow("QUALITY_FILE_UNAVAILABLE");
  mocks.version.mockResolvedValueOnce(null); await expect(loadShowcaseRecommendationSnapshot(task)).rejects.toThrow("QUALITY_ARTIFACT_CHANGED");
});
