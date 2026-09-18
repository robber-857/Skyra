import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  cancellationOutcome,
  staffChangeBooking,
  customerChangeBooking,
  coachChangeBooking,
  coachRoster,
  settleDefaultAttendanceWork,
} from "../app/services/booking-lifecycle.server";
import {
  issueCoachLogin,
  exchangeCoachLogin,
  revokeCoachSession,
} from "../app/services/coach-auth.server";
import { entitlementBalance } from "../app/services/entitlements.server";
import { previewBookingNotification } from "../app/services/booking-notifications.server";
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
  });
  const entitlement = await db.entitlement.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  const token = await exchangeCoachLogin(
    await issueCoachLogin(actor, f.coach.id),
  );
  const input = {
    bookingId: booking.id,
    expectedVersion: 1,
    action: "CANCEL" as const,
    reason: "Requested by customer",
    idempotencyKey: randomUUID(),
  };
  return {
    ...f,
    booking,
    entitlement,
    actor,
    coachToken: token,
    input,
    customerActor: {
      shopId: f.shop.id,
      customerGid: f.customer.shopifyCustomerGid,
    },
  };
}
async function classAt(
  f: Awaited<ReturnType<typeof fixture>>,
  startDelta: number,
  endDelta: number,
) {
  const startsAt = new Date(Date.now() + startDelta),
    endsAt = new Date(Date.now() + endDelta);
  await db.classSession.update({
    where: { id: f.session.id },
    data: { startsAt, endsAt, busyStartsAt: startsAt, busyEndsAt: endsAt },
  });
}
test("12-hour cutoff is inclusive and absolute across Sydney DST", () => {
  const start = new Date("2026-10-04T10:00:00+11:00");
  expect(
    cancellationOutcome(start, new Date(start.getTime() - 12 * 3600000)),
  ).toBe("CANCELLED");
  expect(
    cancellationOutcome(start, new Date(start.getTime() - 12 * 3600000 + 1)),
  ).toBe("LATE_CANCEL");
});
test("10 concurrent customer cancellations release once, suppress confirmation and queue two cancellation emails", async () => {
  const f = await fixture();
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      customerChangeBooking(f.customerActor, f.input),
    ),
  );
  expect(
    results.every((r) => r.status === "CANCELLED" && r.version === 2),
  ).toBe(true);
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ availableUnits: 5, reservedUnits: 0, consumedUnits: 0 });
  expect(
    await db.bookingChange.count({ where: { bookingId: f.booking.id } }),
  ).toBe(1);
  const notifications = await db.bookingNotification.findMany({
    where: { bookingId: f.booking.id },
  });
  expect(notifications.filter((n) => n.status === "SUPPRESSED")).toHaveLength(
    3,
  );
  const cancelled = notifications.filter(
    (n) => n.template === "BOOKING_CANCELLED_V1",
  );
  expect(cancelled).toHaveLength(3);
  const email = await previewBookingNotification(f.shop.id, cancelled[0].id);
  expect(email.subject).toContain("Booking cancelled");
  expect(email.text).toContain("reserved class credit released");
  expect(email.text).toContain("No payment refund has been issued");
  await expect(
    customerChangeBooking(f.customerActor, {
      ...f.input,
      reason: "Different action reason",
    }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
test("late cancellation consumes once without making a money refund", async () => {
  const f = await fixture();
  await classAt(f, 6 * 3600000, 7 * 3600000);
  expect((await customerChangeBooking(f.customerActor, f.input)).status).toBe(
    "LATE_CANCEL",
  );
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ availableUnits: 4, reservedUnits: 0, consumedUnits: 1 });
  expect(
    await db.entitlementLedgerEntry.count({
      where: { bookingId: f.booking.id, kind: "CONSUME" },
    }),
  ).toBe(1);
});
test("staff exception requires Operations and reason, releases even after deadline", async () => {
  const f = await fixture();
  await classAt(f, 3600000, 2 * 3600000);
  await expect(
    staffChangeBooking(
      { ...f.actor, role: "COACH" },
      { ...f.input, action: "CANCEL_WAIVE" },
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    staffChangeBooking(f.actor, {
      ...f.input,
      action: "CANCEL_WAIVE",
      reason: "",
    }),
  ).rejects.toThrow();
  expect(
    (await staffChangeBooking(f.actor, { ...f.input, action: "CANCEL_WAIVE" }))
      .status,
  ).toBe("CANCELLED");
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ availableUnits: 5, reservedUnits: 0 });
});
test("customer cannot waive policy, alter another booking or act as Coach", async () => {
  const f = await fixture();
  await expect(
    customerChangeBooking(f.customerActor, {
      ...f.input,
      action: "CANCEL_WAIVE",
    }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    customerChangeBooking(
      { ...f.customerActor, customerGid: "gid://shopify/Customer/998" },
      f.input,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    customerChangeBooking(
      { ...f.customerActor, shopId: randomUUID() },
      f.input,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    customerChangeBooking(f.customerActor, { ...f.input, action: "COMPLETE" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
});
test("normal cancellation closes at class start", async () => {
  const f = await fixture();
  await classAt(f, -1000, 3600000);
  await expect(
    customerChangeBooking(f.customerActor, f.input),
  ).rejects.toMatchObject({ code: "CANCELLATION_CLOSED" });
  expect(
    (await db.booking.findUniqueOrThrow({ where: { id: f.booking.id } }))
      .version,
  ).toBe(1);
});
test("Operations may still record check-in and completion", async () => {
  const f = await fixture();
  await classAt(f, -60000, 3600000);
  const input = { ...f.input, action: "CHECK_IN", reason: "Arrived for class" };
  const result = await staffChangeBooking(f.actor, input);
  expect(result.checkedInAt).not.toBeNull();
  expect(result.status).toBe("CONFIRMED");
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ reservedUnits: 1, consumedUnits: 0 });
  await expect(
    staffChangeBooking(f.actor, {
      ...input,
      idempotencyKey: randomUUID(),
      expectedVersion: 2,
    }),
  ).rejects.toMatchObject({ code: "ALREADY_CHECKED_IN" });
  await classAt(f, -7200000, -3600000);
  const completed = await staffChangeBooking(f.actor, {
    ...input,
    action: "COMPLETE",
    expectedVersion: 2,
    idempotencyKey: randomUUID(),
  });
  expect(completed.status).toBe("ATTENDED");
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ reservedUnits: 0, consumedUnits: 1 });
});
test("future attendance cannot prematurely consume credits", async () => {
  const f = await fixture();
  await expect(
    coachChangeBooking(f.coachToken, { ...f.input, action: "NO_SHOW" }),
  ).rejects.toMatchObject({ code: "CLASS_NOT_ENDED" });
  for (const action of ["CHECK_IN", "COMPLETE"])
    await expect(
      coachChangeBooking(f.coachToken, { ...f.input, action }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(
    await db.bookingChange.count({ where: { bookingId: f.booking.id } }),
  ).toBe(0);
});
test.each(["NEW_PASS", "DROP_IN"] as const)(
  "%s no-show consumes once under concurrent Coach retries and never returns credit",
  async (kind) => {
    const f = await fixture(kind);
    const notification = await db.bookingNotification.findFirstOrThrow({
      where: { bookingId: f.booking.id, recipientKind: "CUSTOMER" },
    });
    const email = await previewBookingNotification(f.shop.id, notification.id);
    expect(email.text).toContain("Pass credits are not returned");
    expect(email.text).toContain("Drop-in payments are not refunded");
    await classAt(f, -7200000, -3600000);
    const input = { ...f.input, action: "NO_SHOW" };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => coachChangeBooking(f.coachToken, input)),
    );
    expect(
      results.every((r) => r.status === "NO_SHOW" && r.version === 2),
    ).toBe(true);
    await expect(
      staffChangeBooking(f.actor, {
        ...f.input,
        action: "CANCEL_WAIVE",
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "STALE_BOOKING" });
    expect(
      await entitlementBalance(db, f.shop.id, f.entitlement.id),
    ).toMatchObject({
      availableUnits: kind === "NEW_PASS" ? 4 : 0,
      reservedUnits: 0,
      consumedUnits: 1,
    });
    expect(
      await db.entitlementLedgerEntry.count({
        where: { bookingId: f.booking.id, kind: "RELEASE" },
      }),
    ).toBe(0);
    expect(
      await db.entitlementLedgerEntry.count({
        where: { bookingId: f.booking.id, kind: "CONSUME" },
      }),
    ).toBe(1);
    expect(
      await db.auditLog.count({
        where: {
          shopId: f.shop.id,
          entityId: f.booking.id,
          action: "BOOKING_NO_SHOW",
        },
      }),
    ).toBe(1);
    expect(
      await db.bookingChange.count({ where: { bookingId: f.booking.id } }),
    ).toBe(1);
    expect(
      await db.paidBookingResult.findFirstOrThrow({
        where: { bookingId: f.booking.id },
      }),
    ).toMatchObject({
      status: "CONFIRMED",
      sourceOrderGid: f.booking.sourceOrderGid,
    });
    await classAt(f, -26 * 3600000, -25 * 3600000);
    expect(
      await settleDefaultAttendanceWork({ shopId: f.shop.id }),
    ).toMatchObject({ scanned: 0, settled: 0 });
  },
);

test("staff no-show uses the reserved credit", async () => {
  const f = await fixture();
  await classAt(f, -7200000, -3600000);
  expect(
    (await staffChangeBooking(f.actor, { ...f.input, action: "NO_SHOW" }))
      .status,
  ).toBe("NO_SHOW");
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ availableUnits: 4, reservedUnits: 0, consumedUnits: 1 });
});

test("confirmed bookings auto-settle as attended after the 24-hour no-show window", async () => {
  const f = await fixture();
  await classAt(f, -26 * 3600000, -25 * 3600000);
  const settlement = await settleDefaultAttendanceWork({ shopId: f.shop.id });
  expect(settlement.errors).toEqual([]);
  expect(settlement).toMatchObject({ settled: 1, failed: 0 });
  expect(
    await db.booking.findUniqueOrThrow({ where: { id: f.booking.id } }),
  ).toMatchObject({ status: "ATTENDED", version: 2 });
  expect(
    await entitlementBalance(db, f.shop.id, f.entitlement.id),
  ).toMatchObject({ availableUnits: 4, reservedUnits: 0, consumedUnits: 1 });
  expect(
    await db.bookingChange.findFirstOrThrow({
      where: { bookingId: f.booking.id },
    }),
  ).toMatchObject({ action: "AUTO_COMPLETE", actorKind: "SYSTEM" });
  expect(
    await db.bookingNotification.count({
      where: {
        bookingId: f.booking.id,
        template: "BOOKING_CONFIRMED_V1",
        status: "SUPPRESSED",
      },
    }),
  ).toBe(3);
});
test("cancellation and completion race settles exactly one outcome", async () => {
  const f = await fixture();
  await classAt(f, -7200000, -3600000);
  const results = await Promise.allSettled([
    staffChangeBooking(f.actor, { ...f.input, action: "CANCEL_WAIVE" }),
    staffChangeBooking(f.actor, {
      ...f.input,
      action: "COMPLETE",
      idempotencyKey: randomUUID(),
    }),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    await db.entitlementLedgerEntry.count({
      where: { bookingId: f.booking.id, kind: { in: ["CONSUME", "RELEASE"] } },
    }),
  ).toBe(1);
  expect(
    await db.bookingChange.count({ where: { bookingId: f.booking.id } }),
  ).toBe(1);
});
test("Coach roster is scoped and contains no Shopify identity, order, price or email", async () => {
  const f = await fixture();
  await db.customerProfile.update({
    where: { id: f.customer.id },
    data: {
      preferredName: "Queenie",
      signature: "Stronger every class",
      trainingGoals: "Build core strength",
    },
  });
  const roster = await coachRoster(f.coachToken, f.session.id);
  expect(roster.session.bookings).toHaveLength(1);
  expect(roster.session.bookings[0].customer).toMatchObject({
    preferredName: "Queenie",
    signature: "Stronger every class",
    trainingGoals: "Build core strength",
  });
  expect(JSON.stringify(roster)).not.toContain("gid://shopify");
  expect(JSON.stringify(roster)).not.toContain("priceCents");
  const other = await fixture();
  await expect(
    coachRoster(other.coachToken, f.session.id),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(coachChangeBooking(f.coachToken, f.input)).rejects.toMatchObject(
    { code: "FORBIDDEN" },
  );
  const coach = await db.coach.create({
    data: { shopId: f.shop.id, name: "Other coach" },
  });
  const token = await exchangeCoachLogin(
    await issueCoachLogin(f.actor, coach.id),
  );
  await expect(
    coachChangeBooking(token, { ...f.input, action: "NO_SHOW" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await revokeCoachSession(f.coachToken);
  await expect(coachRoster(f.coachToken, f.session.id)).rejects.toMatchObject({
    code: "COACH_LOGIN_REQUIRED",
  });
});
test("missing ledger fails closed and rolls back status and notification changes", async () => {
  const f = await fixture();
  const customer = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/888",
    },
  });
  const orphan = await db.booking.create({
    data: {
      shopId: f.shop.id,
      sessionId: f.session.id,
      customerId: customer.id,
    },
  });
  await expect(
    staffChangeBooking(f.actor, { ...f.input, bookingId: orphan.id }),
  ).rejects.toMatchObject({ code: "BOOKING_LEDGER_REVIEW" });
  expect(
    (await db.booking.findUniqueOrThrow({ where: { id: orphan.id } })).status,
  ).toBe("CONFIRMED");
  expect(
    await db.bookingChange.count({ where: { bookingId: orphan.id } }),
  ).toBe(0);
});
test("booking history cannot be edited or removed", async () => {
  const f = await fixture();
  await staffChangeBooking(f.actor, f.input);
  const change = await db.bookingChange.findFirstOrThrow({
    where: { bookingId: f.booking.id },
  });
  await expect(
    db.bookingChange.update({
      where: { id: change.id },
      data: { reason: "Rewrite history" },
    }),
  ).rejects.toThrow();
  await expect(
    db.bookingChange.delete({ where: { id: change.id } }),
  ).rejects.toThrow();
});
