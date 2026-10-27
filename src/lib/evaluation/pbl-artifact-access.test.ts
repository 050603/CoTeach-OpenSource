// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthClaims } from "@/lib/auth/session";
const mocks = vi.hoisted(() => ({ first: vi.fn(), many: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { peerReviewAssignment: { findFirst: mocks.first, findMany: mocks.many } } }));
import { canReadPblPeerArtifact, canReadPblPeerAsset } from "./pbl-artifact-access";
const student = { sub: "s", role: "student" } as AuthClaims;
const assignment = () => ({ instance: { runtimeConfig: { evaluationContractVersion: 2 }, activity: { chapter: { offeringId: "o" } } }, reviewer: { enrollment: { offeringId: "o" } }, target: { enrollment: { offeringId: "o" } } });
beforeEach(() => { vi.resetAllMocks(); mocks.first.mockResolvedValue(assignment()); mocks.many.mockResolvedValue([]); });
describe("assigned peer artifact access", () => {
  it("requires the current student assignment, exact submitted version and matching enrollment scope", async () => {
    expect(await canReadPblPeerArtifact(student, "i", "v")).toBe(true);
    expect(mocks.first).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instanceId: "i", artifactVersionId: "v", status: "ACTIVE", reviewer: expect.objectContaining({ enrollment: expect.objectContaining({ userId: "s" }) }), artifactVersion: expect.objectContaining({ status: "SUBMITTED" }) }) }));
    mocks.first.mockResolvedValueOnce(null); expect(await canReadPblPeerArtifact(student, "i", "foreign")).toBe(false);
    mocks.first.mockResolvedValueOnce({ ...assignment(), target: { enrollment: { offeringId: "other" } } }); expect(await canReadPblPeerArtifact(student, "i", "v")).toBe(false);
    mocks.first.mockResolvedValueOnce({ ...assignment(), instance: { ...assignment().instance, runtimeConfig: {} } }); expect(await canReadPblPeerArtifact(student, "i", "v")).toBe(false);
  });
  it("does not grant generic teacher access through the peer exception", async () => {
    expect(await canReadPblPeerArtifact({ sub: "t", role: "teacher" } as AuthClaims, "i", "v")).toBe(false); expect(mocks.first).not.toHaveBeenCalled();
  });
  it("permits referenced inline files without opening unrelated uploads or private versions", async () => {
    const file = { id: "f", offeringId: "o", uploadedById: "owner" };
    mocks.many.mockResolvedValue([{ instanceId: "i", artifactVersionId: "v", artifactVersion: { sourceHtml: '<img src="/api/uploads/f"/>', fileAssetId: null } }]);
    expect(await canReadPblPeerAsset(student, file)).toBe(true);
    expect(mocks.many).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ target: { enrollment: expect.objectContaining({ userId: "owner", offeringId: "o" }) } }) }));
    mocks.many.mockResolvedValue([{ instanceId: "i", artifactVersionId: "v", artifactVersion: { sourceHtml: '<p>/api/uploads/f</p>', fileAssetId: null } }]);
    expect(await canReadPblPeerAsset(student, file)).toBe(false);
    mocks.many.mockResolvedValue([{ instanceId: "i", artifactVersionId: "v", artifactVersion: { sourceHtml: null, fileAssetId: "f" } }]); mocks.first.mockResolvedValue(null);
    expect(await canReadPblPeerAsset(student, file)).toBe(false);
  });
});
