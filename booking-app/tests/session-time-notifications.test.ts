import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { DateTime } from "luxon";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import { updateSession } from "../app/services/schedule.server";
import {
  backfillSessionTimeChange,
  SESSION_TIME_CHANGED,
} from "../app/services/session-change-notifications.server";
import {
  deliverBookingNotification,
  previewBookingNotification,
} from "../app/services/booking-notifications.server";
import { adminSessionDetail } from "../app/services/admin-session.server";
import { deliverInternalBookingMail } from "../app/services/internal-booking-mail.server";
import {
  syncMailDeliveryStatus,
  refreshMailDeliveryStatus,
} from "../app/services/mail-delivery-status.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
async function fixture() {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  await db.serviceCoach.create({
    data: { shopId: f.shop.id, serviceId: f.service.id, coachId: f.coach.id },
  });
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  const booking = await db.booking.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const input = {
    id: f.session.id,
    version: f.session.version,
    serviceId: f.service.id,
    coachId: f.coach.id,
    capacity: f.session.capacity,
    localStart: DateTime.fromJSDate(f.session.startsAt, {
      zone: f.session.timezone,
    })
      .plus({ minutes: 30 })
      .toFormat("yyyy-MM-dd'T'HH:mm"),
  };
  return { ...f, actor, booking, input };
}

test("editing a booked session queues immutable old/new time mail and moves its reminder, without altering credits", async () => {
  const f = await fixture();
  const ledgerBefore = await db.entitlementLedgerEntry.count({
    where: { shopId: f.shop.id },
  });
  const saved = await updateSession(f.actor, f.input);
  expect(saved.notifiedCustomers).toBe(1);
  const jobs = await db.bookingNotification.findMany({
    where: { bookingId: f.booking.id, template: SESSION_TIME_CHANGED },
  });
  expect(jobs).toHaveLength(3);
  const customer = jobs.find((j) => j.recipientKind === "CUSTOMER")!;
  const email = await previewBookingNotification(f.shop.id, customer.id);
  expect(email.subject).toContain("Class time changed");
  expect(email.text).toContain("Previous time:");
  expect(email.text).toContain("New time:");
  expect(email.text).not.toContain("Your booking is confirmed");
  const reminder = await db.bookingNotification.findFirstOrThrow({
    where: { bookingId: f.booking.id, template: "BOOKING_REMINDER_V1" },
  });
  expect(reminder.availableAt.getTime()).toBe(
    saved.startsAt.getTime() - 12 * 3600000,
  );
  expect(
    await db.entitlementLedgerEntry.count({ where: { shopId: f.shop.id } }),
  ).toBe(ledgerBefore);
  const second = await updateSession(f.actor, {
    ...f.input,
    version: saved.version,
    localStart: DateTime.fromJSDate(saved.startsAt, { zone: saved.timezone })
      .plus({ minutes: 30 })
      .toFormat("yyyy-MM-dd'T'HH:mm"),
  });
  expect(second.notifiedCustomers).toBe(1);
  expect(
    (
      await db.bookingNotification.findUniqueOrThrow({
        where: { id: customer.id },
      })
    ).status,
  ).toBe("SUPPRESSED");
  expect(await previewBookingNotification(f.shop.id, customer.id)).toEqual(
    email,
  );
  const adapter = vi.fn(async () => ({
    status: "ACCEPTED" as const,
    messageId: randomUUID(),
  }));
  await deliverBookingNotification(customer.id, adapter);
  expect(adapter).not.toHaveBeenCalled();
  const latest = await db.bookingNotification.findFirstOrThrow({
    where: {
      bookingId: f.booking.id,
      template: SESSION_TIME_CHANGED,
      recipientKind: "CUSTOMER",
      status: "PENDING",
    },
  });
  await Promise.all([
    deliverBookingNotification(latest.id, adapter),
    deliverBookingNotification(latest.id, adapter),
  ]);
  expect(adapter).toHaveBeenCalledTimes(1);
  expect(
    (
      await adminSessionDetail(f.actor, f.session.id)
    ).bookings[0].notifications.some(
      (n) => n.id === latest.id && n.status === "ACCEPTED",
    ),
  ).toBe(true);
});

