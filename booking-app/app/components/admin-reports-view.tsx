import { DateTime } from "luxon";
import { Form, Link } from "react-router";
import type { bookingReports } from "../services/booking-reports.server";

type ReportData = Awaited<ReturnType<typeof bookingReports>>;
const money = (cents: number) =>
  `A$${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(cents / 100)}`;

export function AdminReportsView({
  data,
  error,
}: {
  data: ReportData | null;
  error: string | null;
}) {
  const query = new URLSearchParams();
  if (data) {
    query.set("range", data.range.range);
    query.set("from", data.range.from);
    query.set("to", data.range.to);
    if (data.range.customerId) query.set("customer", data.range.customerId);
  }
  const exportLink = (type: "spending" | "unused" | "both") => {
    const params = new URLSearchParams(query);
    params.set("type", type);
    return `/app/reports/export?${params}`;
  };
  const date = (value: string) =>
    DateTime.fromISO(value, {
      zone: data?.range.timezone || "Australia/Sydney",
    }).toFormat("d LLL yyyy");
  return (
    <main className="workspace reports-workspace">
      <header className="page-head reports-head">
        <div>
          <p className="page-kicker">Admin · Exports</p>
          <h1>Reports</h1>
          <p className="muted">
            Two direct reports for the questions the studio needs to answer: who
            spent what, and who bought a Pass but still has classes left.
          </p>
        </div>
      </header>
      <Form method="get" className="reports-toolbar">
        <input type="hidden" name="range" value="custom" />
        <details className="report-date-picker">
          <summary className="button">
            {data
              ? `${date(data.range.from)} – ${date(data.range.to)}`
              : "Choose dates"}
          </summary>
          <div className="report-date-fields">
            <label className="field">
              From
              <input
                type="date"
                name="from"
                defaultValue={data?.range.from}
                required
              />
            </label>
            <label className="field">
              To
              <input
                type="date"
                name="to"
                defaultValue={data?.range.to}
                required
              />
            </label>
            <button>Apply dates</button>
          </div>
        </details>
        <select
          name="customer"
          aria-label="Customer"
          defaultValue={data?.range.customerId || ""}
          onChange={(event) => event.currentTarget.form?.requestSubmit()}
        >
          <option value="">All customers</option>
          {data?.customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
        <span className="toolbar-spacer" />
        {data && (
          <Link className="button" reloadDocument to={exportLink("both")}>
            Export both reports
          </Link>
        )}
      </Form>
      {error && (
        <p role="alert" className="feedback error">
          {error}
        </p>
      )}
      {data && (
        <>
          <section className="report-block" aria-labelledby="customer-spending">
            <div className="report-block-head">
              <div>
                <h2 id="customer-spending">Customer spending</h2>
                <p>Paid orders, Pass purchases and refunds by customer.</p>
              </div>
              <Link
                className="button report-export"
                reloadDocument
                to={exportLink("spending")}
              >
                Export customer spending CSV
              </Link>
            </div>
            <p className="report-connection-note">
              Currently connected: purchases recorded by Skyra Booking. Shopify
              store-wide orders and refunds are not connected yet.
            </p>
            <div className="report-metrics">
              <article>
                <span>Total customer spend</span>
                <strong>{money(data.spending.totalSpendCents)}</strong>
                <small>Recorded Booking purchases</small>
              </article>
              <article>
                <span>Pass revenue</span>
                <strong>{money(data.spending.passRevenueCents)}</strong>
                <small>Recorded Pass purchases</small>
              </article>
              <article>
                <span>Refunds</span>
                <strong>—</strong>
                <small>Shopify refunds not connected</small>
              </article>
            </div>
            <div className="table-wrap">
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Total spend</th>
                    <th>Pass purchases</th>
                    <th>Refunds</th>
                    <th>Last purchase</th>
                  </tr>
                </thead>
                <tbody>
                  {data.spending.rows.map((row) => (
                    <tr key={row.customerId}>
                      <td>
                        <Link
                          to={`/app/reports?range=${data.range.range}&from=${data.range.from}&to=${data.range.to}&customer=${row.customerId}`}
                        >
                          {row.customerName}
                        </Link>
                      </td>
                      <td>{money(row.totalSpendCents)}</td>
                      <td>{row.passPurchases}</td>
                      <td>
                        <span title="Shopify refunds are not connected">—</span>
                      </td>
                      <td>{date(row.lastPurchase)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.spending.rows.length && (
              <p className="empty">No recorded purchases in this period.</p>
            )}
            <p className="report-source">
              Source: Booking purchase records for the selected dates (
              {data.range.timezone}). Shopify store-wide orders, discounts and
              refunds still need connecting.
            </p>
            <details className="report-field-help">
              <summary>What do these fields mean?</summary>
              <p>
                Total spend is the value of recorded purchases. Pass revenue is
                the part spent on Passes. Pass purchases counts purchased Pass
                packages, not classes. Refunds means money returned, not a
                returned class credit.
              </p>
            </details>
          </section>
          <section className="report-block" aria-labelledby="unused-passes">
            <div className="report-block-head">
              <div>
                <h2 id="unused-passes">Purchased Passes with unused classes</h2>
                <p>
                  Remaining credits and expiry for follow-up and liability
                  tracking.
                </p>
              </div>
              <Link
                className="button report-export"
                reloadDocument
                to={exportLink("unused")}
              >
                Export unused Pass CSV
              </Link>
            </div>
            <div className="report-metrics">
              <article>
                <span>Customers with unused credits</span>
                <strong>{data.unusedPasses.customers}</strong>
              </article>
              <article>
                <span>Unused class credits</span>
                <strong>{data.unusedPasses.credits}</strong>
              </article>
              <article>
                <span>Expiring in 30 days</span>
                <strong>{data.unusedPasses.expiringIn30Days}</strong>
              </article>
            </div>
            <div className="table-wrap">
              <table className="data-table report-table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Pass</th>
                    <th>Purchased</th>
                    <th>Used</th>
                    <th>Remaining</th>
                    <th>Expiry</th>
                  </tr>
                </thead>
                <tbody>
                  {data.unusedPasses.rows.map((row) => {
                    const days = Math.ceil(
                      DateTime.fromISO(row.expiresAt).diff(
                        DateTime.fromISO(data.asOf),
                        "days",
                      ).days,
                    );
                    return (
                      <tr key={row.entitlementId}>
                        <td>
                          <Link
                            to={`/app/reports?range=${data.range.range}&from=${data.range.from}&to=${data.range.to}&customer=${row.customerId}`}
                          >
                            {row.customerName}
                          </Link>
                        </td>
                        <td>{row.passName}</td>
                        <td>{row.purchased}</td>
                        <td>{row.used}</td>
                        <td>
                          <strong
                            title={`${row.available} available; ${row.reserved} reserved for bookings`}
                          >
                            {row.remaining}
                          </strong>
                        </td>
                        <td>
                          <span
                            className={`status-pill ${days <= 7 ? "danger" : days <= 30 ? "warn" : ""}`}
                          >
                            {date(row.expiresAt)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!data.unusedPasses.rows.length && (
              <p className="empty">No active Passes have unused classes.</p>
            )}
            <p className="report-source">
              Source: the Pass credit ledger. This is today’s balance,
              regardless of the date filter. Expired, future-start and revoked
              Passes are excluded.
            </p>
            <details className="report-field-help">
              <summary>What do these fields mean?</summary>
              <p>
                Purchased is the number of classes originally included in the
                Pass. Used is classes already consumed. Remaining includes
                available classes and classes reserved for upcoming bookings.
                Expiring in 30 days counts classes, not Passes or customers.
              </p>
            </details>
          </section>
          {data.attention > 0 && (
            <p className="feedback">
              {data.attention} payment event(s) require review.{" "}
              <Link to="/app/bookings">Review bookings</Link>
            </p>
          )}
        </>
      )}
    </main>
  );
}
