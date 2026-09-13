ALTER TABLE "Booking" ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE "Booking" ADD COLUMN "checkedInAt" TIMESTAMPTZ;
CREATE TABLE "BookingChange" (
 id UUID PRIMARY KEY, "shopId" UUID NOT NULL, "bookingId" UUID NOT NULL,
 "idempotencyKey" UUID NOT NULL, "actorKind" TEXT NOT NULL CHECK("actorKind" IN ('STAFF','COACH','CUSTOMER')),
 "actorId" TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('CANCEL','CANCEL_WAIVE','CHECK_IN','COMPLETE','NO_SHOW')),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500), "fromStatus" TEXT NOT NULL, "toStatus" TEXT NOT NULL,
 "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY("shopId","bookingId") REFERENCES "Booking"("shopId",id)
);
CREATE UNIQUE INDEX "BookingChange_shopId_idempotencyKey_key" ON "BookingChange"("shopId","idempotencyKey");
CREATE INDEX "BookingChange_shopId_bookingId_createdAt_idx" ON "BookingChange"("shopId","bookingId","createdAt");
CREATE FUNCTION protect_booking_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Booking changes are append-only'; END $$;
CREATE TRIGGER immutable_booking_change BEFORE UPDATE OR DELETE ON "BookingChange" FOR EACH ROW EXECUTE FUNCTION protect_booking_change();
ALTER TABLE "BookingNotification" DROP CONSTRAINT "BookingNotification_template_check";
ALTER TABLE "BookingNotification" ADD CONSTRAINT "BookingNotification_template_check" CHECK(template IN ('BOOKING_CONFIRMED_V1','BOOKING_CANCELLED_V1'));
