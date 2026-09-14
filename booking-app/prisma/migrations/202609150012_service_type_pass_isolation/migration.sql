ALTER TABLE "Service"
ADD CONSTRAINT "service_kind_supported"
CHECK (kind IN ('CLASS', 'APPOINTMENT', 'COURSE'));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "PassEligibility" eligibility
    JOIN "Service" service
      ON service.id = eligibility."serviceId"
     AND service."shopId" = eligibility."shopId"
    GROUP BY eligibility."shopId", eligibility."passPlanId"
    HAVING COUNT(DISTINCT service.kind) > 1
  ) THEN
    RAISE EXCEPTION 'Existing Pass eligibility mixes service types';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_pass_service_kind()
RETURNS trigger AS $$
DECLARE
  selected_kind TEXT;
BEGIN
  SELECT kind INTO selected_kind
  FROM "Service"
  WHERE id = NEW."serviceId" AND "shopId" = NEW."shopId";

  IF selected_kind IS NULL THEN
    RAISE EXCEPTION 'Eligible service was not found in this shop';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "PassEligibility" eligibility
    JOIN "Service" service
      ON service.id = eligibility."serviceId"
     AND service."shopId" = eligibility."shopId"
    WHERE eligibility."shopId" = NEW."shopId"
      AND eligibility."passPlanId" = NEW."passPlanId"
      AND service.kind <> selected_kind
      AND (
        TG_OP = 'INSERT'
        OR eligibility."serviceId" <> OLD."serviceId"
      )
  ) THEN
    RAISE EXCEPTION 'A Pass cannot mix service types';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pass_eligibility_service_kind
BEFORE INSERT OR UPDATE ON "PassEligibility"
FOR EACH ROW EXECUTE FUNCTION enforce_pass_service_kind();

CREATE OR REPLACE FUNCTION lock_pass_eligible_service_kind()
RETURNS trigger AS $$
BEGIN
  IF NEW.kind <> OLD.kind AND EXISTS (
    SELECT 1
    FROM "PassEligibility"
    WHERE "shopId" = OLD."shopId" AND "serviceId" = OLD.id
  ) THEN
    RAISE EXCEPTION 'Service type is locked while linked to a Pass';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER service_kind_pass_lock
BEFORE UPDATE OF kind ON "Service"
FOR EACH ROW EXECUTE FUNCTION lock_pass_eligible_service_kind();
