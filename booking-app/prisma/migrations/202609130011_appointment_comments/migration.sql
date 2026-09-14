ALTER TABLE "BookingAttempt" ADD COLUMN "customerComment" TEXT NOT NULL DEFAULT '' CHECK(length("customerComment")<=1000);
ALTER TABLE "Booking" ADD COLUMN "customerComment" TEXT NOT NULL DEFAULT '' CHECK(length("customerComment")<=1000);
ALTER TABLE "Service" ADD CONSTRAINT appointment_capacity_one CHECK(kind <> 'APPOINTMENT' OR capacity=1);
CREATE FUNCTION protect_appointment_slot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "Service" WHERE id=NEW."serviceId" AND kind='APPOINTMENT') AND NEW.capacity<>1 THEN RAISE EXCEPTION 'Appointment capacity must be one'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER appointment_slot_capacity BEFORE INSERT OR UPDATE ON "ClassSession" FOR EACH ROW EXECUTE FUNCTION protect_appointment_slot();
CREATE FUNCTION protect_scheduled_service_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS(SELECT 1 FROM "ClassSession" WHERE "serviceId"=OLD.id) THEN RAISE EXCEPTION 'Scheduled service kind is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scheduled_service_kind BEFORE UPDATE ON "Service" FOR EACH ROW EXECUTE FUNCTION protect_scheduled_service_kind();
CREATE FUNCTION protect_confirmed_booking_comment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."customerComment" IS DISTINCT FROM OLD."customerComment" THEN RAISE EXCEPTION 'Booking comment is a confirmation snapshot'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER confirmed_booking_comment BEFORE UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION protect_confirmed_booking_comment();
