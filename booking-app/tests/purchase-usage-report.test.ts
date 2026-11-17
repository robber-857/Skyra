import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  bookingReports,
  reportDateRange,
} from "../app/services/booking-reports.server";
import { purchaseUsageReport } from "../app/services/purchase-usage-report.server";
import { reportCsv, reportZip } from "../app/lib/report-exports.server";
import { retainPaidMembershipReceipt } from "../app/services/membership-notifications.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
const range = { range: "custom", from: "2024-07-01", to: "2024-09-30" };
const actor = (shopId: string) => ({
  shopId,
  actorId: "REPORT_TEST",
  role: "ADMIN" as const,
});
async function cashFixture(at = "2024-08-01T00:00:00Z") {
  const f = await paidFixture("NEW_PASS", true);
  await db.customerProfile.update({
    where: { id: f.customer.id },
    data: { preferredName: "Historical Student" },
  });
  // Insert historical fixtures directly: production audit/ledger tables are append-only.
  const e = await db.entitlement.create({
    data: {
      shopId: f.shop.id,
      customerId: f.customer.id,
      passPlanId: f.plan.id,
      productMappingId: f.mapping.id,
      sourceSystem: "MANUAL_CASH",
      externalKey: randomUUID(),
      validityDays: 30,
      startsAt: new Date(at),
      expiresAt: new Date("2025-01-01T00:00:00Z"),
      grantedUnits: 10,
      createdAt: new Date(at),
    },
  });
  await db.auditLog.create({
    data: {
      shopId: f.shop.id,
      entityId: e.id,
      actorId: "TEST",
      action: "CASH_CREDITS_GRANTED",
      after: { amount: "300.00", units: 10 },
      createdAt: new Date(at),
    },
  });
  await db.entitlementLedgerEntry.create({
    data: {
      shopId: f.shop.id,
      entitlementId: e.id,
      kind: "GRANT",
      availableDelta: 10,
      reservedDelta: 0,
      consumedDelta: 0,
      idempotencyKey: randomUUID(),
      createdAt: new Date(at),
    },
  });
  return { ...f, e };
}

test("historical purchase and usage include expired/revoked passes, reservations and restored credits without using current price", async () => {
  const f = await cashFixture();
  await db.passPlan.update({
    where: { id: f.plan.id },
    data: { requestedPriceCents: 99999, credits: 99 },
  });
  await db.classSession.update({
    where: { id: f.session.id },
    data: {
      startsAt: new Date("2024-08-02T00:00:00Z"),
      endsAt: new Date("2024-08-02T01:00:00Z"),
      busyStartsAt: new Date("2024-08-02T00:00:00Z"),
      busyEndsAt: new Date("2024-08-02T01:00:00Z"),
    },
  });
  const booking = await db.booking.create({
    data: {
      shopId: f.shop.id,
      customerId: f.customer.id,
      sessionId: f.session.id,
    },
  });
  const entry = async (kind: string, key: string, at: string) => {
    const deltas = {
      RESERVE: [-1, 1, 0],
      CONSUME: [0, -1, 1],
      RESTORE: [1, 0, -1],
    }[kind]!;
    return db.entitlementLedgerEntry.create({
      data: {
        shopId: f.shop.id,
        entitlementId: f.e.id,
        kind,
        availableDelta: deltas[0],
        reservedDelta: deltas[1],
        consumedDelta: deltas[2],
        reservationKey: key,
        bookingId: booking.id,
        reason: "Synthetic test",
        createdAt: new Date(at),
        idempotencyKey: randomUUID(),
      },
    });
  };
  for (let i = 0; i < 4; i++) {
    const key = randomUUID();
    await entry("RESERVE", key, "2024-08-02T00:00:00Z");
    await entry("CONSUME", key, "2024-08-02T01:00:00Z");
    if (i === 0) await entry("RESTORE", key, "2024-08-03T00:00:00Z");
  }
  for (let i = 0; i < 2; i++) {
    const key = randomUUID();
    await entry("RESERVE", key, "2024-08-04T00:00:00Z");
    await entry("CONSUME", key, "2024-09-30T14:00:00Z");
  }
  await db.entitlement.update({
    where: { id: f.e.id },
    data: { status: "REVOKED" },
  });
  const report = await bookingReports(actor(f.shop.id), {
    ...range,
    q: "historical",
  });
  expect(report.purchaseUsage.rows).toHaveLength(1);
  expect(report.purchaseUsage.rows[0]).toMatchObject({
    amountCents: 30000,
    purchased: 10,
    used: 3,
    remaining: 7,
    reserved: 2,
    unitPriceCents: 3000,
    source: "Cash",
  });
  expect(report.purchaseUsage.cutoff).toBe("2024-09-30T14:00:00.000Z");
  expect(reportCsv(report, "purchases")).toContain(
    '"300.00","10","3","7","30.00","2"',
  );
  expect(
    reportZip(report, true).readUInt16LE(reportZip(report, true).length - 12),
  ).toBe(3);
  const later = await bookingReports(actor(f.shop.id), {
    ...range,
    to: "2024-10-01",
  });
  expect(later.purchaseUsage.rows[0]).toMatchObject({
    used: 5,
    remaining: 5,
    reserved: 0,
  });
});
test("range boundaries, customer filters, tenant isolation and empty exports", async () => {
  const f = await cashFixture("2024-06-30T14:00:00Z"),
    foreign = await cashFixture();
  const report = await bookingReports(actor(f.shop.id), range);
  expect(report.purchaseUsage.rows).toHaveLength(1);
  expect(report.purchaseUsage.customers).toBe(1);
  expect(
    (
      await bookingReports(actor(f.shop.id), {
        ...range,
        customer: foreign.customer.id,
      })
    ).purchaseUsage.rows,
  ).toEqual([]);
  expect(
    (await bookingReports(actor(f.shop.id), { ...range, q: "missing" }))
      .purchaseUsage.rows,
  ).toEqual([]);
  const end = await cashFixture("2024-09-30T14:00:00Z");
  const empty = await bookingReports(actor(end.shop.id), range);
  expect(empty.purchaseUsage.rows).toEqual([]);
  expect(reportCsv(empty, "purchases").split("\r\n")).toHaveLength(1);
});

