import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { grantCashCredits } from "../app/services/manual-credits.server";
import {
  eligibleEntitlements,
  entitlementBalance,
  reserveEntitlementCredit,
} from "../app/services/entitlements.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
async function fixture(kind: "NEW_PASS" | "DROP_IN" = "NEW_PASS") {
  const f = await paidFixture(kind);
  return {
    ...f,
    actor: { shopId: f.shop.id, actorId: randomUUID(), role: "ADMIN" as const },
    input: {
      customerId: f.customer.id,
      target:
        kind === "NEW_PASS"
          ? "PASS_PLAN:" + f.plan.id
          : "SERVICE:" + f.service.id,
      units: kind === "NEW_PASS" ? 5 : 1,
      validityDays: 30,
      amount: "140.00",
      reason: "Cash received receipt 123",
      idempotencyKey: randomUUID(),
    },
  };
}
test.each(["NEW_PASS", "DROP_IN"] as const)(
  "cash %s creates usable credits once without Shopify payment",
  async (kind) => {
    const f = await fixture(kind);
    const grants = await Promise.all(
      Array.from({ length: 5 }, () => grantCashCredits(f.actor, f.input)),
    );
    expect(new Set(grants.map((g) => g.id)).size).toBe(1);
    const grant = grants[0];
    expect(grant).toMatchObject({
      sourceSystem: "MANUAL_CASH",
      sourceOrderGid: null,
      sourceLineItemGid: null,
      grantedUnits: f.input.units,
    });
    expect(grant.startsAt === null).toBe(kind === "NEW_PASS");
    expect(
      await db.auditLog.count({
        where: { entityId: grant.id, action: "CASH_CREDITS_GRANTED" },
      }),
    ).toBe(1);
    expect(
      await db.entitlementLedgerEntry.count({
        where: { entitlementId: grant.id },
      }),
    ).toBe(1);
    const eligible = await eligibleEntitlements(db, {
      shopId: f.shop.id,
      customerId: f.customer.id,
      serviceId: f.service.id,
      sessionStartsAt: f.session.startsAt,
      now: new Date(),
    });
    expect(eligible.map((e) => e.id)).toContain(grant.id);
    await db.bookingHold.update({
      where: { id: f.hold.id },
      data: { status: "RELEASED" },
    });
    const booking = await db.booking.create({
      data: {
        shopId: f.shop.id,
        customerId: f.customer.id,
        sessionId: f.session.id,
      },
    });
    await db.$transaction((tx) =>
      reserveEntitlementCredit(tx, {
        shopId: f.shop.id,
        customerId: f.customer.id,
        serviceId: f.service.id,
        sessionStartsAt: f.session.startsAt,
        now: new Date(),
        entitlementId: grant.id,
        bookingId: booking.id,
        reservationKey: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    expect(await entitlementBalance(db, f.shop.id, grant.id)).toMatchObject({
      availableUnits: f.input.units - 1,
      reservedUnits: 1,
      consumedUnits: 0,
    });
    expect(
      await db.paidBookingResult.count({ where: { shopId: f.shop.id } }),
    ).toBe(0);
    await expect(
      grantCashCredits(f.actor, { ...f.input, units: 2 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  },
);
test("cash grants enforce staff access, tenant scope and valid cash details", async () => {
  const f = await fixture(),
    other = await fixture();
  await expect(
    grantCashCredits({ ...f.actor, role: "COACH" }, f.input),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    grantCashCredits(f.actor, { ...f.input, customerId: other.customer.id }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    grantCashCredits(f.actor, { ...f.input, target: other.input.target }),
  ).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
  for (const patch of [
    { units: 0 },
    { units: 1.5 },
    { amount: "0" },
    { amount: "1.001" },
    { reason: "" },
  ])
    await expect(
      grantCashCredits(f.actor, { ...f.input, ...patch }),
    ).rejects.toThrow();
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(0);
});
