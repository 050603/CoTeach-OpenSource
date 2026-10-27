-- Immutable PDF project submissions used by the new showcase stage.
ALTER TABLE "Course" ADD COLUMN "presentingStudentId" TEXT;

CREATE TABLE "ProjectPdfVersion" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "groupId" TEXT,
    "stageKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "uploadId" TEXT NOT NULL,
    "sha256" TEXT,
    "size" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "requestId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectPdfVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShowcasePresentation" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "artifactKind" TEXT NOT NULL,
    "artifactVersionId" TEXT NOT NULL,
    "artifactTitle" TEXT NOT NULL,
    "displayMode" TEXT NOT NULL DEFAULT 'continuous',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "viewState" JSONB,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "requestId" TEXT,
    "rejectionReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowcasePresentation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProjectPdfVersion_courseId_studentId_sequence_key"
    ON "ProjectPdfVersion"("courseId", "studentId", "sequence");
CREATE UNIQUE INDEX "ProjectPdfVersion_courseId_requestId_key"
    ON "ProjectPdfVersion"("courseId", "requestId");
CREATE INDEX "ProjectPdfVersion_courseId_studentId_stageKey_createdAt_idx"
    ON "ProjectPdfVersion"("courseId", "studentId", "stageKey", "createdAt");
CREATE INDEX "ProjectPdfVersion_uploadId_idx"
    ON "ProjectPdfVersion"("uploadId");

CREATE UNIQUE INDEX "ShowcasePresentation_courseId_requestId_key"
    ON "ShowcasePresentation"("courseId", "requestId");
CREATE INDEX "ShowcasePresentation_courseId_status_updatedAt_idx"
    ON "ShowcasePresentation"("courseId", "status", "updatedAt");
CREATE INDEX "ShowcasePresentation_courseId_studentId_status_idx"
    ON "ShowcasePresentation"("courseId", "studentId", "status");
CREATE UNIQUE INDEX "ShowcasePresentation_one_pending_per_course_idx"
    ON "ShowcasePresentation"("courseId") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "ShowcasePresentation_one_active_per_course_idx"
    ON "ShowcasePresentation"("courseId") WHERE "status" = 'active';

ALTER TABLE "ProjectPdfVersion"
    ADD CONSTRAINT "ProjectPdfVersion_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShowcasePresentation"
    ADD CONSTRAINT "ShowcasePresentation_courseId_fkey"
    FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
