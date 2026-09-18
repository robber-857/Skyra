ALTER TABLE "CustomerProfile"
  ADD COLUMN "shopifyName" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "email" TEXT,
  ADD COLUMN "contactSyncedAt" TIMESTAMPTZ;
CREATE INDEX "CustomerProfile_shopId_createdAt_idx" ON "CustomerProfile"("shopId", "createdAt");