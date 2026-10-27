ALTER TABLE "Evaluation" ADD COLUMN "pblKey" TEXT;
CREATE UNIQUE INDEX "Evaluation_pblKey_key" ON "Evaluation"("pblKey");
CREATE TABLE "PeerReviewAssignment" (
  "id" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "reviewerParticipationId" TEXT NOT NULL,
  "targetParticipationId" TEXT NOT NULL,
  "artifactVersionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PeerReviewAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PeerReviewAssignment_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "ClassroomInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PeerReviewAssignment_reviewerParticipationId_fkey" FOREIGN KEY ("reviewerParticipationId") REFERENCES "ClassroomParticipation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PeerReviewAssignment_targetParticipationId_fkey" FOREIGN KEY ("targetParticipationId") REFERENCES "ClassroomParticipation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PeerReviewAssignment_artifactVersionId_fkey" FOREIGN KEY ("artifactVersionId") REFERENCES "ArtifactVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PeerReviewAssignment_no_self_review" CHECK ("reviewerParticipationId" <> "targetParticipationId")
);
CREATE UNIQUE INDEX "PeerReviewAssignment_instanceId_reviewerParticipationId_tar_key" ON "PeerReviewAssignment"("instanceId", "reviewerParticipationId", "targetParticipationId");
CREATE INDEX "PeerReviewAssignment_reviewerParticipationId_status_idx" ON "PeerReviewAssignment"("reviewerParticipationId", "status");
CREATE INDEX "PeerReviewAssignment_targetParticipationId_status_idx" ON "PeerReviewAssignment"("targetParticipationId", "status");
