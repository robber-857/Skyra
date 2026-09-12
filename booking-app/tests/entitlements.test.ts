import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import {
  adjustEntitlement,
  consumeEntitlementReservation,
  eligibleEntitlements,
  entitlementBalance,
  grantEntitlement,
  introOfferEligible,
  releaseEntitlementReservation,
  reserveEntitlementCredit,
  revokeEntitlement,
} from "../app/services/entitlements.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Tests require skyra_booking_test.");
});
afterAll(async () => {
  await db.$disconnect();
});

let gid = 900000;
const nextGid = () => String(gid++);

async function fixture(credits = 3) {
  const shop = await db.shop.create({
    data: { domain: randomUUID() + "-entitlements.myshopify.com" },
  });
  const location = await db.location.create({
    data: { shopId: shop.id, name: "Studio" },
  });
  const coach = await db.coach.create({
    data: { shopId: shop.id, name: "Coach" },
  });
  const service = await db.service.create({
    data: {
      shopId: shop.id,
      locationId: location.id,
      name: "Class",
      durationMin: 55,
      capacity: 8,
      requestedPriceCents: 4900,
      status: "ACTIVE",
    },
  });
  const startsAt = new Date(Date.now() + 2 * 86400000);
  const session = await db.classSession.create({
    data: {
      shopId: shop.id,
      serviceId: service.id,
      coachId: coach.id,
      locationId: location.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 55 * 60000),
      busyStartsAt: startsAt,
      busyEndsAt: new Date(startsAt.getTime() + 55 * 60000),
      timezone: "Australia/Sydney",
      capacity: 8,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  const passPlan = await db.passPlan.create({
    data: {
      shopId: shop.id,
      name: credits + " Class Pass",
      credits,
      validityDays: 90,
      requestedPriceCents: 22000,
      status: "ACTIVE",
    },
  });
  await db.passEligibility.create({
    data: {
      shopId: shop.id,
      passPlanId: passPlan.id,
      serviceId: service.id,
    },
  });
  const mapping = await db.productMapping.create({
    data: {
      shopId: shop.id,
      ownerType: "PASS_PLAN",
      ownerId: passPlan.id,
      productGid: "gid://shopify/Product/" + nextGid(),
      variantGid: "gid://shopify/ProductVariant/" + nextGid(),
      syncStatus: "SYNCED",
      productStatus: "ACTIVE",
      requestedVersion: 1,
      shopifyVersion: 1,
      publishedPrice: "220.00",
    },
  });
  const customer = await db.customerProfile.create({
    data: {
      shopId: shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/" + nextGid(),
    },
  });
  const grant = (overrides: Partial<Parameters<typeof grantEntitlement>[0]> = {}) => {
    const orderId = nextGid();
    return grantEntitlement({
      shopId: shop.id,
      customerId: customer.id,
      passPlanId: passPlan.id,
      productMappingId: mapping.id,
      sourceOrderGid: "gid://shopify/Order/" + orderId,
      sourceLineItemGid: "gid://shopify/LineItem/" + nextGid(),
      startsAt: new Date(Date.now() - 60000),
      expiresAt: new Date(Date.now() + 90 * 86400000),
      grantedUnits: credits,
      idempotencyKey: "order-paid:" + orderId,
      ...overrides,
    });
  };
  return {
    shop,
    service,
    session,
    passPlan,
    mapping,
    customer,
    grant,
  };
}

test("Shopify order-line grants are idempotent and ledger rows are immutable", async () => {
  const f = await fixture(5);
  const orderId = nextGid();
  const input = {
    shopId: f.shop.id,
    customerId: f.customer.id,
    passPlanId: f.passPlan.id,
    productMappingId: f.mapping.id,
    sourceOrderGid: "gid://shopify/Order/" + orderId,
    sourceLineItemGid: "gid://shopify/LineItem/" + nextGid(),
    startsAt: new Date(Date.now() - 60000),
    expiresAt: new Date(Date.now() + 90 * 86400000),
    grantedUnits: 5,
    idempotencyKey: "order-paid:" + orderId,
  };
  const first = await grantEntitlement(input);
  const replay = await grantEntitlement(input);
  expect(replay.entitlement.id).toBe(first.entitlement.id);
  expect(replay.balance).toEqual({
    availableUnits: 5,
    reservedUnits: 0,
    consumedUnits: 0,
  });
  expect(
    await db.entitlementLedgerEntry.count({
      where: { entitlementId: first.entitlement.id },
    }),
  ).toBe(1);
  const entry = await db.entitlementLedgerEntry.findFirstOrThrow({
    where: { entitlementId: first.entitlement.id },
  });
  await expect(
    db.entitlementLedgerEntry.update({
      where: { id: entry.id },
      data: { reason: "changed" },
    }),
  ).rejects.toThrow();
  await expect(
    db.entitlementLedgerEntry.create({
      data: {
        shopId: f.shop.id,
        entitlementId: first.entitlement.id,
        kind: "GRANT",
        availableDelta: 5,
        reservedDelta: 0,
        consumedDelta: 0,
        idempotencyKey: "forged-grant:" + randomUUID(),
      },
    }),
  ).rejects.toThrow();
});

test("reserve, consume and release move units between explicit balances once", async () => {
  const f = await fixture(2);
  const { entitlement } = await f.grant();
  const reservationKey = randomUUID();
  const reserved = await db.$transaction((tx) =>
    reserveEntitlementCredit(tx, {
      shopId: f.shop.id,
      entitlementId: entitlement.id,
      customerId: f.customer.id,
      serviceId: f.service.id,
      sessionStartsAt: f.session.startsAt,
      now: new Date(),
      reservationKey,
      idempotencyKey: "reserve:" + reservationKey,
    }),
  );
  expect(reserved.balance).toEqual({
    availableUnits: 1,
    reservedUnits: 1,
    consumedUnits: 0,
  });
  const consumed = await db.$transaction((tx) =>
    consumeEntitlementReservation(tx, {
      shopId: f.shop.id,
      entitlementId: entitlement.id,
      reservationKey,
      idempotencyKey: "consume:" + reservationKey,
    }),
  );
  expect(consumed.balance).toEqual({
    availableUnits: 1,
    reservedUnits: 0,
    consumedUnits: 1,
  });
  const secondKey = randomUUID();
  await db.$transaction((tx) =>
    reserveEntitlementCredit(tx, {
      shopId: f.shop.id,
      entitlementId: entitlement.id,
      customerId: f.customer.id,
      serviceId: f.service.id,
      sessionStartsAt: f.session.startsAt,
      now: new Date(),
      reservationKey: secondKey,
      idempotencyKey: "reserve:" + secondKey,
    }),
  );
  const released = await db.$transaction((tx) =>
    releaseEntitlementReservation(tx, {
      shopId: f.shop.id,
      entitlementId: entitlement.id,
      reservationKey: secondKey,
      idempotencyKey: "release:" + secondKey,
    }),
  );
  expect(released.balance).toEqual({
    availableUnits: 1,
    reservedUnits: 0,
    consumedUnits: 1,
  });
  const replay = await db.$transaction((tx) =>
    releaseEntitlementReservation(tx, {
      shopId: f.shop.id,
      entitlementId: entitlement.id,
      reservationKey: secondKey,
      idempotencyKey: "release:" + secondKey,
    }),
  );
  expect(replay.entry.id).toBe(released.entry.id);
});

test("concurrent reservations cannot spend the last credit twice", async () => {
  const f = await fixture(1);
  const { entitlement } = await f.grant();
  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, () => {
      const reservationKey = randomUUID();
      return db.$transaction((tx) =>
        reserveEntitlementCredit(tx, {
          shopId: f.shop.id,
          entitlementId: entitlement.id,
          customerId: f.customer.id,
          serviceId: f.service.id,
          sessionStartsAt: f.session.startsAt,
          now: new Date(),
          reservationKey,
          idempotencyKey: "reserve:" + reservationKey,
        }),
      );
    }),
  );
  expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(
    await db.entitlementLedgerEntry.count({
      where: { entitlementId: entitlement.id, kind: "RESERVE" },
    }),
  ).toBe(1);
});

