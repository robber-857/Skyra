ALTER TABLE "BookingNotification" ADD COLUMN "eventKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BookingNotification" ADD COLUMN "snapshot" JSONB;
ALTER TABLE "BookingNotification" ADD COLUMN "deliveryStatus" TEXT;
ALTER TABLE "BookingNotification" ADD COLUMN "deliveryCheckedAt" TIMESTAMPTZ;
ALTER TABLE "BookingNotification" ADD COLUMN "deliveryError" TEXT;
DROP INDEX "BookingNotification_recipient_key";
CREATE UNIQUE INDEX "BookingNotification_event_key" ON "BookingNotification" ("shopId", "bookingId", "recipientKind", "recipientId", "template", "eventKey");
