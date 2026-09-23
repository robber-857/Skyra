-- Cash grants have their own source; paid Shopify records remain immutable.
ALTER TABLE "Entitlement" DROP CONSTRAINT entitlement_values;
ALTER TABLE "Entitlement" ADD CONSTRAINT entitlement_values CHECK (
  status IN ('PENDING','ACTIVE','EXPIRED','REVOKED') AND "grantedUnits" > 0
  AND (("startsAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "expiresAt" > "startsAt")
    OR ("startsAt" IS NULL AND "expiresAt" IS NULL AND "passPlanId" IS NOT NULL
      AND ("validityDays" IS NOT NULL OR "validityMonths" IS NOT NULL)))
  AND (("sourceSystem" = 'SHOPIFY' AND "sourceOrderGid" IS NOT NULL AND "sourceLineItemGid" IS NOT NULL
    AND "sourceOrderGid" ~ '^gid://shopify/Order/[1-9][0-9]*$'
    AND "sourceLineItemGid" ~ '^gid://shopify/LineItem/[1-9][0-9]*$' AND "externalKey" IS NULL)
    OR ("sourceSystem" IN ('MIND_BODY','MANUAL_CASH') AND "sourceOrderGid" IS NULL AND "sourceLineItemGid" IS NULL
      AND "externalKey" IS NOT NULL AND length("externalKey") > 0))
);

ALTER TABLE "EntitlementLedgerEntry" DROP CONSTRAINT entitlement_ledger_shape;
ALTER TABLE "EntitlementLedgerEntry" ADD CONSTRAINT entitlement_ledger_shape CHECK (
  CASE kind
    WHEN 'GRANT' THEN "availableDelta">0 AND "reservedDelta"=0 AND "consumedDelta"=0
    WHEN 'OPENING_BALANCE' THEN "availableDelta">=0 AND "reservedDelta"=0 AND "consumedDelta">=0 AND "availableDelta"+"consumedDelta">0
    WHEN 'RESERVE' THEN "availableDelta"=-1 AND "reservedDelta"=1 AND "consumedDelta"=0 AND "reservationKey" IS NOT NULL
    WHEN 'CONSUME' THEN "availableDelta"=0 AND "reservedDelta"=-1 AND "consumedDelta"=1 AND "reservationKey" IS NOT NULL
    WHEN 'RELEASE' THEN "availableDelta"=1 AND "reservedDelta"=-1 AND "consumedDelta"=0 AND "reservationKey" IS NOT NULL
    WHEN 'RESTORE' THEN "availableDelta"=1 AND "reservedDelta"=0 AND "consumedDelta"=-1 AND "reservationKey" IS NOT NULL AND "bookingId" IS NOT NULL AND length(trim(coalesce(reason,'')))>0
    WHEN 'ADJUST' THEN "availableDelta"<>0 AND "reservedDelta"=0 AND "consumedDelta"=0 AND length(trim(coalesce(reason,'')))>0
    WHEN 'EXPIRE' THEN "availableDelta"<=0 AND "reservedDelta"=0 AND "consumedDelta"=0
    WHEN 'REVOKE' THEN "availableDelta"<=0 AND "reservedDelta"=0 AND "consumedDelta"=0
    ELSE false END
);

CREATE UNIQUE INDEX one_entitlement_restore_per_key
  ON "EntitlementLedgerEntry"("shopId","entitlementId","reservationKey") WHERE kind='RESTORE';
CREATE FUNCTION validate_credit_restoration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='RESTORE' AND NOT EXISTS (
    SELECT 1 FROM "EntitlementLedgerEntry" WHERE "shopId"=NEW."shopId"
      AND "entitlementId"=NEW."entitlementId" AND "reservationKey"=NEW."reservationKey"
      AND "bookingId"=NEW."bookingId" AND kind='CONSUME'
  ) THEN RAISE EXCEPTION 'Restoration requires a consumed booking credit'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_credit_restoration BEFORE INSERT ON "EntitlementLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION validate_credit_restoration();
