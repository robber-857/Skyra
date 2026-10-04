CREATE TABLE "LegacyCheckoutClosure" (
  "checkoutId" UUID PRIMARY KEY,
  "shopId" UUID NOT NULL,
  "actorId" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legacy_closure_checkout_fk" FOREIGN KEY ("shopId", "checkoutId")
    REFERENCES "BookingCheckout" ("shopId", "id") ON DELETE RESTRICT,
  CONSTRAINT "legacy_closure_proof" CHECK (
    length("actorId") > 0 AND jsonb_typeof("evidence") = 'object'
    AND "evidence" @> '{"cartEmpty":true,"nativeCheckoutClosed":true,"matchingOrders":0}'::jsonb
  )
);
CREATE INDEX "LegacyCheckoutClosure_shopId_idx" ON "LegacyCheckoutClosure"("shopId");
CREATE FUNCTION protect_legacy_checkout_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Verified legacy checkout closure history is immutable';
END $$;
CREATE TRIGGER legacy_checkout_closure_immutable BEFORE UPDATE OR DELETE ON "LegacyCheckoutClosure"
  FOR EACH ROW EXECUTE FUNCTION protect_legacy_checkout_closure();
