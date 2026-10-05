ALTER TABLE "PassPlan" ADD COLUMN "oneTimePurchaseEnabled" BOOLEAN NOT NULL DEFAULT true;

-- The owner's AUD 299 Lifestyle monthly offer is renewal-only. Preserve all
-- existing purchases, contracts, entitlements and other catalogue offers.
UPDATE "PassPlan" AS p
SET "oneTimePurchaseEnabled" = false, "updatedAt" = CURRENT_TIMESTAMP
FROM "Shop" AS s
WHERE p."shopId" = s.id
  AND s.domain = 'mf0n6s-zg.myshopify.com'
  AND p.name = 'SKYRA Lifestyle 1 month'
  AND p."requestedPriceCents" = 29900
  AND p."validityMonths" = 1
  AND p.credits = 12;
