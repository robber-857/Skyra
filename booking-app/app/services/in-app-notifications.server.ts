import db from "../db.server";
import { databaseNow } from "./booking.server";
import { coachIdentity } from "./coach-auth.server";
import { requireOperations, type Actor } from "./authorization";
import { DomainError } from "../lib/errors.server";

async function listNotifications(
  shopId: string,
  recipientKind: "ADMIN" | "COACH",
  recipientId: string,
) {
  const notifications = await db.bookingNotification.findMany({
    where: { shopId, recipientKind, recipientId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 12,
  });
  const bookings = await db.booking.findMany({
    where: {
      shopId,
      id: { in: notifications.map((notification) => notification.bookingId) },
    },
    select: {
      id: true,
      sessionId: true,
      status: true,
      customerId: true,
      customer: { select: { preferredName: true } },
      session: {
        select: {
          startsAt: true,
          timezone: true,
          service: { select: { name: true } },
        },
      },
    },
  });
  return notifications.flatMap((notification) => {
    const booking = bookings.find((item) => item.id === notification.bookingId);
    if (!booking) return [];
    return [
      {
        id: notification.id,
        bookingId: booking.id,
        sessionId: booking.sessionId,
        unread: notification.readAt === null,
        createdAt: notification.createdAt.toISOString(),
        emailStatus: notification.status,
        template: notification.template,
        className: booking.session.service.name,
        startsAt: booking.session.startsAt.toISOString(),
        timezone: booking.session.timezone,
        customerName:
          booking.customer.preferredName ||
          `Customer ${booking.customerId.slice(-8)}`,
      },
    ];
  });
}

export async function adminNotifications(actor: Actor) {
  requireOperations(actor);
  return listNotifications(actor.shopId, "ADMIN", actor.shopId);
}

export async function coachNotifications(token: string) {
  const identity = await coachIdentity(token);
  return {
    identity,
    notifications: await listNotifications(
      identity.shopId,
      "COACH",
      identity.coachId,
    ),
  };
}

async function markRead(
  shopId: string,
  recipientKind: "ADMIN" | "COACH",
  recipientId: string,
  notificationId: string,
) {
  const now = await databaseNow(db);
  const result = await db.bookingNotification.updateMany({
    where: {
      id: notificationId,
      shopId,
      recipientKind,
      recipientId,
      readAt: null,
    },
    data: { readAt: now },
  });
  if (!result.count) {
    const existing = await db.bookingNotification.findFirst({
      where: { id: notificationId, shopId, recipientKind, recipientId },
    });
    if (!existing)
      throw new DomainError("NOT_FOUND", "Notification not found.", 404);
  }
}

export async function markAdminNotificationRead(
  actor: Actor,
  notificationId: string,
) {
  requireOperations(actor);
  await markRead(actor.shopId, "ADMIN", actor.shopId, notificationId);
}

export async function markCoachNotificationRead(
  token: string,
  notificationId: string,
) {
  const identity = await coachIdentity(token);
  await markRead(
    identity.shopId,
    "COACH",
    identity.coachId,
    notificationId,
  );
}
