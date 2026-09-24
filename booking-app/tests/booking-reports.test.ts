import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  bookingReports,
  reportDateRange,
} from "../app/services/booking-reports.server";
import { customerChangeBooking } from "../app/services/booking-lifecycle.server";
import { grantCashCredits } from "../app/services/manual-credits.server";
import { reportCsv } from "../app/lib/report-exports.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
test.each(["NEW_PASS", "DROP_IN"] as const)(
  "reports include cash %s once at its recorded amount",
  async (kind) => {
    const f = await paidFixture(kind),
      other = await paidFixture(kind);
    const actor = {
      shopId: f.shop.id,
      actorId: randomUUID(),
      role: "ADMIN" as const,
    };
    await db.customerProfile.update({
      where: { id: f.customer.id },
      data: { preferredName: "Cash Mandy" },
    });
    const input = {
      customerId: f.customer.id,
      target:
        kind === "NEW_PASS"
          ? `PASS_PLAN:${f.plan.id}`
          : `SERVICE:${f.service.id}`,
      units: kind === "NEW_PASS" ? 10 : 1,
      validityDays: 30,
      amount: "371.00",
      reason: "Synthetic cash receipt",
      idempotencyKey: randomUUID(),
    };
    const grant = await grantCashCredits(actor, input);
    await grantCashCredits(actor, input);
    await grantCashCredits(
      { ...actor, shopId: other.shop.id },
      {
        ...input,
        customerId: other.customer.id,
        target:
          kind === "NEW_PASS"
            ? `PASS_PLAN:${other.plan.id}`
            : `SERVICE:${other.service.id}`,
        idempotencyKey: randomUUID(),
      },
    );
    const receipt = await db.auditLog.findFirstOrThrow({
      where: {
        shopId: f.shop.id,
        entityId: grant.id,
        action: "CASH_CREDITS_GRANTED",
      },
    });
    const today = reportDateRange({}, "Australia/Sydney", receipt.createdAt).to;
    const range = { range: "custom", from: today, to: today };
    const report = await bookingReports(actor, { ...range, q: "mandy" });
    expect(report.purchases).toEqual({ count: 1, valueCents: 37100 });
    expect(report.spending.totalSpendCents).toBe(37100);
    expect(report.spending.passRevenueCents).toBe(
      kind === "NEW_PASS" ? 37100 : 0,
    );
    expect(report.spending.rows).toHaveLength(1);
    expect(report.spending.rows[0]).toMatchObject({
      purchaseCount: 1,
      passPurchases: kind === "NEW_PASS" ? 1 : 0,
      lastPurchase: receipt.createdAt.toISOString(),
    });
    expect(reportCsv(report, "spending")).toContain('"371.00"');
    expect(
      (await bookingReports(actor, { ...range, q: "missing" })).spending.rows,
    ).toEqual([]);
    expect(
      (await bookingReports(actor, { ...range, customer: other.customer.id }))
        .spending.rows,
    ).toEqual([]);
    // Revoking credits is not a refund; an online payment adds to cash revenue.
    await db.entitlement.update({
      where: { id: grant.id },
      data: { status: "REVOKED" },
    });
    await processPaidBookingEvent((await queuePaid(f)).id);
    const combined = await bookingReports(actor, range);
    expect(combined.purchases.count).toBe(2);
    expect(combined.spending.rows[0].purchaseCount).toBe(2);
    expect(combined.spending.totalSpendCents).toBe(
      37100 + f.checkout.priceCents,
    );
  },
);
test("historical cash uses the Sydney receipt day, even before Pass activation", async () => {
  const f = await paidFixture();
  const actor = {
    shopId: f.shop.id,
    actorId: "CASH_HISTORY_TEST",
    role: "ADMIN" as const,
  };
  const entitlement = await db.entitlement.create({
    data: {
      shopId: f.shop.id,
      customerId: f.customer.id,
      passPlanId: f.plan.id,
      productMappingId: f.mapping.id,
      sourceSystem: "MANUAL_CASH",
      externalKey: randomUUID(),
      grantedUnits: 10,
      validityDays: 30,
    },
  });
  await db.auditLog.create({
    data: {
      shopId: f.shop.id,
      actorId: actor.actorId,
      entityId: entitlement.id,
      action: "CASH_CREDITS_GRANTED",
      after: { amount: "371.15" },
      createdAt: new Date("2026-09-23T14:05:00Z"),
    },
  });
  const range = { range: "custom", from: "2026-09-24", to: "2026-09-24" };
  const result = await bookingReports(actor, range);
  expect(result.purchases).toEqual({ count: 1, valueCents: 37115 });
  expect(result.spending.passRevenueCents).toBe(37115);
  expect(
    (
      await bookingReports(actor, {
        ...range,
        from: "2026-09-23",
        to: "2026-09-23",
      })
    ).purchases.count,
  ).toBe(0);
});
test("report date ranges cover complete studio days and reject invalid dates", () => {
  const r = reportDateRange(
    { range: "custom", from: "2026-10-04", to: "2026-10-04" },
    "Australia/Sydney",
  );
  expect((r.end.getTime() - r.start.getTime()) / 3600000).toBe(23);
  expect(() =>
    reportDateRange(
      { range: "custom", from: "2026-02-30", to: "2026-03-01" },
      "Australia/Sydney",
    ),
  ).toThrow();
  expect(() =>
    reportDateRange(
      { range: "custom", from: "2024-01-01", to: "2026-01-01" },
      "Australia/Sydney",
    ),
  ).toThrow();
});
test("reports isolate shops, count a paid retry once and derive balances from ledger", async () => {
  const f = await paidFixture(),
    other = await paidFixture();
  const event = await queuePaid(f);
  await processPaidBookingEvent(event.id);
  await processPaidBookingEvent(event.id);
  await processPaidBookingEvent((await queuePaid(other)).id);
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  const r = await bookingReports(actor, { range: "month" });
  expect(r.purchases).toMatchObject({ count: 1, valueCents: 22000 });
  expect(r.spending).toMatchObject({
    totalSpendCents: 22000,
    passRevenueCents: 22000,
    refundsTracked: false,
  });
  expect(r.spending.rows).toHaveLength(1);
  expect(r.unused).toMatchObject({
    customers: 1,
    passes: 1,
    available: 4,
    reserved: 1,
  });
  expect(r.unusedPasses).toMatchObject({ customers: 1, credits: 5 });
  expect(r.unusedPasses.rows[0]).toMatchObject({
    purchased: 5,
    used: 0,
    available: 4,
    reserved: 1,
    remaining: 5,
  });
  expect(r.sessionCount).toBe(0);
  const day = f.session.startsAt.toISOString().slice(0, 10);
  const future = await bookingReports(actor, {
    range: "custom",
    from: day,
    to: new Date(f.session.startsAt.getTime() + 86400000)
      .toISOString()
      .slice(0, 10),
  });
  expect(future.sessionCount).toBe(1);
  expect(future.counts.CONFIRMED).toBe(1);
  expect(future.purchases.count).toBe(0);
  const b = await db.booking.findFirstOrThrow({ where: { shopId: f.shop.id } });
  await customerChangeBooking(
    { shopId: f.shop.id, customerGid: f.customer.shopifyCustomerGid },
    {
      bookingId: b.id,
      expectedVersion: 1,
      action: "CANCEL",
      reason: "Customer changed plans",
      idempotencyKey: randomUUID(),
    },
  );
  const updated = await bookingReports(actor, {});
  expect(updated.unused).toMatchObject({ available: 5, reserved: 0 });
  expect(updated.purchases.valueCents).toBe(22000);
  await expect(
    bookingReports({ ...actor, role: "COACH" }, {}),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
