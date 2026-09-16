ALTER TABLE "Shop"
  ADD COLUMN "operationsEmail" TEXT;

ALTER TABLE "Coach"
  ADD COLUMN "notificationEmail" TEXT;

ALTER TABLE "BookingNotification"
  ADD COLUMN "readAt" TIMESTAMPTZ;

CREATE INDEX "BookingNotification_shopId_recipientKind_recipientId_readAt_createdAt_idx"
  ON "BookingNotification"("shopId", "recipientKind", "recipientId", "readAt", "createdAt");