test("online amount and credits use purchase terms and fully consumed passes stay in the report", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const paid = await db.paidBookingResult.findUniqueOrThrow({
    where: { checkoutId: f.checkout.id },
  });
  for (let i = 0; i < 4; i++)
    await db.entitlementLedgerEntry.create({
      data: {
        shopId: f.shop.id,
        entitlementId: paid.entitlementId!,
        kind: "RESERVE",
        availableDelta: -1,
        reservedDelta: 1,
        consumedDelta: 0,
        bookingId: paid.bookingId,
        reservationKey: randomUUID(),
        idempotencyKey: randomUUID(),
      },
    });
  const reservations = await db.entitlementLedgerEntry.findMany({
    where: { entitlementId: paid.entitlementId!, kind: "RESERVE" },
  });
  for (const r of reservations)
    await db.entitlementLedgerEntry.create({
      data: {
        shopId: f.shop.id,
        entitlementId: paid.entitlementId!,
        kind: "CONSUME",
        availableDelta: 0,
        reservedDelta: -1,
        consumedDelta: 1,
        reservationKey: r.reservationKey,
        idempotencyKey: randomUUID(),
      },
    });
  await db.entitlement.update({
    where: { id: paid.entitlementId! },
    data: { status: "EXPIRED" },
  });
  const report = await bookingReports(actor(f.shop.id), { range: "month" });
  // Prisma-created timestamps use the host clock; PostgreSQL can lag slightly
  // in local Docker. Use an explicit cutoff after all fixture entries.
  const latest = await db.entitlementLedgerEntry.aggregate({
    where: { entitlementId: paid.entitlementId! },
    _max: { createdAt: true },
  });
  const cutoff = new Date(latest._max.createdAt!.getTime() + 1000);
  report.purchaseUsage = await db.$transaction((tx) =>
    purchaseUsageReport(
      tx,
      f.shop.id,
      reportDateRange({ range: "month" }, "Australia/Sydney", cutoff),
      cutoff,
    ),
  );
  expect(report.purchaseUsage.rows).toHaveLength(1);
  expect(report.purchaseUsage.rows[0]).toMatchObject({
    purchased: 5,
    used: 5,
    remaining: 0,
    amountCents: 22000,
    unitPriceCents: 4400,
  });
  expect(reportCsv(report, "purchases")).toContain(
    "Checkout price snapshot; verify discounts against payment records",
  );
});
test("membership receipt takes precedence over matching booking payment and uses paid price/credits", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const paid = await db.paidBookingResult.findUniqueOrThrow({
    where: { checkoutId: f.checkout.id },
  });
  const membership = await db.passMembership.create({
    data: {
      shopId: f.shop.id,
      customerId: f.customer.id,
      passPlanId: f.plan.id,
      currentCycle: 1,
    },
  });
  const purchase = await db.passPurchase.create({
    data: {
      shopId: f.shop.id,
      membershipId: membership.id,
      cycle: 1,
      mode: "ONCE",
      status: "PAID",
      reference: randomUUID(),
      idempotencyKey: randomUUID(),
      productMappingId: f.mapping.id,
      productGid: f.mapping.productGid!,
      variantGid: f.mapping.variantGid!,
      priceCents: 22000,
      paidPriceCents: 20000,
      currency: "AUD",
      credits: 5,
      validityDays: 30,
      timezone: "Australia/Sydney",
      termsVersion: "REPORT_TEST",
      sourceOrderGid: paid.sourceOrderGid,
      sourceLineItemGid: paid.sourceLineItemGid,
      entitlementId: paid.entitlementId,
    },
  });
  await db.$transaction((tx) =>
    retainPaidMembershipReceipt(
      tx,
      purchase.id,
      new Date("2024-08-01T00:00:00Z"),
    ),
  );
  await db.paidBookingResult.update({
    where: { id: paid.id },
    data: { createdAt: new Date("2024-08-01T00:00:00Z") },
  });
  const report = await bookingReports(actor(f.shop.id), range);
  expect(report.purchaseUsage.rows).toHaveLength(1);
  expect(report.purchaseUsage.rows[0]).toMatchObject({
    source: "Membership",
    dateBasis: "Payment",
    amountCents: 20000,
    purchased: 5,
    unitPriceCents: 4000,
  });
});
