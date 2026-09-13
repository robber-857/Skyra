import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  customerReschedule,
  rescheduleOptions,
  staffReschedule,
} from "../app/services/booking-reschedule.server";
import { customerChangeBooking } from "../app/services/booking-lifecycle.server";
import { entitlementBalance } from "../app/services/entitlements.server";
import { customerAccountData } from "../app/services/customer-account.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
async function fixture(kind: "NEW_PASS" | "DROP_IN" = "NEW_PASS") {
  const f = await paidFixture(kind);
  await processPaidBookingEvent((await queuePaid(f)).id);
  const booking = await db.booking.findFirstOrThrow({
      where: { shopId: f.shop.id },
    }),
    entitlement = await db.entitlement.findFirstOrThrow({
      where: { shopId: f.shop.id },
    });
  const start = new Date(f.session.startsAt.getTime() + 86400000),
    end = new Date(start.getTime() + 3600000);
  const target = await db.classSession.create({
    data: {
      shopId: f.shop.id,
      serviceId: f.service.id,
      coachId: f.coach.id,
      locationId: f.location.id,
      startsAt: start,
      endsAt: end,
      busyStartsAt: start,
      busyEndsAt: end,
      timezone: "Australia/Sydney",
      capacity: 1,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  const actor = {
    shopId: f.shop.id,
    customerGid: f.customer.shopifyCustomerGid,
  };
  const input = {
    bookingId: booking.id,
    targetSessionId: target.id,
    action: "RESCHEDULE" as const,
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    reason: "Customer changed class time",
  };
  return { ...f, booking, entitlement, target, actor, input };
}
test("ten concurrent reschedules create one replacement, preserve commerce source and move one reservation", async () => {
  const f = await fixture();
  expect(
    (
      await rescheduleOptions(
        { kind: "CUSTOMER", actor: f.actor },
        { bookingId: f.booking.id },
      )
    ).options,
  ).toHaveLength(1);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => customerReschedule(f.actor, f.input)),
  );
  expect(new Set(results.map((r) => r.bookingId)).size).toBe(1);
  expect(
    await db.booking.findUnique({ where: { id: f.booking.id } }),
  ).toMatchObject({
    status: "CANCELLED",
    checkoutId: f.checkout.id,
    sessionId: f.session.id,
  });
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(2);
  expect(
    await db.bookingReschedule.count({ where: { shopId: f.shop.id } }),
  ).toBe(1);
  expect(
    await db.paidBookingResult.count({ where: { shopId: f.shop.id } }),
  ).toBe(1);
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ availableUnits: 4, reservedUnits: 1, consumedUnits: 0 });
  expect(
    (await customerAccountData(f.actor, { view: "history" })).bookings[0]
      .rescheduledTo,
  ).toBe(results[0].bookingId);
  await customerChangeBooking(f.actor, {
    bookingId: results[0].bookingId,
    expectedVersion: 1,
    action: "CANCEL",
    reason: "Cancel the replacement booking",
    idempotencyKey: randomUUID(),
  });
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ availableUnits: 5, reservedUnits: 0 });
  await expect(
    db.bookingReschedule.deleteMany({ where: { shopId: f.shop.id } }),
  ).rejects.toThrow();
});
test("sold-out target leaves original booking and credit history untouched", async () => {
  const f = await fixture();
  const other = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/999",
    },
  });
  await db.booking.create({
    data: { shopId: f.shop.id, sessionId: f.target.id, customerId: other.id },
  });
  await expect(customerReschedule(f.actor, f.input)).rejects.toMatchObject({
    code: "SOLD_OUT",
  });
  expect(
    await db.booking.findUnique({ where: { id: f.booking.id } }),
  ).toMatchObject({ status: "CONFIRMED", version: 1 });
  expect(
    await db.entitlementLedgerEntry.count({
      where: { shopId: f.shop.id, kind: "RELEASE" },
    }),
  ).toBe(0);
});
test("expiry failure rolls back a provisional credit release and new booking", async () => {
  const f = await fixture("DROP_IN");
  expect(
    (
      await rescheduleOptions(
        { kind: "CUSTOMER", actor: f.actor },
        { bookingId: f.booking.id },
      )
    ).options,
  ).toHaveLength(0);
  await expect(customerReschedule(f.actor, f.input)).rejects.toMatchObject({
    code: "ENTITLEMENT_UNAVAILABLE",
  });
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ availableUnits: 0, reservedUnits: 1 });
  expect(
    await db.bookingReschedule.count({ where: { shopId: f.shop.id } }),
  ).toBe(0);
});
test("late changes, same class, stale forms and wrong customer are rejected", async () => {
  const f = await fixture();
  await expect(
    customerReschedule(
      { ...f.actor, customerGid: "gid://shopify/Customer/999" },
      f.input,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    customerReschedule(f.actor, { ...f.input, targetSessionId: f.session.id }),
  ).rejects.toMatchObject({ code: "SAME_CLASS" });
  await expect(
    customerReschedule(f.actor, { ...f.input, expectedVersion: 2 }),
  ).rejects.toMatchObject({ code: "STALE_BOOKING" });
  const start = new Date(Date.now() + 3600000),
    end = new Date(start.getTime() + 3600000);
  await db.classSession.update({
    where: { id: f.session.id },
    data: {
      startsAt: start,
      endsAt: end,
      busyStartsAt: start,
      busyEndsAt: end,
    },
  });
  await expect(customerReschedule(f.actor, f.input)).rejects.toMatchObject({
    code: "RESCHEDULE_CLOSED",
  });
});
test("reschedule and cancellation race has only one committed outcome", async () => {
  const f = await fixture();
  const settled = await Promise.allSettled([
    customerReschedule(f.actor, f.input),
    customerChangeBooking(f.actor, {
      bookingId: f.booking.id,
      expectedVersion: 1,
      action: "CANCEL",
      reason: "Customer cancelling instead",
      idempotencyKey: randomUUID(),
    }),
  ]);
  expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const balance = await entitlementBalance(db, f.shop.id, f.entitlement.id);
  expect(balance.availableUnits + balance.reservedUnits).toBe(5);
  expect(balance.consumedUnits).toBe(0);
});
test("staff reschedule uses the same rules, rejects Coach and idempotency changes", async () => {
  const f = await fixture(),
    actor = {
      shopId: f.shop.id,
      actorId: randomUUID(),
      role: "ADMIN" as const,
    };
  await expect(
    staffReschedule({ ...actor, role: "COACH" }, f.input),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await staffReschedule(actor, f.input);
  await expect(
    staffReschedule(actor, { ...f.input, reason: "Another reason" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
