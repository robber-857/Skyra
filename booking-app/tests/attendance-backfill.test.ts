import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { grantCashCredits } from "../app/services/manual-credits.server";
import {
  attendanceBackfillOptions,
  backfillAttendance,
} from "../app/services/attendance-backfill.server";
import { entitlementBalance } from "../app/services/entitlements.server";
import {
  staffBookingDetail,
  staffChangeBooking,
  settleDefaultAttendanceWork,
} from "../app/services/booking-lifecycle.server";

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
    reason: "Synthetic cash Pass",
    idempotencyKey: randomUUID(),
  });
  const startsAt = new Date(Date.now() - 7200000),
    endsAt = new Date(Date.now() - 3600000);
  await db.classSession.update({
    where: { id: f.session.id },
    data: {
      startsAt,
      endsAt,
      busyStartsAt: startsAt,
      busyEndsAt: endsAt,
    },
  });
  const date = DateTime.fromJSDate(startsAt, {
    zone: f.shop.timezone,
  }).toISODate()!;
  return {
    ...f,
    actor,
    pass,
    startsAt,
    date,
    input: {
      customerId: f.customer.id,
      sessionId: f.session.id,
      entitlementId: pass.id,
      reason: "Walk-in attended in person",
      idempotencyKey: randomUUID(),
    },
  };
}

test("past attendance consumes exactly once, activates at class time, has an audit timeline and sends no notifications", async () => {
  const f = await fixture();
  const options = await attendanceBackfillOptions(
    f.actor,
    f.customer.id,
    f.date,
  );
  expect(
    options.options.find((s) => s.id === f.session.id)?.passes.map((p) => p.id),
  ).toContain(f.pass.id);
  const ids = await Promise.all(
    Array.from({ length: 5 }, () => backfillAttendance(f.actor, f.input)),
  );
  expect(new Set(ids).size).toBe(1);
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    availableUnits: 4,
    reservedUnits: 0,
    consumedUnits: 1,
  });
  const detail = await staffBookingDetail(f.actor, ids[0]);
  expect(detail.booking).toMatchObject({
    status: "ATTENDED",
    checkedInAt: null,
    sourceOrderGid: null,
    checkoutId: null,
  });
  expect(detail.booking.createdAt.getTime()).toBeGreaterThan(
    f.startsAt.getTime(),
  );
  expect(detail.timeline).toHaveLength(1);
  expect(detail.timeline[0]).toMatchObject({
    action: "BACKFILL_ATTENDANCE",
    actorId: f.actor.actorId,
    reason: f.input.reason,
  });
  expect(
    detail.booking.entitlementLedgerEntries.map((e) => e.kind).sort(),
  ).toEqual(["CONSUME", "RESERVE"]);
  expect(
    (await db.entitlement.findUniqueOrThrow({ where: { id: f.pass.id } }))
      .startsAt,
  ).toEqual(
    DateTime.fromJSDate(f.startsAt, { zone: f.shop.timezone })
      .startOf("day")
      .toJSDate(),
  );
  expect(
    await db.bookingNotification.count({ where: { bookingId: ids[0] } }),
  ).toBe(0);
  expect(
    await db.auditLog.count({
      where: { entityId: ids[0], action: "ATTENDANCE_BACKFILLED" },
    }),
  ).toBe(1);
  expect(
    (await settleDefaultAttendanceWork({ shopId: f.shop.id })).settled,
  ).toBe(0);
  expect(
    (await attendanceBackfillOptions(f.actor, f.customer.id, f.date)).options,
  ).toHaveLength(0);
  for (const changed of [
    { reason: "Changed reason" },
    { sessionId: randomUUID() },
    { entitlementId: randomUUID() },
  ])
    await expect(
      backfillAttendance(f.actor, { ...f.input, ...changed }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    backfillAttendance({ ...f.actor, actorId: randomUUID() }, f.input),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  // Existing credit restoration continues to work with the linked reservation.
  await staffChangeBooking(f.actor, {
    bookingId: ids[0],
    expectedVersion: 1,
    action: "CANCEL_WAIVE",
    reason: "Correct synthetic attendance",
    idempotencyKey: randomUUID(),
  });
  expect(
    (await entitlementBalance(db, f.shop.id, f.pass.id)).availableUnits,
  ).toBe(5);
});

