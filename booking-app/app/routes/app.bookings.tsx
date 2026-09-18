import {
  Link,
  useLoaderData,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import { DateTime } from "luxon";
import { adminContext } from "../services/context.server";
import { bookingOperationsData } from "../services/booking-operations.server";
import { Status } from "../components/admin-ui";
export async function loader({ request }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  return bookingOperationsData(
    actor,
    Number(new URL(request.url).searchParams.get("bookingPage") || 1),
  );
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function Bookings() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { page, pageSize, totalCount, totalPages } = data.pagination;
  function changePage(value: number) {
    const params = new URLSearchParams(searchParams);
    params.set("bookingPage", String(value));
    setSearchParams(params);
  }
  return (
    <main className="workspace bookings-workspace">
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
      <section
        className="panel record-list catalog-list"
        aria-label="Recent bookings"
      >
        <div className="catalog-list-head">
          <h2>Recent bookings</h2>
          <p className="muted" role="status" aria-live="polite">
            {totalCount
              ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, totalCount)} of ${totalCount}`
              : "0 bookings"}{" "}
            · 8 per page
          </p>
        </div>
        {data.bookings.length ? (
          data.bookings.map((item) => (
            <article className="record booking-record" key={item.id}>
              <div>
                <h3>{item.session.service.name}</h3>
                <p>
                  {DateTime.fromJSDate(new Date(item.session.startsAt), {
                    zone: item.session.timezone,
                  }).toFormat("d LLL yyyy · h:mm a")}
                </p>
                <p className="muted">{item.id}</p>
                <Link to={`/app/bookings/${item.id}`}>Manage booking</Link>
              </div>
              <Status>{item.status}</Status>
            </article>
          ))
        ) : (
          <p className="muted empty">No bookings yet.</p>
        )}
      </section>
      {totalCount > 0 && (
        <nav
          className="catalog-pagination"
          aria-label="Recent bookings pagination"
        >
          <div className="catalog-page-controls">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => changePage(page - 1)}
            >
              Previous
            </button>
            <span
              className="catalog-page-count"
              role="status"
              aria-live="polite"
            >
              <span className="visually-hidden">Page </span>
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page === totalPages}
              onClick={() => changePage(page + 1)}
            >
              Next
            </button>
          </div>
          <form
            className="catalog-page-jump"
            onSubmit={(event) => {
              event.preventDefault();
              const target = Number(
                new FormData(event.currentTarget).get("page"),
              );
              if (
                Number.isInteger(target) &&
                target >= 1 &&
                target <= totalPages
              )
                changePage(target);
            }}
          >
            <label htmlFor="booking-page">Go to page</label>
            <input
              key={`${page}:${totalPages}`}
              id="booking-page"
              name="page"
              type="number"
              inputMode="numeric"
              min={1}
              max={totalPages}
              step={1}
              required
              defaultValue={page}
            />
            <button type="submit">Go</button>
          </form>
        </nav>
      )}
      <section className="panel">
        <h2>Booking emails</h2>
        <p className="muted">
          Latest 50 booking confirmation and cancellation notifications. Each
          row is one notification; retries update its attempt count. Preview
          email generates current content and does not send it or confirm inbox
          delivery.
        </p>
        <details className="booking-email-help">
          <summary>What do email statuses mean?</summary>
          <p className="muted">
            PENDING: queued; 0 attempts means sending has not been tried.
            SENDING: being sent. ACCEPTED: accepted by the mail provider, with
            inbox delivery unconfirmed. FAILED: rejected. UNKNOWN: sending
            outcome needs review. SUPPRESSED: obsolete notification will not be
            sent.
          </p>
          <p className="muted">
            Statuses update automatically. Admin and Coach mail needs enabled
            server mail configuration and recipient addresses in{" "}
            <Link to="/app/settings">Settings</Link> and{" "}
            <Link to="/app/people">People</Link>. Customer live mail is not
            connected yet.
          </p>
        </details>
        {data.notifications.length ? (
          data.notifications.map((item) => (
            <article className="record" key={item.id}>
              <div>
                <h3>
                  {item.recipientKind === "COACH"
                    ? "Coach notification"
                    : item.recipientKind === "ADMIN"
                      ? "Admin notification"
                      : "Customer confirmation"}
                </h3>
                <p className="muted">
                  {item.template === "BOOKING_CANCELLED_V1"
                    ? "Cancellation"
                    : "Confirmation"}{" "}
                  · {new Date(item.createdAt).toLocaleString()}
                </p>
                <p className="muted">
                  Booking{" "}
                  <Link to={`/app/bookings/${item.bookingId}`}>
                    {item.bookingId}
                  </Link>
                </p>
                <p className="muted">
                  {item.status} · {item.attempts} attempt(s)
                  {item.lastError ? ` · ${item.lastError}` : ""}
                </p>
              </div>
              {item.status === "SUPPRESSED" ? (
                <span className="muted">Preview unavailable</span>
              ) : (
                <Link to={`/app/notifications/${item.id}`}>Preview email</Link>
              )}
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
