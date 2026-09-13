ALTER TABLE "Booking" ADD COLUMN "ownedAttemptId" UUID;
CREATE UNIQUE INDEX "Booking_ownedAttemptId_key" ON "Booking"("ownedAttemptId");
ALTER TABLE "Booking" ADD CONSTRAINT booking_owned_attempt_fk
  FOREIGN KEY ("shopId", "ownedAttemptId", "sessionId", "customerId")
  REFERENCES "BookingAttempt"("shopId", id, "sessionId", "customerId");
ALTER TABLE "Booking" ADD CONSTRAINT booking_one_source CHECK ("ownedAttemptId" IS NULL OR "checkoutId" IS NULL);
CREATE FUNCTION protect_owned_booking_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."ownedAttemptId" IS DISTINCT FROM OLD."ownedAttemptId" THEN
    RAISE EXCEPTION 'Owned booking attempt is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_owned_booking_attempt BEFORE UPDATE ON "Booking"
  FOR EACH ROW EXECUTE FUNCTION protect_owned_booking_attempt();
