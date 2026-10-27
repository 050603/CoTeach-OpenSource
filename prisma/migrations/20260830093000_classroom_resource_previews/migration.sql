-- Keep the uploaded presentation as the source file while storing a derived,
-- fixed-layout classroom preview independently.
ALTER TABLE "CourseResource"
  ADD COLUMN "previewUrl" TEXT,
  ADD COLUMN "previewType" TEXT;

ALTER TABLE "UploadFile"
  ADD COLUMN "previewStoredName" TEXT,
  ADD COLUMN "previewMimeType" TEXT,
  ADD COLUMN "previewSize" INTEGER;

CREATE UNIQUE INDEX "UploadFile_previewStoredName_key"
  ON "UploadFile"("previewStoredName");
