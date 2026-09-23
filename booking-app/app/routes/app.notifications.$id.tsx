import {
  data,
  Link,
  useLoaderData,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";
import { adminContext } from "../services/context.server";
import { previewBookingNotification } from "../services/booking-notifications.server";
import { DomainError } from "../lib/errors.server";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  const headers = { "Cache-Control": "private, no-store" };
  const id = z.string().uuid().safeParse(params.id);
  if (!id.success)
    return data(
      { email: null, error: "Email notification not found." },
      { status: 404, headers },
    );
  try {
    return data(
      {
        email: await previewBookingNotification(actor.shopId, id.data),
        error: null,
      },
      { headers },
    );
  } catch (error) {
    if (error instanceof DomainError)
      return data(
        { email: null, error: error.message },
        { status: error.status, headers },
      );
    throw error;
  }
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function NotificationPreview() {
  const { email, error } = useLoaderData<typeof loader>();
  if (!email)
    return (
      <main className="workspace">
        <h1>Email preview unavailable</h1>
        <p role="alert">{error}</p>
        <Link to="/app/bookings">Back to bookings</Link>
      </main>
    );
  return (
    <main className="workspace">
      <h1>Email preview</h1>
      <p>
        This preview uses current booking details, not a saved copy of the sent
        email. Opening it does not send or resend an email. Past classes and
        changed bookings can still be previewed.
      </p>
      <Link to="/app/bookings">Back to bookings</Link>
      <p>{email.subject}</p>
      <iframe
        title="Booking email preview"
        srcDoc={email.html}
        sandbox=""
        style={{ border: 0, width: "100%", minHeight: 720 }}
      />
      <details>
        <summary>Plain text version</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{email.text}</pre>
      </details>
    </main>
  );
}
