import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { resumeAttempt } from "../services/booking.server";
import { bookingRequest, bookingJson } from "../services/booking-proxy.server";
export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export function action({ request }: ActionFunctionArgs) {
  return bookingRequest(request, (actor, raw) => {
    const { token } = z
      .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(raw);
    return resumeAttempt(actor, token);
  });
}
