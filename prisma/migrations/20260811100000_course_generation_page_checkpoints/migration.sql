ALTER TABLE "CourseGenerationJob"
ADD COLUMN "preparedOutlines" JSONB;

CREATE TABLE "CourseGenerationPageCheckpoint" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "pageKey" TEXT NOT NULL,
    "outlineFingerprint" TEXT NOT NULL,
    "outlineOrder" INTEGER NOT NULL,
    "scene" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseGenerationPageCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseGenerationPageCheckpoint_jobId_pageKey_key"
ON "CourseGenerationPageCheckpoint"("jobId", "pageKey");

CREATE INDEX "CourseGenerationPageCheckpoint_jobId_outlineOrder_idx"
ON "CourseGenerationPageCheckpoint"("jobId", "outlineOrder");

ALTER TABLE "CourseGenerationPageCheckpoint"
ADD CONSTRAINT "CourseGenerationPageCheckpoint_jobId_fkey"
FOREIGN KEY ("jobId") REFERENCES "CourseGenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
