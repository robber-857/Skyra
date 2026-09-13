CREATE TABLE "BookingReschedule" (
 id UUID PRIMARY KEY, "shopId" UUID NOT NULL, "oldBookingId" UUID NOT NULL, "newBookingId" UUID NOT NULL,
 "idempotencyKey" UUID NOT NULL, "actorKind" TEXT NOT NULL CHECK ("actorKind" IN ('STAFF','CUSTOMER')), "actorId" TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500), "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY("shopId","oldBookingId") REFERENCES "Booking"("shopId",id),
 FOREIGN KEY("shopId","newBookingId") REFERENCES "Booking"("shopId",id),
 CHECK ("oldBookingId" <> "newBookingId")
);
CREATE UNIQUE INDEX "BookingReschedule_shopId_idempotencyKey_key" ON "BookingReschedule"("shopId","idempotencyKey");
CREATE UNIQUE INDEX "BookingReschedule_oldBookingId_key" ON "BookingReschedule"("oldBookingId");
CREATE UNIQUE INDEX "BookingReschedule_newBookingId_key" ON "BookingReschedule"("newBookingId");
CREATE TRIGGER immutable_booking_reschedule BEFORE UPDATE OR DELETE ON "BookingReschedule" FOR EACH ROW EXECUTE FUNCTION protect_booking_change();
ALTER TABLE "BookingChange" DROP CONSTRAINT "BookingChange_action_check";
ALTER TABLE "BookingChange" ADD CONSTRAINT "BookingChange_action_check" CHECK(action IN ('CANCEL','CANCEL_WAIVE','CHECK_IN','COMPLETE','NO_SHOW','RESCHEDULE'));
