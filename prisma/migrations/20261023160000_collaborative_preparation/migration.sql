CREATE TABLE "CoursePreparationSession" (
  "id" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'DISCUSSING',
  "state" JSONB NOT NULL,
  "confirmedSnapshot" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoursePreparationSession_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CoursePreparationTurn" (
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "userMessage" TEXT NOT NULL,
  "request" JSONB NOT NULL,
  "result" JSONB,
  "error" TEXT,
  "executionId" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CoursePreparationTurn_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CoursePreparationSession_templateId_key" ON "CoursePreparationSession"("templateId");
CREATE INDEX "CoursePreparationSession_ownerId_updatedAt_idx" ON "CoursePreparationSession"("ownerId", "updatedAt");
CREATE UNIQUE INDEX "CoursePreparationTurn_sessionId_requestId_key" ON "CoursePreparationTurn"("sessionId", "requestId");
CREATE INDEX "CoursePreparationTurn_sessionId_revision_idx" ON "CoursePreparationTurn"("sessionId", "revision");
ALTER TABLE "CoursePreparationSession" ADD CONSTRAINT "CoursePreparationSession_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ClassroomTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CoursePreparationTurn" ADD CONSTRAINT "CoursePreparationTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CoursePreparationSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
