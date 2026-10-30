import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  adjustClientPassCredits,
  updateClientPass,
} from "../app/services/pass-credit-adjustment.server";
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

async function editFixture() {
  const f = await fixture();
  return {
    ...f,
    input: {
      ...f.input,
      expectedRevision: f.pass.revision,
      expectedExpiresAt: f.pass.expiresAt?.toISOString() ?? null,
      expiryDate: "",
    },
  };
}

test("expiry-only concurrent retries produce one receipt and no credit ledger entry", async () => {
  const f = await editFixture();
  const input = {
    ...f.input,
    available: f.balance.availableUnits,
    expiryDate: "2099-10-04",
  };
  await Promise.all(
    Array.from({ length: 5 }, () => updateClientPass(f.actor, input)),
  );
  const pass = await db.entitlement.findUniqueOrThrow({
    where: { id: f.pass.id },
  });
  expect(pass.expiresAt?.toISOString()).toBe("2099-10-04T13:00:00.000Z");
  expect(pass.revision).toBe(f.pass.revision + 1);
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual(f.balance);
  expect(
    await db.auditLog.count({
      where: { shopId: f.shop.id, action: "PASS_UPDATED" },
    }),
  ).toBe(1);
  expect(
    await db.entitlementLedgerEntry.count({
      where: { entitlementId: f.pass.id, kind: "ADJUST" },
    }),
  ).toBe(0);
  await expect(
    updateClientPass(f.actor, { ...input, expiryDate: "2099-10-05" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    updateClientPass({ ...f.actor, actorId: randomUUID() }, input),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    updateClientPass(f.actor, { ...input, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: "PASS_CHANGED" });
});

test("expired pass can be reopened with an exact balance once, retaining purchase and used/reserved credits", async () => {
  const f = await editFixture();
  const closed = await db.entitlement.update({
    where: { id: f.pass.id },
    data: { status: "EXPIRED" },
  });
  const input = {
    ...f.input,
    expectedRevision: closed.revision,
    expiryDate: "2099-10-04",
  };
  await Promise.all(
    Array.from({ length: 5 }, () => updateClientPass(f.actor, input)),
  );
  const pass = await db.entitlement.findUniqueOrThrow({
    where: { id: f.pass.id },
  });
  expect(pass).toMatchObject({
    status: "ACTIVE",
    startsAt: f.pass.startsAt,
    sourceOrderGid: f.pass.sourceOrderGid,
    sourceLineItemGid: f.pass.sourceLineItemGid,
    grantedUnits: f.pass.grantedUnits,
  });
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    ...f.balance,
    availableUnits: input.available,
  });
  expect(
    await db.entitlementLedgerEntry.count({
      where: { entitlementId: f.pass.id, kind: "ADJUST" },
    }),
  ).toBe(1);
  // A delayed retry after another edit must not restore the earlier balance or expiry.
  await updateClientPass(f.actor, {
    ...input,
    expectedRevision: pass.revision,
    expectedExpiresAt: pass.expiresAt!.toISOString(),
    expectedAvailable: input.available,
    available: 0,
    expiryDate: "",
    idempotencyKey: randomUUID(),
  });
  await updateClientPass(f.actor, input);
  expect(
    (await entitlementBalance(db, f.shop.id, f.pass.id)).availableUnits,
  ).toBe(0);
});

test("simultaneous expiry edits from one snapshot cannot overwrite each other", async () => {
  const f = await editFixture();
  const results = await Promise.allSettled(
    ["2099-10-04", "2099-10-05"].map((expiryDate) =>
      updateClientPass(f.actor, {
        ...f.input,
        expiryDate,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
});

test("invalid expiry, wrong ownership and coach edits leave no partial writes", async () => {
  const f = await editFixture();
  for (const expiryDate of ["2026-02-30", "2000-01-01", "bad"]) {
    await expect(
      updateClientPass(f.actor, { ...f.input, expiryDate }),
    ).rejects.toThrow();
  }
  await expect(
    updateClientPass({ ...f.actor, role: "COACH" }, f.input),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    updateClientPass(f.actor, { ...f.input, customerId: randomUUID() }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    updateClientPass({ ...f.actor, shopId: randomUUID() }, f.input),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(
    await db.entitlement.findUniqueOrThrow({ where: { id: f.pass.id } }),
  ).toEqual(f.pass);
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual(f.balance);
  expect(
    await db.auditLog.count({
      where: { shopId: f.shop.id, action: "PASS_UPDATED" },
    }),
  ).toBe(0);
});

test("a ledger failure rolls back expiry, revision and receipt together", async () => {
  const f = await editFixture();
  const key = `staff-pass-edit:${f.input.idempotencyKey}`;
  await db.entitlementLedgerEntry.create({
    data: {
      shopId: f.shop.id,
      entitlementId: f.pass.id,
      kind: "ADJUST",
      availableDelta: 1,
      reservedDelta: 0,
      consumedDelta: 0,
      reason: "Different request",
      idempotencyKey: key,
    },
  });
  await expect(
    updateClientPass(f.actor, {
      ...f.input,
      expectedAvailable: f.balance.availableUnits + 1,
      available: f.balance.availableUnits + 4,
      expiryDate: "2099-10-04",
    }),
  ).rejects.toThrow();
  expect(
    await db.entitlement.findUniqueOrThrow({ where: { id: f.pass.id } }),
  ).toEqual(f.pass);
  expect(
    await db.auditLog.count({
      where: { shopId: f.shop.id, action: "PASS_UPDATED" },
    }),
  ).toBe(0);
});

test("reserved passes cannot shorten expiry and revoked passes cannot be reopened", async () => {
  const f = await editFixture();
  const shortened = new Date(f.pass.expiresAt!.getTime() - 7 * 86400000)
    .toISOString()
    .slice(0, 10);
  await expect(
    updateClientPass(f.actor, { ...f.input, expiryDate: shortened }),
  ).rejects.toMatchObject({ code: "PASS_RESERVED" });
  await db.entitlement.update({
    where: { id: f.pass.id },
    data: { status: "REVOKED" },
  });
  await expect(
    updateClientPass(f.actor, { ...f.input, expiryDate: "2099-10-04" }),
  ).rejects.toMatchObject({ code: "PASS_NOT_USABLE" });
});

test("unactivated passes accept credit-only edits without activation, or an explicit expiry with activation", async () => {
  const f = await editFixture();
  const pass = await db.entitlement.create({
    data: {
      ...f.pass,
      id: randomUUID(),
      sourceSystem: "MANUAL_CASH",
      externalKey: randomUUID(),
      sourceOrderGid: null,
      sourceLineItemGid: null,
      startsAt: null,
      expiresAt: null,
      activationBookingId: null,
      validityDays: 30,
    },
  });
  const input = {
    ...f.input,
    entitlementId: pass.id,
    expectedRevision: pass.revision,
    expectedExpiresAt: null,
    expectedAvailable: 0,
    available: 2,
  };
  await updateClientPass(f.actor, input);
  const edited = await db.entitlement.findUniqueOrThrow({
    where: { id: pass.id },
  });
  expect(edited.startsAt).toBeNull();
  expect(edited.expiresAt).toBeNull();
  await updateClientPass(f.actor, {
    ...input,
    expectedRevision: edited.revision,
    expectedAvailable: 2,
    expiryDate: "2099-10-04",
    idempotencyKey: randomUUID(),
  });
  const activated = await db.entitlement.findUniqueOrThrow({
    where: { id: pass.id },
  });
  expect(activated.startsAt).not.toBeNull();
  expect(activated.expiresAt?.toISOString()).toBe("2099-10-04T13:00:00.000Z");
});
