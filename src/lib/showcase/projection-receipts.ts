import type { RedisClientType } from "redis";
import { SHOWCASE_RECEIPT_TTL_MS, validShowcaseReceipt, type ShowcaseProjectionReport } from "./projection-receipt-types";

const local = new Map<string, ShowcaseProjectionReport>();
const key = (courseId: string) => `openpbl:showcase-receipts:${courseId}`;

export async function recordShowcaseReceipt(courseId: string, studentId: string, value: unknown, redis: RedisClientType | null, now = Date.now()) {
  if (!validShowcaseReceipt(value)) return;
  const report: ShowcaseProjectionReport = { presentationId: value.presentationId, artifactVersionId: value.artifactVersionId,
    revision: value.revision, status: value.status, studentId, receivedAt: now };
  if (redis) {
    await redis.multi().hSet(key(courseId), studentId, JSON.stringify(report)).expire(key(courseId), 120).exec();
  } else {
    for (const [id, item] of local) if (now - item.receivedAt >= SHOWCASE_RECEIPT_TTL_MS) local.delete(id);
    if (local.size >= 4096) local.delete(local.keys().next().value!);
    local.set(JSON.stringify([courseId, studentId]), report);
  }
}

export async function readShowcaseReceipts(courseId: string, redis: RedisClientType | null, now = Date.now()): Promise<ShowcaseProjectionReport[]> {
  const reports = redis ? Object.values(await redis.hGetAll(key(courseId))).flatMap(value => {
    try { return [JSON.parse(value) as ShowcaseProjectionReport]; } catch { return []; }
  }) : [...local.entries()].filter(([id]) => id.startsWith(JSON.stringify([courseId]).slice(0, -1) + ",")).map(([, report]) => report);
  return reports.filter(report => validShowcaseReceipt(report) && typeof report.studentId === "string"
    && Number.isFinite(report.receivedAt) && now - report.receivedAt < SHOWCASE_RECEIPT_TTL_MS && now >= report.receivedAt);
}
