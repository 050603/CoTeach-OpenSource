-- Existing requests keep their receipt and synchronous recovery semantics.
ALTER TABLE "AiTask"
  ADD COLUMN "queueKey" TEXT,
  ADD COLUMN "availableAt" TIMESTAMP(3),
  ADD COLUMN "leaseUntil" TIMESTAMP(3),
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX "AiTask_queueKey_status_availableAt_idx" ON "AiTask"("queueKey", "status", "availableAt");
CREATE INDEX "AiTask_queueKey_createdById_startedAt_idx" ON "AiTask"("queueKey", "createdById", "startedAt");
