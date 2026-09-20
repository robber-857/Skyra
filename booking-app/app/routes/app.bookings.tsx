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
  const params = new URL(request.url).searchParams;
  return bookingOperationsData(actor, Number(params.get("bookingPage") || 1), {
    notificationPage: Number(params.get("notificationPage") || 1),
    notificationKind: params.get("notificationKind") || "ALL",
  });
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function Bookings() {
  const data = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { page, pageSize, totalCount, totalPages } = data.pagination;
  const email = data.notificationPagination;
  function changeNotifications(value: number, kind = email.kind) {
    const params = new URLSearchParams(searchParams);
    params.set("notificationPage", String(value));
    params.set("notificationKind", kind);
    setSearchParams(params, { preventScrollReset: true });
  }
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
      <section className="panel record-list" aria-label="Booking emails">
        <div className="catalog-list-head notification-head">
          <h2>Booking emails</h2>
          <label className="notification-filter" htmlFor="notification-kind">
            Notification category
            <select
              id="notification-kind"
              value={email.kind}
              onChange={(event) => changeNotifications(1, event.target.value)}
            >
              <option value="ALL">All notifications</option>
              <option value="ADMIN">Admin notifications</option>
              <option value="COACH">Coach notifications</option>
              <option value="CUSTOMER">Customer emails</option>
            </select>
          </label>
        </div>
        <p className="muted" role="status" aria-live="polite">
          {email.totalCount
            ? `${(email.page - 1) * email.pageSize + 1}–${Math.min(email.page * email.pageSize, email.totalCount)} of ${email.totalCount}`
            : "0 notifications"}{" "}
          · 8 per page
        </p>
        <p className="muted">
          Booking confirmation, reminder and cancellation emails. Each row is
          one notification; retries update its attempt count. Preview email
          generates current content and does not send it or confirm inbox
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
            Statuses update automatically. Live mail needs enabled server mail
            configuration and recipient addresses in{" "}
            <Link to="/app/settings">Settings</Link> and{" "}
            <Link to="/app/people">People</Link>. Customer email also requires
            Shopify customer-data access and a current app authorization.
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
                      : item.template === "BOOKING_REMINDER_V1"
                        ? "Customer reminder"
                        : "Customer confirmation"}
                </h3>
                <p className="muted">
                  {item.template === "BOOKING_CANCELLED_V1"
                    ? "Cancellation"
                    : item.template === "BOOKING_REMINDER_V1"
                      ? "12-hour reminder · Scheduled for"
                      : "Confirmation · Created"}{" "}
                  {new Date(
                    item.template === "BOOKING_REMINDER_V1"
                      ? item.availableAt
                      : item.createdAt,
                  ).toLocaleString()}
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
            {email.kind === "ALL"
              ? "Notifications appear after a booking is confirmed."
              : "No notifications in this category."}
          </p>
        )}
      </section>
      {email.totalCount > 0 && (
        <nav
          className="catalog-pagination"
          aria-label="Booking emails pagination"
        >
          <div className="catalog-page-controls">
            <button
              type="button"
              disabled={email.page === 1}
              onClick={() => changeNotifications(email.page - 1)}
            >
              Previous
            </button>
            <span
              className="catalog-page-count"
              role="status"
              aria-live="polite"
            >
              <span className="visually-hidden">Page </span>
              {email.page} / {email.totalPages}
            </span>
            <button
              type="button"
              disabled={email.page === email.totalPages}
              onClick={() => changeNotifications(email.page + 1)}
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
                target <= email.totalPages
              )
                changeNotifications(target);
            }}
          >
            <label htmlFor="notification-page">Go to page</label>
            <input
              key={`${email.page}:${email.totalPages}`}
              id="notification-page"
              name="page"
              type="number"
              inputMode="numeric"
              min={1}
              max={email.totalPages}
              step={1}
              required
              defaultValue={email.page}
            />
            <button type="submit">Go</button>
          </form>
        </nav>
      )}
    </main>
  );
}
