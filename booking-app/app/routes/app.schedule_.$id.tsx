import {
  useLoaderData,
  useActionData,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import { DateTime } from "luxon";
import { adminContext } from "../services/context.server";
import { adminSessionDetail } from "../services/admin-session.server";
import { DomainError, publicError } from "../lib/errors.server";
import { backfillSessionTimeChange } from "../services/session-change-notifications.server";
import { refreshMailDeliveryStatus } from "../services/mail-delivery-status.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const { actor } = await adminContext(request);
  const form = await request.formData();
  try {
    const session = await adminSessionDetail(actor, params.id);
    if (form.get("intent") === "backfill-time-change") {
      const count = await backfillSessionTimeChange(
        actor,
        session.id,
        String(form.get("auditId")),
      );
      return { message: `${count} student time-change email(s) queued.` };
    }
    if (form.get("intent") === "refresh-delivery") {
      const id = String(form.get("notificationId"));
      if (
        !session.bookings.some((b) => b.notifications.some((n) => n.id === id))
      )
        throw new DomainError("NOT_FOUND", "Notification not found.", 404);
      await refreshMailDeliveryStatus(actor, id);
      return {
        message:
          "Delivery status checked. See the email record for the result.",
      };
    }
    return { error: "Unknown action." };
  } catch (error) {
    return publicError(error);
  }
}
import { AdminSessionDetailView } from "../components/admin-session-detail";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  try {
    const session = await adminSessionDetail(actor, params.id);
    const week = DateTime.fromJSDate(session.startsAt, { zone: shop.timezone })
      .startOf("week")
      .toISODate()!;
    return { session, week };
  } catch (error) {
    if (error instanceof DomainError)
      throw new Response(error.message, { status: error.status });
    throw error;
  }
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function SessionDetail() {
  const result = useActionData<typeof action>();
  return (
    <AdminSessionDetailView
      {...useLoaderData<typeof loader>()}
      feedback={result}
    />
  );
}
