import { z } from "zod";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import { databaseNow, type BookingActor } from "./booking.server";
import { coachIdentity, type CoachIdentity } from "./coach-auth.server";
import {
  consumeEntitlementReservation,
  releaseEntitlementReservation,
} from "./entitlements.server";
import { enqueueBookingNotifications } from "./booking-notifications.server";
export const bookingChangeInput = z
  .object({
    bookingId: z.string().uuid(),
    expectedVersion: z.coerce.number().int().positive(),
    action: z.enum([
      "CANCEL",
      "CANCEL_WAIVE",
      "CHECK_IN",
      "COMPLETE",
      "NO_SHOW",
    ]),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
type Identity =
  | { kind: "STAFF"; actor: Actor }
  | { kind: "COACH"; identity: CoachIdentity }
  | { kind: "CUSTOMER"; actor: BookingActor };
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
export function cancellationOutcome(startsAt: Date, now: Date) {
  return now.getTime() <= startsAt.getTime() - 12 * 3600000
    ? "CANCELLED"
    : "LATE_CANCEL";
}
async function withBooking<T>(
  identity: Identity,
  bookingId: string,
  run: (
    tx: Prisma.TransactionClient,
    booking: Awaited<ReturnType<typeof loadBooking>>,
    now: Date,
  ) => Promise<T>,
) {
  const shopId =
    identity.kind === "COACH"
      ? identity.identity.shopId
      : identity.actor.shopId;
  if (identity.kind === "STAFF") requireOperations(identity.actor);
  return db.$transaction(
    async (tx) => {
      const first = await tx.booking.findFirst({
        where: { shopId, id: bookingId },
      });
      if (!first) return fail("NOT_FOUND", "Booking not found.", 404);
      await tx.$queryRaw`SELECT id FROM "ClassSession" WHERE id = ${first.sessionId}::uuid AND "shopId" = ${shopId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${bookingId}::uuid FOR UPDATE`;
      const booking = await loadBooking(tx, bookingId);
      const shop = await tx.shop.findFirst({
        where: { id: shopId, status: "ACTIVE" },
      });
      if (!shop) return fail("NOT_FOUND", "Booking unavailable.", 404);
      if (
        identity.kind === "COACH" &&
        booking.session.coachId !== identity.identity.coachId
      )
        return fail(
          "FORBIDDEN",
          "This class is assigned to another coach.",
          403,
        );
      if (
        identity.kind === "CUSTOMER" &&
        (!identity.actor.customerGid ||
          booking.customer.shopifyCustomerGid !== identity.actor.customerGid)
      )
        return fail(
          "FORBIDDEN",
          "This booking belongs to another customer.",
          403,
        );
      return run(tx, booking, await databaseNow(tx));
    },
    { maxWait: 30000, timeout: 15000 },
  );
}
function loadBooking(tx: Prisma.TransactionClient, id: string) {
  return tx.booking.findUniqueOrThrow({
    where: { id },
    include: { session: true, customer: true },
  });
}
async function changeBooking(identity: Identity, raw: unknown) {
  const input = bookingChangeInput.parse(raw);
  if (identity.kind === "COACH" && input.action !== "NO_SHOW")
    fail("FORBIDDEN", "Coaches can only record a no-show.", 403);
  if (identity.kind === "CUSTOMER" && input.action !== "CANCEL")
    fail("FORBIDDEN", "Customers can only cancel their own booking.", 403);
  return withBooking(identity, input.bookingId, async (tx, booking, now) => {
    const actorId =
      identity.kind === "COACH"
        ? identity.identity.coachId
        : identity.kind === "STAFF"
          ? identity.actor.actorId
          : booking.customerId;
    const replay = await tx.bookingChange.findUnique({
      where: {
        shopId_idempotencyKey: {
          shopId: booking.shopId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (replay) {
      if (
        replay.bookingId !== booking.id ||
        replay.action !== input.action ||
        replay.reason !== input.reason ||
        replay.actorKind !== identity.kind ||
        replay.actorId !== actorId
      )
        fail(
          "IDEMPOTENCY_CONFLICT",
          "This operation key has already been used.",
        );
      return {
        bookingId: booking.id,
        status: booking.status,
        version: booking.version,
        checkedInAt: booking.checkedInAt,
      };
    }
    if (booking.version !== input.expectedVersion)
      fail("STALE_BOOKING", "This booking changed. Refresh before continuing.");
    if (booking.status !== "CONFIRMED")
      fail("INVALID_BOOKING_STATE", "This booking has already been settled.");
    let status = booking.status;
    let checkedInAt = booking.checkedInAt;
    const cancelling = ["CANCEL", "CANCEL_WAIVE"].includes(input.action);
    if (cancelling) {
      if (
        input.action === "CANCEL" &&
        (now >= booking.session.startsAt || checkedInAt)
      )
        fail(
          "CANCELLATION_CLOSED",
          "Class has started or attendance was recorded. Contact Skyra Studio.",
        );
      status =
        input.action === "CANCEL_WAIVE"
          ? "CANCELLED"
          : cancellationOutcome(booking.session.startsAt, now);
    } else {
      if (!["PUBLISHED", "COMPLETED"].includes(booking.session.status))
        fail("SESSION_UNAVAILABLE", "This class is not active.");
      if (input.action === "CHECK_IN") {
        if (now < booking.session.startsAt || now >= booking.session.endsAt)
          fail("CHECK_IN_CLOSED", "Check-in is available during the class.");
        if (checkedInAt)
          fail("ALREADY_CHECKED_IN", "This customer is already checked in.");
        checkedInAt = now;
      } else {
        if (now < booking.session.endsAt)
          fail(
            "CLASS_NOT_ENDED",
            "Record completion or no-show after the class ends.",
          );
        if (input.action === "NO_SHOW" && checkedInAt)
          fail(
            "ATTENDANCE_CONFLICT",
            "A checked-in customer cannot be marked no-show.",
          );
        status = input.action === "COMPLETE" ? "ATTENDED" : "NO_SHOW";
      }
    }
    if (status !== "CONFIRMED") {
      const reservations = await tx.entitlementLedgerEntry.findMany({
        where: {
          shopId: booking.shopId,
          bookingId: booking.id,
          kind: "RESERVE",
        },
      });
      if (reservations.length !== 1 || !reservations[0].reservationKey)
        fail(
          "BOOKING_LEDGER_REVIEW",
          "This booking needs a credit ledger review before changing status.",
        );
      const reserve = reservations[0];
      const settle =
        status === "CANCELLED"
          ? releaseEntitlementReservation
          : consumeEntitlementReservation;
      await settle(tx, {
        shopId: booking.shopId,
        entitlementId: reserve.entitlementId,
        reservationKey: reserve.reservationKey!,
        bookingId: booking.id,
        idempotencyKey: "booking-settle:" + booking.id,
      });
    }
    const updated = await tx.booking.update({
      where: { id: booking.id },
      data: { status, checkedInAt, version: { increment: 1 } },
    });
    await tx.bookingChange.create({
      data: {
        shopId: booking.shopId,
        bookingId: booking.id,
        idempotencyKey: input.idempotencyKey,
        actorKind: identity.kind,
        actorId,
        action: input.action,
        reason: input.reason,
        fromStatus: booking.status,
        toStatus: status,
      },
    });
    await tx.auditLog.create({
      data: {
        shopId: booking.shopId,
        actorId,
        action: "BOOKING_" + input.action,
        entityId: booking.id,
        before: { status: booking.status, version: booking.version },
        after: { status, version: updated.version, reason: input.reason },
      },
    });
    if (status !== "CONFIRMED")
      await tx.bookingNotification.updateMany({
        where: {
          shopId: booking.shopId,
          bookingId: booking.id,
          template: { in: ["BOOKING_CONFIRMED_V1", "BOOKING_REMINDER_V1"] },
          status: "PENDING",
        },
        data: { status: "SUPPRESSED", lastError: "NOTIFICATION_OBSOLETE" },
      });
    if (cancelling)
      await enqueueBookingNotifications(
        tx,
        booking.shopId,
        booking.id,
        "BOOKING_CANCELLED_V1",
      );
    return {
      bookingId: updated.id,
      status: updated.status,
      version: updated.version,
      checkedInAt: updated.checkedInAt,
    };
  });
}
export const staffChangeBooking = (actor: Actor, raw: unknown) =>
  changeBooking({ kind: "STAFF", actor }, raw);
export const customerChangeBooking = (actor: BookingActor, raw: unknown) =>
  changeBooking({ kind: "CUSTOMER", actor }, raw);
export async function coachChangeBooking(token: string, raw: unknown) {
  return changeBooking(
    { kind: "COACH", identity: await coachIdentity(token) },
    raw,
  );
}

const defaultAttendanceDelayMs = 24 * 3600000;

export async function settleDefaultAttendanceWork(
  options: { batchSize?: number; shopId?: string } = {},
) {
  const now = await databaseNow(db);
  const candidates = await db.booking.findMany({
    where: {
      ...(options.shopId ? { shopId: options.shopId } : {}),
      status: "CONFIRMED",
      session: {
        status: { in: ["PUBLISHED", "COMPLETED"] },
        endsAt: { lte: new Date(now.getTime() - defaultAttendanceDelayMs) },
      },
    },
    select: { id: true, shopId: true, sessionId: true },
    orderBy: { createdAt: "asc" },
    take: options.batchSize || 100,
  });
  let settled = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const changed = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ClassSession" WHERE id = ${candidate.sessionId}::uuid AND "shopId" = ${candidate.shopId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM "Booking" WHERE id = ${candidate.id}::uuid AND "shopId" = ${candidate.shopId}::uuid FOR UPDATE`;
        const booking = await loadBooking(tx, candidate.id);
        const clock = await databaseNow(tx);
        if (
          booking.status !== "CONFIRMED" ||
          booking.session.endsAt.getTime() + defaultAttendanceDelayMs >
            clock.getTime()
        )
          return false;
        const reservations = await tx.entitlementLedgerEntry.findMany({
          where: {
            shopId: booking.shopId,
            bookingId: booking.id,
            kind: "RESERVE",
          },
        });
        if (reservations.length !== 1 || !reservations[0].reservationKey)
          fail(
            "BOOKING_LEDGER_REVIEW",
            "This booking needs a credit ledger review before auto-settlement.",
          );
        await consumeEntitlementReservation(tx, {
          shopId: booking.shopId,
          entitlementId: reservations[0].entitlementId,
          reservationKey: reservations[0].reservationKey!,
          bookingId: booking.id,
          idempotencyKey: "booking-settle:" + booking.id,
        });
        const updated = await tx.booking.update({
          where: { id: booking.id },
          data: { status: "ATTENDED", version: { increment: 1 } },
        });
        const reason =
          "Automatically attended after the 24-hour no-show window.";
        await tx.bookingChange.create({
          data: {
            shopId: booking.shopId,
            bookingId: booking.id,
            idempotencyKey: booking.id,
            actorKind: "SYSTEM",
            actorId: "SYSTEM",
            action: "AUTO_COMPLETE",
            reason,
            fromStatus: booking.status,
            toStatus: updated.status,
          },
        });
        await tx.auditLog.create({
          data: {
            shopId: booking.shopId,
            actorId: "SYSTEM",
            action: "BOOKING_AUTO_COMPLETE",
            entityId: booking.id,
            before: { status: booking.status, version: booking.version },
            after: { status: updated.status, version: updated.version, reason },
          },
        });
        await tx.bookingNotification.updateMany({
          where: {
            shopId: booking.shopId,
            bookingId: booking.id,
            template: { in: ["BOOKING_CONFIRMED_V1", "BOOKING_REMINDER_V1"] },
            status: "PENDING",
          },
          data: { status: "SUPPRESSED", lastError: "NOTIFICATION_OBSOLETE" },
        });
        return true;
      });
      if (changed) settled += 1;
    } catch (error) {
      failed += 1;
      errors.push(error instanceof Error ? error.message : "Unknown error");
    }
  }
  return { scanned: candidates.length, settled, failed, errors };
}
export async function staffBookingDetail(actor: Actor, id: string) {
  requireOperations(actor);
  z.string().uuid().parse(id);
  const booking = await db.booking.findFirst({
    where: { shopId: actor.shopId, id },
    include: {
      session: { include: { service: true, coach: true, location: true } },
      entitlementLedgerEntries: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!booking) fail("NOT_FOUND", "Booking not found.", 404);
  const timeline = await db.bookingChange.findMany({
    where: { shopId: actor.shopId, bookingId: id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const moves = await db.bookingReschedule.findMany({
    where: {
      shopId: actor.shopId,
      OR: [{ oldBookingId: id }, { newBookingId: id }],
    },
  });
  return {
    booking,
    timeline,
    rescheduledFrom:
      moves.find((m) => m.newBookingId === id)?.oldBookingId || null,
    rescheduledTo:
      moves.find((m) => m.oldBookingId === id)?.newBookingId || null,
    now: (await databaseNow(db)).toISOString(),
  };
}
export async function coachRoster(token: string, id: string) {
  z.string().uuid().parse(id);
  const identity = await coachIdentity(token);
  const session = await db.classSession.findFirst({
    where: {
      id,
      shopId: identity.shopId,
      coachId: identity.coachId,
      status: { in: ["PUBLISHED", "COMPLETED", "CANCELLED"] },
    },
    include: {
      service: { select: { name: true } },
      location: { select: { name: true } },
      bookings: {
        select: {
          id: true,
          customerId: true,
          customerComment: true,
          status: true,
          version: true,
          checkedInAt: true,
          customer: {
            select: {
              preferredName: true,
              avatarBytes: true,
              avatarMimeType: true,
              signature: true,
              trainingGoals: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!session) fail("NOT_FOUND", "Class not found.", 404);
  await db.auditLog.create({
    data: {
      shopId: identity.shopId,
      actorId: identity.coachId,
      action: "COACH_ROSTER_VIEWED",
      entityId: id,
    },
  });
  return {
    session: {
      ...session,
      bookings: session.bookings.map(({ customer, ...booking }) => ({
        ...booking,
        customer: {
          preferredName: customer.preferredName,
          avatarDataUrl:
            customer.avatarBytes && customer.avatarMimeType
              ? `data:${customer.avatarMimeType};base64,${Buffer.from(
                  customer.avatarBytes,
                ).toString("base64")}`
              : null,
          signature: customer.signature,
          trainingGoals: customer.trainingGoals,
        },
      })),
    },
    coachName: identity.name,
    now: (await databaseNow(db)).toISOString(),
  };
}
