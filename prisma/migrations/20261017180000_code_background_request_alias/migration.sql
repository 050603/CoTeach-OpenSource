CREATE TABLE "AiTaskRequestAlias" (
  "participationId" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "bodyDigest" TEXT NOT NULL,
  "requestBody" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiTaskRequestAlias_pkey" PRIMARY KEY ("participationId", "clientRequestId"),
  CONSTRAINT "AiTaskRequestAlias_participationId_fkey" FOREIGN KEY ("participationId") REFERENCES "ClassroomParticipation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "AiTaskRequestAlias_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "AiTask"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AiTaskRequestAlias_taskId_idx" ON "AiTaskRequestAlias"("taskId");
