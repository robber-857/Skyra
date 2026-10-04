import type { ActionFunctionArgs } from "react-router";
import { bookingJson, bookingRequest } from "../services/booking-proxy.server";
import { membershipPurchaseResult } from "../services/membership-checkout.server";
import { unauthenticated } from "../shopify.server";

export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export const action = ({ request }: ActionFunctionArgs) =>
  bookingRequest(request, (actor, input) =>
    membershipPurchaseResult(
      actor,
      input,
      async (domain) => (await unauthenticated.admin(domain)).admin.graphql,
    ),
  );
