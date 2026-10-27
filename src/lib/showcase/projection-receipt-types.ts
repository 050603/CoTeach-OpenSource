export type ShowcaseProjectionReceipt = {
  presentationId: string;
  artifactVersionId: string;
  revision: number;
  status: "loading" | "ready" | "error";
};

export type ShowcaseProjectionReport = ShowcaseProjectionReceipt & {
  studentId: string;
  receivedAt: number;
};

export const SHOWCASE_RECEIPT_TTL_MS = 45_000;

export function validShowcaseReceipt(value: unknown): value is ShowcaseProjectionReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as ShowcaseProjectionReceipt;
  return typeof receipt.presentationId === "string" && receipt.presentationId.length > 0 && receipt.presentationId.length <= 128
    && typeof receipt.artifactVersionId === "string" && receipt.artifactVersionId.length > 0 && receipt.artifactVersionId.length <= 128
    && Number.isSafeInteger(receipt.revision) && receipt.revision >= 0
    && ["loading", "ready", "error"].includes(receipt.status);
}
