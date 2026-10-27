ALTER TABLE "ProjectPdfVersion"
ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'pdf',
ADD COLUMN "mimeType" TEXT NOT NULL DEFAULT 'application/pdf';
