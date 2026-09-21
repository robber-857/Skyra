import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import {
  importMindbody,
  type MindbodyManifest,
} from "../app/services/mindbody-import.server";
import { PRODUCTION_BOOKING_SHOP } from "../app/services/commerce-capabilities.server";
import {
  entitlementBalance,
  eligibleEntitlements,
} from "../app/services/entitlements.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
const options = {
  apply: true,
  actorId: "synthetic-migration-test",
  backupReference: "synthetic-backup",
  cutoffApproved: true,
};
async function fixture(): Promise<MindbodyManifest> {
  const shop = await db.shop.upsert({
    where: { domain: PRODUCTION_BOOKING_SHOP },
    create: {
      domain: PRODUCTION_BOOKING_SHOP,
      rules: { onlineBookingsEnabled: false },
    },
    update: {},
  });
  const suffix = randomUUID();
  const location = await db.location.create({
    data: { shopId: shop.id, name: `Synthetic ${suffix}` },
  });
  const coach = await db.coach.create({
    data: { shopId: shop.id, name: "Synthetic migration coach" },
  });
  const service = await db.service.create({
    data: {
      shopId: shop.id,
      locationId: location.id,
      name: "Synthetic migration class",
      durationMin: 55,
      capacity: 8,
      requestedPriceCents: 0,
    },
  });
  await db.serviceCoach.create({
    data: { shopId: shop.id, serviceId: service.id, coachId: coach.id },
  });
  const pass = await db.passPlan.create({
    data: {
      shopId: shop.id,
      name: "Synthetic legacy pass",
      credits: 10,
      validityDays: 90,
      status: "ACTIVE",
      requestedPriceCents: 0,
    },
  });
  await db.passEligibility.create({
    data: { shopId: shop.id, passPlanId: pass.id, serviceId: service.id },
  });
  await db.productMapping.create({
    data: { shopId: shop.id, ownerId: pass.id, ownerType: "PASS_PLAN" },
  });
  const customer = await db.customerProfile.create({
    data: {
      shopId: shop.id,
      shopifyCustomerGid: `gid://shopify/Customer/${BigInt("0x" + suffix.replaceAll("-", "")).toString()}`,
    },
  });
  const future = new Date(Date.now() + 3 * 86400000);
  return {
    version: 1,
    sourceSystem: "MIND_BODY",
    targetShop: PRODUCTION_BOOKING_SHOP,
    shopId: shop.id,
    batchKey: suffix,
    cutoff: new Date().toISOString(),
    customers: [{ externalKey: `client:${suffix}`, customerId: customer.id }],
    mappings: [
      {
        entityType: "SERVICE",
        externalKey: `service:${suffix}`,
        targetId: service.id,
      },
      {
        entityType: "COACH",
        externalKey: `coach:${suffix}`,
        targetId: coach.id,
      },
      {
        entityType: "LOCATION",
        externalKey: `location:${suffix}`,
        targetId: location.id,
      },
      {
        entityType: "PASS_PLAN",
        externalKey: `plan:${suffix}`,
        targetId: pass.id,
      },
    ],
    passes: [
      {
        externalKey: `pass:${suffix}`,
        customerKey: `client:${suffix}`,
        passKey: `plan:${suffix}`,
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(),
        available: 7,
        reserved: 1,
        consumed: 2,
      },
    ],
    sessions: [
      {
        externalKey: `session:${suffix}`,
        serviceKey: `service:${suffix}`,
        coachKey: `coach:${suffix}`,
        locationKey: `location:${suffix}`,
        startsAt: future.toISOString(),
        endsAt: new Date(future.getTime() + 55 * 60000).toISOString(),
        capacity: 8,
      },
    ],
    bookings: [
      {
        externalKey: `booking:${suffix}`,
        customerKey: `client:${suffix}`,
        passKey: `pass:${suffix}`,
        sessionKey: `session:${suffix}`,
      },
    ],
  };
}
test("dry-run executes all DB constraints but rolls back customers sources, balances, bookings and audit", async () => {
  const m = await fixture();
  const before = await db.migrationBatch.count();
  const result = await importMindbody(m, { actorId: options.actorId });
  expect(result).toMatchObject({
    mode: "DRY_RUN",
    counts: { available: 7, reserved: 1, consumed: 2, bookings: 1 },
  });
  expect(await db.migrationBatch.count()).toBe(before);
  expect(
    await db.entitlement.count({
      where: { customerId: m.customers[0].customerId },
    }),
  ).toBe(0);
  expect(
    await db.booking.count({
      where: { customerId: m.customers[0].customerId },
    }),
  ).toBe(0);
});
test("concurrent/repeated batches preserve one opening balance, one reservation and no notifications", async () => {
  const m = await fixture();
  const results = await Promise.all([
    importMindbody(m, options),
    importMindbody(m, options),
  ]);
  expect(results.filter((r) => r.replay)).toHaveLength(1);
  await importMindbody({ ...m, batchKey: randomUUID() }, options);
  const rows = await db.entitlement.findMany({
    where: { customerId: m.customers[0].customerId },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    sourceSystem: "MIND_BODY",
    sourceOrderGid: null,
    sourceLineItemGid: null,
  });
  expect(await entitlementBalance(db, m.shopId, rows[0].id)).toEqual({
    availableUnits: 7,
    reservedUnits: 1,
    consumedUnits: 2,
  });
  expect(
    await db.entitlementLedgerEntry.count({
      where: { entitlementId: rows[0].id },
    }),
  ).toBe(2);
  const bookings = await db.booking.findMany({
    where: { customerId: m.customers[0].customerId },
    include: { session: true },
  });
  expect(bookings).toHaveLength(1);
  expect(bookings[0].session.status).toBe("DRAFT");
  expect(
    await db.bookingNotification.count({
      where: { bookingId: bookings[0].id },
    }),
  ).toBe(0);
  const eligible = await eligibleEntitlements(db, {
    shopId: m.shopId,
    customerId: m.customers[0].customerId,
    serviceId: m.mappings[0].targetId,
    sessionStartsAt: new Date(m.sessions[0].startsAt),
    now: new Date(),
  });
  expect(eligible).toHaveLength(1);
  expect(
    await eligibleEntitlements(db, {
      shopId: m.shopId,
      customerId: m.customers[0].customerId,
      serviceId: m.mappings[0].targetId,
      sessionStartsAt: new Date(m.passes[0].expiresAt),
      now: new Date(),
    }),
  ).toHaveLength(0);
});
test("late failure rolls back all business records and retains a retryable PII-free failure", async () => {
  const m = await fixture();
  // A same-kind but different eligible service fails only when the booking is reserved.
  await db.passEligibility.deleteMany({
    where: { passPlanId: m.mappings[3].targetId },
  });
  const decoy = await fixture();
  await db.passEligibility.create({
    data: {
      shopId: m.shopId,
      passPlanId: m.mappings[3].targetId,
      serviceId: decoy.mappings[0].targetId,
    },
  });
  await expect(importMindbody(m, options)).rejects.toMatchObject({
    code: "ENTITLEMENT_UNAVAILABLE",
  });
  expect(
    await db.entitlement.count({
      where: { customerId: m.customers[0].customerId },
    }),
  ).toBe(0);
  expect(
    await db.booking.count({
      where: { customerId: m.customers[0].customerId },
    }),
  ).toBe(0);
  await db.passEligibility.create({
    data: {
      shopId: m.shopId,
      passPlanId: m.mappings[3].targetId,
      serviceId: m.mappings[0].targetId,
    },
  });
  expect(await importMindbody(m, options)).toMatchObject({
    mode: "APPLY",
    replay: false,
  });
});
test("changed source rows fail instead of resetting an imported balance", async () => {
  const m = await fixture();
  await importMindbody(m, options);
  const changed = structuredClone(m);
  changed.batchKey = randomUUID();
  changed.passes[0].available = 6;
  await expect(importMindbody(changed, options)).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
});
test("rejects wrong shop, missing signoff, duplicate identities, incomplete reservations and unsplit tranches", async () => {
  const m = await fixture();
  await expect(
    importMindbody(
      { ...m, targetShop: "skyra-booking-dev.myshopify.com" },
      options,
    ),
  ).rejects.toMatchObject({ code: "MIGRATION_INPUT_INVALID" });
  await expect(
    importMindbody(m, { actorId: "test", apply: true }),
  ).rejects.toMatchObject({ code: "MIGRATION_SIGNOFF_REQUIRED" });
  await expect(
    importMindbody(
      {
        ...m,
        customers: [
          ...m.customers,
          { ...m.customers[0], externalKey: "duplicate" },
        ],
      },
      options,
    ),
  ).rejects.toMatchObject({ code: "MIGRATION_CUSTOMER_MERGE_REVIEW" });
  await expect(
    importMindbody({ ...m, bookings: [] }, options),
  ).rejects.toMatchObject({ code: "MIGRATION_RESERVED_MISMATCH" });
  const changed = structuredClone(m);
  changed.passes[0].available = 36;
  await expect(importMindbody(changed, options)).rejects.toMatchObject({
    code: "MIGRATION_PASS_CREDITS_EXCEEDED",
  });
});

test("legacy entitlements cannot accidentally use a saleable plan or ordinary class scope", async () => {
  const m = await fixture();
  m.passes[0].legacyOnly = true;
  await expect(
    importMindbody(m, { actorId: options.actorId }),
  ).rejects.toMatchObject({
    code: "MIGRATION_LEGACY_PASS_MUST_NOT_BE_SALEABLE",
  });
  await db.passPlan.update({
    where: { id: m.mappings[3].targetId },
    data: { saleable: false },
  });
  m.passes[0].serviceKind = "APPOINTMENT";
  await expect(
    importMindbody(m, { actorId: options.actorId }),
  ).rejects.toMatchObject({ code: "MIGRATION_PASS_SCOPE_MISMATCH" });
});
test("approved duplicate Client IDs map to one existing profile without creating customers", async () => {
  const m = await fixture();
  m.customers[0].mergeApproved = true;
  m.customers.push({ ...m.customers[0], externalKey: "approved-alias" });
  expect(await importMindbody(m, { actorId: options.actorId })).toMatchObject({
    counts: { customers: 1, customerSourceRows: 2 },
  });
});
