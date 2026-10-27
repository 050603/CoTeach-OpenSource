-- Project-practice document versions and append-only AI collaboration audit.
CREATE TABLE "ProjectDocumentVersion" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "sourceHtml" TEXT NOT NULL,
    "docxUploadId" TEXT,
    "docxSha256" TEXT,
    "docxSize" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "error" TEXT,
    "requestId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectDocumentVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectDocumentVersion_submissionId_sequence_key"
    ON "ProjectDocumentVersion"("submissionId", "sequence");
CREATE UNIQUE INDEX "ProjectDocumentVersion_submissionId_requestId_key"
    ON "ProjectDocumentVersion"("submissionId", "requestId");
CREATE INDEX "ProjectDocumentVersion_courseId_studentId_stageKey_createdAt_idx"
    ON "ProjectDocumentVersion"("courseId", "studentId", "stageKey", "createdAt");
CREATE INDEX "ProjectDocumentVersion_submissionId_status_idx"
    ON "ProjectDocumentVersion"("submissionId", "status");

ALTER TABLE "ProjectDocumentVersion"
    ADD CONSTRAINT "ProjectDocumentVersion_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectDocumentVersion"
    ADD CONSTRAINT "ProjectDocumentVersion_submissionId_fkey"
    FOREIGN KEY ("submissionId") REFERENCES "ClassroomSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AiInteractionEvent" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "conversationId" TEXT,
    "source" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "actorId" TEXT,
    "content" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiInteractionEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiInteractionEvent_courseId_studentId_stageKey_createdAt_idx"
    ON "AiInteractionEvent"("courseId", "studentId", "stageKey", "createdAt");
CREATE INDEX "AiInteractionEvent_courseId_requestId_idx"
    ON "AiInteractionEvent"("courseId", "requestId");
CREATE INDEX "AiInteractionEvent_courseId_source_createdAt_idx"
    ON "AiInteractionEvent"("courseId", "source", "createdAt");

ALTER TABLE "AiInteractionEvent"
    ADD CONSTRAINT "AiInteractionEvent_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
