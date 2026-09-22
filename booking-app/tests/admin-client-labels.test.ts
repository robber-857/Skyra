import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import { adminOverview } from "../app/services/admin-overview.server";
import { bookingOperationsData } from "../app/services/booking-operations.server";
import { staffBookingDetail } from "../app/services/booking-lifecycle.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
test("Admin shows Shopify or preferred client names and the original booking note, scoped to the shop", async () => {
  const f = await paidFixture(),
    other = await paidFixture();
  const note =
    "First class\nPlease explain the warm-up. <script>not markup</script>";
  await db.bookingAttempt.update({
    where: { id: f.attempt.id },
    data: { customerComment: note },
  });
  await processPaidBookingEvent((await queuePaid(f)).id);
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  const booking = await db.booking.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const expiring = await db.entitlement.create({
    data: {
      shopId: f.shop.id,
      customerId: f.customer.id,
      passPlanId: f.plan.id,
      productMappingId: f.mapping.id,
      sourceOrderGid: "gid://shopify/Order/99999",
      sourceLineItemGid: "gid://shopify/LineItem/99999",
      grantedUnits: 5,
      startsAt: new Date(Date.now() - 1000),
      expiresAt: new Date(Date.now() + 7 * 86400000),
    },
  });
  await db.entitlementLedgerEntry.create({
    data: {
      shopId: f.shop.id,
      entitlementId: expiring.id,
      kind: "GRANT",
      availableDelta: 5,
      reservedDelta: 0,
      consumedDelta: 0,
      idempotencyKey: randomUUID(),
    },
  });
  for (const [preferredName, shopifyName, email, expected] of [
    ["", "Alice Chen", "alice@example.com", "Alice Chen"],
    [" Ally ", "Alice Chen", "alice@example.com", "Ally"],
    ["   ", "   ", "alice@example.com", "alice@example.com"],
    ["", "", null, "Unnamed client"],
  ] as const) {
    await db.customerProfile.update({
      where: { id: f.customer.id },
      data: { preferredName, shopifyName, email },
    });
    const overview = await adminOverview(actor),
      list = await bookingOperationsData(actor),
      detail = await staffBookingDetail(actor, booking.id);
    expect(overview.expiringPasses[0]).toMatchObject({
      customerId: f.customer.id,
      customerName: expected,
    });
    expect(list.bookings[0]).toMatchObject({
      customerId: f.customer.id,
      customerName: expected,
      customerComment: note,
    });
    expect(detail.booking).toMatchObject({
      customerId: f.customer.id,
      customerName: expected,
      customerComment: note,
    });
  }
  expect(
    (await adminOverview({ ...actor, shopId: other.shop.id })).expiringPasses,
  ).toEqual([]);
  expect(
    (await bookingOperationsData({ ...actor, shopId: other.shop.id })).bookings,
  ).toEqual([]);
  await expect(
    staffBookingDetail({ ...actor, shopId: other.shop.id }, booking.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  for (const load of [
    () => adminOverview({ ...actor, role: "COACH" }),
    () => bookingOperationsData({ ...actor, role: "COACH" }),
    () => staffBookingDetail({ ...actor, role: "COACH" }, booking.id),
  ])
    await expect(load()).rejects.toMatchObject({ code: "FORBIDDEN" });
});

