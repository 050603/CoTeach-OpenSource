ALTER TABLE "CourseResource"
ADD COLUMN "displayMode" TEXT;

ALTER TABLE "CourseResource"
ADD CONSTRAINT "CourseResource_displayMode_check"
CHECK ("displayMode" IS NULL OR "displayMode" IN ('document', 'slides'));
