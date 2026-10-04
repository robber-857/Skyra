import { randomUUID } from "node:crypto";
import { afterAll, expect, test } from "vitest";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { claimPassPurchaseInTransaction } from "../app/services/membership-purchases.server";

afterAll(() => db.$disconnect());

test("only explicit provider closure proof releases a legacy checkout claim", async () => {
  const f = await paidFixture("NEW_PASS", true, "CLASS", 1);
  const claim = () =>
    db.$transaction((tx) =>
      claimPassPurchaseInTransaction(tx, {
        shopId: f.shop.id,
        customerId: f.customer.id,
        passPlanId: f.plan.id,
        mode: "ONCE",
        idempotencyKey: randomUUID(),
        productMappingId: f.mapping.id,
        productGid: f.mapping.productGid!,
        variantGid: f.mapping.variantGid!,
        priceCents: f.plan.requestedPriceCents,
        currency: "AUD",
        credits: f.plan.credits,
        validityDays: f.plan.validityDays,
        validityMonths: 1,
        timezone: "Australia/Sydney",
        termsVersion: "test",
      }),
    );
  await expect(claim()).rejects.toMatchObject({
    code: "PASS_PAYMENT_IN_PROGRESS",
  });
  await expect(
    db.legacyCheckoutClosure.create({
      data: {
        checkoutId: f.checkout.id,
        shopId: f.shop.id,
        actorId: "test",
        evidence: { cartEmpty: true },
      },
    }),
  ).rejects.toThrow();
  await db.legacyCheckoutClosure.create({
    data: {
      checkoutId: f.checkout.id,
      shopId: f.shop.id,
      actorId: "test",
      evidence: {
        cartEmpty: true,
        nativeCheckoutClosed: true,
        matchingOrders: 0,
      },
    },
  });
  await expect(claim()).resolves.toHaveProperty("purchase.id");
  await expect(
    db.legacyCheckoutClosure.delete({ where: { checkoutId: f.checkout.id } }),
  ).rejects.toThrow();
  expect(
    (
      await db.bookingCheckout.findUniqueOrThrow({
        where: { id: f.checkout.id },
      })
    ).status,
  ).toBe(f.checkout.status);
});
