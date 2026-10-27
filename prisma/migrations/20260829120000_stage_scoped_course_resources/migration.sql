ALTER TABLE "CourseResource"
ADD COLUMN "stageKey" TEXT;

CREATE INDEX "CourseResource_courseId_stageKey_idx"
ON "CourseResource"("courseId", "stageKey");
