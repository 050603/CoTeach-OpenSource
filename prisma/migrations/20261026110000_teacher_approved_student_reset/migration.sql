CREATE TABLE "StudentPasswordResetRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "offeringId" TEXT,
    "usedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    CONSTRAINT "StudentPasswordResetRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StudentPasswordResetRequest_requestHash_key" ON "StudentPasswordResetRequest"("requestHash");
CREATE INDEX "StudentPasswordResetRequest_userId_createdAt_idx" ON "StudentPasswordResetRequest"("userId", "createdAt");
ALTER TABLE "StudentPasswordResetRequest" ADD CONSTRAINT "StudentPasswordResetRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StudentPasswordResetRequest" ADD CONSTRAINT "StudentPasswordResetRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "StudentPasswordResetRequest" ADD CONSTRAINT "StudentPasswordResetRequest_offeringId_fkey" FOREIGN KEY ("offeringId") REFERENCES "CourseOffering"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Retire previously issued bearer links and recovery codes without removing history.
UPDATE "PasswordResetToken" SET "usedAt" = CURRENT_TIMESTAMP WHERE "usedAt" IS NULL;
UPDATE "User" SET "recoveryCodeHash" = NULL WHERE "recoveryCodeHash" IS NOT NULL;
