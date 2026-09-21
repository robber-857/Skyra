ALTER TABLE "PassPlan" ADD COLUMN "validityMonths" INTEGER CHECK ("validityMonths" BETWEEN 1 AND 120);
ALTER TABLE "Entitlement"
  ALTER COLUMN "sourceOrderGid" DROP NOT NULL,
  ALTER COLUMN "sourceLineItemGid" DROP NOT NULL,
  ALTER COLUMN "startsAt" DROP NOT NULL,
  ALTER COLUMN "expiresAt" DROP NOT NULL,
  ADD COLUMN "sourceSystem" TEXT NOT NULL DEFAULT 'SHOPIFY',
  ADD COLUMN "externalKey" TEXT,
  ADD COLUMN "validityDays" INTEGER CHECK ("validityDays" > 0),
  ADD COLUMN "validityMonths" INTEGER CHECK ("validityMonths" BETWEEN 1 AND 120),
  ADD COLUMN "activationTimezone" TEXT NOT NULL DEFAULT 'Australia/Sydney',
  ADD COLUMN "activationBookingId" UUID;
ALTER TABLE "Entitlement" DROP CONSTRAINT entitlement_values;
ALTER TABLE "Entitlement" ADD CONSTRAINT entitlement_values CHECK (
  status IN ('PENDING','ACTIVE','EXPIRED','REVOKED') AND "grantedUnits" > 0
  AND (("startsAt" IS NOT NULL AND "expiresAt" IS NOT NULL AND "expiresAt" > "startsAt")
    OR ("startsAt" IS NULL AND "expiresAt" IS NULL AND "passPlanId" IS NOT NULL
      AND ("validityDays" IS NOT NULL OR "validityMonths" IS NOT NULL)))
  AND (("sourceSystem" = 'SHOPIFY' AND "sourceOrderGid" IS NOT NULL AND "sourceLineItemGid" IS NOT NULL
    AND "sourceOrderGid" ~ '^gid://shopify/Order/[1-9][0-9]*$'
    AND "sourceLineItemGid" ~ '^gid://shopify/LineItem/[1-9][0-9]*$' AND "externalKey" IS NULL)
    OR ("sourceSystem" = 'MIND_BODY' AND "sourceOrderGid" IS NULL AND "sourceLineItemGid" IS NULL
      AND "externalKey" IS NOT NULL AND length("externalKey") > 0))
);
CREATE UNIQUE INDEX "Entitlement_shopId_sourceSystem_externalKey_key" ON "Entitlement"("shopId","sourceSystem","externalKey");
ALTER TABLE "Entitlement" ADD CONSTRAINT entitlement_activation_booking_fk FOREIGN KEY ("shopId","activationBookingId") REFERENCES "Booking"("shopId",id);
CREATE OR REPLACE FUNCTION protect_entitlement_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."shopId" <> OLD."shopId" OR NEW."customerId" <> OLD."customerId"
    OR NEW."passPlanId" IS DISTINCT FROM OLD."passPlanId"
    OR NEW."serviceId" IS DISTINCT FROM OLD."serviceId"
    OR NEW."productMappingId" <> OLD."productMappingId"
    OR NEW."sourceOrderGid" IS DISTINCT FROM OLD."sourceOrderGid"
    OR NEW."sourceLineItemGid" IS DISTINCT FROM OLD."sourceLineItemGid"
    OR NEW."sourceSystem" <> OLD."sourceSystem" OR NEW."externalKey" IS DISTINCT FROM OLD."externalKey"
    OR NEW."validityDays" IS DISTINCT FROM OLD."validityDays"
    OR NEW."validityMonths" IS DISTINCT FROM OLD."validityMonths"
    OR NEW."activationTimezone" <> OLD."activationTimezone"
    OR (OLD."startsAt" IS NOT NULL AND (NEW."startsAt" IS DISTINCT FROM OLD."startsAt"
      OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
      OR NEW."activationBookingId" IS DISTINCT FROM OLD."activationBookingId"))
    OR NEW."grantedUnits" <> OLD."grantedUnits" THEN
    RAISE EXCEPTION 'Entitlement source and ownership are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION enforce_entitlement_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_available integer; current_reserved integer; current_consumed integer;
  entitlement_status text; entitlement_start timestamptz; entitlement_end timestamptz;
  entitlement_granted integer; source_system text; class_start timestamptz;
