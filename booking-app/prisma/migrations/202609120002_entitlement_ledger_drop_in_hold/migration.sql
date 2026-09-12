-- Allow the existing seat-hold primitive to represent either a new Pass or the
-- Session's own drop-in product. Existing rows remain NEW_PASS rows.
ALTER TABLE "BookingHold" ADD COLUMN "purchaseKind" TEXT NOT NULL DEFAULT 'NEW_PASS';
ALTER TABLE "BookingHold" ALTER COLUMN "passPlanId" DROP NOT NULL;
ALTER TABLE "BookingHold" DROP CONSTRAINT hold_values;
ALTER TABLE "BookingHold" ADD CONSTRAINT hold_values CHECK (
  status IN ('ACTIVE','CONSUMED','EXPIRED','RELEASED')
  AND "purchaseKind" IN ('NEW_PASS','DROP_IN')
  AND "expiresAt" > "createdAt"
  AND "expiresAt" <= "createdAt" + interval '15 minutes'
);
ALTER TABLE "BookingHold" ADD CONSTRAINT hold_purchase_target CHECK (
  ("purchaseKind" = 'NEW_PASS' AND "passPlanId" IS NOT NULL)
  OR ("purchaseKind" = 'DROP_IN' AND "passPlanId" IS NULL)
);

-- Composite tenant-safe foreign keys need a matching unique key.
CREATE UNIQUE INDEX "ProductMapping_shopId_id_key" ON "ProductMapping"("shopId", "id");

CREATE TABLE "Entitlement" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "passPlanId" UUID NOT NULL,
  "productMappingId" UUID NOT NULL,
  "sourceOrderGid" TEXT NOT NULL,
  "sourceLineItemGid" TEXT NOT NULL,
  "startsAt" TIMESTAMPTZ NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "grantedUnits" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EntitlementLedgerEntry" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "entitlementId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "availableDelta" INTEGER NOT NULL,
  "reservedDelta" INTEGER NOT NULL,
  "consumedDelta" INTEGER NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "reservationKey" UUID,
  "bookingId" UUID,
  "reason" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EntitlementLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Entitlement_shopId_id_key" ON "Entitlement"("shopId", "id");
CREATE UNIQUE INDEX "Entitlement_shopId_sourceOrderGid_sourceLineItemGid_key"
  ON "Entitlement"("shopId", "sourceOrderGid", "sourceLineItemGid");
CREATE INDEX "Entitlement_shopId_customerId_status_expiresAt_idx"
  ON "Entitlement"("shopId", "customerId", "status", "expiresAt");
CREATE UNIQUE INDEX "EntitlementLedgerEntry_shopId_id_key"
  ON "EntitlementLedgerEntry"("shopId", "id");
CREATE UNIQUE INDEX "EntitlementLedgerEntry_shopId_idempotencyKey_key"
  ON "EntitlementLedgerEntry"("shopId", "idempotencyKey");
CREATE INDEX "EntitlementLedgerEntry_shopId_entitlementId_createdAt_idx"
  ON "EntitlementLedgerEntry"("shopId", "entitlementId", "createdAt");
CREATE INDEX "EntitlementLedgerEntry_shopId_reservationKey_idx"
  ON "EntitlementLedgerEntry"("shopId", "reservationKey");
CREATE UNIQUE INDEX one_entitlement_reserve_per_key
  ON "EntitlementLedgerEntry"("shopId", "entitlementId", "reservationKey")
  WHERE kind = 'RESERVE';
CREATE UNIQUE INDEX one_entitlement_terminal_per_key
  ON "EntitlementLedgerEntry"("shopId", "entitlementId", "reservationKey")
  WHERE kind IN ('CONSUME','RELEASE');

