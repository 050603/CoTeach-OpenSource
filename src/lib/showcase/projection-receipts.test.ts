// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readShowcaseReceipts, recordShowcaseReceipt } from "./projection-receipts";

const receipt = { presentationId: "present", artifactVersionId: "version", revision: 3, status: "ready" as const };
describe("showcase render receipts", () => {
  it("binds reports to authenticated students and expires them", async () => {
    await recordShowcaseReceipt("receipts-A", "s1", { ...receipt, studentId: "forged" }, null, 1000);
    await recordShowcaseReceipt("receipts-B", "s2", receipt, null, 1000);
    expect(await readShowcaseReceipts("receipts-A", null, 2000)).toEqual([{ ...receipt, studentId: "s1", receivedAt: 1000 }]);
    expect(await readShowcaseReceipts("receipts-A", null, 46_000)).toEqual([]);
  });
  it("does not accept malformed receipt revisions or oversized identities", async () => {
    await recordShowcaseReceipt("receipts-C", "s1", { ...receipt, revision: -1 }, null, 1000);
    await recordShowcaseReceipt("receipts-C", "s1", { ...receipt, artifactVersionId: "x".repeat(200) }, null, 1000);
    expect(await readShowcaseReceipts("receipts-C", null, 2000)).toEqual([]);
  });
});