BEGIN
  SELECT status,"startsAt","expiresAt","grantedUnits","sourceSystem"
    INTO entitlement_status,entitlement_start,entitlement_end,entitlement_granted,source_system
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
    IF entitlement_status<>'ACTIVE' OR entitlement_start IS NULL OR entitlement_end IS NULL
      OR class_start IS NULL OR class_start<entitlement_start OR class_start>=entitlement_end THEN
      RAISE EXCEPTION 'Entitlement is not active for the class';
    END IF;
  END IF;
  IF current_available+NEW."availableDelta"<0 OR current_reserved+NEW."reservedDelta"<0
    OR current_consumed+NEW."consumedDelta"<0 THEN RAISE EXCEPTION 'Entitlement balance cannot be negative'; END IF;
  RETURN NEW;
END $$;
ALTER TABLE "EntitlementLedgerEntry" DROP CONSTRAINT entitlement_ledger_shape;
ALTER TABLE "EntitlementLedgerEntry" ADD CONSTRAINT entitlement_ledger_shape CHECK (
  CASE kind
    WHEN 'GRANT' THEN "availableDelta">0 AND "reservedDelta"=0 AND "consumedDelta"=0
    WHEN 'OPENING_BALANCE' THEN "availableDelta">=0 AND "reservedDelta"=0 AND "consumedDelta">=0 AND "availableDelta"+"consumedDelta">0
    WHEN 'RESERVE' THEN "availableDelta"=-1 AND "reservedDelta"=1 AND "consumedDelta"=0 AND "reservationKey" IS NOT NULL
    WHEN 'CONSUME' THEN "availableDelta"=0 AND "reservedDelta"=-1 AND "consumedDelta"=1 AND "reservationKey" IS NOT NULL
    WHEN 'RELEASE' THEN "availableDelta"=1 AND "reservedDelta"=-1 AND "consumedDelta"=0 AND "reservationKey" IS NOT NULL
    WHEN 'ADJUST' THEN "availableDelta"<>0 AND "reservedDelta"=0 AND "consumedDelta"=0 AND length(trim(coalesce(reason,'')))>0
    WHEN 'EXPIRE' THEN "availableDelta"<=0 AND "reservedDelta"=0 AND "consumedDelta"=0
    WHEN 'REVOKE' THEN "availableDelta"<=0 AND "reservedDelta"=0 AND "consumedDelta"=0
    ELSE false END
);
CREATE TABLE "MigrationBatch" (
  id UUID PRIMARY KEY, "shopId" UUID NOT NULL REFERENCES "Shop"(id), "sourceSystem" TEXT NOT NULL,
  "externalKey" TEXT NOT NULL, "inputHash" TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1, counts JSONB NOT NULL DEFAULT '{}', "errorCode" TEXT,
  "actorId" TEXT NOT NULL, "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "completedAt" TIMESTAMPTZ,
  UNIQUE("shopId","sourceSystem","externalKey"), UNIQUE("shopId",id)
);
CREATE TABLE "MigrationSource" (
  id UUID PRIMARY KEY, "shopId" UUID NOT NULL REFERENCES "Shop"(id), "sourceSystem" TEXT NOT NULL,
  "entityType" TEXT NOT NULL, "externalKey" TEXT NOT NULL, "inputHash" TEXT NOT NULL,
  "targetId" UUID NOT NULL, "batchId" UUID NOT NULL,
  FOREIGN KEY ("shopId","batchId") REFERENCES "MigrationBatch"("shopId",id),
  UNIQUE("shopId","sourceSystem","entityType","externalKey")
);
