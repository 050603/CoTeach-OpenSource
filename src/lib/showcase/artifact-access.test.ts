// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";

const mocks = vi.hoisted(() => ({ access: vi.fn(), course: vi.fn(), presentation: vi.fn(), activeAssets: vi.fn() }));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.access }));
vi.mock("./persistence", () => ({ showcaseStore: { loadCourse: mocks.course, findPresentation: mocks.presentation } }));
vi.mock("@/lib/db/client", () => ({ prisma: { showcasePresentation: { findMany: mocks.activeAssets } } }));
import { canReadActiveShowcaseArtifact, canReadActiveShowcaseAsset } from "./artifact-access";
const student = { role: "student", sub: "listener" } as AuthClaims;

describe("active showcase artifact authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue(true);
    mocks.course.mockResolvedValue({ status: "teaching", currentStageIndex: 0, stages: [{ key: "showcase" }] });
    mocks.presentation.mockResolvedValue({ id: "active" });
    mocks.activeAssets.mockResolvedValue([]);
  });
  it("checks live classroom membership and the exact active version", async () => {
    expect(await canReadActiveShowcaseArtifact(student, "classroom", "version")).toBe(true);
    expect(mocks.presentation).toHaveBeenCalledWith({ where: { courseId: "classroom", artifactVersionId: "version", status: "active" } });
    mocks.access.mockResolvedValueOnce(false);
    expect(await canReadActiveShowcaseArtifact(student, "foreign", "version")).toBe(false);
    mocks.presentation.mockResolvedValueOnce(null);
    expect(await canReadActiveShowcaseArtifact(student, "classroom", "ended-version")).toBe(false);
  });
  it("revokes old active rows when the classroom closes or leaves showcase", async () => {
    mocks.course.mockResolvedValueOnce({ status: "finished", currentStageIndex: 0, stages: [{ key: "showcase" }] });
    expect(await canReadActiveShowcaseArtifact(student, "classroom", "version")).toBe(false);
    mocks.course.mockResolvedValueOnce({ status: "teaching", currentStageIndex: 0, stages: [{ key: "reflection" }] });
    expect(await canReadActiveShowcaseArtifact(student, "classroom", "version")).toBe(false);
    expect(mocks.presentation).not.toHaveBeenCalled();
  });
  it("permits only inline asset URLs referenced by the active version in the same offering", async () => {
    mocks.activeAssets.mockResolvedValue([{ artifactVersionId: "version", participation: { instanceId: "classroom", enrollment: { userId: "presenter" } }, artifactVersion: { sourceHtml: '<img src="/api/uploads/asset?download=0"><p>other-asset</p>' } }]);
    expect(await canReadActiveShowcaseAsset(student, { id: "asset", offeringId: "offering", uploadedById: "presenter" })).toBe(true);
    expect(await canReadActiveShowcaseAsset(student, { id: "other-asset", offeringId: "offering", uploadedById: "presenter" })).toBe(false);
    expect(await canReadActiveShowcaseAsset(student, { id: "asset", offeringId: "offering", uploadedById: "another-student" })).toBe(false);
    expect(mocks.activeAssets).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      artifactVersion: { artifact: { participation: { enrollment: { offeringId: "offering" } } } },
    }) }));
    mocks.presentation.mockResolvedValueOnce(null);
    expect(await canReadActiveShowcaseAsset(student, { id: "asset", offeringId: "offering", uploadedById: "presenter" })).toBe(false);
  });
});
