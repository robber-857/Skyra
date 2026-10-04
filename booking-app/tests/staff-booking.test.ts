import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { grantCashCredits } from "../app/services/manual-credits.server";
import {
  bookClientIntoSession,
  staffBookingOptions,
} from "../app/services/staff-booking.server";
import { entitlementBalance } from "../app/services/entitlements.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
async function fixture() {
  const f = await paidFixture();
  await db.bookingHold.update({
    where: { id: f.hold.id },
    data: { status: "RELEASED" },
  });
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  const pass = await grantCashCredits(actor, {
    customerId: f.customer.id,
    target: `PASS_PLAN:${f.plan.id}`,
    units: 5,
    validityDays: 30,
    amount: "100",
    reason: "Synthetic cash grant",
    idempotencyKey: randomUUID(),
  });
  return {
    ...f,
    actor,
    pass,
    input: {
      customerId: f.customer.id,
      sessionId: f.session.id,
      entitlementId: pass.id,
      reason: "Client requested staff booking",
      idempotencyKey: randomUUID(),
    },
  };
}
async function moveSessionStart(
  f: Awaited<ReturnType<typeof fixture>>,
  minutesFromNow: number,
) {
  const startsAt = new Date(Date.now() + minutesFromNow * 60000);
  const endsAt = new Date(
    startsAt.getTime() + f.session.endsAt.getTime() - f.session.startsAt.getTime(),
  );
  return db.classSession.update({
    where: { id: f.session.id },
    data: { startsAt, endsAt, busyStartsAt: startsAt, busyEndsAt: endsAt },
  });
}

test("ADMIN can book during the final two hours and concurrent retries reserve exactly one Pass credit", async () => {
  const f = await fixture();
  const session = await moveSessionStart(f, 60);
  const options = await staffBookingOptions(f.actor, f.customer.id);
  expect(options.find((s) => s.id === f.session.id)).toMatchObject({
    startsAt: session.startsAt.toISOString(),
    passes: expect.arrayContaining([expect.objectContaining({ id: f.pass.id })]),
  });

  const ids = await Promise.all(
    Array.from({ length: 5 }, () => bookClientIntoSession(f.actor, f.input)),
  );
  expect(new Set(ids).size).toBe(1);
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    availableUnits: 4,
    reservedUnits: 1,
    consumedUnits: 0,
  });
  expect(
    await db.bookingNotification.count({ where: { bookingId: ids[0] } }),
  ).toBe(4);
  expect(
    await db.auditLog.count({
      where: { entityId: ids[0], action: "STAFF_BOOKING_CONFIRMED" },
    }),
  ).toBe(1);
  expect(
    (await staffBookingOptions(f.actor, f.customer.id)).some(
      (s) => s.id === f.session.id,
    ),
  ).toBe(false);

  // A retry of an already-confirmed booking must still succeed after class starts.
  await moveSessionStart(f, -1);
  expect(await bookClientIntoSession(f.actor, f.input)).toBe(ids[0]);
  await expect(
    bookClientIntoSession(f.actor, { ...f.input, idempotencyKey: randomUUID() }),
  ).rejects.toMatchObject({ code: "BOOKING_CLOSED" });
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    availableUnits: 4,
    reservedUnits: 1,
    consumedUnits: 0,
  });
});

test("OPERATIONS cannot select or book during the final two hours, and COACH has no staff booking access", async () => {
  const f = await fixture();
  await moveSessionStart(f, 60);
  const operations = { ...f.actor, role: "OPERATIONS" as const };
  expect(
    (await staffBookingOptions(operations, f.customer.id)).some(
      (s) => s.id === f.session.id,
    ),
  ).toBe(false);
  await expect(bookClientIntoSession(operations, f.input)).rejects.toMatchObject({
    code: "BOOKING_CLOSED",
  });
  await expect(
    bookClientIntoSession(operations, { ...f.input, mode: "ADMIN" }),
  ).rejects.toThrow();
  const coach = { ...f.actor, role: "COACH" as const };
  await expect(staffBookingOptions(coach, f.customer.id)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(bookClientIntoSession(coach, f.input)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    availableUnits: 5,
    reservedUnits: 0,
    consumedUnits: 0,
  });
});