test("different requests for the same client and class cannot double-charge", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      backfillAttendance(f.actor, { ...f.input, idempotencyKey: randomUUID() }),
    ),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    (await entitlementBalance(db, f.shop.id, f.pass.id)).consumedUnits,
  ).toBe(1);
});

test("concurrent different classes competing for the last credit roll back the losing booking", async () => {
  const f = await fixture();
  await db.entitlementLedgerEntry.create({
    data: {
      shopId: f.shop.id,
      entitlementId: f.pass.id,
      kind: "ADJUST",
      availableDelta: -4,
      reservedDelta: 0,
      consumedDelta: 0,
      idempotencyKey: randomUUID(),
      reason: "One synthetic credit left",
    },
  });
  const otherStart = new Date(f.startsAt.getTime() - 86400000);
  const otherEnd = new Date(otherStart.getTime() + 3600000);
  // Activate before both classes to isolate the last-credit race from activation rules.
  await db.entitlement.update({
    where: { id: f.pass.id },
    data: {
      startsAt: new Date(otherStart.getTime() - 86400000),
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  const otherSession = await db.classSession.create({
    data: {
      shopId: f.shop.id,
      serviceId: f.service.id,
      coachId: f.coach.id,
      locationId: f.location.id,
      startsAt: otherStart,
      endsAt: otherEnd,
      busyStartsAt: otherStart,
      busyEndsAt: otherEnd,
      timezone: f.session.timezone,
      capacity: 8,
      status: "COMPLETED",
      dedupeKey: randomUUID(),
    },
  });
  const results = await Promise.allSettled(
    [f.session.id, otherSession.id].map((sessionId) =>
      backfillAttendance(f.actor, {
        ...f.input,
        sessionId,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(await db.bookingChange.count({ where: { shopId: f.shop.id } })).toBe(
    1,
  );
  expect(await entitlementBalance(db, f.shop.id, f.pass.id)).toEqual({
    availableUnits: 0,
    reservedUnits: 0,
    consumedUnits: 1,
  });
});

test.each(["CONFIRMED", "ATTENDED", "NO_SHOW", "LATE_CANCEL"])(
  "existing %s record is excluded and cannot be charged again",
  async (status) => {
    const f = await fixture();
    await db.booking.create({
      data: {
        shopId: f.shop.id,
        customerId: f.customer.id,
        sessionId: f.session.id,
        status,
      },
    });
    expect(
      (await attendanceBackfillOptions(f.actor, f.customer.id, f.date)).options,
    ).toHaveLength(0);
    await expect(backfillAttendance(f.actor, f.input)).rejects.toMatchObject({
      code: "ALREADY_BOOKED",
    });
    expect(
      (await entitlementBalance(db, f.shop.id, f.pass.id)).availableUnits,
    ).toBe(5);
  },
);

test.each(["DRAFT", "CANCELLED", "future", "in-progress"])(
  "%s class cannot be backfilled",
  async (scenario) => {
    const f = await fixture();
    const startsAt = new Date(
      Date.now() + (scenario === "future" ? 3600000 : -1800000),
    );
    const endsAt = new Date(Date.now() + 7200000);
    await db.classSession.update({
      where: { id: f.session.id },
      data: ["DRAFT", "CANCELLED"].includes(scenario)
        ? { status: scenario }
        : { startsAt, endsAt, busyStartsAt: startsAt, busyEndsAt: endsAt },
    });
    await expect(backfillAttendance(f.actor, f.input)).rejects.toMatchObject({
      code: "CLASS_NOT_ENDED",
    });
    expect(
      (await attendanceBackfillOptions(f.actor, f.customer.id, f.date)).options,
    ).toHaveLength(0);
    expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
  },
);

test("completed full classes accept factual attendance and a cancelled record does not block it", async () => {
  const f = await fixture();
  await db.classSession.update({
    where: { id: f.session.id },
    data: { capacity: 1, status: "COMPLETED" },
  });
  const other = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/678",
    },
  });
  await db.booking.create({
    data: {
      shopId: f.shop.id,
      customerId: other.id,
      sessionId: f.session.id,
      status: "ATTENDED",
    },
  });
  await db.booking.create({
    data: {
      shopId: f.shop.id,
      customerId: f.customer.id,
      sessionId: f.session.id,
      status: "CANCELLED",
    },
  });
  expect(
    (await attendanceBackfillOptions(f.actor, f.customer.id, f.date))
      .options[0],
  ).toMatchObject({ enrolled: 1, capacity: 1 });
  await backfillAttendance(f.actor, f.input);
  expect(
    await db.booking.count({
      where: { shopId: f.shop.id, status: "ATTENDED" },
    }),
  ).toBe(2);
});

test("wrong role, shop, client, Pass ownership and reason are rejected", async () => {
  const f = await fixture();
  await expect(
    backfillAttendance({ ...f.actor, role: "COACH" }, f.input),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    attendanceBackfillOptions({ ...f.actor, role: "COACH" }, f.customer.id),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    backfillAttendance({ ...f.actor, shopId: randomUUID() }, f.input),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    backfillAttendance(f.actor, { ...f.input, customerId: randomUUID() }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const other = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/678",
    },
  });
  await expect(
    backfillAttendance(f.actor, { ...f.input, customerId: other.id }),
  ).rejects.toMatchObject({ code: "PASS_UNAVAILABLE" });
  await expect(
    backfillAttendance(f.actor, { ...f.input, reason: " " }),
  ).rejects.toThrow();
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
});

test.each(["revoked", "expired", "ineligible", "empty", "outside-validity"])(
  "%s Pass leaves no partial attendance or charge",
  async (scenario) => {
    const f = await fixture();
    if (scenario === "revoked" || scenario === "expired")
      await db.entitlement.update({
        where: { id: f.pass.id },
        data: { status: scenario.toUpperCase() },
      });
    else if (scenario === "ineligible")
      await db.passEligibility.deleteMany({
        where: { shopId: f.shop.id, passPlanId: f.plan.id },
      });
    else if (scenario === "empty")
      await db.entitlementLedgerEntry.create({
        data: {
          shopId: f.shop.id,
          entitlementId: f.pass.id,
          kind: "ADJUST",
          availableDelta: -5,
          reservedDelta: 0,
          consumedDelta: 0,
          idempotencyKey: randomUUID(),
          reason: "Synthetic exhausted Pass",
        },
      });
    else
      await db.entitlement.update({
        where: { id: f.pass.id },
        data: {
          startsAt: new Date(),
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
    await expect(backfillAttendance(f.actor, f.input)).rejects.toMatchObject({
      code: "PASS_UNAVAILABLE",
    });
    expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
    expect(
      (await attendanceBackfillOptions(f.actor, f.customer.id, f.date))
        .options[0].passes,
    ).toHaveLength(0);
    expect(
      (await entitlementBalance(db, f.shop.id, f.pass.id)).consumedUnits,
    ).toBe(0);
  },
);

test("date selection uses studio calendar days and rejects invalid dates", async () => {
  const f = await fixture();
  const start = DateTime.fromISO("2026-04-05T00:30", { zone: f.shop.timezone });
  const end = start.plus({ hours: 1 });
  await db.classSession.update({
    where: { id: f.session.id },
    data: {
      startsAt: start.toJSDate(),
      endsAt: end.toJSDate(),
      busyStartsAt: start.toJSDate(),
      busyEndsAt: end.toJSDate(),
    },
  });
  expect(
    (
      await attendanceBackfillOptions(f.actor, f.customer.id, "2026-04-05")
    ).options.map((s) => s.id),
  ).toContain(f.session.id);
  expect(
    (await attendanceBackfillOptions(f.actor, f.customer.id, "2026-04-04"))
      .options,
  ).toHaveLength(0);
  await expect(
    attendanceBackfillOptions(f.actor, f.customer.id, "2026-02-30"),
  ).rejects.toMatchObject({ code: "INVALID_DATE" });
});
