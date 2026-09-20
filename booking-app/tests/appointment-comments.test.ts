import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  startAttempt,
  bookingPassOptions,
} from "../app/services/booking.server";
import { confirmOwnedBooking } from "../app/services/owned-booking.server";
import { saveBookingComment } from "../app/services/booking-comment.server";
import { customerAccountData } from "../app/services/customer-account.server";
import { coachRoster } from "../app/services/booking-lifecycle.server";
import {
  issueCoachLogin,
  exchangeCoachLogin,
} from "../app/services/coach-auth.server";
import { adminToday, coachToday } from "../app/services/today-bookings.server";
import { addSessions, publishWeek } from "../app/services/schedule.server";
import { customerReschedule } from "../app/services/booking-reschedule.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
async function privateFixture() {
  const f = await paidFixture("NEW_PASS", false, "APPOINTMENT");
  await db.serviceCoach.create({
    data: { shopId: f.shop.id, serviceId: f.service.id, coachId: f.coach.id },
  });
  return {
    ...f,
    actor: { shopId: f.shop.id, actorId: randomUUID(), role: "ADMIN" as const },
    customerActor: {
      shopId: f.shop.id,
      customerGid: f.customer.shopifyCustomerGid,
    },
  };
}
async function target(f: Awaited<ReturnType<typeof privateFixture>>) {
  const local = DateTime.fromJSDate(f.session.startsAt, {
    zone: f.session.timezone,
  }).plus({ days: 1 });
  const [slot] = await addSessions(f.actor, {
    serviceId: f.service.id,
    coachId: f.coach.id,
    localStart: local.toFormat("yyyy-MM-dd'T'HH:mm"),
    requestId: randomUUID(),
    weeks: 1,
  });
  await publishWeek(f.actor, local.toISODate()!);
  return slot;
}
test("paid private appointment confirms directly with comment snapshot and confirmation plus reminder notifications", async () => {
  const f = await privateFixture();
  const note = "Work on shoulders <script>alert(1)</script>";
  await db.bookingAttempt.update({
    where: { id: f.attempt.id },
    data: { customerComment: note },
  });
  const event = await queuePaid(f);
  await Promise.all(
    Array.from({ length: 10 }, () => processPaidBookingEvent(event.id)),
  );
  const bookings = await db.booking.findMany({ where: { shopId: f.shop.id } });
  expect(bookings).toHaveLength(1);
  expect(bookings[0]).toMatchObject({
    status: "CONFIRMED",
    customerComment: note,
  });
  const notifications = await db.bookingNotification.findMany({
    where: { shopId: f.shop.id },
  });
  expect(notifications).toHaveLength(4);
  expect(JSON.stringify(notifications)).not.toContain("shoulders");
  expect(
    JSON.stringify(
      await db.outboxEvent.findMany({ where: { shopId: f.shop.id } }),
    ),
  ).not.toContain("shoulders");
  await expect(
    db.booking.update({
      where: { id: bookings[0].id },
      data: { customerComment: "changed" },
    }),
  ).rejects.toThrow();
});
test("published private slot accepts an owned Pass and confirms once under ten concurrent retries", async () => {
  const f = await privateFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const slot = await target(f);
  await db.shop.update({
    where: { id: f.shop.id },
    data: {
      rules: { ...(f.shop.rules as object), onlineBookingsEnabled: true },
    },
  });
  const attempt = await startAttempt(f.customerActor, {
    sessionId: slot.id,
    surface: "PROGRAMS",
  });
  await saveBookingComment(f.customerActor, {
    token: attempt.token,
    comment: "  Core strength and balance\nPlease focus on stability.  ",
  });
  const options = await bookingPassOptions(f.customerActor, {
    token: attempt.token,
  });
  expect(options.customerComment).toBe(
    "Core strength and balance\nPlease focus on stability.",
  );
  const entitlement = await db.entitlement.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      confirmOwnedBooking(f.customerActor, {
        token: attempt.token,
        entitlementId: entitlement.id,
      }),
    ),
  );
  expect(new Set(results.map((r) => r.bookingReference)).size).toBe(1);
  const b = await db.booking.findUniqueOrThrow({
    where: { id: results[0].bookingReference },
  });
  expect(b).toMatchObject({
    status: "CONFIRMED",
    customerComment: options.customerComment,
  });
  expect(
    await db.booking.count({
      where: { sessionId: slot.id, status: "CONFIRMED" },
    }),
  ).toBe(1);
  await expect(
    startAttempt(
      { ...f.customerActor, customerGid: "gid://shopify/Customer/999" },
      { sessionId: slot.id, surface: "HOME" },
    ),
  ).rejects.toMatchObject({ code: "SOLD_OUT" });
});
test("notes require signed-in ownership, bounded plain text and an unfrozen attempt", async () => {
  const f = await privateFixture();
  const slot = await target(f);
  const attempt = await startAttempt(f.customerActor, {
    sessionId: slot.id,
    surface: "HOME",
  });
  for (const actor of [
    { ...f.customerActor, customerGid: null },
    { ...f.customerActor, customerGid: "gid://shopify/Customer/999" },
  ])
    await expect(
      saveBookingComment(actor, { token: attempt.token, comment: "Mobility" }),
    ).rejects.toMatchObject({ status: actor.customerGid ? 403 : 401 });
  for (const comment of ["x".repeat(1001), "a\u0000b"])
    await expect(
      saveBookingComment(f.customerActor, { token: attempt.token, comment }),
    ).rejects.toThrow();
  await saveBookingComment(f.customerActor, {
    token: attempt.token,
    comment: "Mobility",
  });
  await saveBookingComment(f.customerActor, {
    token: attempt.token,
    comment: "",
  });
  expect(
    (await bookingPassOptions(f.customerActor, { token: attempt.token }))
      .customerComment,
  ).toBe("");
  await expect(
    saveBookingComment(f.customerActor, {
      token: f.token,
      comment: "Changed after checkout",
    }),
  ).rejects.toMatchObject({ code: "COMMENT_FROZEN" });
});
test("private slots reserve coach/location/buffers and database rejects capacity changes", async () => {
  const f = await privateFixture();
  await expect(
    addSessions(f.actor, {
      serviceId: f.service.id,
      coachId: f.coach.id,
      localStart: DateTime.fromJSDate(f.session.startsAt, {
        zone: f.session.timezone,
      }).toFormat("yyyy-MM-dd'T'HH:mm"),
      requestId: randomUUID(),
      weeks: 1,
    }),
  ).rejects.toMatchObject({ code: "SCHEDULE_CONFLICT" });
  await expect(
    db.classSession.update({
      where: { id: f.session.id },
      data: { capacity: 2 },
    }),
  ).rejects.toThrow();
  await expect(
    db.service.update({ where: { id: f.service.id }, data: { capacity: 2 } }),
  ).rejects.toThrow();
  await expect(
    db.service.update({ where: { id: f.service.id }, data: { kind: "CLASS" } }),
  ).rejects.toThrow();
});
test("rescheduling retains per-booking note and only assigned coach can read it", async () => {
  const f = await privateFixture();
  await db.bookingAttempt.update({
    where: { id: f.attempt.id },
    data: { customerComment: "Shoulder flexibility" },
  });
  await processPaidBookingEvent((await queuePaid(f)).id);
  const slot = await target(f),
    original = await db.booking.findFirstOrThrow({
      where: { shopId: f.shop.id },
    });
  const moved = await customerReschedule(f.customerActor, {
    action: "RESCHEDULE",
    bookingId: original.id,
    targetSessionId: slot.id,
    expectedVersion: 1,
    idempotencyKey: randomUUID(),
    reason: "Customer changed time",
  });
  const token = await exchangeCoachLogin(
    await issueCoachLogin(f.actor, f.coach.id),
  );
  expect((await coachRoster(token, slot.id)).session.bookings[0]).toMatchObject(
    { id: moved.bookingId, customerComment: "Shoulder flexibility" },
  );
  const other = await db.coach.create({
    data: { shopId: f.shop.id, name: "Another coach" },
  });
  const otherToken = await exchangeCoachLogin(
    await issueCoachLogin(f.actor, other.id),
  );
  await expect(coachRoster(otherToken, slot.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect(
    (await customerAccountData(f.customerActor, {})).bookings[0],
  ).toMatchObject({
    serviceKind: "APPOINTMENT",
    customerComment: "Shoulder flexibility",
  });
});
test("today dashboards show current registrations, restrict Coach and omit private note text", async () => {
  const f = await privateFixture();
  await db.bookingAttempt.update({
    where: { id: f.attempt.id },
    data: { customerComment: "Personal goal" },
  });
  await processPaidBookingEvent((await queuePaid(f)).id);
  const start = DateTime.now()
      .setZone(f.shop.timezone)
      .startOf("day")
      .plus({ hours: 12 }),
    end = start.plus({ hours: 1 });
  await db.classSession.update({
    where: { id: f.session.id },
    data: {
      startsAt: start.toJSDate(),
      endsAt: end.toJSDate(),
      busyStartsAt: start.toJSDate(),
      busyEndsAt: end.toJSDate(),
    },
  });
  const admin = await adminToday(f.actor);
  expect(admin.sessions[0].bookings).toHaveLength(1);
  expect(JSON.stringify(admin)).not.toContain("Personal goal");
  const token = await exchangeCoachLogin(
    await issueCoachLogin(f.actor, f.coach.id),
  );
  expect((await coachToday(token)).sessions[0].bookings).toHaveLength(1);
  const other = await db.coach.create({
    data: { shopId: f.shop.id, name: "Another coach" },
  });
  const otherToken = await exchangeCoachLogin(
    await issueCoachLogin(f.actor, other.id),
  );
  expect((await coachToday(otherToken)).sessions).toHaveLength(0);
  await expect(adminToday({ ...f.actor, role: "COACH" })).rejects.toMatchObject(
    { code: "FORBIDDEN" },
  );
});
