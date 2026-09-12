CREATE UNIQUE INDEX "BookingHold_shopId_id_key" ON "BookingHold"("shopId", "id");

CREATE TABLE "BookingCheckout" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "holdId" UUID NOT NULL,
  "productMappingId" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "productGid" TEXT NOT NULL,
  "variantGid" TEXT NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "catalogFingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'CREATING',
  "cartId" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "BookingCheckout_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "checkout_hold_fk" FOREIGN KEY ("shopId","holdId")
    REFERENCES "BookingHold"("shopId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "checkout_mapping_fk" FOREIGN KEY ("shopId","productMappingId")
    REFERENCES "ProductMapping"("shopId","id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "checkout_values" CHECK (
    status IN ('CREATING','READY','UNKNOWN','REJECTED','INVALIDATED')
    AND "priceCents" >= 0
    AND reference ~ '^[A-Za-z0-9_-]{43}$'
    AND "catalogFingerprint" ~ '^[a-f0-9]{64}$'
    AND "productGid" ~ '^gid://shopify/Product/[1-9][0-9]*$'
    AND "variantGid" ~ '^gid://shopify/ProductVariant/[1-9][0-9]*$'
    AND (status <> 'READY' OR "cartId" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "BookingCheckout_holdId_key" ON "BookingCheckout"("holdId");
CREATE UNIQUE INDEX "BookingCheckout_shopId_holdId_key" ON "BookingCheckout"("shopId","holdId");
CREATE UNIQUE INDEX "BookingCheckout_reference_key" ON "BookingCheckout"("reference");
CREATE UNIQUE INDEX "BookingCheckout_shopId_cartId_key" ON "BookingCheckout"("shopId","cartId");
CREATE INDEX "BookingCheckout_shopId_status_createdAt_idx" ON "BookingCheckout"("shopId","status","createdAt");

-- Keep a durable single creation claim, including uncertain network outcomes.
CREATE FUNCTION protect_checkout_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Checkout creation history cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR NEW."shopId" <> OLD."shopId"
    OR NEW."holdId" <> OLD."holdId" OR NEW."reference" <> OLD."reference"
    OR NEW."productMappingId" <> OLD."productMappingId"
    OR NEW."productGid" <> OLD."productGid" OR NEW."variantGid" <> OLD."variantGid"
    OR NEW."priceCents" <> OLD."priceCents"
    OR NEW."catalogFingerprint" <> OLD."catalogFingerprint"
    OR NEW."createdAt" <> OLD."createdAt"
    OR (OLD."cartId" IS NOT NULL AND NEW."cartId" IS DISTINCT FROM OLD."cartId") THEN
    RAISE EXCEPTION 'Checkout context cannot be reassigned';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    OLD.status = 'CREATING' AND NEW.status IN ('READY','UNKNOWN','REJECTED','INVALIDATED')
    OR OLD.status = 'READY' AND NEW.status = 'INVALIDATED'
  ) THEN
    RAISE EXCEPTION 'Checkout creation cannot be replayed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_checkout_context BEFORE UPDATE OR DELETE ON "BookingCheckout"
  FOR EACH ROW EXECUTE FUNCTION protect_checkout_context();
