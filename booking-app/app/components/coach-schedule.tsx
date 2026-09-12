import { DateTime } from "luxon";
import type { coachSchedule } from "../services/coach-schedule.server";
import { Field, Status } from "./admin-ui";
export function CoachScheduleView({
  data,
}: {
  data: Awaited<ReturnType<typeof coachSchedule>>;
}) {
  return (
    <main className="workspace coach-workspace">
      <header className="page-head">
        <div>
          <p className="muted">SKYRA · COACH</p>
          <h1>Your classes</h1>
          <p className="muted">
            {data.coachName} · {data.range.timezone}
          </p>
        </div>
        <form method="post" action="/coach/logout">
          <button>Sign out</button>
        </form>
      </header>
      <form method="get" action="/coach" className="panel">
        <div className="form-grid">
          <Field label="Show classes">
            <select name="range" defaultValue={data.range.range}>
              <option value="week">Next 7 days</option>
              <option value="month">Next 30 days</option>
              <option value="custom">Custom dates</option>
            </select>
          </Field>
          <div className="muted">
            Filter by the date of the class. Custom dates include both the first
            and last day.
          </div>
          <Field label="From (custom dates)">
            <input
              type="date"
              name="from"
              defaultValue={data.range.from}
              required
            />
          </Field>
          <Field label="To (custom dates)">
            <input
              type="date"
              name="to"
              defaultValue={data.range.to}
              required
            />
          </Field>
        </div>
        <div className="actions">
          <button className="primary">Apply dates</button>
          <span className="muted">
            {data.range.from} – {data.range.to}
          </span>
        </div>
      </form>
      <section className="coach-summary" aria-label="Registration summary">
        <div>
          <strong>{data.summary.sessions}</strong>
          <span>Classes</span>
        </div>
        <div>
          <strong>{data.summary.enrolled}</strong>
          <span>Enrolled places</span>
        </div>
        <div>
          <strong>{data.summary.occupancyPercent}%</strong>
          <span>Places filled</span>
        </div>
      </section>
      <p className="muted">
        Enrolled places count each class registration, including attended and
        no-show bookings. Cancelled and late-cancelled bookings are shown
        separately. Temporary payment holds are excluded from enrolment.
      </p>
      <section className="panel" aria-label="Your class registrations">
        <h2>Class registrations</h2>
        {data.rows.length ? (
          <div className="record-list">
            {data.rows.map((row) => (
              <article className="record coach-record" key={row.id}>
                <div>
                  <p className="muted">
                    {DateTime.fromISO(row.startsAt, { zone: row.timezone })
                      .setLocale("en-AU")
                      .toFormat("ccc, d LLL · h:mm a")}{" "}
                    –{" "}
                    {DateTime.fromISO(row.endsAt, {
                      zone: row.timezone,
                    }).toFormat("h:mm a")}
                  </p>
                  <h3>{row.className}</h3>
                  <p className="muted">
                    {row.location} · {row.timezone}
                  </p>
                  <Status>{row.status}</Status>
                  <p className="muted">
                    Attended {row.attended} · Cancelled {row.cancelled} · Late
                    cancel {row.lateCancel} · No-show {row.noShow}
                  </p>
                </div>
                <div className="coach-count">
                  <strong>
                    {row.enrolled} / {row.capacity}
                  </strong>
                  <span>enrolled</span>
                  <p className="muted">{row.confirmed} confirmed</p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="muted" role="status">
            No classes in this date range. Try another week or choose custom
            dates.
          </p>
        )}
      </section>
    </main>
  );
}
