-- Existing accounts opt in from their authenticated student profile.
ALTER TABLE "User" ADD COLUMN "recoveryCodeHash" TEXT;
