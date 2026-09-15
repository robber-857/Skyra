import type { ActionFunctionArgs } from "react-router";
import { DomainError } from "../lib/errors.server";
import { bookingJson, bookingRequest } from "../services/booking-proxy.server";
import { commerceCapabilities } from "../services/commerce-capabilities.server";
import { prepareBookingCheckout } from "../services/booking-checkout.server";
import {
  authenticatedStorefrontClient,
  STOREFRONT_CHECKOUT_SCOPE,
  STOREFRONT_PRODUCT_SCOPE,
} from "../services/storefront-access.server";
import { unauthenticated } from "../shopify.server";

export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export function action({ request }: ActionFunctionArgs) {
  return bookingRequest(request, async (actor, input) => {
    if (!actor.customerGid)
      throw new DomainError(
        "LOGIN_REQUIRED",
        "Sign in with Shopify before checkout.",
        401,
      );
    if (!commerceCapabilities(actor.shopDomain).checkoutAvailable)
      throw new DomainError(
        "CHECKOUT_NOT_AVAILABLE",
        "Checkout is not available yet.",
        503,
      );
    return prepareBookingCheckout(actor, input, async (domain) => ({
      admin: (await unauthenticated.admin(domain)).admin.graphql,
      storefront: authenticatedStorefrontClient(
        domain,
        unauthenticated.storefront,
        [STOREFRONT_PRODUCT_SCOPE, STOREFRONT_CHECKOUT_SCOPE],
      ),
    }));
  });
}
