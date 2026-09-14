import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import {
  databaseNow,
  classForBooking,
  classAvailability,
  bookingWindow,
  type BookingActor,
} from "./booking.server";
import { cancellationOutcome } from "./booking-lifecycle.server";
import {
  releaseEntitlementReservation,
  reserveEntitlementCredit,
} from "./entitlements.server";
import { enqueueBookingNotifications } from "./booking-notifications.server";
const input = z
  .object({
    action: z.literal("RESCHEDULE"),
    bookingId: z.string().uuid(),
    targetSessionId: z.string().uuid(),
    expectedVersion: z.coerce.number().int().positive(),
    idempotencyKey: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
type Identity =
  { kind: "STAFF"; actor: Actor } | { kind: "CUSTOMER"; actor: BookingActor };
async function currentBooking(
  tx: Prisma.TransactionClient,
  identity: Identity,
  id: string,
) {
  const booking = await tx.booking.findFirst({
    where: { id, shopId: identity.actor.shopId },
    include: { customer: true, session: true },
  });
  if (!booking) fail("NOT_FOUND", "Booking not found.", 404);
  if (
    identity.kind === "CUSTOMER" &&
    (!identity.actor.customerGid ||
      booking.customer.shopifyCustomerGid !== identity.actor.customerGid)
  )
    fail("FORBIDDEN", "This booking belongs to another customer.", 403);
  return booking;
}
function canMove(
  booking: {
    status: string;
    checkedInAt: Date | null;
    session: { startsAt: Date };
  },
  now: Date,
) {
  if (
    booking.status !== "CONFIRMED" ||
    booking.checkedInAt ||
    cancellationOutcome(booking.session.startsAt, now) !== "CANCELLED"
  )
    fail(
      "RESCHEDULE_CLOSED",
      "Changes require at least 12 hours before class. Contact the studio for assistance.",
    );
}
async function change(identity: Identity, raw: unknown) {
  if (identity.kind === "STAFF") requireOperations(identity.actor);
  const q = input.parse(raw),
    shopId = identity.actor.shopId;
  return db.$transaction(
    async (tx) => {
      const original = await currentBooking(tx, identity, q.bookingId);
      if (original.sessionId === q.targetSessionId)
        fail("SAME_CLASS", "Choose a different class time.");
      // Every multi-session operation locks IDs in the same order, before bookings/credits.
      const ids = [original.sessionId, q.targetSessionId].sort();
      for (const id of ids) {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM "ClassSession" WHERE "shopId"=${shopId}::uuid AND id=${id}::uuid FOR UPDATE`;
        if (!rows.length) fail("NOT_FOUND", "Class not found.", 404);
      }
      await tx.$queryRaw`SELECT id FROM "Booking" WHERE id=${q.bookingId}::uuid FOR UPDATE`;
      const booking = await currentBooking(tx, identity, q.bookingId);
      const actorId =
        identity.kind === "STAFF" ? identity.actor.actorId : booking.customerId;
      const replay = await tx.bookingReschedule.findUnique({
        where: {
          shopId_idempotencyKey: { shopId, idempotencyKey: q.idempotencyKey },
        },
      });
      if (replay) {
        const next = await tx.booking.findUniqueOrThrow({
          where: { id: replay.newBookingId },
        });
        if (
          replay.oldBookingId !== q.bookingId ||
          next.sessionId !== q.targetSessionId ||
          replay.actorKind !== identity.kind ||
          replay.actorId !== actorId ||
          replay.reason !== q.reason
        )
          fail(
            "IDEMPOTENCY_CONFLICT",
            "This operation key has already been used.",
          );
        return {
          bookingId: next.id,
          status: next.status,
          version: next.version,
        };
      }
      const shop = await tx.shop.findFirst({
        where: { id: shopId, status: "ACTIVE" },
      });
      if (!shop) fail("NOT_FOUND", "Booking unavailable.", 404);
      const now = await databaseNow(tx);
      canMove(booking, now);
      if (booking.version !== q.expectedVersion)
        fail(
          "STALE_BOOKING",
          "This booking changed. Refresh before continuing.",
        );
      const target = await classForBooking(tx, shop, q.targetSessionId, now);
      if (target.serviceId !== booking.session.serviceId)
        fail("DIFFERENT_CLASS", "Rescheduling keeps the same class type.");
      if (!(await classAvailability(shopId, [target.id], tx)).get(target.id))
        fail(
          "SOLD_OUT",
          "This class is full. Your original booking is unchanged.",
        );
      if (
        await tx.booking.findFirst({
          where: {
            shopId,
            customerId: booking.customerId,
            sessionId: target.id,
            status: { in: ["CONFIRMED", "ATTENDED"] },
          },
        })
      )
        fail("ALREADY_BOOKED", "You already have a booking for that class.");
      const reserves = await tx.entitlementLedgerEntry.findMany({
        where: { shopId, bookingId: booking.id, kind: "RESERVE" },
      });
      if (reserves.length !== 1 || !reserves[0].reservationKey)
        fail(
          "BOOKING_LEDGER_REVIEW",
          "This booking needs a credit ledger review.",
        );
      const reserve = reserves[0];
      // The release is invisible outside this transaction until the new reservation succeeds.
      await releaseEntitlementReservation(tx, {
        shopId,
        entitlementId: reserve.entitlementId,
        reservationKey: reserve.reservationKey!,
        bookingId: booking.id,
        idempotencyKey: "booking-settle:" + booking.id,
      });
      const next = await tx.booking.create({
        data: {
          shopId,
          sessionId: target.id,
          customerId: booking.customerId,
          customerComment: booking.customerComment,
        },
      });
      await reserveEntitlementCredit(tx, {
        shopId,
        entitlementId: reserve.entitlementId,
        customerId: booking.customerId,
        serviceId: target.serviceId,
        sessionStartsAt: target.startsAt,
        now,
        reservationKey: randomUUID(),
        idempotencyKey: "reschedule:" + q.idempotencyKey,
        bookingId: next.id,
      });
      await tx.booking.update({
        where: { id: booking.id },
        data: { status: "CANCELLED", version: { increment: 1 } },
      });
      await tx.bookingReschedule.create({
        data: {
          shopId,
          oldBookingId: booking.id,
          newBookingId: next.id,
          idempotencyKey: q.idempotencyKey,
          actorKind: identity.kind,
          actorId,
          reason: q.reason,
        },
      });
      await tx.bookingChange.create({
        data: {
          shopId,
          bookingId: booking.id,
          idempotencyKey: q.idempotencyKey,
          actorKind: identity.kind,
          actorId,
          action: "RESCHEDULE",
          reason: q.reason,
          fromStatus: "CONFIRMED",
          toStatus: "CANCELLED",
        },
      });
      await tx.bookingNotification.updateMany({
        where: {
          shopId,
          bookingId: booking.id,
          status: "PENDING",
          template: "BOOKING_CONFIRMED_V1",
        },
        data: { status: "SUPPRESSED", lastError: "NOTIFICATION_OBSOLETE" },
      });
      await enqueueBookingNotifications(
        tx,
        shopId,
        booking.id,
        "BOOKING_CANCELLED_V1",
      );
      await enqueueBookingNotifications(tx, shopId, next.id);
      await tx.auditLog.create({
        data: {
          shopId,
          actorId,
          action: "BOOKING_RESCHEDULED",
          entityId: booking.id,
          after: {
            newBookingId: next.id,
            oldSessionId: booking.sessionId,
            newSessionId: target.id,
          },
        },
      });
      return { bookingId: next.id, status: next.status, version: next.version };
    },
    { maxWait: 30000, timeout: 15000 },
  );
}
export const customerReschedule = (actor: BookingActor, raw: unknown) =>
  change({ kind: "CUSTOMER", actor }, raw);
export const staffReschedule = (actor: Actor, raw: unknown) =>
  change({ kind: "STAFF", actor }, raw);
export async function rescheduleOptions(identity: Identity, raw: unknown) {
  if (identity.kind === "STAFF") requireOperations(identity.actor);
  const q = z.object({ bookingId: z.string().uuid() }).strict().parse(raw);
  return db.$transaction(async (tx) => {
    const booking = await currentBooking(tx, identity, q.bookingId);
    const now = await databaseNow(tx);
    canMove(booking, now);
    const shop = await tx.shop.findFirstOrThrow({
      where: { id: identity.actor.shopId, status: "ACTIVE" },
    });
    const reserve = await tx.entitlementLedgerEntry.findFirst({
      where: { shopId: shop.id, bookingId: booking.id, kind: "RESERVE" },
      include: { entitlement: true },
    });
    if (!reserve)
      fail(
        "BOOKING_LEDGER_REVIEW",
        "This booking needs a credit ledger review.",
      );
    if (reserve.entitlement.status !== "ACTIVE") return { options: [] };
    const rows = await tx.classSession.findMany({
      where: {
        shopId: shop.id,
        serviceId: booking.session.serviceId,
        id: { not: booking.sessionId },
        status: "PUBLISHED",
        startsAt: { gt: now, lt: reserve.entitlement.expiresAt },
        coach: { status: "ACTIVE" },
        service: { status: "ACTIVE" },
        bookings: {
          none: {
            customerId: booking.customerId,
            status: { in: ["CONFIRMED", "ATTENDED"] },
          },
        },
      },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: 100,
      include: {
        coach: { select: { name: true } },
        location: { select: { name: true } },
      },
    });
    const availability = await classAvailability(
      shop.id,
      rows.map((r) => r.id),
      tx,
    );
    return {
      options: rows
        .filter(
          (r) =>
            bookingWindow(shop, r, now) === "OPEN" &&
            (availability.get(r.id) || 0) > 0,
        )
        .map((r) => ({
          id: r.id,
          startsAt: r.startsAt.toISOString(),
          timezone: r.timezone,
          coachName: r.coach.name,
          locationName: r.location.name,
        })),
      limit: 100,
    };
  });
}
