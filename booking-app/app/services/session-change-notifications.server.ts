import type { Prisma } from "@prisma/client";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { audit, lockShop } from "./catalog.server";
import { requireOperations, type Actor } from "./authorization";
import { databaseNow } from "./booking.server";

export const SESSION_TIME_CHANGED = "SESSION_TIME_CHANGED_V1";
const timeSchema = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  timezone: z.string(),
});
export const sessionChangeSnapshot = z.object({
  className: z.string(),
  coachName: z.string(),
  locationName: z.string(),
  previous: timeSchema,
  next: timeSchema,
  bookingReference: z.string(),
  confirmedCount: z.number(),
  capacity: z.number(),
});
type SessionTime = z.infer<typeof timeSchema>;
export function timeChanged(before: SessionTime, after: SessionTime) {
  return (
    before.startsAt.getTime() !== after.startsAt.getTime() ||
    before.endsAt.getTime() !== after.endsAt.getTime() ||
    before.timezone !== after.timezone
  );
}

// Delivery and edits serialize per session. A reminder cannot be sent with an
// old time while an edit commits a replacement time.
export async function lockSessionMail(
  tx: Prisma.TransactionClient,
  id: string,
) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`;
}

export async function enqueueSessionTimeChange(
  tx: Prisma.TransactionClient,
  shopId: string,
  sessionId: string,
  previous: SessionTime,
  eventKey: string,
  bookedBefore?: Date,
) {
  const session = await tx.classSession.findFirstOrThrow({
    where: { id: sessionId, shopId },
    include: {
      service: true,
      coach: true,
      location: true,
      bookings: {
        where: {
          shopId,
          status: "CONFIRMED",
          ...(bookedBefore ? { createdAt: { lte: bookedBefore } } : {}),
        },
      },
    },
  });
  const now = await databaseNow(tx);
  if (!timeChanged(previous, session)) return 0;
  const next = {
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    timezone: session.timezone,
  };
  let queued = 0;
  for (const booking of session.bookings) {
    await tx.bookingNotification.updateMany({
      where: {
        shopId,
        bookingId: booking.id,
        template: SESSION_TIME_CHANGED,
        eventKey: { not: eventKey },
        status: "PENDING",
      },
      data: { status: "SUPPRESSED", lastError: "SUPERSEDED_TIME_CHANGE" },
    });
    for (const recipient of [
      { recipientKind: "CUSTOMER", recipientId: booking.customerId },
      { recipientKind: "COACH", recipientId: session.coachId },
      { recipientKind: "ADMIN", recipientId: shopId },
    ]) {
      const result = await tx.bookingNotification.createMany({
        data: [
          {
            shopId,
            bookingId: booking.id,
            ...recipient,
            template: SESSION_TIME_CHANGED,
            eventKey,
            availableAt: now,
            snapshot: JSON.parse(
              JSON.stringify({
                className: session.service.name,
                coachName: session.coach.name,
                locationName: session.location.name,
                previous: {
                  startsAt: previous.startsAt,
                  endsAt: previous.endsAt,
                  timezone: previous.timezone,
                },
                next,
                bookingReference: booking.id,
                confirmedCount: session.bookings.length,
                capacity: session.capacity,
              }),
            ),
          },
        ],
        skipDuplicates: true,
      });
      if (recipient.recipientKind === "CUSTOMER") queued += result.count;
    }
  }
  // Keep already accepted/ambiguous reminders untouched; never blindly resend.
  // Imported bookings may not yet have a reminder, so create one if missing.
  const bookings = await tx.booking.findMany({
    where: { shopId, sessionId, status: "CONFIRMED" },
  });
  for (const booking of bookings) {
    const availableAt = new Date(
      Math.max(now.getTime(), session.startsAt.getTime() - 12 * 3600000),
    );
    const key = {
      shopId,
      bookingId: booking.id,
      recipientKind: "CUSTOMER",
      recipientId: booking.customerId,
      template: "BOOKING_REMINDER_V1",
      eventKey: "",
    };
    await tx.bookingNotification.upsert({
      where: { notificationEvent: key },
      create: { ...key, availableAt },
      update: {},
    });
    await tx.bookingNotification.updateMany({
      where: { ...key, status: "PENDING" },
      data: { availableAt },
    });
  }
  return queued;
}

export async function historicalTimeChange(
  tx: Prisma.TransactionClient,
  shopId: string,
  sessionId: string,
  current: SessionTime,
) {
  const records = await tx.auditLog.findMany({
    where: { shopId, entityId: sessionId, action: "SESSION_UPDATED" },
    orderBy: { createdAt: "desc" },
  });
  for (const record of records) {
    const before = timeSchema.safeParse(record.before);
    const after = timeSchema
      .extend({ version: z.number().int() })
      .safeParse(record.after);
    if (
      !before.success ||
      !after.success ||
      !timeChanged(before.data, after.data)
    )
      continue;
    if (timeChanged(after.data, current)) return null;
    return {
      id: record.id,
      previous: before.data,
      next: after.data,
      createdAt: record.createdAt,
      eventKey: `session:${sessionId}:version:${after.data.version}`,
    };
  }
  return null;
}

export async function backfillSessionTimeChange(
  actor: Actor,
  sessionId: string,
  auditId: string,
) {
  requireOperations(actor);
  z.uuid().parse(sessionId);
  z.uuid().parse(auditId);
  return db.$transaction(
    async (tx) => {
      await lockShop(tx, actor.shopId);
      await lockSessionMail(tx, sessionId);
      const session = await tx.classSession.findFirst({
        where: {
          shopId: actor.shopId,
          id: sessionId,
          status: "PUBLISHED",
          startsAt: { gt: new Date() },
        },
      });
      if (!session)
        throw new DomainError(
          "NOT_FOUND",
          "Future published session not found.",
          404,
        );
      const change = await historicalTimeChange(
        tx,
        actor.shopId,
        sessionId,
        session,
      );
      if (!change || change.id !== auditId)
        throw new DomainError(
          "CONFLICT",
          "The session changed. Refresh and review the latest times.",
          409,
        );
      const queued = await enqueueSessionTimeChange(
        tx,
        actor.shopId,
        sessionId,
        change.previous,
        change.eventKey,
        change.createdAt,
      );
      await audit(tx, actor, "SESSION_TIME_EMAIL_BACKFILL", sessionId, null, {
        auditId,
        queued,
      });
      return queued;
    },
    { timeout: 15000 },
  );
}
