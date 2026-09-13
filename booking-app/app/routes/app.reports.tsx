import {
  Form,
  Link,
  useLoaderData,
  type LoaderFunctionArgs,
} from "react-router";
import { adminContext } from "../services/context.server";
import { bookingReports } from "../services/booking-reports.server";
import { Field } from "../components/admin-ui";
import { publicError } from "../lib/errors.server";
export async function loader({ request }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  const url = new URL(request.url);
  const raw = Object.fromEntries(
    ["range", "from", "to"].flatMap((k) =>
      url.searchParams.has(k) ? [[k, url.searchParams.get(k)!]] : [],
    ),
  );
  try {
    return { data: await bookingReports(actor, raw), error: null };
  } catch (e) {
    return { data: null, error: publicError(e).error };
  }
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function Reports() {
  const { data, error } = useLoaderData<typeof loader>();
  return (
    <main className="workspace">
      <header className="page-head">
        <div>
          <h1>Reports</h1>
          <p className="muted">Booking activity and class credit balances.</p>
        </div>
      </header>
      <section className="panel">
        <Form
          method="get"
          className="form-grid"
          key={data?.range.from + ":" + data?.range.to}
        >
          <Field label="Period">
            <select name="range" defaultValue={data?.range.range || "month"}>
              <option value="week">Last 7 days</option>
              <option value="month">Last 30 days</option>
              <option value="custom">Custom dates</option>
            </select>
          </Field>
          <Field label="From">
            <input type="date" name="from" defaultValue={data?.range.from} />
          </Field>
          <Field label="To">
            <input type="date" name="to" defaultValue={data?.range.to} />
          </Field>
          <button type="submit">Apply dates</button>
        </Form>
      </section>
      {error && (
        <p role="alert" className="feedback error">
          {error}
        </p>
      )}
      {data && (
        <>
          <p className="muted">
            {data.range.from} to {data.range.to}, inclusive ·{" "}
            {data.range.timezone}
          </p>
          <section className="panel">
            <h2>Classes in this period</h2>
            <div className="report-grid">
              <div>
                <strong>{data.sessionCount}</strong>
                <span>Published / completed classes</span>
              </div>
              {[
                ["CONFIRMED", "Confirmed"],
                ["ATTENDED", "Attended"],
                ["NO_SHOW", "Missed class"],
                ["CANCELLED", "Cancelled"],
                ["LATE_CANCEL", "Late cancellations"],
              ].map(([key, label]) => (
                <div key={key}>
                  <strong>{data.counts[key] || 0}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <p className="muted">
              Bookings are grouped by the class start date and show their
              current status.
            </p>
          </section>
          <section className="panel">
            <h2>Validated booking purchases</h2>
            <div className="report-grid">
              <div>
                <strong>{data.purchases.count}</strong>
                <span>Purchases processed in this period</span>
              </div>
              <div>
                <strong>
                  {new Intl.NumberFormat("en-AU", {
                    style: "currency",
                    currency: "AUD",
                  }).format(data.purchases.valueCents / 100)}
                </strong>
                <span>Validated booking purchase value</span>
              </div>
            </div>
            <p className="muted">
              Includes purchases handled by this booking system, including paid
              bookings that need attention. Uses the processing date. Excludes
              other store orders and offline refund adjustments. Use Shopify for
              financial reconciliation.
            </p>
          </section>
          <section className="panel">
            <h2>Current active class credits</h2>
            <div className="report-grid">
              <div>
                <strong>{data.unused.customers}</strong>
                <span>Customers with active credits</span>
              </div>
              <div>
                <strong>{data.unused.passes}</strong>
                <span>Passes with available or reserved credits</span>
              </div>
              <div>
                <strong>{data.unused.available}</strong>
                <span>Available credits</span>
              </div>
              <div>
                <strong>{data.unused.reserved}</strong>
                <span>Reserved credits</span>
              </div>
            </div>
            <p className="muted">
              Current snapshot across all purchase dates. Excludes expired,
              future-start and revoked passes.
            </p>
          </section>
          <section className="panel">
            <h2>Needs attention</h2>
            <p>{data.attention} payment receipt(s) currently require review.</p>
            <Link to="/app/bookings">Review bookings</Link>
          </section>
        </>
      )}
    </main>
  );
}
