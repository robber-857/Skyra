import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import { customerAccountData } from "../app/services/customer-account.server";
import { customerChangeBooking } from "../app/services/booking-lifecycle.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
async function fixture() {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  return {
    ...f,
    actor: { shopId: f.shop.id, customerGid: f.customer.shopifyCustomerGid },
  };
}
test("customer dashboard returns only own bookings and safe fields even while new booking gates are off", async () => {
  const f = await fixture(),
    other = await fixture();
  const result = await customerAccountData(f.actor, {});
  expect(result.bookings).toHaveLength(1);
  expect(result.bookings[0]).toMatchObject({
    className: f.service.name,
    canCancel: true,
    cancellationOutcome: "CANCELLED",
  });
  const json = JSON.stringify(result);
  for (const secret of [
    f.customer.shopifyCustomerGid,
    f.customer.id,
    f.token,
    other.session.id,
    "checkoutUrl",
    "customerId",
    "customerGid",
    "orderGid",
  ])
    expect(json).not.toContain(secret);
  expect(
    (
      await customerAccountData(
        { ...f.actor, customerGid: "gid://shopify/Customer/999" },
        {},
      )
    ).bookings,
  ).toEqual([]);
  await expect(
    customerAccountData({ ...f.actor, customerGid: null }, {}),
  ).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
});
test("pass balances and ledger reflect reserved credits then cancellation release without extending expiry", async () => {
  const f = await fixture();
  const initial = await customerAccountData(f.actor, { view: "passes" });
  expect(initial.passes[0]).toMatchObject({
    name: "Five Class Pass",
    available: 4,
    reserved: 1,
    used: 0,
    eligibleClasses: [f.service.name],
  });
  const booking = (await customerAccountData(f.actor, {})).bookings[0];
  await customerChangeBooking(f.actor, {
    bookingId: booking.id,
    expectedVersion: booking.version,
    action: "CANCEL",
    reason: "Customer changed plans",
    idempotencyKey: booking.cancellationKey,
  });
  expect((await customerAccountData(f.actor, {})).bookings).toEqual([]);
  expect(
    (await customerAccountData(f.actor, { view: "history" })).bookings[0],
  ).toMatchObject({ status: "CANCELLED", canCancel: false });
  const pass = (await customerAccountData(f.actor, { view: "passes" }))
    .passes[0];
  expect(pass).toMatchObject({
    available: 5,
    reserved: 0,
    used: 0,
    expiresAt: initial.passes[0].expiresAt,
  });
  expect(pass.history.some((x) => x.kind === "RELEASE")).toBe(true);
});
test("customer input cannot override identity and cross-customer cursors are denied", async () => {
  const f = await fixture(),
    other = await fixture();
  const booking = await db.booking.findFirstOrThrow({
    where: { shopId: other.shop.id },
  });
  const pass = await db.entitlement.findFirstOrThrow({
    where: { shopId: other.shop.id },
  });
  await expect(
    customerAccountData(f.actor, { customerId: other.customer.id }),
  ).rejects.toThrow();
  await expect(
    customerAccountData(f.actor, { cursor: booking.id }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(
    customerAccountData(f.actor, { view: "passes", cursor: pass.id }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(customerAccountData(f.actor, { view: "all" })).rejects.toThrow();
});
test("booking pagination is bounded, ordered and does not repeat the previous page", async () => {
  const f = await fixture();
  for (let n = 0; n < 27; n++) {
    const start = new Date(Date.now() + (n + 4) * 86400000),
      end = new Date(start.getTime() + 3600000);
    const session = await db.classSession.create({
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
        capacity: 8,
        status: "PUBLISHED",
        dedupeKey: randomUUID(),
      },
    });
    await db.booking.create({
      data: {
        shopId: f.shop.id,
        sessionId: session.id,
        customerId: f.customer.id,
        status: "CONFIRMED",
      },
    });
  }
  const first = await customerAccountData(f.actor, {});
  expect(first.bookings).toHaveLength(25);
  expect(first.nextCursor).toBeTruthy();
  const second = await customerAccountData(f.actor, {
    cursor: first.nextCursor,
  });
  expect(second.bookings).toHaveLength(3);
  expect(second.nextCursor).toBeNull();
  expect(
    new Set([...first.bookings, ...second.bookings].map((b) => b.id)).size,
  ).toBe(28);
});
test("past unmarked attendance belongs in history and cannot be cancelled", async () => {
  const f = await fixture();
  const start = new Date(Date.now() - 7200000),
    end = new Date(Date.now() - 3600000);
  await db.classSession.update({
    where: { id: f.session.id },
    data: {
      startsAt: start,
      endsAt: end,
      busyStartsAt: start,
      busyEndsAt: end,
    },
  });
  expect((await customerAccountData(f.actor, {})).bookings).toHaveLength(0);
  expect(
    (await customerAccountData(f.actor, { view: "history" })).bookings[0],
  ).toMatchObject({ status: "CONFIRMED", canCancel: false });
});
