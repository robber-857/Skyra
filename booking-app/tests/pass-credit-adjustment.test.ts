import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import { adjustClientPassCredits } from "../app/services/pass-credit-adjustment.server";
import { entitlementBalance } from "../app/services/entitlements.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
async function fixture() {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const pass = await db.entitlement.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const balance = await entitlementBalance(db, f.shop.id, pass.id);
  return {
    ...f,
    pass,
    balance,
    actor: { shopId: f.shop.id, actorId: randomUUID(), role: "ADMIN" as const },
    input: {
      customerId: f.customer.id,
      entitlementId: pass.id,
      available: balance.availableUnits + 2,
      expectedAvailable: balance.availableUnits,
      reason: "Owner approved balance correction",
      idempotencyKey: randomUUID(),
    },
  };
}
test("adjustments preserve reservations, payment source and pass terms with one ledger entry and audit on concurrent retries", async () => {
  const f = await fixture();
  await Promise.all(
    Array.from({ length: 5 }, () => adjustClientPassCredits(f.actor, f.input)),
  );
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    ...f.balance,
    availableUnits: f.input.available,
  });
  expect(
    await db.entitlement.findUniqueOrThrow({ where: { id: f.pass.id } }),
  ).toEqual(f.pass);
  const entries = await db.entitlementLedgerEntry.findMany({
    where: { entitlementId: f.pass.id, kind: "ADJUST" },
  });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    availableDelta: 2,
    reservedDelta: 0,
    consumedDelta: 0,
    reason: f.input.reason,
  });
  const logs = await db.auditLog.findMany({
    where: { entityId: entries[0].id, action: "PASS_CREDITS_ADJUSTED" },
  });
  expect(logs).toHaveLength(1);
  expect(logs[0].actorId).toBe(f.actor.actorId);
  await expect(
    adjustClientPassCredits(f.actor, { ...f.input, available: 10 }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    adjustClientPassCredits({ ...f.actor, actorId: randomUUID() }, f.input),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
test("reducing available to zero preserves already reserved credits", async () => {
  const f = await fixture();
  await adjustClientPassCredits(f.actor, { ...f.input, available: 0 });
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    ...f.balance,
    availableUnits: 0,
  });
  await expect(
    adjustClientPassCredits(f.actor, {
      ...f.input,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "BALANCE_CHANGED" });
});
test("conflicting simultaneous edits cannot overwrite a newer balance", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(
    [2, 3].map((add) =>
      adjustClientPassCredits(f.actor, {
        ...f.input,
        available: f.balance.availableUnits + add,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(
    await db.entitlementLedgerEntry.count({
      where: { entitlementId: f.pass.id, kind: "ADJUST" },
    }),
  ).toBe(1);
});
test("cross-shop, wrong customer, coach and invalid inputs cannot adjust credits", async () => {
  const f = await fixture();
  await expect(
    adjustClientPassCredits({ ...f.actor, role: "COACH" }, f.input),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    adjustClientPassCredits({ ...f.actor, shopId: randomUUID() }, f.input),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    adjustClientPassCredits(f.actor, { ...f.input, customerId: randomUUID() }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  for (const available of [-1, 0.5, 10001, "", null])
    await expect(
      adjustClientPassCredits(f.actor, { ...f.input, available }),
    ).rejects.toThrow();
  await expect(
    adjustClientPassCredits(f.actor, { ...f.input, reason: " " }),
  ).rejects.toThrow();
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual(f.balance);
});
test.each(["EXPIRED", "REVOKED", "elapsed"])(
  "%s passes reject balance adjustments",
  async (status) => {
    const f = await fixture();
    if (status === "elapsed") {
      const expired = await db.entitlement.create({
        data: {
          ...f.pass,
          id: randomUUID(),
          sourceSystem: "MANUAL_CASH",
          externalKey: randomUUID(),
          sourceOrderGid: null,
          sourceLineItemGid: null,
          startsAt: new Date(Date.now() - 86400000),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      f.input.entitlementId = expired.id;
    } else
      await db.entitlement.update({
        where: { id: f.pass.id },
        data: { status },
      });
    await expect(
      adjustClientPassCredits(f.actor, f.input),
    ).rejects.toMatchObject({ code: "PASS_NOT_USABLE" });
    expect(
      await db.entitlementLedgerEntry.count({
        where: { entitlementId: f.pass.id, kind: "ADJUST" },
      }),
    ).toBe(0);
  },
);
