CREATE FUNCTION protect_hold_purchase_target() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."purchaseKind" <> OLD."purchaseKind"
    OR NEW."passPlanId" IS DISTINCT FROM OLD."passPlanId" THEN
    RAISE EXCEPTION 'Hold purchase target is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_hold_purchase_target BEFORE UPDATE ON "BookingHold"
  FOR EACH ROW EXECUTE FUNCTION protect_hold_purchase_target();

CREATE OR REPLACE FUNCTION enforce_entitlement_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_available integer; current_reserved integer; current_consumed integer; entitlement_status text; entitlement_start timestamptz; entitlement_end timestamptz; entitlement_granted integer;
BEGIN
  SELECT status, "startsAt", "expiresAt", "grantedUnits"
    INTO entitlement_status, entitlement_start, entitlement_end, entitlement_granted
    FROM "Entitlement" WHERE "shopId" = NEW."shopId" AND id = NEW."entitlementId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entitlement not found'; END IF;
  SELECT coalesce(sum("availableDelta"), 0), coalesce(sum("reservedDelta"), 0), coalesce(sum("consumedDelta"), 0)
    INTO current_available, current_reserved, current_consumed
    FROM "EntitlementLedgerEntry" WHERE "shopId" = NEW."shopId" AND "entitlementId" = NEW."entitlementId";
  IF NEW.kind = 'GRANT'
    AND (current_available <> 0 OR current_reserved <> 0 OR current_consumed <> 0 OR NEW."availableDelta" <> entitlement_granted) THEN
    RAISE EXCEPTION 'Entitlement grant must be the first entry and equal granted units';
  END IF;
  IF NEW.kind = 'RESERVE' AND (entitlement_status <> 'ACTIVE' OR clock_timestamp() < entitlement_start OR clock_timestamp() >= entitlement_end) THEN
    RAISE EXCEPTION 'Entitlement is not active';
  END IF;
  IF current_available + NEW."availableDelta" < 0
    OR current_reserved + NEW."reservedDelta" < 0
    OR current_consumed + NEW."consumedDelta" < 0 THEN
    RAISE EXCEPTION 'Entitlement balance cannot be negative';
  END IF;
  RETURN NEW;
END $$;
