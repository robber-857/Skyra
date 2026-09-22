import { z } from "zod";
import { DomainError } from "../lib/errors.server";
import { withAttempt, type BookingActor } from "./booking.server";
import { bookingResult } from "./booking-result.server";
import { assertBookingCart, readBookingCart } from "./shopify-cart.server";
import type { GraphQL } from "./shopify-catalog.server";
const input = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();

// Resume the same cart across page reloads or replacement attempts. Never create
// a cart, rotate an attempt token, extend a hold, or infer successful payment.
export async function resumeBookingCheckout(
  actor: BookingActor,
  raw: unknown,
  storefront: GraphQL,
) {
  const data = input.parse(raw);
  async function target() {
    const result = await bookingResult(actor, data);
    if (!("resumeAvailable" in result) || !result.resumeAvailable)
      throw new DomainError(
        "CHECKOUT_NOT_RESUMABLE",
        "This checkout cannot be resumed. Check your booking status before starting another payment.",
        409,
      );
    return withAttempt(actor, data.token, async (tx, attempt, shop, now) => {
      if (!actor.customerGid || !attempt.customerId)
        throw new DomainError(
          "LOGIN_REQUIRED",
          "Sign in to continue payment.",
          401,
        );
      const hold = await tx.bookingHold.findFirst({
        where: {
          shopId: shop.id,
          customerId: attempt.customerId,
          sessionId: attempt.sessionId,
          status: "ACTIVE",
          expiresAt: { gt: now },
        },
        include: { checkout: true },
      });
      if (
        !hold?.checkout?.cartId ||
        hold.checkout.status !== "READY" ||
        hold.checkout.handoffMode !== "STOREFRONT_API"
      )
        throw new DomainError(
          "CHECKOUT_NOT_RESUMABLE",
          "Your payment hold has ended. Check your booking status.",
          409,
        );
      return {
        checkout: hold.checkout,
        expiresAt: hold.expiresAt,
        domain: shop.domain,
      };
    });
  }
  const before = await target();
  const cart = await readBookingCart(storefront, before.checkout.cartId!);
  if (cart.id !== before.checkout.cartId)
    throw new DomainError(
      "CART_CHANGED",
      "This cart no longer matches your booking.",
      409,
    );
  const checkoutUrl = assertBookingCart(cart, before.checkout, before.domain);
  const after = await target();
  if (
    after.checkout.id !== before.checkout.id ||
    after.checkout.cartId !== before.checkout.cartId
  )
    throw new DomainError(
      "CART_CHANGED",
      "Your checkout changed. Check your booking status.",
      409,
    );
  return {
    status: "CHECKOUT_READY",
    checkoutUrl,
    holdExpiresAt: after.expiresAt.toISOString(),
  };
}
