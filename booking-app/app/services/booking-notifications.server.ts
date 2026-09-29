import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { databaseNow } from "./booking.server";
import { DateTime } from "luxon";
import { DomainError } from "../lib/errors.server";
import {
  lockSessionMail,
  SESSION_TIME_CHANGED,
  sessionChangeSnapshot,
  timeChanged,
} from "./session-change-notifications.server";

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
        notificationEvent: {
          eventKey: "",
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
        notificationEvent: {
          eventKey: "",
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
  previousTime?: { startsAt: Date; endsAt: Date; timezone: string };
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
  const heading = details.previousTime
    ? "Your class time has changed"
    : details.cancellation
      ? "Booking cancelled"
      : details.reminder
        ? "Your class starts soon"
        : isCoach
          ? "A new booking for your class"
          : details.recipientKind === "ADMIN"
            ? "A new studio booking"
            : "Your booking is confirmed";
  const subject =
    `${details.previousTime ? "Class time changed" : details.cancellation ? "Booking cancelled" : details.reminder ? "Class reminder" : isOperations ? "New booking" : "Booking confirmed"}: ${details.className}`.replace(
      /[\r\n]/g,
      " ",
    );
  const rows = [
    ["Class", details.className],
    ...(details.previousTime
      ? [
          [
            "Previous time",
            `${DateTime.fromJSDate(details.previousTime.startsAt, { zone: details.previousTime.timezone }).setLocale("en-AU").toFormat("cccc, d LLLL yyyy · h:mm a")} – ${DateTime.fromJSDate(details.previousTime.endsAt, { zone: details.previousTime.timezone }).toFormat("h:mm a")} (${details.previousTime.timezone})`,
          ],
          [
            "New time",
            `${start.setLocale("en-AU").toFormat("cccc, d LLLL yyyy · h:mm a")} – ${end.toFormat("h:mm a")} (${details.timezone}, ${start.offsetNameShort})`,
          ],
        ]
      : []),
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
  const note = details.previousTime
    ? "Your existing booking remains confirmed. Please use the new class time above. If you cannot attend at the new time, please contact the studio."
    : details.cancellation
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
  return prepareBookingNotification(shopId, notificationId, false);
}

// Preview is read-only and remains available after class or booking changes.
// Delivery must independently enforce eligibility before contacting the provider.
async function prepareBookingNotification(
  shopId: string,
  notificationId: string,
  forDelivery: boolean,
) {
  const notification = await db.bookingNotification.findFirst({
    where: { shopId, id: notificationId },
  });
  if (!notification)
    throw new DomainError(
      "NOTIFICATION_NOT_FOUND",
      "Email notification not found.",
      404,
    );
  const booking = await db.booking.findFirst({
    where: { shopId, id: notification.bookingId },
    include: {
      session: { include: { service: true, coach: true, location: true } },
    },
  });
  if (!booking)
    throw new DomainError(
      "NOTIFICATION_NOT_FOUND",
      "Booking for this email is unavailable.",
      404,
    );
  const reminder = notification.template === "BOOKING_REMINDER_V1";
  const change =
    notification.template === SESSION_TIME_CHANGED
      ? sessionChangeSnapshot.parse(notification.snapshot)
      : null;
  if (
    forDelivery &&
    change &&
    (timeChanged(change.next, booking.session) ||
      booking.session.status !== "PUBLISHED" ||
      booking.session.startsAt <= new Date())
  )
    throw new DomainError(
      "NOTIFICATION_OBSOLETE",
      "The class time changed again or the class is no longer upcoming.",
    );
  const now = forDelivery && reminder ? await databaseNow(db) : null;
  if (
    forDelivery &&
    ((notification.template === "BOOKING_CANCELLED_V1"
      ? !["CANCELLED", "LATE_CANCEL"].includes(booking.status)
      : booking.status !== "CONFIRMED") ||
      (reminder && booking.session.startsAt <= now!) ||
      (notification.recipientKind === "COACH"
        ? notification.recipientId !== booking.session.coachId
        : notification.recipientKind === "ADMIN"
          ? notification.recipientId !== shopId
          : notification.recipientId !== booking.customerId))
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
        ? booking.status === "LATE_CANCEL"
          ? "LATE_CANCEL"
          : "CANCELLED"
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
    ...(change
      ? {
          className: change.className,
          coachName: change.coachName,
          locationName: change.locationName,
          ...change.next,
          previousTime: change.previous,
          bookingReference: change.bookingReference,
          confirmedCount: change.confirmedCount,
          capacity: change.capacity,
        }
      : {}),
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
  const notification = await db.bookingNotification.findUniqueOrThrow({
    where: { id },
  });
  const booking = await db.booking.findFirst({
    where: { id: notification.bookingId, shopId: notification.shopId },
    select: { sessionId: true },
  });
  return db.$transaction(
    async (tx) => {
      if (booking) await lockSessionMail(tx, booking.sessionId);
      // Claim is committed independently so a process crash leaves SENDING for
      // reconciliation, not a rolled-back PENDING job that could send twice.
      return deliverClaimedBookingNotification(id, adapter);
    },
    { timeout: 25000, maxWait: 15000 },
  );
}

async function deliverClaimedBookingNotification(
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
    const email = await prepareBookingNotification(
      notification.shopId,
      id,
      true,
    );
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
