import { z } from "zod";
import type { ActionFunctionArgs } from "react-router";
import { bookingJson, bookingRequest } from "../services/booking-proxy.server";
import { cancelPassMembership } from "../services/membership-lifecycle.server";

export const loader = () => bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
export const action = ({ request }: ActionFunctionArgs) =>
  bookingRequest(request, (actor, raw) => {
    const { membershipId } = z
      .object({ membershipId: z.string().uuid() })
      .strict()
      .parse(raw);
    return cancelPassMembership(actor, membershipId);
  });
