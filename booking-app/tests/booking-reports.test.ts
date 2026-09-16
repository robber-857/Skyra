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
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
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
