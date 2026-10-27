-- Authentication/session invalidation.
ALTER TABLE "Teacher"
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "StudentAccount"
  ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "nameKey" TEXT;

WITH ranked AS (
  SELECT
    "id",
    lower(trim("studentName")) AS normalized,
    row_number() OVER (
      PARTITION BY "courseId", lower(trim("studentName"))
      ORDER BY "createdAt", "id"
    ) AS duplicate_number
  FROM "StudentAccount"
)
UPDATE "StudentAccount" AS account
SET "nameKey" = CASE
  WHEN ranked.duplicate_number = 1 THEN ranked.normalized
  ELSE ranked.normalized || ':' || account."id"
END
FROM ranked
WHERE ranked."id" = account."id";

ALTER TABLE "StudentAccount"
  ALTER COLUMN "nameKey" SET NOT NULL;

CREATE UNIQUE INDEX "StudentAccount_courseId_nameKey_key"
  ON "StudentAccount"("courseId", "nameKey");

-- Upload ownership and unguessable storage identifiers.
ALTER TABLE "UploadFile"
  ADD COLUMN "uploadedById" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "uploadedByRole" TEXT NOT NULL DEFAULT 'teacher';

ALTER TABLE "UploadFile"
  ALTER COLUMN "uploadedById" DROP DEFAULT,
  ALTER COLUMN "uploadedByRole" DROP DEFAULT;

CREATE UNIQUE INDEX "UploadFile_storedName_key" ON "UploadFile"("storedName");
CREATE INDEX "UploadFile_uploadedById_idx" ON "UploadFile"("uploadedById");

-- Normalized high-contention collections.
CREATE TABLE "GroupMember" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "studentName" TEXT NOT NULL,
  "role" TEXT,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TodoCompletion" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "todoId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TodoCompletion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnnouncementReply" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "announcementId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "authorName" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnnouncementReply_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResourceDownload" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "studentName" TEXT NOT NULL,
  "downloadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResourceDownload_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GroupMember_courseId_groupId_studentId_key"
  ON "GroupMember"("courseId", "groupId", "studentId");
CREATE INDEX "GroupMember_courseId_studentId_idx"
  ON "GroupMember"("courseId", "studentId");
CREATE UNIQUE INDEX "TodoCompletion_courseId_todoId_studentId_key"
  ON "TodoCompletion"("courseId", "todoId", "studentId");
CREATE INDEX "TodoCompletion_courseId_studentId_idx"
  ON "TodoCompletion"("courseId", "studentId");
CREATE UNIQUE INDEX "AnnouncementReply_courseId_announcementId_id_key"
  ON "AnnouncementReply"("courseId", "announcementId", "id");
CREATE INDEX "AnnouncementReply_courseId_announcementId_createdAt_idx"
  ON "AnnouncementReply"("courseId", "announcementId", "createdAt");
CREATE UNIQUE INDEX "ResourceDownload_courseId_resourceId_studentId_key"
  ON "ResourceDownload"("courseId", "resourceId", "studentId");
CREATE INDEX "ResourceDownload_courseId_studentId_idx"
  ON "ResourceDownload"("courseId", "studentId");

ALTER TABLE "GroupMember"
  ADD CONSTRAINT "GroupMember_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember"
  ADD CONSTRAINT "GroupMember_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "ProjectGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TodoCompletion"
  ADD CONSTRAINT "TodoCompletion_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TodoCompletion"
  ADD CONSTRAINT "TodoCompletion_todoId_fkey"
  FOREIGN KEY ("todoId") REFERENCES "CourseTodo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnnouncementReply"
  ADD CONSTRAINT "AnnouncementReply_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnnouncementReply"
  ADD CONSTRAINT "AnnouncementReply_announcementId_fkey"
  FOREIGN KEY ("announcementId") REFERENCES "CourseAnnouncement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceDownload"
  ADD CONSTRAINT "ResourceDownload_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceDownload"
  ADD CONSTRAINT "ResourceDownload_resourceId_fkey"
  FOREIGN KEY ("resourceId") REFERENCES "CourseResource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Durable event replay and idempotent write receipts.
CREATE TABLE "CourseEvent" (
  "cursor" BIGSERIAL NOT NULL,
  "courseId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "actorRole" TEXT NOT NULL,
  "courseVersion" INTEGER NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CourseEvent_pkey" PRIMARY KEY ("cursor")
);

CREATE TABLE "CourseMutationReceipt" (
  "requestId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "courseVersion" INTEGER,
  "eventCursor" BIGINT,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "CourseMutationReceipt_pkey" PRIMARY KEY ("requestId")
);

CREATE UNIQUE INDEX "CourseEvent_requestId_key" ON "CourseEvent"("requestId");
CREATE INDEX "CourseEvent_courseId_cursor_idx" ON "CourseEvent"("courseId", "cursor");
CREATE INDEX "CourseEvent_courseId_createdAt_idx" ON "CourseEvent"("courseId", "createdAt");
CREATE INDEX "CourseMutationReceipt_courseId_createdAt_idx"
  ON "CourseMutationReceipt"("courseId", "createdAt");

-- Provider credentials are encrypted by the application with AES-256-GCM.
CREATE TABLE "ProviderCredential" (
  "section" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "encryptedApiKey" BYTEA,
  "iv" BYTEA,
  "authTag" BYTEA,
  "config" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("section", "providerId")
);

CREATE INDEX "ProviderCredential_updatedAt_idx" ON "ProviderCredential"("updatedAt");

-- Explicit ownership marker for isolated load-test fixtures.
CREATE TABLE "LoadTestRun" (
  "runId" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "studentCount" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "LoadTestRun_pkey" PRIMARY KEY ("runId")
);

CREATE UNIQUE INDEX "LoadTestRun_teacherId_key" ON "LoadTestRun"("teacherId");
CREATE UNIQUE INDEX "LoadTestRun_courseId_key" ON "LoadTestRun"("courseId");
CREATE INDEX "LoadTestRun_expiresAt_idx" ON "LoadTestRun"("expiresAt");
