import { DateTime } from "luxon";
import { Form, Link, useNavigation } from "react-router";
import type {
  adminClients,
  adminClientDetail,
} from "../services/admin-clients.server";
import { Feedback } from "./admin-ui";

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
        <Form method="post">
          <input type="hidden" name="after" value={result?.nextCursor || ""} />
          <button disabled={busy}>
            {busy
              ? "Syncing…"
              : result?.nextCursor
                ? "Sync next 100 clients"
                : "Sync Shopify clients"}
          </button>
        </Form>
      </header>
      <Feedback result={result} />
      {result?.nextCursor && (
        <p className="muted">
          More Shopify clients are available. Continue syncing to include them
          in this directory.
        </p>
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
              : "No clients yet. Sync Shopify clients to add existing customers."}
          </p>
        )}
      </section>
      <nav className="catalog-pagination" aria-label="Client pages">
        <span className="muted">
          Page {data.page} of {data.pages}
        </span>
        <div className="catalog-page-controls">
          {data.page > 1 && (
            <Link className="button" to={pageLink(data.page - 1)}>
              Previous
            </Link>
          )}
          {data.page < data.pages && (
            <Link className="button" to={pageLink(data.page + 1)}>
              Next
            </Link>
          )}
        </div>
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
}: {
  data: Awaited<ReturnType<typeof adminClientDetail>>;
  warning: string | null;
}) {
  const c = data.client;
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
              <div className="summary client-pass-summary">
                <div>
                  <strong>
                    {p.remaining}
                    <small> / {p.granted}</small>
                  </strong>
                  <span>Classes remaining</span>
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
                  <dd>{date(p.startsAt, data.timezone)}</dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>{date(p.expiresAt, data.timezone)}</dd>
                </div>
                <div>
                  <dt>Validity</dt>
                  <dd>{p.validityDays} days</dd>
                </div>
                <div>
                  <dt>Time remaining</dt>
                  <dd>
                    {p.status === "ACTIVE"
                      ? `${p.daysLeft} days`
                      : p.status === "UPCOMING"
                        ? "Starts in the future"
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
            </article>
          ))}
        </div>
        {data.pages > 1 && (
          <nav className="catalog-pagination" aria-label="Pass pages">
            <span className="muted">
              Page {data.page} of {data.pages}
            </span>
            <div className="catalog-page-controls">
              {data.page > 1 && (
                <Link className="button" to={`?passPage=${data.page - 1}`}>
                  Previous Passes
                </Link>
              )}
              {data.page < data.pages && (
                <Link className="button" to={`?passPage=${data.page + 1}`}>
                  Next Passes
                </Link>
              )}
            </div>
          </nav>
        )}
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
