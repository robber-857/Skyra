-- Additive migration: historical checkouts without frozen terms require review.
ALTER TABLE "BookingCheckout" ADD COLUMN "purchaseTerms" JSONB;
CREATE FUNCTION protect_checkout_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."purchaseTerms" IS DISTINCT FROM OLD."purchaseTerms" THEN
    RAISE EXCEPTION 'Checkout purchase terms are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_checkout_terms BEFORE UPDATE ON "BookingCheckout"
  FOR EACH ROW EXECUTE FUNCTION protect_checkout_terms();

ALTER TABLE "Entitlement" ALTER COLUMN "passPlanId" DROP NOT NULL;
ALTER TABLE "Entitlement" ADD COLUMN "serviceId" UUID;
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_shopId_serviceId_fkey"
  FOREIGN KEY ("shopId", "serviceId") REFERENCES "Service"("shopId", id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Entitlement" ADD CONSTRAINT entitlement_purchase_target CHECK (
  ("passPlanId" IS NOT NULL AND "serviceId" IS NULL)
  OR ("passPlanId" IS NULL AND "serviceId" IS NOT NULL AND "grantedUnits" = 1)
);
CREATE OR REPLACE FUNCTION protect_entitlement_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."shopId" <> OLD."shopId" OR NEW."customerId" <> OLD."customerId"
    OR NEW."passPlanId" IS DISTINCT FROM OLD."passPlanId"
    OR NEW."serviceId" IS DISTINCT FROM OLD."serviceId"
    OR NEW."productMappingId" <> OLD."productMappingId"
    OR NEW."sourceOrderGid" <> OLD."sourceOrderGid"
    OR NEW."sourceLineItemGid" <> OLD."sourceLineItemGid"
    OR NEW."startsAt" <> OLD."startsAt" OR NEW."expiresAt" <> OLD."expiresAt"
    OR NEW."grantedUnits" <> OLD."grantedUnits" THEN
    RAISE EXCEPTION 'Entitlement source and ownership are immutable';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE "Booking" ADD COLUMN "checkoutId" UUID;
ALTER TABLE "Booking" ADD COLUMN "sourceOrderGid" TEXT;
ALTER TABLE "Booking" ADD COLUMN "sourceLineItemGid" TEXT;
CREATE UNIQUE INDEX "BookingCheckout_shopId_id_key" ON "BookingCheckout"("shopId",id);
CREATE UNIQUE INDEX "Booking_checkoutId_key" ON "Booking"("checkoutId");
CREATE UNIQUE INDEX "Booking_shopId_sourceOrderGid_sourceLineItemGid_key"
  ON "Booking"("shopId","sourceOrderGid","sourceLineItemGid");
ALTER TABLE "Booking" ADD CONSTRAINT booking_checkout_fk FOREIGN KEY ("shopId","checkoutId") REFERENCES "BookingCheckout"("shopId",id);
ALTER TABLE "Booking" ADD CONSTRAINT booking_order_source CHECK (
  ("checkoutId" IS NULL AND "sourceOrderGid" IS NULL AND "sourceLineItemGid" IS NULL)
  OR ("checkoutId" IS NOT NULL AND "sourceOrderGid" IS NOT NULL AND "sourceLineItemGid" IS NOT NULL
    AND "sourceOrderGid" ~ '^gid://shopify/Order/[1-9][0-9]*$'
    AND "sourceLineItemGid" ~ '^gid://shopify/LineItem/[1-9][0-9]*$')
);
CREATE FUNCTION protect_booking_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."checkoutId" IS DISTINCT FROM OLD."checkoutId"
    OR NEW."sourceOrderGid" IS DISTINCT FROM OLD."sourceOrderGid"
    OR NEW."sourceLineItemGid" IS DISTINCT FROM OLD."sourceLineItemGid" THEN
    RAISE EXCEPTION 'Booking payment source is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_booking_source BEFORE UPDATE ON "Booking"
  FOR EACH ROW EXECUTE FUNCTION protect_booking_source();
ALTER TABLE "BookingAttempt" DROP CONSTRAINT attempt_values;
ALTER TABLE "BookingAttempt" ADD CONSTRAINT attempt_values CHECK (
  surface IN ('HOME','PROGRAMS')
  AND status IN ('LOGIN_REQUIRED','STARTED','HOLD_ACTIVE','RECOVERY','EXPIRED','CONFIRMED')
  AND "expiresAt" > "createdAt"
);
CREATE INDEX "ClassSession_shopId_coachId_startsAt_idx" ON "ClassSession"("shopId","coachId","startsAt");
CREATE TABLE "BookingNotification" (
  id UUID PRIMARY KEY,
  "shopId" UUID NOT NULL REFERENCES "Shop"(id),
  "bookingId" UUID NOT NULL,
  "recipientKind" TEXT NOT NULL CHECK ("recipientKind" IN ('CUSTOMER','COACH')),
  "recipientId" UUID NOT NULL,
  template TEXT NOT NULL DEFAULT 'BOOKING_CONFIRMED_V1' CHECK (template = 'BOOKING_CONFIRMED_V1'),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENDING','ACCEPTED','FAILED','UNKNOWN','SUPPRESSED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMPTZ,
  "acceptedAt" TIMESTAMPTZ,
  "providerMessageId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("shopId","bookingId") REFERENCES "Booking"("shopId",id)
);
CREATE UNIQUE INDEX "BookingNotification_recipient_key" ON "BookingNotification"("shopId","bookingId","recipientKind","recipientId",template);
CREATE INDEX "BookingNotification_status_availableAt_idx" ON "BookingNotification"(status,"availableAt");
CREATE TABLE "PaidBookingResult" (
  id UUID PRIMARY KEY,
  "shopId" UUID NOT NULL REFERENCES "Shop"(id),
  "checkoutId" UUID NOT NULL UNIQUE,
  "sourceOrderGid" TEXT NOT NULL,
  "sourceLineItemGid" TEXT NOT NULL,
  "entitlementId" UUID,
  "bookingId" UUID,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED','NEEDS_ATTENTION')),
  reason TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("shopId","checkoutId") REFERENCES "BookingCheckout"("shopId",id),
  FOREIGN KEY ("shopId","entitlementId") REFERENCES "Entitlement"("shopId",id),
  FOREIGN KEY ("shopId","bookingId") REFERENCES "Booking"("shopId",id),
  CHECK (status <> 'CONFIRMED' OR ("entitlementId" IS NOT NULL AND "bookingId" IS NOT NULL))
);
CREATE UNIQUE INDEX "PaidBookingResult_shopId_sourceOrderGid_sourceLineItemGid_key" ON "PaidBookingResult"("shopId","sourceOrderGid","sourceLineItemGid");
CREATE INDEX "PaidBookingResult_shopId_status_createdAt_idx" ON "PaidBookingResult"("shopId",status,"createdAt");
