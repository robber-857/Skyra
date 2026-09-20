import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  adminNotifications,
  coachNotifications,
  markAdminNotificationRead,
  markCoachNotificationRead,
} from "../app/services/in-app-notifications.server";
import {
  exchangeCoachLogin,
  issueCoachLogin,
} from "../app/services/coach-auth.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());

test("a confirmed booking creates scoped Admin and Coach app notifications with independent read state", async () => {
  const fixture = await paidFixture();
  await processPaidBookingEvent((await queuePaid(fixture)).id);
  const actor = {
    shopId: fixture.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };

  const records = await db.bookingNotification.findMany({
    where: { shopId: fixture.shop.id },
    orderBy: { recipientKind: "asc" },
  });
  expect(records.map((record) => record.recipientKind)).toEqual([
    "ADMIN",
    "COACH",
    "CUSTOMER",
    "CUSTOMER",
  ]);
  expect(
    records.find((record) => record.template === "BOOKING_REMINDER_V1"),
  ).toMatchObject({ recipientKind: "CUSTOMER", status: "PENDING" });

  const adminInbox = await adminNotifications(actor);
  expect(adminInbox).toHaveLength(1);
  expect(adminInbox[0]).toMatchObject({ unread: true, emailStatus: "PENDING" });
  await markAdminNotificationRead(actor, adminInbox[0].id);
  expect((await adminNotifications(actor))[0].unread).toBe(false);

  const oneTime = await issueCoachLogin(actor, fixture.coach.id);
  const coachSession = await exchangeCoachLogin(oneTime);
  const coachInbox = await coachNotifications(coachSession);
  expect(coachInbox.notifications).toHaveLength(1);
  expect(coachInbox.notifications[0].unread).toBe(true);
  await markCoachNotificationRead(
    coachSession,
    coachInbox.notifications[0].id,
  );
  expect((await coachNotifications(coachSession)).notifications[0].unread).toBe(
    false,
  );
});
