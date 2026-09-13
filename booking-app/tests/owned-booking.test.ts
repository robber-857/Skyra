import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import {
  startAttempt,
  resumeAttempt,
  bookingPassOptions,
} from "../app/services/booking.server";
import { grantEntitlement } from "../app/services/entitlements.server";
import { confirmOwnedBooking } from "../app/services/owned-booking.server";
import { bookingResult } from "../app/services/booking-result.server";
import { bookingPurchaseReview } from "../app/services/booking-purchase-review.server";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
async function fixture(units = 5) {
  const f = await paidFixture("NEW_PASS", true);
  await db.shop.update({
    where: { id: f.shop.id },
    data: {
      rules: { ...(f.shop.rules as object), onlineBookingsEnabled: true },
    },
  });
  const actor = {
    shopId: f.shop.id,
    customerGid: f.customer.shopifyCustomerGid,
  };
  const grant = await grantEntitlement({
    shopId: f.shop.id,
    customerId: f.customer.id,
    passPlanId: f.plan.id,
    productMappingId: f.mapping.id,
    sourceOrderGid: "gid://shopify/Order/9999",
    sourceLineItemGid: "gid://shopify/LineItem/9999",
    startsAt: new Date(Date.now() - 60000),
    expiresAt: new Date(Date.now() + 30 * 86400000),
    grantedUnits: units,
    idempotencyKey: randomUUID(),
  });
  const attempt = await startAttempt(actor, {
    sessionId: f.session.id,
    surface: "HOME",
  });
  const input = { token: attempt.token, entitlementId: grant.entitlement.id };
  return {
    ...f,
    actor,
    input,
    ownedAttempt: attempt,
    entitlement: grant.entitlement,
  };
}
test("10 simultaneous confirmations reserve once, create one booking and two emails without a new cart or grant", async () => {
  const f = await fixture();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => confirmOwnedBooking(f.actor, f.input)),
  );
  expect(new Set(results.map((x) => x.bookingReference)).size).toBe(1);
  expect(results[0].status).toBe("CONFIRMED");
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    await db.bookingNotification.count({ where: { shopId: f.shop.id } }),
  ).toBe(2);
  const ledger = await db.entitlementLedgerEntry.findMany({
    where: { entitlementId: f.entitlement.id },
  });
  expect(ledger.map((x) => x.kind).sort()).toEqual(["GRANT", "RESERVE"]);
  expect(ledger.reduce((sum, x) => sum + x.availableDelta, 0)).toBe(4);
  expect(await db.bookingCheckout.count({ where: { shopId: f.shop.id } })).toBe(
    1,
  ); // original fixture only
  expect(await bookingResult(f.actor, { token: f.input.token })).toEqual(
    results[0],
  );
  await expect(
    confirmOwnedBooking(f.actor, { ...f.input, entitlementId: randomUUID() }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
test("owned Pass review uses no Shopify network and release remains disabled", async () => {
  const f = await fixture();
  const clients = vi.fn();
  const options = await bookingPurchaseReview(
    f.actor,
    {
      token: f.input.token,
      purchaseKind: "OWNED_PASS",
      entitlementId: f.entitlement.id,
    },
    clients,
  );
  expect(options.selected).toMatchObject({
    kind: "OWNED_PASS",
    availableUnits: 5,
  });
  expect(options.ownedPassesAvailable).toBe(false);
  expect(clients).not.toHaveBeenCalled();
  await expect(
    bookingPassOptions(f.actor, {
      token: f.input.token,
      purchaseKind: "DROP_IN",
      entitlementId: f.entitlement.id,
    }),
  ).rejects.toThrow();
});
test("anonymous, another customer and another shop cannot read or confirm", async () => {
  const f = await fixture();
  for (const [actor, code] of [
    [{ ...f.actor, customerGid: null }, "LOGIN_REQUIRED"],
    [{ ...f.actor, customerGid: "gid://shopify/Customer/456" }, "FORBIDDEN"],
    [{ ...f.actor, shopId: randomUUID() }, "NOT_FOUND"],
  ] as const) {
    await expect(confirmOwnedBooking(actor, f.input)).rejects.toMatchObject({
      code,
    });
    await expect(
      bookingResult(actor, { token: f.input.token }),
    ).rejects.toMatchObject({ code });
  }
  const other = await fixture();
  await expect(
    confirmOwnedBooking(f.actor, {
      ...f.input,
      entitlementId: other.entitlement.id,
    }),
  ).rejects.toMatchObject({ code: "PASS_UNAVAILABLE" });
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
});
test("last credit across two sessions cannot be spent twice; losing transaction rolls back its booking and emails", async () => {
  const f = await fixture(1);
  const start = new Date(f.session.startsAt.getTime() + 86400000),
    end = new Date(f.session.endsAt.getTime() + 86400000);
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
      timezone: f.session.timezone,
      capacity: 8,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  const second = await startAttempt(f.actor, {
    sessionId: session.id,
    surface: "PROGRAMS",
  });
  const outcomes = await Promise.allSettled([
    confirmOwnedBooking(f.actor, f.input),
    confirmOwnedBooking(f.actor, { ...f.input, token: second.token }),
  ]);
  expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    await db.bookingNotification.count({ where: { shopId: f.shop.id } }),
  ).toBe(2);
  expect(
    await db.entitlementLedgerEntry.count({
      where: { shopId: f.shop.id, kind: "RESERVE" },
    }),
  ).toBe(1);
});
test("two customers compete for the last seat without overselling", async () => {
  const f = await fixture();
  await db.classSession.update({
    where: { id: f.session.id },
    data: { capacity: 1 },
  });
  const customer = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/456",
    },
  });
  const grant = await grantEntitlement({
    shopId: f.shop.id,
    customerId: customer.id,
    passPlanId: f.plan.id,
    productMappingId: f.mapping.id,
    sourceOrderGid: "gid://shopify/Order/8888",
    sourceLineItemGid: "gid://shopify/LineItem/8888",
    startsAt: f.entitlement.startsAt,
    expiresAt: f.entitlement.expiresAt,
    grantedUnits: 5,
    idempotencyKey: randomUUID(),
  });
  const actor = { shopId: f.shop.id, customerGid: customer.shopifyCustomerGid };
  const attempt = await startAttempt(actor, {
    sessionId: f.session.id,
    surface: "PROGRAMS",
  });
  const outcomes = await Promise.allSettled([
    confirmOwnedBooking(f.actor, f.input),
    confirmOwnedBooking(actor, {
      token: attempt.token,
      entitlementId: grant.entitlement.id,
    }),
  ]);
  expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  const rejected = outcomes.find(
    (x) => x.status === "rejected",
  ) as PromiseRejectedResult;
  expect(rejected.reason.code).toBe("SOLD_OUT");
});
test("a second attempt cannot duplicate the customer's existing class booking", async () => {
  const f = await fixture();
  const second = await startAttempt(f.actor, {
    sessionId: f.session.id,
    surface: "PROGRAMS",
  });
  await confirmOwnedBooking(f.actor, f.input);
  await expect(
    confirmOwnedBooking(f.actor, { ...f.input, token: second.token }),
  ).rejects.toMatchObject({ code: "ALREADY_BOOKED" });
});
test("closed store gate and inactive Pass reject confirmation without side effects", async () => {
  const f = await fixture();
  await db.shop.update({
    where: { id: f.shop.id },
    data: { rules: f.shop.rules! },
  });
  await expect(confirmOwnedBooking(f.actor, f.input)).rejects.toMatchObject({
    code: "BOOKING_NOT_AVAILABLE",
  });
  await db.shop.update({
    where: { id: f.shop.id },
    data: {
      rules: { ...(f.shop.rules as object), onlineBookingsEnabled: true },
    },
  });
  await db.entitlement.update({
    where: { id: f.entitlement.id },
    data: { status: "REVOKED" },
  });
  await expect(confirmOwnedBooking(f.actor, f.input)).rejects.toMatchObject({
    code: "PASS_UNAVAILABLE",
  });
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
});
test("confirmed attempt can recover after expiry and cannot change its immutable source", async () => {
  const f = await fixture();
  const result = await confirmOwnedBooking(f.actor, f.input);
  await db.bookingAttempt.updateMany({
    where: { tokenHash: { not: f.attempt.tokenHash }, shopId: f.shop.id },
    data: {
      createdAt: new Date(Date.now() - 3600000),
      expiresAt: new Date(Date.now() - 60000),
    },
  });
  expect(await resumeAttempt(f.actor, f.input.token)).toMatchObject({
    status: "CONFIRMED",
    resultAvailable: true,
  });
  expect(await confirmOwnedBooking(f.actor, f.input)).toEqual(result);
  await expect(
    db.booking.update({
      where: { id: result.bookingReference },
      data: { ownedAttemptId: null },
    }),
  ).rejects.toThrow();
});
test("paid recovery reads only persisted payment and booking states and exposes no payment secrets", async () => {
  const f = await paidFixture();
  const actor = {
    shopId: f.shop.id,
    customerGid: f.customer.shopifyCustomerGid,
  };
  const input = { token: f.token };
  expect(await bookingResult(actor, input)).toEqual({
    status: "AWAITING_PAYMENT",
    bookingReference: null,
  });
  const event = await queuePaid(f);
  expect(await bookingResult(actor, input)).toEqual({
    status: "PROCESSING",
    bookingReference: null,
  });
  const before = await db.auditLog.count({ where: { shopId: f.shop.id } });
  await bookingResult(actor, input);
  expect(await db.auditLog.count({ where: { shopId: f.shop.id } })).toBe(
    before,
  );
  await processPaidBookingEvent(event.id);
  const result = await bookingResult(actor, input);
  expect(result.status).toBe("CONFIRMED");
  expect(Object.keys(result).sort()).toEqual(["bookingReference", "status"]);
  const text = JSON.stringify(result);
  for (const secret of [
    f.checkout.cartId!,
    f.checkout.reference,
    f.customer.shopifyCustomerGid,
    f.payload.admin_graphql_api_id,
  ])
    expect(text).not.toContain(secret);
  await db.booking.update({
    where: { id: result.bookingReference! },
    data: { status: "CANCELLED" },
  });
  expect((await bookingResult(actor, input)).status).toBe("CANCELLED");
});
test("expired paid attempt preserves recovery and does not silently create an owned booking", async () => {
  const f = await fixture();
  await db.bookingAttempt.update({
    where: { id: f.attempt.id },
    data: {
      createdAt: new Date(Date.now() - 3600000),
      expiresAt: new Date(Date.now() - 60000),
    },
  });
  expect(await resumeAttempt(f.actor, f.token)).toMatchObject({
    status: "EXPIRED",
    resultAvailable: true,
  });
  await expect(
    confirmOwnedBooking(f.actor, { ...f.input, token: f.token }),
  ).rejects.toMatchObject({ code: "ATTEMPT_EXPIRED" });
  expect((await bookingResult(f.actor, { token: f.token })).status).toBe(
    "AWAITING_PAYMENT",
  );
});
test("worker failure is a customer review state, never an automatic refund", async () => {
  const f = await paidFixture();
  const event = await queuePaid(f);
  await db.outboxEvent.update({
    where: { id: event.id },
    data: { status: "FAILED" },
  });
  expect(
    await bookingResult(
      { shopId: f.shop.id, customerGid: f.customer.shopifyCustomerGid },
      { token: f.token },
    ),
  ).toEqual({ status: "NEEDS_ATTENTION", bookingReference: null });
});
