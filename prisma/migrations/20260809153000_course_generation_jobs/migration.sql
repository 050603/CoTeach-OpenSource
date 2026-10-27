CREATE TABLE "CourseGenerationJob" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "requestedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "step" TEXT NOT NULL DEFAULT 'queued',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL DEFAULT '课程生成任务已创建',
    "scenesGenerated" INTEGER NOT NULL DEFAULT 0,
    "totalScenes" INTEGER NOT NULL DEFAULT 0,
    "estimatedRemainingSeconds" INTEGER,
    "request" JSONB NOT NULL,
    "result" JSONB,
    "events" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CourseGenerationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseGenerationJob_courseId_key" ON "CourseGenerationJob"("courseId");
CREATE INDEX "CourseGenerationJob_status_createdAt_idx" ON "CourseGenerationJob"("status", "createdAt");
CREATE INDEX "CourseGenerationJob_lastHeartbeatAt_idx" ON "CourseGenerationJob"("lastHeartbeatAt");

ALTER TABLE "CourseGenerationJob"
ADD CONSTRAINT "CourseGenerationJob_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
