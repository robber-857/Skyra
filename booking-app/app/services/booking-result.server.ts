import { z } from "zod";
import { DomainError } from "../lib/errors.server";
import { withAttempt, type BookingActor } from "./booking.server";
const resultInput = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
// Authenticated read-only status; return URLs and browser flags never prove payment.
export async function bookingResult(actor: BookingActor, raw: unknown) {
  const { token } = resultInput.parse(raw);
  return withAttempt(actor, token, async (tx, attempt, shop, now) => {
    if (!actor.customerGid || !attempt.customerId)
      throw new DomainError(
        "LOGIN_REQUIRED",
        "Sign in to check your booking.",
        401,
      );
    const owned = await tx.booking.findUnique({
      where: { ownedAttemptId: attempt.id },
    });
    if (owned) return { status: owned.status, bookingReference: owned.id };
    const hold =
      (await tx.bookingHold.findFirst({
        where: {
          shopId: shop.id,
          sessionId: attempt.sessionId,
          customerId: attempt.customerId,
          status: "ACTIVE",
          expiresAt: { gt: now },
        },
        include: { checkout: true },
      })) ||
      (await tx.bookingHold.findUnique({
        where: { attemptId: attempt.id },
        include: { checkout: true },
      }));
    if (!hold?.checkout)
      return { status: "NOT_CONFIRMED", bookingReference: null };
    const checkout = hold.checkout;
    const paid = await tx.paidBookingResult.findUnique({
      where: { checkoutId: checkout.id },
    });
    if (paid) {
      if (paid.status === "CONFIRMED" && paid.bookingId) {
        const booking = await tx.booking.findFirstOrThrow({
          where: {
            shopId: shop.id,
            id: paid.bookingId,
            customerId: attempt.customerId,
          },
        });
        return { status: booking.status, bookingReference: booking.id };
      }
      return { status: "NEEDS_ATTENTION", bookingReference: null };
    }
    const received = await tx.outboxEvent.findFirst({
      where: {
        shopId: shop.id,
        kind: "ORDER_PAID_RECEIVED",
        payload: { path: ["checkoutId"], equals: checkout.id },
      },
      orderBy: { createdAt: "desc" },
    });
    if (received)
      return {
        status: received.status === "FAILED" ? "NEEDS_ATTENTION" : "PROCESSING",
        bookingReference: null,
      };
    const review = await tx.outboxEvent.findFirst({
      where: {
        shopId: shop.id,
        kind: "ORDER_PAID_REVIEW",
        payload: { path: ["checkoutId"], equals: checkout.id },
      },
    });
    return {
      status:
        review || checkout.status !== "READY"
          ? "NEEDS_ATTENTION"
          : hold.status !== "ACTIVE" || hold.expiresAt <= now
            ? "PAYMENT_WINDOW_ENDED"
            : "AWAITING_PAYMENT",
      bookingReference: null,
      resumeAvailable:
        !review &&
        checkout.status === "READY" &&
        Boolean(checkout.cartId) &&
        checkout.handoffMode === "STOREFRONT_API" &&
        hold.status === "ACTIVE" &&
        hold.expiresAt > now,
      holdExpiresAt: hold.expiresAt.toISOString(),
    };
  });
}
