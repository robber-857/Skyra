import type { ActionFunctionArgs } from "react-router";
import { bookingJson, bookingRequest } from "../services/booking-proxy.server";
import { prepareMembershipCheckout } from "../services/membership-checkout.server";
import {
  authenticatedStorefrontClient,
  STOREFRONT_CHECKOUT_SCOPE,
  STOREFRONT_PRODUCT_SCOPE,
  STOREFRONT_SELLING_PLAN_SCOPE,
} from "../services/storefront-access.server";
import { unauthenticated } from "../shopify.server";

export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export const action = ({ request }: ActionFunctionArgs) =>
  bookingRequest(request, (actor, input) =>
    prepareMembershipCheckout(actor, input, async (domain) => ({
      admin: (await unauthenticated.admin(domain)).admin.graphql,
      storefront: authenticatedStorefrontClient(
        domain,
        unauthenticated.storefront,
        [
          STOREFRONT_PRODUCT_SCOPE,
          STOREFRONT_CHECKOUT_SCOPE,
          STOREFRONT_SELLING_PLAN_SCOPE,
        ],
      ),
    })),
  );
