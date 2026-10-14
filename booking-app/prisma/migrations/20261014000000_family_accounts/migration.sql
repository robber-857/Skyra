ALTER TABLE "CustomerProfile" ADD COLUMN "familyParentId" UUID;
ALTER TABLE "CustomerProfile" ADD CONSTRAINT "CustomerProfile_family_parent_not_self" CHECK ("familyParentId" IS NULL OR "familyParentId" <> "id");
CREATE INDEX "CustomerProfile_shopId_familyParentId_idx" ON "CustomerProfile"("shopId", "familyParentId");
ALTER TABLE "CustomerProfile" ADD CONSTRAINT "CustomerProfile_shopId_familyParentId_fkey" FOREIGN KEY ("shopId", "familyParentId") REFERENCES "CustomerProfile"("shopId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

CREATE TABLE "FamilyMemberCreation" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "parentId" UUID NOT NULL,
  "idempotencyKey" UUID NOT NULL,
  "inputHash" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "shopifyCustomerGid" TEXT,
  "customerId" UUID,
  "claimedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "FamilyMemberCreation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FamilyMemberCreation_shopId_parentId_fkey" FOREIGN KEY ("shopId", "parentId") REFERENCES "CustomerProfile"("shopId", "id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "FamilyMemberCreation_shopId_parentId_idempotencyKey_key" ON "FamilyMemberCreation"("shopId", "parentId", "idempotencyKey");
CREATE UNIQUE INDEX "FamilyMemberCreation_shopId_email_key" ON "FamilyMemberCreation"("shopId", "email");
CREATE INDEX "FamilyMemberCreation_shopId_status_idx" ON "FamilyMemberCreation"("shopId", "status");

ALTER TABLE "BookingCheckout" ADD COLUMN "payerCustomerGid" TEXT;
ALTER TABLE "PassMembership" ADD COLUMN "payerCustomerGid" TEXT;
ALTER TABLE "PassPurchase" ADD COLUMN "payerCustomerGid" TEXT;

-- Payer identity is part of the original commerce context, including legacy NULLs.
CREATE FUNCTION prevent_commerce_payer_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."payerCustomerGid" IS DISTINCT FROM OLD."payerCustomerGid" THEN
    RAISE EXCEPTION 'Commerce payer identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_booking_checkout_payer BEFORE UPDATE ON "BookingCheckout" FOR EACH ROW EXECUTE FUNCTION prevent_commerce_payer_change();
CREATE TRIGGER immutable_pass_purchase_payer BEFORE UPDATE ON "PassPurchase" FOR EACH ROW EXECUTE FUNCTION prevent_commerce_payer_change();
CREATE TRIGGER immutable_pass_membership_payer BEFORE UPDATE ON "PassMembership" FOR EACH ROW EXECUTE FUNCTION prevent_commerce_payer_change();

CREATE FUNCTION validate_family_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_family UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."familyParentId" IS NOT NULL AND NEW."familyParentId" IS DISTINCT FROM OLD."familyParentId" THEN
    RAISE EXCEPTION 'Family membership cannot be reassigned or removed';
  END IF;
  IF NEW."familyParentId" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW."familyParentId" IS NOT DISTINCT FROM OLD."familyParentId" THEN RETURN NEW; END IF;
  SELECT "familyParentId" INTO parent_family FROM "CustomerProfile" WHERE "shopId" = NEW."shopId" AND id = NEW."familyParentId" FOR UPDATE;
  IF NOT FOUND OR parent_family IS NOT NULL THEN RAISE EXCEPTION 'Family parent must be a root client in the same shop'; END IF;
  IF EXISTS (SELECT 1 FROM "CustomerProfile" WHERE "shopId" = NEW."shopId" AND "familyParentId" = NEW.id) THEN
    RAISE EXCEPTION 'A family parent cannot become a child';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER valid_customer_family_parent BEFORE INSERT OR UPDATE OF "familyParentId" ON "CustomerProfile" FOR EACH ROW EXECUTE FUNCTION validate_family_parent();
