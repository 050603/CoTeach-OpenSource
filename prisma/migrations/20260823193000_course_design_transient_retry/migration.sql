ALTER TABLE "CourseDesignGenerationJob"
ADD COLUMN "retryAt" TIMESTAMP(3);

CREATE INDEX "CourseDesignGenerationJob_status_retryAt_idx"
ON "CourseDesignGenerationJob"("status", "retryAt");
