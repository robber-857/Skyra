import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { DateTime } from "luxon";
import { adminContext } from "../services/context.server";
import { bookingOperationsData } from "../services/booking-operations.server";
import { Status } from "../components/admin-ui";
export async function loader({ request }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  return bookingOperationsData(actor);
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function Bookings() {
  const data = useLoaderData<typeof loader>();
  return (
    <main className="workspace">
      <h1>Bookings</h1>
      <section className="panel">
        <h2>Needs attention</h2>
        <p className="muted">
          Review payment exceptions before taking action. Reconciliation and
          refunds are not available here yet.
        </p>
        {data.attention.length ? (
          data.attention.map((item) => (
            <article className="record" key={item.id}>
              <div>
                <h3>{item.status}</h3>
                <p>{item.codes.join(" · ") || "Payment review required"}</p>
                <p className="muted">Receipt {item.id}</p>
              </div>
            </article>
          ))
        ) : (
          <p className="muted">No payment exceptions to review.</p>
        )}
      </section>
      <section className="panel">
        <h2>Recent bookings</h2>
        {data.bookings.length ? (
          data.bookings.map((item) => (
            <article className="record" key={item.id}>
              <div>
                <h3>{item.session.service.name}</h3>
                <p>
                  {DateTime.fromJSDate(new Date(item.session.startsAt), {
                    zone: item.session.timezone,
                  }).toFormat("d LLL yyyy · h:mm a")}
                </p>
                <p className="muted">{item.id}</p>
              </div>
              <Status>{item.status}</Status>
            </article>
          ))
        ) : (
          <p className="muted">No bookings yet.</p>
        )}
      </section>
      <section className="panel">
        <h2>Booking emails</h2>
        <p className="muted">
          Provider acceptance does not confirm inbox delivery. Live sending
          requires a configured mail provider and verified recipients.
        </p>
        {data.notifications.length ? (
          data.notifications.map((item) => (
            <article className="record" key={item.id}>
              <div>
                <h3>
                  {item.recipientKind === "COACH"
                    ? "Coach notification"
                    : "Customer confirmation"}
                </h3>
                <p className="muted">
                  {item.status} · {item.attempts} attempt(s)
                  {item.lastError ? ` · ${item.lastError}` : ""}
                </p>
              </div>
              <Link to={`/app/notifications/${item.id}`}>Preview email</Link>
            </article>
          ))
        ) : (
          <p className="muted">
            Notifications appear after a booking is confirmed.
          </p>
        )}
      </section>
    </main>
  );
}
