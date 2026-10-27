import type { Prisma } from "@prisma/client";
import { CONTENT_MONITOR_QUEUE } from "./content-monitor-contract";

/** Invoke in the configuration/stage mutation transaction so even a quick off/on cannot revive old work. */
export async function cancelContentMonitorChecks(db: Pick<Prisma.TransactionClient, "$executeRaw">, courseId: string) {
  return db.$executeRaw`UPDATE "AiTask" SET status='CANCELLED', error='CONTENT_MONITOR_SCOPE_CLOSED',
    "completedAt"=clock_timestamp(), "leaseUntil"=NULL, "updatedAt"=clock_timestamp(),
    input=jsonb_build_object('requestId',input->'requestId','fingerprint',input->'fingerprint','courseId',input->'courseId',
      'studentId',input->'studentId','participationId',input->'participationId','submittedAt',input->'submittedAt')
    WHERE "queueKey"=${CONTENT_MONITOR_QUEUE} AND status IN ('PENDING','RUNNING') AND input->>'courseId'=${courseId}`;
}
