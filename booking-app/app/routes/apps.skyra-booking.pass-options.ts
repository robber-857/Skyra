import type { ActionFunctionArgs } from "react-router";
import { bookingPurchaseReview } from "../services/booking-purchase-review.server";
import { authenticatedStorefrontClient } from "../services/storefront-access.server";
import { unauthenticated } from "../shopify.server";
import { bookingRequest, bookingJson } from "../services/booking-proxy.server";
export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export function action({ request }: ActionFunctionArgs) {
  return bookingRequest(request, (actor, input) =>
    bookingPurchaseReview(actor, input, async (domain) => ({
      admin: (await unauthenticated.admin(domain)).admin.graphql,
      storefront: authenticatedStorefrontClient(
        domain,
        unauthenticated.storefront,
      ),
    })),
  );
}
