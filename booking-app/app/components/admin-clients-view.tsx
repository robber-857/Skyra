import { useState, type ReactNode } from "react";
import { DateTime } from "luxon";
import { Form, Link, useNavigate, useNavigation } from "react-router";
import type {
  adminClients,
  adminClientDetail,
} from "../services/admin-clients.server";
import { Feedback } from "./admin-ui";
import { ClientSyncButton } from "./client-sync-button";

const date = (value: string, zone: string) =>
  DateTime.fromISO(value, { zone }).toFormat("d LLL yyyy");
const state = (value: string) => value.toLowerCase().replaceAll("_", " ");
export function AdminClientsView({
  data,
  warning,
  result,
}: {
  data: Awaited<ReturnType<typeof adminClients>>;
  warning: string | null;
  result?: { error?: string; message?: string; nextCursor?: string | null };
}) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const navigation = useNavigation(),
    busy = navigation.state !== "idle";
  const pageLink = (page: number) =>
    `/app/clients?${new URLSearchParams({ q: data.q, page: String(page) })}`;
  return (
    <main className="workspace clients-workspace">
      <header className="page-head">
        <div>
          <p className="page-kicker">Admin · Clients</p>
          <h1>Client Directory</h1>
          <p className="muted">
            Find a client and view their profile, Pass balances and bookings.
          </p>
        </div>
        <div className="catalog-page-controls">
          <button
            type="button"
            className="primary"
            disabled={busy}
            aria-expanded={adding}
            aria-controls="add-client"
            onClick={() => setAdding(!adding)}
          >
            Add client
          </button>
          <ClientSyncButton />
        </div>
      </header>
      <Feedback result={result} />
      {adding && (
        <section
          className="panel"
          id="add-client"
          aria-labelledby="add-client-title"
        >
          <h2 id="add-client-title">Add client</h2>
          <p className="muted">
            Enter the client’s name and email. If this email already exists in
            Shopify, their existing profile will be linked.
          </p>
          <Form method="post" className="form-grid">
            <input type="hidden" name="intent" value="create" />
            <label className="field">
              First name
              <input
                name="firstName"
                autoComplete="given-name"
                required
                maxLength={100}
              />
            </label>
            <label className="field">
              Last name (optional)
              <input
                name="lastName"
                autoComplete="family-name"
                maxLength={100}
              />
            </label>
            <label className="field">
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
              />
            </label>
            <div className="catalog-page-controls">
              <button className="primary" disabled={busy}>
                {busy && navigation.formData?.get("intent") === "create"
                  ? "Saving…"
                  : "Save client"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
            </div>
          </Form>
        </section>
      )}
      {warning && (
        <p className="feedback error" role="alert">
          {warning}
        </p>
      )}
      <Form method="get" className="clients-search">
        <label className="field">
          Search clients
          <input
            type="search"
            name="q"
            defaultValue={data.q}
            key={data.q}
            placeholder="Name, preferred name or email"
            maxLength={160}
          />
        </label>
        <button className="primary" disabled={busy}>
          Search
        </button>
        {data.q && (
          <Link className="button" to="/app/clients">
            Clear
          </Link>
        )}
      </Form>
      <section className="panel clients-list" aria-label="Clients">
        <div className="catalog-list-head">
          <h2>
            {data.total} {data.total === 1 ? "client" : "clients"}
          </h2>
          <p className="muted">Booking clients and synced Shopify customers</p>
        </div>
        {data.clients.length ? (
          <div className="clients-table-scroll">
            <table className="clients-table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Email</th>
                  <th scope="col">Active Passes</th>
                  <th scope="col">Classes left</th>
                  <th scope="col">Next expiry</th>
                  <th scope="col">Bookings</th>
                </tr>
              </thead>
              <tbody>
                {data.clients.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/app/clients/${c.id}`} className="client-name">
                        {c.name}
                      </Link>
                    </td>
                    <td>
                      {c.email ? (
                        <a href={`mailto:${c.email}`}>{c.email}</a>
                      ) : (
                        <span className="muted">Not available</span>
                      )}
                    </td>
                    <td>{c.activePasses}</td>
                    <td>{c.remaining}</td>
                    <td>
                      {c.nextExpiry ? date(c.nextExpiry, data.timezone) : "—"}
                    </td>
                    <td>{c.bookings}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">
            {data.q
              ? "No clients match this search."
              : "No clients yet. Add a client or sync existing Shopify customers."}
          </p>
        )}
      </section>
      <nav className="catalog-pagination" aria-label="Client pages">
        <span className="muted">10 clients per page</span>
        <div className="catalog-page-controls">
          <button
            type="button"
            disabled={busy || data.page === 1}
            onClick={() => navigate(pageLink(data.page - 1))}
          >
            Previous
          </button>
          <span className="catalog-page-count" role="status" aria-live="polite">
            <span className="visually-hidden">Page </span>
            {data.page} / {data.pages}
          </span>
          <button
            type="button"
            disabled={busy || data.page === data.pages}
            onClick={() => navigate(pageLink(data.page + 1))}
          >
            Next
          </button>
        </div>
        <Form method="get" action="/app/clients" className="catalog-page-jump">
          <input type="hidden" name="q" value={data.q} />
          <label htmlFor="client-page">Go to page</label>
          <input
            key={`${data.q}:${data.page}:${data.pages}`}
            id="client-page"
            name="page"
            type="number"
            inputMode="numeric"
            min={1}
            max={data.pages}
            step={1}
            required
            defaultValue={data.page}
          />
          <button type="submit" disabled={busy}>
            Go
          </button>
        </Form>
      </nav>
      <p className="muted">
        Classes left includes available and reserved credits on active, valid
        Passes. Expired and fully used Passes appear in each client’s profile.
      </p>
    </main>
  );
}
export function AdminClientDetailView({
  data,
  warning,
  creditForm,
  passAdjustmentForm,
}: {
  data: Awaited<ReturnType<typeof adminClientDetail>>;
  warning: string | null;
  creditForm?: ReactNode;
  passAdjustmentForm?: (
    pass: Awaited<ReturnType<typeof adminClientDetail>>["passes"][number],
  ) => ReactNode;
}) {
  const c = data.client;
  const navigate = useNavigate(),
    navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <main className="workspace clients-workspace">
      <Link to="/app/clients" className="client-back">
        ← Client Directory
      </Link>
      <header className="page-head client-profile-head">
        <div className="client-identity">
          {c.avatarDataUrl ? (
            <img
              className="client-avatar"
              src={c.avatarDataUrl}
              alt={`${c.name} profile`}
            />
          ) : (
            <span className="client-avatar client-initial" aria-hidden="true">
              {c.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <p className="page-kicker">Admin · Client profile</p>
            <h1>{c.name}</h1>
            {c.email ? (
              <a href={`mailto:${c.email}`}>{c.email}</a>
            ) : (
              <p className="muted">Email not available</p>
            )}
          </div>
        </div>
        <Link className="button" to={`/app/reports?customer=${c.id}`}>
          View spending report
        </Link>
      </header>
      {warning && (
        <p className="feedback error" role="alert">
          {warning}
        </p>
      )}
      <section className="panel" aria-labelledby="client-profile-title">
        <h2 id="client-profile-title">Profile</h2>
        <dl className="client-profile-fields">
          <div>
            <dt>Shopify name</dt>
            <dd>{c.shopifyName || "Not provided"}</dd>
          </div>
          <div>
            <dt>Preferred name</dt>
            <dd>{c.preferredName || "Not provided"}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{c.email || "Not available"}</dd>
          </div>
          <div>
            <dt>Added to Booking</dt>
            <dd>{date(c.joinedAt, data.timezone)}</dd>
          </div>
          <div>
            <dt>About me</dt>
            <dd>{c.signature || "Not provided"}</dd>
          </div>
          <div>
            <dt>Training goals</dt>
            <dd>{c.trainingGoals || "Not provided"}</dd>
          </div>
        </dl>
        {c.syncedAt && (
          <p className="muted">
            Shopify details last synced {date(c.syncedAt, data.timezone)}.
          </p>
        )}
      </section>
      {creditForm}
      <section className="panel" aria-labelledby="client-passes-title">
        <div className="report-block-head">
          <h2 id="client-passes-title">Passes &amp; class credits</h2>
          <span className="muted">{data.total} total</span>
        </div>
        {!data.passes.length && (
          <p className="empty">
            This client has no recorded Passes or class credits.
          </p>
        )}
        <div className="client-pass-list">
          {data.passes.map((p) => (
            <article className="client-pass" key={p.id}>
              <div className="report-block-head">
                <h3>{p.name}</h3>
                <span
                  className={`status client-pass-status ${p.status === "ACTIVE" ? "active" : ""}`}
                >
                  {state(p.status)}
                </span>
              </div>
              {p.sourceSystem === "MANUAL_CASH" && (
                <p className="muted">
                  Cash payment{p.cashAmount ? " · A$" + p.cashAmount : ""}
                  {p.cashReason ? " · " + p.cashReason : ""}
                </p>
              )}
              <div className="summary client-pass-summary">
                <div>
                  <strong>{p.remaining}</strong>
                  <span>Classes remaining</span>
                  <small>Originally granted: {p.granted}</small>
                </div>
                <div>
                  <strong>{p.available}</strong>
                  <span>Available</span>
                </div>
                <div>
                  <strong>{p.reserved}</strong>
                  <span>Reserved</span>
                </div>
                <div>
                  <strong>{p.used}</strong>
                  <span>Used</span>
                </div>
              </div>
              <dl className="client-pass-dates">
                <div>
                  <dt>Valid from</dt>
                  <dd>
                    {p.startsAt
                      ? date(p.startsAt, data.timezone)
                      : "First booked class"}
                  </dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>
                    {p.expiresAt
                      ? date(p.expiresAt, data.timezone)
                      : "Not activated"}
                  </dd>
                </div>
                <div>
                  <dt>Validity</dt>
                  <dd>
                    {p.validityMonths
                      ? `${p.validityMonths} calendar months`
                      : `${p.validityDays ?? "—"} days`}
                  </dd>
                </div>
                <div>
                  <dt>Time remaining</dt>
                  <dd>
                    {p.status === "ACTIVE"
                      ? `${p.daysLeft} days`
                      : p.status === "UPCOMING"
                        ? "Starts in the future"
                        : p.status === "UNACTIVATED"
                          ? "Starts with first booked class"
                          : p.status === "EXPIRED"
                            ? "Expired"
                            : "Not usable"}
                  </dd>
                </div>
              </dl>
              {p.status === "EXPIRED" && p.remaining > 0 && (
                <p className="muted">
                  Unused credits remain on this expired Pass and cannot be
                  booked.
                </p>
              )}
              {passAdjustmentForm?.(p)}
            </article>
          ))}
        </div>
        <nav className="catalog-pagination" aria-label="Pass pages">
          <span className="muted">5 Passes or class credits per page</span>
          <div className="catalog-page-controls">
            <button
              type="button"
              disabled={busy || data.page === 1}
              onClick={() => navigate(`?passPage=${data.page - 1}`)}
            >
              Previous
            </button>
            <span
              className="catalog-page-count"
              role="status"
              aria-live="polite"
            >
              <span className="visually-hidden">Page </span>
              {data.page} / {data.pages}
            </span>
            <button
              type="button"
              disabled={busy || data.page === data.pages}
              onClick={() => navigate(`?passPage=${data.page + 1}`)}
            >
              Next
            </button>
          </div>
          <Form method="get" className="catalog-page-jump">
            <label htmlFor="client-pass-page">Go to page</label>
            <input
              key={`${data.page}:${data.pages}`}
              id="client-pass-page"
              name="passPage"
              type="number"
              inputMode="numeric"
              min={1}
              max={data.pages}
              step={1}
              required
              defaultValue={data.page}
            />
            <button type="submit" disabled={busy}>
              Go
            </button>
          </Form>
        </nav>
        <p className="muted">
          Balances come from recorded credit transactions. Reserved credits are
          allocated to bookings.
        </p>
      </section>
      <section className="panel" aria-labelledby="client-bookings-title">
        <h2 id="client-bookings-title">Recent bookings</h2>
        {!data.bookings.length && (
          <p className="empty">No bookings recorded for this client.</p>
        )}
        {data.bookings.map((b) => (
          <article className="record" key={b.id}>
            <div>
              <h3>{b.className}</h3>
              <p className="muted">
                {DateTime.fromISO(b.startsAt, { zone: b.timezone }).toFormat(
                  "d LLL yyyy, h:mm a",
                )}{" "}
                · {b.coachName}
              </p>
              {b.comment && <p className="client-note">{b.comment}</p>}
            </div>
            <span className="status">
              {b.checkedIn ? "checked in" : state(b.status)}
            </span>
          </article>
        ))}
        {data.bookingCount > 10 && (
          <p className="muted">
            Showing the 10 most recent of {data.bookingCount} bookings.
          </p>
        )}
      </section>
    </main>
  );
}
