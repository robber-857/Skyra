import { data, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { adminContext } from "../services/context.server";
import { previewBookingNotification } from "../services/booking-notifications.server";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  const id = z.string().uuid().parse(params.id);
  return data(await previewBookingNotification(actor.shopId, id), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function NotificationPreview() {
  const email = useLoaderData<typeof loader>();
  return (
    <main className="workspace">
      <h1>Email preview</h1>
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
