-- Staff cash grants can contain multiple credits for one service.
-- Shopify drop-in purchases still grant exactly one credit.
ALTER TABLE "Entitlement" DROP CONSTRAINT entitlement_purchase_target;
ALTER TABLE "Entitlement" ADD CONSTRAINT entitlement_purchase_target CHECK (
  ("passPlanId" IS NOT NULL AND "serviceId" IS NULL)
  OR ("passPlanId" IS NULL AND "serviceId" IS NOT NULL
    AND ("grantedUnits" = 1 OR "sourceSystem" = 'MANUAL_CASH'))
);
