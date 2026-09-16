ALTER TABLE "Coach" ADD COLUMN "loginEmail" TEXT, ADD COLUMN "loginVerifiedAt" TIMESTAMPTZ;
CREATE UNIQUE INDEX "Coach_shopId_loginEmail_key" ON "Coach"("shopId", "loginEmail");
ALTER TABLE "Coach" ADD CONSTRAINT "Coach_loginEmail_normalized" CHECK ("loginEmail" IS NULL OR ("loginEmail" = LOWER(BTRIM("loginEmail")) AND LENGTH("loginEmail") <= 254 AND "loginEmail" LIKE '%@%'));
ALTER TABLE "CoachAccessToken" ADD COLUMN "loginEmail" TEXT;
CREATE TABLE "CoachLoginDelivery" (
  id UUID PRIMARY KEY,
  "tokenId" UUID NOT NULL UNIQUE REFERENCES "CoachAccessToken"(id),
  "shopId" UUID NOT NULL REFERENCES "Shop"(id),
  "coachId" UUID NOT NULL,
  "encryptedPayload" TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','ACCEPTED','FAILED','UNKNOWN','SUPPRESSED')),
  "providerMessageId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMPTZ,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  FOREIGN KEY ("shopId", "coachId") REFERENCES "Coach"("shopId", id),
  CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX "CoachLoginDelivery_status_createdAt_idx" ON "CoachLoginDelivery"(status,"createdAt");
