CREATE TABLE "CoachAccessToken" (
  id UUID PRIMARY KEY,
  "shopId" UUID NOT NULL REFERENCES "Shop"(id),
  "coachId" UUID NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE CHECK ("tokenHash" ~ '^[a-f0-9]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('LOGIN','SESSION')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CONSUMED','REVOKED')),
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("shopId","coachId") REFERENCES "Coach"("shopId",id),
  CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX "CoachAccessToken_shopId_coachId_status_idx" ON "CoachAccessToken"("shopId","coachId",status);
