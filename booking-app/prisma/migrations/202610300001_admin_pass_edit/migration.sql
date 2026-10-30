ALTER TABLE "Entitlement" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0;

-- Permit expiry corrections, preserving purchase ownership and activation history.
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
      OR NEW."activationBookingId" IS DISTINCT FROM OLD."activationBookingId"))
    OR NEW."grantedUnits" <> OLD."grantedUnits" THEN
    RAISE EXCEPTION 'Entitlement source and ownership are immutable';
  END IF;
  NEW.revision := OLD.revision + 1;
  RETURN NEW;
END $$;

-- One durable receipt per shop/request, including expiry-only changes.
CREATE UNIQUE INDEX pass_update_receipt ON "AuditLog" ("shopId", "entityId") WHERE action = 'PASS_UPDATED';
