-- Preserve all ledger invariants; attendance-based Passes may reserve a seat
-- before their first attended class fixes the validity window.
CREATE OR REPLACE FUNCTION enforce_entitlement_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_available integer; current_reserved integer; current_consumed integer;
  entitlement_status text; entitlement_start timestamptz; entitlement_end timestamptz;
  entitlement_granted integer; source_system text; class_start timestamptz; activation_mode text;
BEGIN
  SELECT status,"startsAt","expiresAt","grantedUnits","sourceSystem","activationMode"
    INTO entitlement_status,entitlement_start,entitlement_end,entitlement_granted,source_system,activation_mode
    FROM "Entitlement" WHERE "shopId"=NEW."shopId" AND id=NEW."entitlementId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entitlement not found'; END IF;
  SELECT coalesce(sum("availableDelta"),0),coalesce(sum("reservedDelta"),0),coalesce(sum("consumedDelta"),0)
    INTO current_available,current_reserved,current_consumed FROM "EntitlementLedgerEntry"
    WHERE "shopId"=NEW."shopId" AND "entitlementId"=NEW."entitlementId";
  IF NEW.kind IN ('GRANT','OPENING_BALANCE') AND (EXISTS (
    SELECT 1 FROM "EntitlementLedgerEntry" WHERE "shopId"=NEW."shopId" AND "entitlementId"=NEW."entitlementId")
    OR NEW."availableDelta"+NEW."consumedDelta"<>entitlement_granted) THEN
    RAISE EXCEPTION 'Entitlement grant must be the first entry and equal granted units';
  END IF;
  IF NEW.kind='OPENING_BALANCE' AND source_system<>'MIND_BODY' THEN
    RAISE EXCEPTION 'Opening balance requires migration source';
  END IF;
  IF NEW.kind='RESERVE' THEN
    class_start := clock_timestamp();
    IF NEW."bookingId" IS NOT NULL THEN
      SELECT s."startsAt" INTO class_start FROM "Booking" b JOIN "ClassSession" s
        ON s."shopId"=b."shopId" AND s.id=b."sessionId"
        WHERE b."shopId"=NEW."shopId" AND b.id=NEW."bookingId";
    END IF;
    IF entitlement_status<>'ACTIVE' OR class_start IS NULL OR
      NOT ((activation_mode='FIRST_ATTENDANCE' AND entitlement_start IS NULL AND entitlement_end IS NULL AND NEW."bookingId" IS NOT NULL)
        OR (entitlement_start IS NOT NULL AND entitlement_end IS NOT NULL AND class_start>=entitlement_start AND class_start<entitlement_end)) THEN
      RAISE EXCEPTION 'Entitlement is not active for the class';
    END IF;
  END IF;
  IF current_available+NEW."availableDelta"<0 OR current_reserved+NEW."reservedDelta"<0
    OR current_consumed+NEW."consumedDelta"<0 THEN RAISE EXCEPTION 'Entitlement balance cannot be negative'; END IF;
  RETURN NEW;
END $$;