test.each(["live-hold", "confirmed-booking"])(
  "ADMIN late booking cannot bypass capacity occupied by a %s",
  async (occupiedBy) => {
    const f = await fixture();
    await moveSessionStart(f, 60);
    await db.classSession.update({
      where: { id: f.session.id },
      data: { capacity: 1 },
    });
    if (occupiedBy === "live-hold") {
      await db.bookingHold.update({
        where: { id: f.hold.id },
        data: { status: "ACTIVE" },
      });
    } else {
      const other = await db.customerProfile.create({
        data: {
          shopId: f.shop.id,
          shopifyCustomerGid: "gid://shopify/Customer/988",
        },
      });
      await db.booking.create({
        data: {
          shopId: f.shop.id,
          sessionId: f.session.id,
          customerId: other.id,
        },
      });
    }
    expect(
      (await staffBookingOptions(f.actor, f.customer.id)).some(
        (s) => s.id === f.session.id,
      ),
    ).toBe(false);
    await expect(bookClientIntoSession(f.actor, f.input)).rejects.toMatchObject({
      code: "SOLD_OUT",
    });
    expect(
      await db.booking.count({
        where: { shopId: f.shop.id, customerId: f.customer.id },
      }),
    ).toBe(0);
    expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
      availableUnits: 5,
      reservedUnits: 0,
      consumedUnits: 0,
    });
  },
);

test.each(["expired-pass", "ineligible-pass", "wrong-owner"])(
  "ADMIN late booking cannot use an %s",
  async (scenario) => {
    const f = await fixture();
    await moveSessionStart(f, 60);
    let customerId = f.customer.id;
    if (scenario === "expired-pass") {
      await db.entitlement.update({
        where: { id: f.pass.id },
        data: { status: "EXPIRED" },
      });
    } else if (scenario === "ineligible-pass") {
      await db.passEligibility.deleteMany({
        where: { shopId: f.shop.id, passPlanId: f.plan.id },
      });
    } else {
      customerId = (
        await db.customerProfile.create({
          data: {
            shopId: f.shop.id,
            shopifyCustomerGid: "gid://shopify/Customer/989",
          },
        })
      ).id;
    }
    await expect(
      bookClientIntoSession(f.actor, { ...f.input, customerId }),
    ).rejects.toMatchObject({ code: "PASS_UNAVAILABLE" });
    expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
    expect(
      await db.bookingNotification.count({ where: { shopId: f.shop.id } }),
    ).toBe(0);
    expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
      availableUnits: 5,
      reservedUnits: 0,
      consumedUnits: 0,
    });
  },
);

