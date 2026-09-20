import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { databaseNow } from "./booking.server";
import { DateTime } from "luxon";
import { DomainError } from "../lib/errors.server";

export async function enqueueBookingNotifications(
  tx: Prisma.TransactionClient,
  shopId: string,
  bookingId: string,
  template:
    "BOOKING_CONFIRMED_V1" | "BOOKING_CANCELLED_V1" = "BOOKING_CONFIRMED_V1",
) {
  const booking = await tx.booking.findFirstOrThrow({
    where: {
      shopId,
      id: bookingId,
      status:
        template === "BOOKING_CONFIRMED_V1"
          ? "CONFIRMED"
          : { in: ["CANCELLED", "LATE_CANCEL"] },
    },
    include: { session: true },
  });
  const availableAt = await databaseNow(tx);
  for (const recipient of [
    { recipientKind: "CUSTOMER", recipientId: booking.customerId },
    { recipientKind: "COACH", recipientId: booking.session.coachId },
    { recipientKind: "ADMIN", recipientId: shopId },
  ]) {
    await tx.bookingNotification.upsert({
      where: {
        shopId_bookingId_recipientKind_recipientId_template: {
          shopId,
          bookingId,
          ...recipient,
          template,
        },
      },
      create: { shopId, bookingId, ...recipient, template, availableAt },
      update: {},
    });
  }
  if (
    template === "BOOKING_CONFIRMED_V1" &&
    booking.session.startsAt > availableAt
  ) {
    const reminderAt = new Date(
      Math.max(
        availableAt.getTime(),
        booking.session.startsAt.getTime() - 12 * 60 * 60 * 1000,
      ),
    );
    await tx.bookingNotification.upsert({
      where: {
        shopId_bookingId_recipientKind_recipientId_template: {
          shopId,
          bookingId,
          recipientKind: "CUSTOMER",
          recipientId: booking.customerId,
          template: "BOOKING_REMINDER_V1",
        },
      },
      create: {
        shopId,
        bookingId,
        recipientKind: "CUSTOMER",
        recipientId: booking.customerId,
        template: "BOOKING_REMINDER_V1",
        availableAt: reminderAt,
      },
      update: {},
    });
  }
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export type BookingEmailDetails = {
  cancellation?: "CANCELLED" | "LATE_CANCEL";
  reminder?: boolean;
  recipientKind: "CUSTOMER" | "COACH" | "ADMIN";
  className: string;
  coachName: string;
  locationName: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  bookingReference: string;
  confirmedCount: number;
  capacity: number;
};
export function renderBookingEmail(details: BookingEmailDetails) {
  const start = DateTime.fromJSDate(details.startsAt, {
    zone: details.timezone,
  });
  const end = DateTime.fromJSDate(details.endsAt, { zone: details.timezone });
  if (!start.isValid || !end.isValid)
    throw new DomainError("INVALID_TIMEZONE", "Cannot render booking time.");
  const isOperations = ["COACH", "ADMIN"].includes(details.recipientKind);
  const isCoach = details.recipientKind === "COACH";
  const heading = details.cancellation
    ? "Booking cancelled"
    : details.reminder
      ? "Your class starts soon"
      : isCoach
      ? "A new booking for your class"
      : details.recipientKind === "ADMIN"
        ? "A new studio booking"
        : "Your booking is confirmed";
  const subject =
    `${details.cancellation ? "Booking cancelled" : details.reminder ? "Class reminder" : isOperations ? "New booking" : "Booking confirmed"}: ${details.className}`.replace(
      /[\r\n]/g,
      " ",
    );
  const rows = [
    ["Class", details.className],
    ["Date", start.setLocale("en-AU").toFormat("cccc, d LLLL yyyy")],
    [
      "Time",
      `${start.toFormat("h:mm a")} – ${end.toFormat("h:mm a")} (${details.timezone}, ${start.offsetNameShort})`,
    ],
    ["Coach", details.coachName],
    ["Location", details.locationName],
    ["Booking reference", details.bookingReference],
    ...(isOperations
      ? [
          [
            "Confirmed places",
            `${details.confirmedCount} / ${details.capacity}`,
          ],
        ]
      : []),
  ];
  const note = details.cancellation
    ? details.cancellation === "CANCELLED"
      ? "This booking has been cancelled and its reserved class credit released. Your Pass retains its original expiry and eligibility. No payment refund has been issued by this system."
      : "This booking was cancelled after the free cancellation deadline. One class credit has been used. No payment refund has been issued by this system."
    : details.reminder
      ? "Your class starts in about 12 hours and your place is reserved. Free cancellation is available until 12 hours before class; after that, one class credit is used. A no-show uses one class credit; Pass credits are not returned and Drop-in payments are not refunded."
      : isOperations
        ? `This count reflects confirmed bookings when this email was prepared. Check ${isCoach ? "your schedule" : "Admin bookings"} for the latest roster.`
      : "Your place is reserved. Free cancellation is available until 12 hours before class; late cancellation uses one class credit. Your booking is treated as attended by default. A no-show uses one class credit; Pass credits are not returned and Drop-in payments are not refunded. Original Pass expiry and eligibility still apply.";
  return {
    subject,
    text: `${heading}\n\n${rows.map(([label, value]) => `${label}: ${value}`).join("\n")}\n\n${note}\n\nSkyra`,
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><body style="margin:0;background:#f5f2ec;color:#252722;font-family:Arial,sans-serif"><main style="max-width:560px;margin:32px auto;padding:32px;background:white"><p style="letter-spacing:4px;font-size:18px">SKYRA</p><h1 style="font-size:28px">${heading}</h1><table style="width:100%;border-collapse:collapse">${rows.map(([label, value]) => `<tr><th scope="row" style="text-align:left;padding:12px 10px 12px 0;border-bottom:1px solid #ddd;font-weight:normal;color:#686b62">${escape(label)}</th><td style="padding:12px 0;border-bottom:1px solid #ddd">${escape(value)}</td></tr>`).join("")}</table><p style="font-size:14px;line-height:1.6">${escape(note)}</p></main></body></html>`,
  };
}

export async function previewBookingNotification(
  shopId: string,
  notificationId: string,
) {
  const notification = await db.bookingNotification.findFirstOrThrow({
    where: { shopId, id: notificationId },
  });
  const booking = await db.booking.findFirstOrThrow({
    where: { shopId, id: notification.bookingId },
    include: {
      session: { include: { service: true, coach: true, location: true } },
    },
  });
  const reminder = notification.template === "BOOKING_REMINDER_V1";
  const now = reminder ? await databaseNow(db) : null;
  if (
    (notification.template === "BOOKING_CANCELLED_V1"
      ? !["CANCELLED", "LATE_CANCEL"].includes(booking.status)
      : booking.status !== "CONFIRMED") ||
    (reminder && booking.session.startsAt <= now!) ||
    (notification.recipientKind === "COACH"
      ? notification.recipientId !== booking.session.coachId
      : notification.recipientKind === "ADMIN"
        ? notification.recipientId !== shopId
        : notification.recipientId !== booking.customerId)
  )
    throw new DomainError(
      "NOTIFICATION_OBSOLETE",
      "Booking or assigned recipient changed.",
    );
  const confirmedCount = await db.booking.count({
    where: { shopId, sessionId: booking.sessionId, status: "CONFIRMED" },
  });
  return renderBookingEmail({
    cancellation:
      notification.template === "BOOKING_CANCELLED_V1"
        ? (booking.status as "CANCELLED" | "LATE_CANCEL")
        : undefined,
    reminder,
    recipientKind: notification.recipientKind as "CUSTOMER" | "COACH" | "ADMIN",
    className: booking.session.service.name,
    coachName: booking.session.coach.name,
    locationName: booking.session.location.name,
    startsAt: booking.session.startsAt,
    endsAt: booking.session.endsAt,
    timezone: booking.session.timezone,
    bookingReference: booking.id,
    confirmedCount,
    capacity: booking.session.capacity,
  });
}

// An adapter must resolve the current verified recipient from the internal IDs.
// Never accept a browser-supplied destination. No adapter is enabled by default.
// ACCEPTED means provider acceptance, not inbox delivery. Ambiguous sends require
// reconciliation; blindly retrying after a timeout can send duplicate emails.
export type BookingMailAdapter = (input: {
  shopId: string;
  recipientKind: string;
  recipientId: string;
  idempotencyKey: string;
  subject: string;
  html: string;
  text: string;
}) => Promise<
  { status: "ACCEPTED"; messageId: string } | { status: "RETRY" | "FAILED" }
>;

export async function deliverBookingNotification(
  id: string,
  adapter: BookingMailAdapter,
) {
  const now = await databaseNow(db);
  const claimed = await db.bookingNotification.updateMany({
    where: { id, status: "PENDING", availableAt: { lte: now } },
    data: {
      status: "SENDING",
      claimedAt: now,
      attempts: { increment: 1 },
    },
  });
  if (!claimed.count) return;
  const notification = await db.bookingNotification.findUniqueOrThrow({
    where: { id },
  });
  try {
    const shop = await db.shop.findUniqueOrThrow({
      where: { id: notification.shopId },
    });
    if (shop.status !== "ACTIVE")
      throw new DomainError("NOTIFICATION_OBSOLETE", "Shop is inactive.");
    const email = await previewBookingNotification(notification.shopId, id);
    const result = await adapter({
      shopId: notification.shopId,
      recipientKind: notification.recipientKind,
      recipientId: notification.recipientId,
      idempotencyKey: `skyra-booking-email:${id}`,
      ...email,
    });
    const finishedAt = await databaseNow(db);
    await db.bookingNotification.update({
      where: { id },
      data:
        result.status === "ACCEPTED"
          ? {
              status: "ACCEPTED",
              acceptedAt: finishedAt,
              providerMessageId: result.messageId,
              lastError: null,
            }
          : {
              status:
                result.status === "RETRY" && notification.attempts < 5
                  ? "PENDING"
                  : "FAILED",
              availableAt: new Date(
                finishedAt.getTime() + 60000 * 2 ** notification.attempts,
              ),
              lastError: "DELIVERY_REJECTED",
            },
    });
  } catch (error) {
    const obsolete =
      error instanceof DomainError && error.code === "NOTIFICATION_OBSOLETE";
    await db.bookingNotification.update({
      where: { id },
      data: {
        status: obsolete ? "SUPPRESSED" : "UNKNOWN",
        lastError: obsolete
          ? "NOTIFICATION_OBSOLETE"
          : "DELIVERY_OUTCOME_UNKNOWN",
      },
    });
  }
}

export async function markStaleNotificationsUnknown() {
  const now = await databaseNow(db);
  return db.bookingNotification.updateMany({
    where: {
      status: "SENDING",
      claimedAt: { lt: new Date(now.getTime() - 10 * 60000) },
    },
    data: { status: "UNKNOWN", lastError: "DELIVERY_OUTCOME_UNKNOWN" },
  });
}
