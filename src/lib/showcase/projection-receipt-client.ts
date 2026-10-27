import type { ShowcaseProjectionReceipt } from "./projection-receipt-types";

const receipts = new Map<string, ShowcaseProjectionReceipt>();
export function showcaseReceipt(courseId: string) { return receipts.get(courseId); }
export function setShowcaseReceipt(courseId: string, receipt: ShowcaseProjectionReceipt | undefined) {
  const previous = receipts.get(courseId);
  if (receipt) receipts.set(courseId, receipt);
  else receipts.delete(courseId);
  if (previous?.presentationId !== receipt?.presentationId || previous?.artifactVersionId !== receipt?.artifactVersionId || previous?.status !== receipt?.status)
    window.dispatchEvent(new CustomEvent("openpbl-showcase-receipt", { detail: courseId }));
}
