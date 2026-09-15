ALTER TABLE "BookingCheckout"
  ADD COLUMN "handoffMode" TEXT NOT NULL DEFAULT 'STOREFRONT_API';

ALTER TABLE "BookingCheckout" DROP CONSTRAINT "checkout_values";
ALTER TABLE "BookingCheckout" ADD CONSTRAINT "checkout_values" CHECK (
  status IN ('CREATING','READY','UNKNOWN','REJECTED','INVALIDATED')
  AND "handoffMode" IN ('STOREFRONT_API','ONLINE_STORE_NATIVE')
  AND "priceCents" >= 0
  AND reference ~ '^[A-Za-z0-9_-]{43}$'
  AND "catalogFingerprint" ~ '^[a-f0-9]{64}$'
  AND "productGid" ~ '^gid://shopify/Product/[1-9][0-9]*$'
  AND "variantGid" ~ '^gid://shopify/ProductVariant/[1-9][0-9]*$'
  AND (
    status <> 'READY'
    OR "handoffMode" = 'ONLINE_STORE_NATIVE'
    OR "cartId" IS NOT NULL
  )
  AND ("handoffMode" <> 'ONLINE_STORE_NATIVE' OR "cartId" IS NULL)
);

CREATE OR REPLACE FUNCTION protect_checkout_context() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR NEW."handoffMode" <> OLD."handoffMode"
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
