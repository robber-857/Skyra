import type { ActionFunctionArgs } from "react-router";
import { bookingJson, bookingRequest } from "../services/booking-proxy.server";
import { familyAccountData } from "../services/family-accounts.server";
import { unauthenticated } from "../shopify.server";
export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export function action({ request }: ActionFunctionArgs) {
  return bookingRequest(request, async (actor) => familyAccountData(actor, actor.customerGid ? (await unauthenticated.admin(actor.shopDomain!)).admin.graphql : undefined), 2048, false);
}
