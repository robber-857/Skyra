import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../lib/errors.server";
import {
  withAttempt,
  classForBooking,
  classAvailability,
  type BookingActor,
} from "./booking.server";
import {
  eligibleEntitlements,
  reserveEntitlementCredit,
} from "./entitlements.server";
import { enqueueBookingNotifications } from "./booking-notifications.server";

export const ownedBookingInput = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    entitlementId: z.string().uuid(),
  })
  .strict();
export async function confirmOwnedBooking(actor: BookingActor, raw: unknown) {
  const input = ownedBookingInput.parse(raw);
  return withAttempt(actor, input.token, async (tx, attempt, shop, now) => {
    if (!actor.customerGid || !attempt.customerId)
      throw new DomainError(
        "LOGIN_REQUIRED",
        "Sign in to confirm your booking.",
        401,
      );
    const replay = await tx.booking.findUnique({
      where: { ownedAttemptId: attempt.id },
      include: { entitlementLedgerEntries: { where: { kind: "RESERVE" } } },
    });
    if (replay) {
      if (
        !replay.entitlementLedgerEntries.some(
          (entry) => entry.entitlementId === input.entitlementId,
        )
      )
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This booking already used another Pass.",
          409,
        );
      return { status: replay.status, bookingReference: replay.id };
    }
    if ((shop.rules as Record<string, unknown>).onlineBookingsEnabled !== true)
      throw new DomainError(
        "BOOKING_NOT_AVAILABLE",
        "Online booking is not available yet.",
        503,
      );
    if (attempt.status !== "STARTED" || attempt.expiresAt <= now)
      throw new DomainError(
        "ATTEMPT_EXPIRED",
        "This booking attempt has ended.",
        409,
      );
    // Once commerce has started, never create an independent second booking.
    if (await tx.bookingHold.findUnique({ where: { attemptId: attempt.id } }))
      throw new DomainError(
        "CHECKOUT_IN_PROGRESS",
        "Check your existing booking before continuing.",
        409,
      );
    const session = await classForBooking(tx, shop, attempt.sessionId, now);
    if (
      await tx.booking.findFirst({
        where: {
          shopId: shop.id,
          sessionId: session.id,
          customerId: attempt.customerId,
          status: { in: ["CONFIRMED", "ATTENDED"] },
        },
      })
    )
      throw new DomainError(
        "ALREADY_BOOKED",
        "You already have a booking for this class.",
        409,
      );
    if (!(
      (await classAvailability(shop.id, [session.id], tx)).get(session.id) || 0
    ))
      throw new DomainError(
        "SOLD_OUT",
        "This class is full. Choose another class.",
        409,
      );
    const eligible = await eligibleEntitlements(tx, {
      shopId: shop.id,
      customerId: attempt.customerId,
      serviceId: session.serviceId,
      sessionStartsAt: session.startsAt,
      now,
    });
    if (!eligible.some((item) => item.id === input.entitlementId))
      throw new DomainError(
        "PASS_UNAVAILABLE",
        "This Pass is unavailable for this class. Choose another Pass.",
        409,
      );
    const booking = await tx.booking.create({
      data: {
        shopId: shop.id,
        sessionId: session.id,
        customerId: attempt.customerId,
        ownedAttemptId: attempt.id,
      },
    });
    // The ledger service locks the entitlement and rechecks its latest balance.
    // Any failure rolls back the booking, status, audit and both notifications.
    await reserveEntitlementCredit(tx, {
      shopId: shop.id,
      entitlementId: input.entitlementId,
      customerId: attempt.customerId,
      serviceId: session.serviceId,
      sessionStartsAt: session.startsAt,
      now,
      reservationKey: randomUUID(),
      idempotencyKey: "owned-booking:" + attempt.id,
      bookingId: booking.id,
    });
    await tx.bookingAttempt.update({
      where: { id: attempt.id },
      data: { status: "CONFIRMED" },
    });
    await enqueueBookingNotifications(tx, shop.id, booking.id);
    await tx.auditLog.create({
      data: {
        shopId: shop.id,
        actorId: attempt.customerId,
        action: "OWNED_PASS_BOOKING_CONFIRMED",
        entityId: booking.id,
        after: { attemptId: attempt.id, entitlementId: input.entitlementId },
      },
    });
    return { status: booking.status, bookingReference: booking.id };
  });
}
