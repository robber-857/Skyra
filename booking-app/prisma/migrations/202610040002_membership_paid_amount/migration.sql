ALTER TABLE "PassPurchase" ADD COLUMN "paidPriceCents" INTEGER;
ALTER TABLE "PassPurchase" ADD CONSTRAINT "membership_paid_amount_range"
  CHECK ("paidPriceCents" IS NULL OR ("paidPriceCents" >= 0 AND "paidPriceCents" <= "priceCents"));