ALTER TABLE "Entitlement" ADD CONSTRAINT entitlement_shop_fk
  FOREIGN KEY ("shopId") REFERENCES "Shop"(id);
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_shopId_customerId_fkey"
  FOREIGN KEY ("shopId", "customerId") REFERENCES "CustomerProfile"("shopId", id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_shopId_passPlanId_fkey"
  FOREIGN KEY ("shopId", "passPlanId") REFERENCES "PassPlan"("shopId", id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_shopId_productMappingId_fkey"
  FOREIGN KEY ("shopId", "productMappingId") REFERENCES "ProductMapping"("shopId", id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EntitlementLedgerEntry" ADD CONSTRAINT ledger_shop_fk
  FOREIGN KEY ("shopId") REFERENCES "Shop"(id);
ALTER TABLE "EntitlementLedgerEntry" ADD CONSTRAINT "EntitlementLedgerEntry_shopId_entitlementId_fkey"
  FOREIGN KEY ("shopId", "entitlementId") REFERENCES "Entitlement"("shopId", id) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EntitlementLedgerEntry" ADD CONSTRAINT "EntitlementLedgerEntry_shopId_bookingId_fkey"
  FOREIGN KEY ("shopId", "bookingId") REFERENCES "Booking"("shopId", id) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Entitlement" ADD CONSTRAINT entitlement_values CHECK (
  status IN ('PENDING','ACTIVE','EXPIRED','REVOKED')
  AND "grantedUnits" > 0
  AND "expiresAt" > "startsAt"
  AND "sourceOrderGid" ~ '^gid://shopify/Order/[1-9][0-9]*$'
  AND "sourceLineItemGid" ~ '^gid://shopify/LineItem/[1-9][0-9]*$'
);
ALTER TABLE "EntitlementLedgerEntry" ADD CONSTRAINT entitlement_ledger_shape CHECK (
  kind IN ('GRANT','RESERVE','CONSUME','RELEASE','ADJUST','EXPIRE','REVOKE')
  AND CASE kind
    WHEN 'GRANT' THEN "availableDelta" > 0 AND "reservedDelta" = 0 AND "consumedDelta" = 0
    WHEN 'RESERVE' THEN "availableDelta" = -1 AND "reservedDelta" = 1 AND "consumedDelta" = 0 AND "reservationKey" IS NOT NULL
    WHEN 'CONSUME' THEN "availableDelta" = 0 AND "reservedDelta" = -1 AND "consumedDelta" = 1 AND "reservationKey" IS NOT NULL
    WHEN 'RELEASE' THEN "availableDelta" = 1 AND "reservedDelta" = -1 AND "consumedDelta" = 0 AND "reservationKey" IS NOT NULL
    WHEN 'ADJUST' THEN "availableDelta" <> 0 AND "reservedDelta" = 0 AND "consumedDelta" = 0 AND length(trim(coalesce(reason, ''))) > 0
    WHEN 'EXPIRE' THEN "availableDelta" <= 0 AND "reservedDelta" = 0 AND "consumedDelta" = 0
    WHEN 'REVOKE' THEN "availableDelta" <= 0 AND "reservedDelta" = 0 AND "consumedDelta" = 0
  END
);

CREATE FUNCTION protect_entitlement_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."shopId" <> OLD."shopId"
    OR NEW."customerId" <> OLD."customerId"
    OR NEW."passPlanId" <> OLD."passPlanId"
    OR NEW."productMappingId" <> OLD."productMappingId"
    OR NEW."sourceOrderGid" <> OLD."sourceOrderGid"
    OR NEW."sourceLineItemGid" <> OLD."sourceLineItemGid"
    OR NEW."startsAt" <> OLD."startsAt"
    OR NEW."expiresAt" <> OLD."expiresAt"
    OR NEW."grantedUnits" <> OLD."grantedUnits" THEN
    RAISE EXCEPTION 'Entitlement source and ownership are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_entitlement_context BEFORE UPDATE ON "Entitlement"
  FOR EACH ROW EXECUTE FUNCTION protect_entitlement_context();

CREATE FUNCTION enforce_entitlement_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_available integer; current_reserved integer; current_consumed integer; entitlement_status text; entitlement_start timestamptz; entitlement_end timestamptz;
BEGIN
  SELECT status, "startsAt", "expiresAt" INTO entitlement_status, entitlement_start, entitlement_end
    FROM "Entitlement" WHERE "shopId" = NEW."shopId" AND id = NEW."entitlementId" FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entitlement not found'; END IF;
  SELECT coalesce(sum("availableDelta"), 0), coalesce(sum("reservedDelta"), 0), coalesce(sum("consumedDelta"), 0)
    INTO current_available, current_reserved, current_consumed
    FROM "EntitlementLedgerEntry" WHERE "shopId" = NEW."shopId" AND "entitlementId" = NEW."entitlementId";
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
CREATE TRIGGER entitlement_balance BEFORE INSERT ON "EntitlementLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION enforce_entitlement_balance();

CREATE FUNCTION prevent_entitlement_ledger_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Entitlement ledger is append-only';
END $$;
CREATE TRIGGER immutable_entitlement_ledger BEFORE UPDATE OR DELETE ON "EntitlementLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION prevent_entitlement_ledger_mutation();