test("unchanged time/capacity-only changes do not notify; stale updates and foreign shops cannot queue mail", async () => {
  const f = await fixture();
  const first = await updateSession(f.actor, f.input);
  const unchanged = await updateSession(f.actor, {
    ...f.input,
    version: first.version,
    capacity: 9,
  });
  expect(unchanged.notifiedCustomers).toBe(0);
  await expect(updateSession(f.actor, f.input)).rejects.toMatchObject({
    code: "CONFLICT",
  });
  const other = await fixture();
  await expect(
    updateSession(other.actor, { ...f.input, version: unchanged.version }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(
    await db.bookingNotification.count({
      where: { bookingId: f.booking.id, template: SESSION_TIME_CHANGED },
    }),
  ).toBe(3);
});

test("historical repair uses the recorded change, excludes later bookings, and is idempotent", async () => {
  const f = await fixture();
  const next = {
    ...f.session,
    startsAt: new Date(f.session.startsAt.getTime() + 1800000),
    endsAt: new Date(f.session.endsAt.getTime() + 1800000),
    version: f.session.version + 1,
  };
  await db.classSession.update({
    where: { id: f.session.id },
    data: {
      startsAt: next.startsAt,
      endsAt: next.endsAt,
      busyStartsAt: next.startsAt,
      busyEndsAt: next.endsAt,
      version: next.version,
    },
  });
  const audit = await db.auditLog.create({
    data: {
      shopId: f.shop.id,
      actorId: f.actor.actorId,
      action: "SESSION_UPDATED",
      entityId: f.session.id,
      before: JSON.parse(JSON.stringify(f.session)),
      after: JSON.parse(JSON.stringify(next)),
    },
  });
  const laterCustomer = await db.customerProfile.create({
    data: {
      shopId: f.shop.id,
      shopifyCustomerGid: `gid://shopify/Customer/${Date.now()}`,
    },
  });
  const laterBooking = await db.booking.create({
    data: {
      shopId: f.shop.id,
      customerId: laterCustomer.id,
      sessionId: f.session.id,
      status: "CONFIRMED",
      createdAt: new Date(audit.createdAt.getTime() + 1000),
    },
  });
  expect(
    (await adminSessionDetail(f.actor, f.session.id)).timeChange?.missingCount,
  ).toBe(1);
  expect(await backfillSessionTimeChange(f.actor, f.session.id, audit.id)).toBe(
    1,
  );
  expect(await backfillSessionTimeChange(f.actor, f.session.id, audit.id)).toBe(
    0,
  );
  expect(
    await db.bookingNotification.count({
      where: { bookingId: laterBooking.id, template: SESSION_TIME_CHANGED },
    }),
  ).toBe(0);
  expect(
    (await adminSessionDetail(f.actor, f.session.id)).timeChange?.missingCount,
  ).toBe(0);
  await expect(
    backfillSessionTimeChange(
      { ...f.actor, role: "COACH" },
      f.session.id,
      audit.id,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    backfillSessionTimeChange(f.actor, f.session.id, randomUUID()),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("cancelled bookings suppress time-change delivery; ambiguous sends are not retried", async () => {
  const f = await fixture();
  await updateSession(f.actor, f.input);
  const job = await db.bookingNotification.findFirstOrThrow({
    where: {
      bookingId: f.booking.id,
      template: SESSION_TIME_CHANGED,
      recipientKind: "CUSTOMER",
    },
  });
  const send = vi.fn(async () => {
    throw Error("timeout");
  });
  await deliverBookingNotification(job.id, send);
  await deliverBookingNotification(job.id, send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    (await db.bookingNotification.findUniqueOrThrow({ where: { id: job.id } }))
      .status,
  ).toBe("UNKNOWN");
  const coach = await db.bookingNotification.findFirstOrThrow({
    where: {
      bookingId: f.booking.id,
      template: SESSION_TIME_CHANGED,
      recipientKind: "COACH",
    },
  });
  await db.booking.update({
    where: { id: f.booking.id },
    data: { status: "CANCELLED" },
  });
  await deliverBookingNotification(coach.id, send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    (
      await db.bookingNotification.findUniqueOrThrow({
        where: { id: coach.id },
      })
    ).status,
  ).toBe("SUPPRESSED");
});

test("provider receipts distinguish delivery and bounce; read errors never invent delivery", async () => {
  const f = await fixture();
  await updateSession(f.actor, f.input);
  const job = await db.bookingNotification.findFirstOrThrow({
    where: {
      bookingId: f.booking.id,
      template: SESSION_TIME_CHANGED,
      recipientKind: "CUSTOMER",
    },
  });
  const messageId = randomUUID();
  await deliverBookingNotification(job.id, async () => ({
    status: "ACCEPTED",
    messageId,
  }));
  vi.stubEnv("SKYRA_MAIL_PROVIDER", "resend");
  vi.stubEnv("RESEND_API_KEY", "test-only");
  try {
    for (const event of ["delivered", "bounced"]) {
      await db.bookingNotification.update({
        where: { id: job.id },
        data: { deliveryCheckedAt: null },
      });
      await syncMailDeliveryStatus(
        f.shop.id,
        job.id,
        vi.fn(async () => Response.json({ id: messageId, last_event: event })),
      );
      expect(
        (
          await db.bookingNotification.findUniqueOrThrow({
            where: { id: job.id },
          })
        ).deliveryStatus,
      ).toBe(event);
    }
    await db.bookingNotification.update({
      where: { id: job.id },
      data: { deliveryCheckedAt: null },
    });
    await syncMailDeliveryStatus(
      f.shop.id,
      job.id,
      vi.fn(async () => new Response(null, { status: 403 })),
    );
    const checked = await db.bookingNotification.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(checked.deliveryError).toBe("PROVIDER_READ_PERMISSION_REQUIRED");
    expect(checked.deliveryStatus).toBe("bounced");
    await expect(
      refreshMailDeliveryStatus({ ...f.actor, shopId: randomUUID() }, job.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    vi.unstubAllEnvs();
  }
});

test("an in-flight send finishes before a time edit commits; accepted reminders are not resent", async () => {
  const f = await fixture();
  const reminder = await db.bookingNotification.findFirstOrThrow({
    where: { bookingId: f.booking.id, template: "BOOKING_REMINDER_V1" },
  });
  await db.bookingNotification.update({
    where: { id: reminder.id },
    data: { availableAt: new Date(0) },
  });
  let release!: () => void;
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivery = deliverBookingNotification(reminder.id, async () => {
    entered();
    await finish;
    return { status: "ACCEPTED", messageId: randomUUID() };
  });
  await sending;
  let updated = false;
  const editing = updateSession(f.actor, f.input).then((result) => {
    updated = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(updated).toBe(false);
  release();
  await delivery;
  await editing;
  const preserved = await db.bookingNotification.findUniqueOrThrow({
    where: { id: reminder.id },
  });
  expect(preserved.status).toBe("ACCEPTED");
  expect(preserved.attempts).toBe(1);
  expect(
    await db.bookingNotification.count({
      where: { bookingId: f.booking.id, template: "BOOKING_REMINDER_V1" },
    }),
  ).toBe(1);
});

test("unavailable recipients are visibly deferred so they cannot block newer mail", async () => {
  const f = await fixture();
  vi.stubEnv("SKYRA_BOOKING_MAIL_SHOP", f.shop.domain);
  try {
    const job = await db.bookingNotification.findFirstOrThrow({
      where: { bookingId: f.booking.id, recipientKind: "ADMIN" },
    });
    const send = vi.fn();
    await deliverInternalBookingMail(job.id, send);
    const deferred = await db.bookingNotification.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(send).not.toHaveBeenCalled();
    expect(deferred.status).toBe("PENDING");
    expect(deferred.lastError).toBe("RECIPIENT_UNAVAILABLE");
    expect(deferred.availableAt.getTime()).toBeGreaterThan(
      Date.now() + 14 * 60000,
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
