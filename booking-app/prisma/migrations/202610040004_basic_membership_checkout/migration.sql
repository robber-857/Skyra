CREATE TABLE "MembershipCheckoutResource" (
  "purchaseId" UUID PRIMARY KEY REFERENCES "PassPurchase"("id"),
  "shopId" UUID NOT NULL,
  "state" TEXT NOT NULL CHECK ("state" IN ('CREATING','VERIFYING','READY','REVIEW')),
  "productGid" TEXT UNIQUE,
  "variantGid" TEXT UNIQUE,
  "inventoryItemGid" TEXT,
  "locationGid" TEXT NOT NULL,
  "publicationGid" TEXT NOT NULL,
  "sellingPlanGroupGid" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL,
  FOREIGN KEY ("shopId", "purchaseId") REFERENCES "PassPurchase"("shopId", "id")
);
CREATE INDEX "MembershipCheckoutResource_shopId_state_idx" ON "MembershipCheckoutResource"("shopId", "state");
