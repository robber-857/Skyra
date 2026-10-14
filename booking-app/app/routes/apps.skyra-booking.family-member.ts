import type { ActionFunctionArgs } from "react-router";
import { bookingJson, bookingRequest } from "../services/booking-proxy.server";
import { addCustomerFamilyMember } from "../services/family-accounts.server";
import { unauthenticated } from "../shopify.server";
import { DomainError } from "../lib/errors.server";
export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export function action({ request }: ActionFunctionArgs) {
  return bookingRequest(request, async (actor, input) => {
    if (!actor.customerGid) throw new DomainError("LOGIN_REQUIRED", "Sign in to add a family member.", 401);
    return addCustomerFamilyMember(actor, (await unauthenticated.admin(actor.shopDomain!)).admin.graphql, input);
  }, 2048, false);
}
