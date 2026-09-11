-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" UUID NOT NULL,
    "domain" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Sydney',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "rules" JSONB NOT NULL DEFAULT '{}',
    "rulesApprovedAt" TIMESTAMPTZ,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAccount" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "displayName" TEXT NOT NULL,

    CONSTRAINT "StaffAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coach" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "bufferBeforeMin" INTEGER NOT NULL DEFAULT 0,
    "bufferAfterMin" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Coach_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Location" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Australia/Sydney',

    CONSTRAINT "Location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "categoryId" UUID,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CLASS',
    "description" TEXT NOT NULL DEFAULT '',
    "level" TEXT NOT NULL DEFAULT '',
    "durationMin" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "locationId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "requestedPriceCents" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceCoach" (
    "shopId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "coachId" UUID NOT NULL,

    CONSTRAINT "ServiceCoach_pkey" PRIMARY KEY ("shopId","serviceId","coachId")
);

-- CreateTable
CREATE TABLE "PassPlan" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "validityDays" INTEGER NOT NULL,
    "introOnly" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "requestedPriceCents" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "PassPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PassEligibility" (
    "shopId" UUID NOT NULL,
    "passPlanId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,

    CONSTRAINT "PassEligibility_pkey" PRIMARY KEY ("shopId","passPlanId","serviceId")
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "productGid" TEXT,
    "variantGid" TEXT,
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedVersion" INTEGER NOT NULL DEFAULT 1,
    "shopifyVersion" INTEGER NOT NULL DEFAULT 0,
    "publishedPrice" TEXT,
    "publishedTitle" TEXT,
    "productStatus" TEXT,
    "lastError" TEXT,
    "syncedAt" TIMESTAMPTZ,

    CONSTRAINT "ProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassSession" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "coachId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "startsAt" TIMESTAMPTZ NOT NULL,
    "endsAt" TIMESTAMPTZ NOT NULL,
    "busyStartsAt" TIMESTAMPTZ NOT NULL,
    "busyEndsAt" TIMESTAMPTZ NOT NULL,
    "timezone" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "receivedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAccount_shopId_subject_key" ON "StaffAccount"("shopId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "Category_shopId_name_key" ON "Category"("shopId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Coach_shopId_id_key" ON "Coach"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Location_shopId_id_key" ON "Location"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Location_shopId_name_key" ON "Location"("shopId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Service_shopId_id_key" ON "Service"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PassPlan_shopId_id_key" ON "PassPlan"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_shopId_ownerType_ownerId_key" ON "ProductMapping"("shopId", "ownerType", "ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_shopId_variantGid_key" ON "ProductMapping"("shopId", "variantGid");

-- CreateIndex
CREATE INDEX "ClassSession_shopId_startsAt_idx" ON "ClassSession"("shopId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassSession_shopId_dedupeKey_key" ON "ClassSession"("shopId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "ClassSession_shopId_id_key" ON "ClassSession"("shopId", "id");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_availableAt_idx" ON "OutboxEvent"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxEvent_shopId_kind_aggregateId_version_key" ON "OutboxEvent"("shopId", "kind", "aggregateId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_shopId_webhookId_key" ON "WebhookReceipt"("shopId", "webhookId");

-- CreateIndex
CREATE INDEX "AuditLog_shopId_createdAt_idx" ON "AuditLog"("shopId", "createdAt");

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_shopId_locationId_fkey" FOREIGN KEY ("shopId", "locationId") REFERENCES "Location"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCoach" ADD CONSTRAINT "ServiceCoach_shopId_serviceId_fkey" FOREIGN KEY ("shopId", "serviceId") REFERENCES "Service"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceCoach" ADD CONSTRAINT "ServiceCoach_shopId_coachId_fkey" FOREIGN KEY ("shopId", "coachId") REFERENCES "Coach"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassEligibility" ADD CONSTRAINT "PassEligibility_shopId_passPlanId_fkey" FOREIGN KEY ("shopId", "passPlanId") REFERENCES "PassPlan"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassEligibility" ADD CONSTRAINT "PassEligibility_shopId_serviceId_fkey" FOREIGN KEY ("shopId", "serviceId") REFERENCES "Service"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_shopId_serviceId_fkey" FOREIGN KEY ("shopId", "serviceId") REFERENCES "Service"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_shopId_coachId_fkey" FOREIGN KEY ("shopId", "coachId") REFERENCES "Coach"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_shopId_locationId_fkey" FOREIGN KEY ("shopId", "locationId") REFERENCES "Location"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cross-tenant ownership is enforced even for direct SQL writes.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['StaffAccount','Category','Coach','Location','Service','ServiceCoach','PassPlan','PassEligibility','ProductMapping','ClassSession','OutboxEvent','WebhookReceipt','AuditLog'] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("shopId") REFERENCES "Shop"(id) ON DELETE RESTRICT', t, t || '_shop_fk');
  END LOOP;
END $$;
ALTER TABLE "Service" ADD CONSTRAINT service_values CHECK ("durationMin" BETWEEN 5 AND 480 AND capacity BETWEEN 1 AND 200 AND "requestedPriceCents" >= 0 AND status IN ('DRAFT','ACTIVE','INACTIVE'));
ALTER TABLE "PassPlan" ADD CONSTRAINT pass_values CHECK (credits > 0 AND "validityDays" > 0 AND "requestedPriceCents" >= 0 AND status IN ('DRAFT','ACTIVE','INACTIVE'));
ALTER TABLE "ClassSession" ADD CONSTRAINT session_values CHECK ("startsAt" < "endsAt" AND "busyStartsAt" <= "startsAt" AND "busyEndsAt" >= "endsAt" AND capacity > 0 AND status IN ('DRAFT','PUBLISHED','CANCELLED','COMPLETED'));
ALTER TABLE "StaffAccount" ADD CONSTRAINT staff_role CHECK (role IN ('ADMIN','OPERATIONS','COACH'));
ALTER TABLE "Coach" ADD CONSTRAINT coach_buffer CHECK ("bufferBeforeMin" >= 0 AND "bufferAfterMin" >= 0);
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- All sessions in this first slice reserve the entire location.
-- Multi-resource/shared-room allocation is a later M2 task.
ALTER TABLE "ClassSession" ADD CONSTRAINT coach_no_overlap
  EXCLUDE USING gist ("shopId" WITH =, "coachId" WITH =, tstzrange("busyStartsAt","busyEndsAt",'[)') WITH &&)
  WHERE (status IN ('DRAFT','PUBLISHED'));
ALTER TABLE "ClassSession" ADD CONSTRAINT location_no_overlap
  EXCLUDE USING gist ("shopId" WITH =, "locationId" WITH =, tstzrange("startsAt","endsAt",'[)') WITH &&)
  WHERE (status IN ('DRAFT','PUBLISHED'));
CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit logs are append-only'; END $$;
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

