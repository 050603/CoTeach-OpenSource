ALTER TABLE "Course"
ADD COLUMN "learningEvidence" JSONB,
ADD COLUMN "artifactSnapshots" JSONB,
ADD COLUMN "aiContributions" JSONB,
ADD COLUMN "studentAiDecisions" JSONB,
ADD COLUMN "aiAssessmentSuggestions" JSONB;

