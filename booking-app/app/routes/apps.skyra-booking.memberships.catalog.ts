import type { ActionFunctionArgs } from "react-router";
import { bookingJson, bookingRequest } from "../services/booking-proxy.server";
import { membershipCatalog } from "../services/membership-catalog.server";

export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export const action = ({ request }: ActionFunctionArgs) =>
  bookingRequest(request, membershipCatalog);
