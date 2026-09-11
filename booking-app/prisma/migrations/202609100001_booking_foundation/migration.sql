-- CreateTable
CREATE TABLE "CustomerProfile" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "shopifyCustomerGid" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAttempt" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "sessionId" UUID NOT NULL,
    "customerId" UUID,
    "surface" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'LOGIN_REQUIRED',
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "BookingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingHold" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "passPlanId" UUID NOT NULL,
    "idempotencyKey" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" UUID NOT NULL,
    "shopId" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfile_shopId_shopifyCustomerGid_key" ON "CustomerProfile"("shopId", "shopifyCustomerGid");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfile_shopId_id_key" ON "CustomerProfile"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAttempt_tokenHash_key" ON "BookingAttempt"("tokenHash");

-- CreateIndex
CREATE INDEX "BookingAttempt_status_expiresAt_idx" ON "BookingAttempt"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAttempt_shopId_id_key" ON "BookingAttempt"("shopId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BookingAttempt_shopId_id_sessionId_customerId_key" ON "BookingAttempt"("shopId", "id", "sessionId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingHold_attemptId_key" ON "BookingHold"("attemptId");

-- CreateIndex
CREATE INDEX "BookingHold_shopId_sessionId_status_expiresAt_idx" ON "BookingHold"("shopId", "sessionId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "BookingHold_status_expiresAt_idx" ON "BookingHold"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingHold_shopId_attemptId_key" ON "BookingHold"("shopId", "attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingHold_shopId_customerId_idempotencyKey_key" ON "BookingHold"("shopId", "customerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "Booking_shopId_sessionId_status_idx" ON "Booking"("shopId", "sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_shopId_id_key" ON "Booking"("shopId", "id");

-- AddForeignKey
ALTER TABLE "BookingAttempt" ADD CONSTRAINT "BookingAttempt_shopId_sessionId_fkey" FOREIGN KEY ("shopId", "sessionId") REFERENCES "ClassSession"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAttempt" ADD CONSTRAINT "BookingAttempt_shopId_customerId_fkey" FOREIGN KEY ("shopId", "customerId") REFERENCES "CustomerProfile"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_shopId_attemptId_fkey" FOREIGN KEY ("shopId", "attemptId") REFERENCES "BookingAttempt"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_shopId_sessionId_fkey" FOREIGN KEY ("shopId", "sessionId") REFERENCES "ClassSession"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_shopId_customerId_fkey" FOREIGN KEY ("shopId", "customerId") REFERENCES "CustomerProfile"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingHold" ADD CONSTRAINT "BookingHold_shopId_passPlanId_fkey" FOREIGN KEY ("shopId", "passPlanId") REFERENCES "PassPlan"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_shopId_sessionId_fkey" FOREIGN KEY ("shopId", "sessionId") REFERENCES "ClassSession"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_shopId_customerId_fkey" FOREIGN KEY ("shopId", "customerId") REFERENCES "CustomerProfile"("shopId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Additional invariants not expressible in Prisma schema.
ALTER TABLE "CustomerProfile" ADD CONSTRAINT customer_shop_fk FOREIGN KEY ("shopId") REFERENCES "Shop"(id);
ALTER TABLE "BookingAttempt" ADD CONSTRAINT attempt_shop_fk FOREIGN KEY ("shopId") REFERENCES "Shop"(id);
ALTER TABLE "BookingHold" ADD CONSTRAINT hold_shop_fk FOREIGN KEY ("shopId") REFERENCES "Shop"(id);
ALTER TABLE "Booking" ADD CONSTRAINT booking_shop_fk FOREIGN KEY ("shopId") REFERENCES "Shop"(id);
ALTER TABLE "CustomerProfile" ADD CONSTRAINT customer_gid CHECK ("shopifyCustomerGid" ~ '^gid://shopify/Customer/[1-9][0-9]*$');
ALTER TABLE "BookingAttempt" ADD CONSTRAINT attempt_values CHECK (surface IN ('HOME','PROGRAMS') AND status IN ('LOGIN_REQUIRED','STARTED','HOLD_ACTIVE','RECOVERY','EXPIRED') AND "expiresAt" > "createdAt");
ALTER TABLE "BookingHold" ADD CONSTRAINT hold_values CHECK (status IN ('ACTIVE','CONSUMED','EXPIRED','RELEASED') AND "expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '15 minutes');
ALTER TABLE "BookingHold" ADD CONSTRAINT hold_attempt_context_fk FOREIGN KEY ("shopId","attemptId","sessionId","customerId") REFERENCES "BookingAttempt"("shopId",id,"sessionId","customerId");
ALTER TABLE "Booking" ADD CONSTRAINT booking_status CHECK (status IN ('CONFIRMED','CANCELLED','ATTENDED','LATE_CANCEL','NO_SHOW'));
CREATE UNIQUE INDEX one_active_hold_per_customer_session ON "BookingHold"("shopId","sessionId","customerId") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX one_confirmed_booking_per_customer_session ON "Booking"("shopId","sessionId","customerId") WHERE status = 'CONFIRMED';
CREATE FUNCTION protect_attempt_context() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."shopId" <> OLD."shopId" OR NEW."sessionId" <> OLD."sessionId" OR NEW.surface <> OLD.surface OR NEW."tokenHash" <> OLD."tokenHash"
    OR (OLD."customerId" IS NOT NULL AND NEW."customerId" IS DISTINCT FROM OLD."customerId") THEN
    RAISE EXCEPTION 'Booking attempt context cannot be reassigned';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_attempt_context BEFORE UPDATE ON "BookingAttempt" FOR EACH ROW EXECUTE FUNCTION protect_attempt_context();

-- Serialize writes across both occupancy tables, even if a caller bypasses the service.
CREATE FUNCTION enforce_booking_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE seats integer; occupied integer; duplicate_customer integer; is_active boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."shopId" <> OLD."shopId" OR NEW."sessionId" <> OLD."sessionId" OR NEW."customerId" <> OLD."customerId") THEN
    RAISE EXCEPTION 'Reservation ownership and session are immutable';
  END IF;
  SELECT capacity INTO seats FROM "ClassSession" WHERE id = NEW."sessionId" AND "shopId" = NEW."shopId" FOR UPDATE;
  IF TG_TABLE_NAME = 'Booking' THEN is_active := NEW.status = 'CONFIRMED';
  ELSE is_active := NEW.status = 'ACTIVE' AND NEW."expiresAt" > clock_timestamp(); END IF;
  IF is_active THEN
    SELECT (SELECT count(*) FROM "Booking" WHERE "shopId" = NEW."shopId" AND "sessionId" = NEW."sessionId" AND status = 'CONFIRMED' AND (TG_TABLE_NAME <> 'Booking' OR id <> NEW.id))
         + (SELECT count(*) FROM "BookingHold" WHERE "shopId" = NEW."shopId" AND "sessionId" = NEW."sessionId" AND status = 'ACTIVE' AND "expiresAt" > clock_timestamp() AND (TG_TABLE_NAME <> 'BookingHold' OR id <> NEW.id)) INTO occupied;
    IF occupied >= seats THEN RAISE EXCEPTION 'Session capacity exceeded'; END IF;
    SELECT (SELECT count(*) FROM "Booking" WHERE "shopId" = NEW."shopId" AND "sessionId" = NEW."sessionId" AND "customerId" = NEW."customerId" AND status = 'CONFIRMED' AND (TG_TABLE_NAME <> 'Booking' OR id <> NEW.id))
         + (SELECT count(*) FROM "BookingHold" WHERE "shopId" = NEW."shopId" AND "sessionId" = NEW."sessionId" AND "customerId" = NEW."customerId" AND status = 'ACTIVE' AND "expiresAt" > clock_timestamp() AND (TG_TABLE_NAME <> 'BookingHold' OR id <> NEW.id)) INTO duplicate_customer;
    IF duplicate_customer > 0 THEN RAISE EXCEPTION 'Customer already occupies this session'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_capacity BEFORE INSERT OR UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION enforce_booking_capacity();
CREATE TRIGGER hold_capacity BEFORE INSERT OR UPDATE ON "BookingHold" FOR EACH ROW EXECUTE FUNCTION enforce_booking_capacity();
CREATE FUNCTION protect_session_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occupied integer;
BEGIN
  SELECT (SELECT count(*) FROM "Booking" WHERE "shopId" = NEW."shopId" AND "sessionId" = NEW.id AND status = 'CONFIRMED')
       + (SELECT count(*) FROM "BookingHold" WHERE "shopId" = NEW."shopId" AND "sessionId" = NEW.id AND status = 'ACTIVE' AND "expiresAt" > clock_timestamp()) INTO occupied;
  IF NEW.capacity < occupied THEN RAISE EXCEPTION 'Capacity is below current occupancy'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER session_capacity BEFORE UPDATE OF capacity ON "ClassSession" FOR EACH ROW EXECUTE FUNCTION protect_session_capacity();