test("eligible Passes require service match, class-date validity and available balance", async () => {
  const f = await fixture(2);
  const later = await f.grant({
    expiresAt: new Date(Date.now() + 60 * 86400000),
  });
  const sooner = await f.grant({
    expiresAt: new Date(Date.now() + 30 * 86400000),
  });
  const eligible = await db.$transaction((tx) =>
    eligibleEntitlements(tx, {
      shopId: f.shop.id,
      customerId: f.customer.id,
      serviceId: f.service.id,
      sessionStartsAt: f.session.startsAt,
      now: new Date(),
    }),
  );
  expect(eligible.map((item) => item.id)).toEqual([
    sooner.entitlement.id,
    later.entitlement.id,
  ]);
  expect(eligible[0].availableUnits).toBe(2);
  expect(
    await db.$transaction((tx) =>
      eligibleEntitlements(tx, {
        shopId: f.shop.id,
        customerId: f.customer.id,
        serviceId: randomUUID(),
        sessionStartsAt: f.session.startsAt,
        now: new Date(),
      }),
    ),
  ).toEqual([]);
});

test("Intro eligibility is conservative and adjustments/revocation remain auditable", async () => {
  const f = await fixture(2);
  expect(
    await db.$transaction((tx) =>
      introOfferEligible(tx, f.shop.id, f.customer.id),
    ),
  ).toBe(true);
  const { entitlement } = await f.grant();
  expect(
    await db.$transaction((tx) =>
      introOfferEligible(tx, f.shop.id, f.customer.id),
    ),
  ).toBe(false);
  const adjusted = await db.$transaction((tx) =>
    adjustEntitlement(tx, {
      shopId: f.shop.id,
      entitlementId: entitlement.id,
      units: 1,
      reason: "Customer service correction",
      idempotencyKey: "adjust:" + randomUUID(),
    }),
  );
  expect(adjusted.balance.availableUnits).toBe(3);
  const revoked = await db.$transaction((tx) =>
    revokeEntitlement(tx, {
      shopId: f.shop.id,
      entitlementId: entitlement.id,
      reason: "Full refund before use",
      idempotencyKey: "revoke:" + randomUUID(),
    }),
  );
  const replay = await db.$transaction((tx) =>
    revokeEntitlement(tx, {
      shopId: f.shop.id,
      entitlementId: entitlement.id,
      reason: "Full refund before use",
      idempotencyKey: revoked.entry.idempotencyKey,
    }),
  );
  expect(replay.entry.id).toBe(revoked.entry.id);
  expect(revoked.balance.availableUnits).toBe(0);
  expect(
    (await db.entitlement.findUniqueOrThrow({ where: { id: entitlement.id } }))
      .status,
  ).toBe("REVOKED");
  expect(
    await db.entitlementLedgerEntry.count({
      where: { entitlementId: entitlement.id },
    }),
  ).toBe(3);
  expect(
    await db.$transaction((tx) =>
      entitlementBalance(tx, f.shop.id, entitlement.id),
    ),
  ).toEqual({ availableUnits: 0, reservedUnits: 0, consumedUnits: 0 });
});
