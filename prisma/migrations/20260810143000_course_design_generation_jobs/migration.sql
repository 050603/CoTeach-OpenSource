CREATE TABLE "CourseDesignGenerationJob" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "requestedBy" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "step" TEXT NOT NULL DEFAULT 'queued',
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL DEFAULT '快速生成任务已创建',
    "estimatedRemainingSeconds" INTEGER,
    "request" JSONB NOT NULL,
    "trace" JSONB NOT NULL DEFAULT '[]',
    "qualityReport" JSONB,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CourseDesignGenerationJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CourseDesignGenerationJob_courseId_key" ON "CourseDesignGenerationJob"("courseId");
CREATE INDEX "CourseDesignGenerationJob_status_createdAt_idx" ON "CourseDesignGenerationJob"("status", "createdAt");
CREATE INDEX "CourseDesignGenerationJob_lastHeartbeatAt_idx" ON "CourseDesignGenerationJob"("lastHeartbeatAt");

ALTER TABLE "CourseDesignGenerationJob"
ADD CONSTRAINT "CourseDesignGenerationJob_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
