-- AlterTable
ALTER TABLE "PassPlan" ADD COLUMN     "autoRenewEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sellingPlanGid" TEXT,
ADD COLUMN     "standalonePurchaseEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Entitlement" ADD COLUMN     "activationMode" TEXT NOT NULL DEFAULT 'FIRST_BOOKING';

-- CreateTable
CREATE TABLE "PassMembership" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "passPlanId" UUID NOT NULL,
    "contractGid" TEXT,
    "autoRenew" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',
    "currentCycle" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PassMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PassPurchase" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "membershipId" UUID NOT NULL,
    "cycle" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "reference" TEXT NOT NULL,
    "bookingCheckoutId" UUID,
    "cartId" TEXT,
    "productMappingId" UUID NOT NULL,
    "productGid" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "sellingPlanGid" TEXT,
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'AUD',
    "credits" INTEGER NOT NULL,
    "validityDays" INTEGER NOT NULL,
    "validityMonths" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Sydney',
    "termsVersion" TEXT NOT NULL,
    "autoRenewTermsVersion" TEXT,
    "entitlementId" UUID,
    "sourceOrderGid" TEXT,
    "sourceLineItemGid" TEXT,
    "billingAttemptGid" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "submittedAt" TIMESTAMPTZ,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PassPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PassMembership_shopId_customerId_passPlanId_key" ON "PassMembership"("shopId", "customerId", "passPlanId");

-- CreateIndex
CREATE UNIQUE INDEX "PassMembership_shopId_contractGid_key" ON "PassMembership"("shopId", "contractGid");

-- CreateIndex
CREATE UNIQUE INDEX "PassMembership_shopId_id_key" ON "PassMembership"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PassPurchase_reference_key" ON "PassPurchase"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "PassPurchase_bookingCheckoutId_key" ON "PassPurchase"("bookingCheckoutId");

-- CreateIndex
CREATE UNIQUE INDEX "PassPurchase_entitlementId_key" ON "PassPurchase"("entitlementId");

-- CreateIndex
CREATE UNIQUE INDEX "PassPurchase_billingAttemptGid_key" ON "PassPurchase"("billingAttemptGid");

-- CreateIndex
CREATE UNIQUE INDEX "PassPurchase_idempotencyKey_key" ON "PassPurchase"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PassPurchase_status_updatedAt_idx" ON "PassPurchase"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PassPurchase_shopId_id_key" ON "PassPurchase"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PassPurchase_membershipId_cycle_key" ON "PassPurchase"("membershipId", "cycle");

-- CreateIndex
CREATE UNIQUE INDEX "PassPurchase_shopId_sourceOrderGid_sourceLineItemGid_key" ON "PassPurchase"("shopId", "sourceOrderGid", "sourceLineItemGid");

-- AddForeignKey
ALTER TABLE "PassPurchase" ADD CONSTRAINT "PassPurchase_shopId_membershipId_fkey" FOREIGN KEY ("shopId", "membershipId") REFERENCES "PassMembership"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PassMembership" ADD CONSTRAINT "membership_customer_fk" FOREIGN KEY ("shopId", "customerId") REFERENCES "CustomerProfile"("shopId", "id");
ALTER TABLE "PassMembership" ADD CONSTRAINT "membership_plan_fk" FOREIGN KEY ("shopId", "passPlanId") REFERENCES "PassPlan"("shopId", "id");
ALTER TABLE "PassPurchase" ADD CONSTRAINT "membership_purchase_mapping_fk" FOREIGN KEY ("shopId", "productMappingId") REFERENCES "ProductMapping"("shopId", "id");
ALTER TABLE "PassPurchase" ADD CONSTRAINT "membership_purchase_checkout_fk" FOREIGN KEY ("shopId", "bookingCheckoutId") REFERENCES "BookingCheckout"("shopId", "id");
ALTER TABLE "PassPurchase" ADD CONSTRAINT "membership_purchase_entitlement_fk" FOREIGN KEY ("shopId", "entitlementId") REFERENCES "Entitlement"("shopId", "id");
ALTER TABLE "PassPurchase" ADD CONSTRAINT "membership_purchase_positive_terms" CHECK (cycle > 0 AND "priceCents" > 0 AND credits > 0 AND "validityDays" > 0 AND ("validityMonths" IS NULL OR "validityMonths" > 0));
CREATE UNIQUE INDEX "membership_one_open_payment" ON "PassPurchase" ("membershipId") WHERE status <> 'PAID';