test("staff booking reserves one credit, activates Pass and queues notifications exactly once with public booking closed", async () => {
  const f = await fixture();
  expect((f.shop.rules as Record<string, unknown>).onlineBookingsEnabled).toBe(
    false,
  );
  const options = await staffBookingOptions(f.actor, f.customer.id);
  expect(
    options.find((s) => s.id === f.session.id)?.passes.map((p) => p.id),
  ).toContain(f.pass.id);
  const ids = await Promise.all(
    Array.from({ length: 5 }, () => bookClientIntoSession(f.actor, f.input)),
  );
  expect(new Set(ids).size).toBe(1);
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    availableUnits: 4,
    reservedUnits: 1,
    consumedUnits: 0,
  });
  const booking = await db.booking.findUniqueOrThrow({ where: { id: ids[0] } });
  expect(booking).toMatchObject({
    status: "CONFIRMED",
    customerId: f.customer.id,
    checkoutId: null,
    sourceOrderGid: null,
  });
  expect(
    (await db.entitlement.findUniqueOrThrow({ where: { id: f.pass.id } }))
      .startsAt,
  ).not.toBeNull();
  expect(
    await db.bookingNotification.count({ where: { bookingId: ids[0] } }),
  ).toBe(4);
  expect(
    await db.auditLog.count({
      where: { entityId: ids[0], action: "STAFF_BOOKING_CONFIRMED" },
    }),
  ).toBe(1);
  await expect(
    bookClientIntoSession(f.actor, { ...f.input, reason: "Changed reason" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    bookClientIntoSession(f.actor, {
      ...f.input,
      idempotencyKey: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "ALREADY_BOOKED" });
});

test("staff can select and reserve a published class more than 14 days away", async () => {
  const f = await fixture();
  const startsAt = new Date(Date.now() + 20 * 86400000);
  const endsAt = new Date(
    startsAt.getTime() + f.session.endsAt.getTime() - f.session.startsAt.getTime(),
  );
  await db.classSession.update({
    where: { id: f.session.id },
    data: { startsAt, endsAt, busyStartsAt: startsAt, busyEndsAt: endsAt },
  });

  const options = await staffBookingOptions(f.actor, f.customer.id);
  expect(options.find((session) => session.id === f.session.id)).toMatchObject({
    startsAt: startsAt.toISOString(),
    passes: expect.arrayContaining([expect.objectContaining({ id: f.pass.id })]),
  });
  const bookingId = await bookClientIntoSession(f.actor, f.input);
  expect(
    await db.booking.findUniqueOrThrow({ where: { id: bookingId } }),
  ).toMatchObject({
    status: "CONFIRMED",
    sessionId: f.session.id,
    customerId: f.customer.id,
  });
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    availableUnits: 4,
    reservedUnits: 1,
    consumedUnits: 0,
  });
});

test("full classes including live checkout holds cannot be overbooked", async () => {
  const f = await fixture();
  await db.classSession.update({
    where: { id: f.session.id },
    data: { capacity: 1 },
  });
  await db.bookingHold.update({
    where: { id: f.hold.id },
    data: { status: "ACTIVE" },
  });
  await expect(bookClientIntoSession(f.actor, f.input)).rejects.toMatchObject({
    code: "SOLD_OUT",
  });
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
  expect(
    (await entitlementBalance(db, f.shop.id, f.pass.id)).availableUnits,
  ).toBe(5);
});
test("booking rejects wrong clients, shops, roles and Pass ownership", async () => {
  const f = await fixture();
  await expect(
    bookClientIntoSession({ ...f.actor, role: "COACH" }, f.input),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    bookClientIntoSession({ ...f.actor, shopId: randomUUID() }, f.input),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    bookClientIntoSession(f.actor, { ...f.input, customerId: randomUUID() }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const other = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/987",
    },
  });
  await expect(
    bookClientIntoSession(f.actor, { ...f.input, customerId: other.id }),
  ).rejects.toMatchObject({ code: "PASS_UNAVAILABLE" });
});
test.each(["past", "draft", "expired-pass", "ineligible-pass"])(
  "%s cannot create a staff booking",
  async (scenario) => {
    const f = await fixture();
    if (scenario === "past") {
      const startsAt = new Date(Date.now() - 7200000),
        endsAt = new Date(Date.now() - 3600000);
      await db.classSession.update({
        where: { id: f.session.id },
        data: { startsAt, endsAt, busyStartsAt: startsAt, busyEndsAt: endsAt },
      });
    } else if (scenario === "draft")
      await db.classSession.update({
        where: { id: f.session.id },
        data: { status: "DRAFT" },
      });
    else if (scenario === "expired-pass")
      await db.entitlement.update({
        where: { id: f.pass.id },
        data: { status: "EXPIRED" },
      });
    else
      await db.passEligibility.deleteMany({
        where: { shopId: f.shop.id, passPlanId: f.plan.id },
      });
    await expect(bookClientIntoSession(f.actor, f.input)).rejects.toThrow();
    expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
    expect(
      await db.bookingNotification.count({ where: { shopId: f.shop.id } }),
    ).toBe(0);
  },
);
