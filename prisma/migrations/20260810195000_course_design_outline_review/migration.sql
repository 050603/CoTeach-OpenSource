ALTER TABLE "CourseDesignGenerationJob"
ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'unavailable',
ADD COLUMN "reviewAvailableUntil" TIMESTAMP(3);
