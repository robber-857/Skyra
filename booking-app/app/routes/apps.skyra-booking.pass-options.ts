import type { ActionFunctionArgs } from "react-router";
import { bookingPassOptions } from "../services/booking.server";
import { bookingRequest, bookingJson } from "../services/booking-proxy.server";
export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export function action({ request }: ActionFunctionArgs) {
  return bookingRequest(request, bookingPassOptions);
}
