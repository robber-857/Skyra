CREATE TABLE "CoachAccountRequest" (
  id UUID PRIMARY KEY,
  "shopId" UUID NOT NULL REFERENCES "Shop"(id),
  name TEXT NOT NULL CHECK (LENGTH(name) BETWEEN 2 AND 100),
  email TEXT NOT NULL CHECK (email = LOWER(BTRIM(email)) AND LENGTH(email) <= 254 AND email LIKE '%@%'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  "approvedCoachId" UUID,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("shopId", "approvedCoachId") REFERENCES "Coach"("shopId", id),
  CHECK ((status='PENDING' AND "reviewedAt" IS NULL AND "reviewedBy" IS NULL AND "approvedCoachId" IS NULL) OR (status='APPROVED' AND "reviewedAt" IS NOT NULL AND "reviewedBy" IS NOT NULL AND "approvedCoachId" IS NOT NULL) OR (status='REJECTED' AND "reviewedAt" IS NOT NULL AND "reviewedBy" IS NOT NULL AND "approvedCoachId" IS NULL))
);
CREATE UNIQUE INDEX "CoachAccountRequest_shopId_email_key" ON "CoachAccountRequest"("shopId", email);
CREATE INDEX "CoachAccountRequest_shopId_status_createdAt_idx" ON "CoachAccountRequest"("shopId", status, "createdAt");
