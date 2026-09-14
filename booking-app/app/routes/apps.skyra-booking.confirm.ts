import type { ActionFunctionArgs } from "react-router";
import { DomainError } from "../lib/errors.server";
import { bookingJson, bookingRequest } from "../services/booking-proxy.server";
import { commerceCapabilities } from "../services/commerce-capabilities.server";
import { confirmOwnedBooking } from "../services/owned-booking.server";
export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export function action({ request }: ActionFunctionArgs) {
  return bookingRequest(request, async (actor, input) => {
    if (!actor.customerGid)
      throw new DomainError(
        "LOGIN_REQUIRED",
        "Sign in to confirm your booking.",
        401,
      );
    if (!commerceCapabilities(actor.shopDomain).ownedPassesAvailable)
      throw new DomainError(
        "BOOKING_NOT_AVAILABLE",
        "Online booking is not available yet.",
        503,
      );
    return confirmOwnedBooking(actor, input);
  });
}
