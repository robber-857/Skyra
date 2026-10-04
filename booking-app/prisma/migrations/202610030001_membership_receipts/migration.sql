CREATE TABLE "MembershipReceipt" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "purchaseId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "passPlanId" UUID NOT NULL,
  "passName" TEXT NOT NULL,
  "cycle" INTEGER NOT NULL,
  "mode" TEXT NOT NULL,
  "sourceOrderGid" TEXT NOT NULL,
  "sourceLineItemGid" TEXT NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "currency" TEXT NOT NULL,
  "credits" INTEGER NOT NULL,
  "validityDays" INTEGER NOT NULL,
  "validityMonths" INTEGER,
  "timezone" TEXT NOT NULL,
  "termsVersion" TEXT NOT NULL,
  "paidAt" TIMESTAMPTZ,
  "issuedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "snapshotHash" TEXT NOT NULL,
  CONSTRAINT "MembershipReceipt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipReceipt_terms_check" CHECK (
    "cycle" > 0 AND "priceCents" > 0 AND "credits" > 0 AND "validityDays" > 0
    AND ("validityMonths" IS NULL OR "validityMonths" > 0)
  )
);
CREATE UNIQUE INDEX "MembershipReceipt_purchaseId_key" ON "MembershipReceipt" ("purchaseId");
CREATE UNIQUE INDEX "MembershipReceipt_shopId_id_key" ON "MembershipReceipt" ("shopId", "id");
CREATE UNIQUE INDEX "MembershipReceipt_shopId_purchaseId_key" ON "MembershipReceipt" ("shopId", "purchaseId");
CREATE UNIQUE INDEX "MembershipReceipt_order_line_key" ON "MembershipReceipt" ("shopId", "sourceOrderGid", "sourceLineItemGid");
CREATE INDEX "MembershipReceipt_customer_issued_idx" ON "MembershipReceipt" ("shopId", "customerId", "issuedAt");
ALTER TABLE "MembershipReceipt" ADD CONSTRAINT "MembershipReceipt_purchase_fkey"
  FOREIGN KEY ("shopId", "purchaseId") REFERENCES "PassPurchase" ("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "MembershipNotification" (
  "id" UUID NOT NULL,
  "shopId" UUID NOT NULL,
  "purchaseId" UUID NOT NULL,
  "receiptId" UUID NOT NULL,
  "event" TEXT NOT NULL DEFAULT 'PAID',
  "template" TEXT NOT NULL DEFAULT 'MEMBERSHIP_PAID_V1',
  "subject" TEXT NOT NULL,
  "bodyText" TEXT NOT NULL,
  "recipientEmail" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMPTZ,
  "acceptedAt" TIMESTAMPTZ,
  "providerMessageId" TEXT,
  "deliveryStatus" TEXT,
  "deliveryCheckedAt" TIMESTAMPTZ,
  "deliveryError" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipNotification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MembershipNotification_status_check" CHECK ("status" IN ('PENDING', 'SENDING', 'ACCEPTED', 'FAILED', 'UNKNOWN')),
  CONSTRAINT "MembershipNotification_event_check" CHECK ("event" = 'PAID')
);
CREATE UNIQUE INDEX "MembershipNotification_receiptId_key" ON "MembershipNotification" ("receiptId");
CREATE UNIQUE INDEX "MembershipNotification_shopId_receiptId_key" ON "MembershipNotification" ("shopId", "receiptId");
CREATE UNIQUE INDEX "MembershipNotification_idempotencyKey_key" ON "MembershipNotification" ("idempotencyKey");
CREATE UNIQUE INDEX "MembershipNotification_purchaseId_event_key" ON "MembershipNotification" ("purchaseId", "event");
CREATE INDEX "MembershipNotification_pending_idx" ON "MembershipNotification" ("shopId", "status", "availableAt");
ALTER TABLE "MembershipNotification" ADD CONSTRAINT "MembershipNotification_purchase_fkey"
  FOREIGN KEY ("shopId", "purchaseId") REFERENCES "PassPurchase" ("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MembershipNotification" ADD CONSTRAINT "MembershipNotification_receipt_fkey"
  FOREIGN KEY ("shopId", "receiptId") REFERENCES "MembershipReceipt" ("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "membership_receipt_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Membership payment receipts are immutable';
END;
$$;
CREATE TRIGGER "membership_receipt_immutable" BEFORE UPDATE ON "MembershipReceipt"
  FOR EACH ROW EXECUTE FUNCTION "membership_receipt_immutable"();
