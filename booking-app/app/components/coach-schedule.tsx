import { Link } from "react-router";
import { DateTime } from "luxon";
import type { coachSchedule } from "../services/coach-schedule.server";
import { Field, Status } from "./admin-ui";
export function CoachScheduleView({
  data,
}: {
  data: Awaited<ReturnType<typeof coachSchedule>>;
}) {
  const weekStart = DateTime.fromISO(data.range.from, {
    zone: data.range.timezone,
  }).setLocale("en-AU");
  const weekDays = Array.from({ length: 7 }, (_, index) =>
    weekStart.plus({ days: index }),
  );
  const previousWeek = weekStart.minus({ days: 7 }).toISODate();
  const nextWeek = weekStart.plus({ days: 7 }).toISODate();
  return (
    <section
      className="coach-section coach-schedule"
      id="schedule"
      aria-labelledby="coach-schedule-title"
    >
      <header className="coach-section-head">
        <div>
          <p className="coach-kicker">Plan ahead</p>
          <h2 id="coach-schedule-title">My schedule</h2>
          <p className="muted">
            {data.coachName} · {data.range.timezone}
          </p>
        </div>
        <p className="coach-section-note">
          Read-only schedule. Contact Skyra if an assigned session is wrong.
        </p>
      </header>
      <form method="get" action="/coach#schedule" className="coach-filter-panel">
        <div className="coach-filter-grid">
          <Field label="Show">
            <select name="range" defaultValue={data.range.range}>
              <option value="week">Week</option>
              <option value="month">Next 30 days</option>
              <option value="custom">Custom dates</option>
            </select>
          </Field>
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
        <div className="coach-filter-actions">
          <span className="coach-range">
            {data.range.from} – {data.range.to}
          </span>
          <button className="primary">Apply dates</button>
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
      <p className="coach-summary-note">
        Enrolled places count each class registration, including attended and
        no-show bookings. Cancelled and late-cancelled bookings are shown
        separately. Temporary payment holds are excluded from enrolment.
      </p>
      {data.range.range === "week" ? (
        <section aria-label="Weekly class calendar">
          <div className="coach-week-switcher">
            <Link
              className="button"
              to={`/coach?range=week&from=${previousWeek}#schedule`}
            >
              ← Previous week
            </Link>
            <strong>
              {weekStart.toFormat("d LLL")} –{" "}
              {weekStart.plus({ days: 6 }).toFormat("d LLL yyyy")}
            </strong>
            <Link
              className="button"
              to={`/coach?range=week&from=${nextWeek}#schedule`}
            >
              Next week →
            </Link>
          </div>
          <div className="coach-week-calendar">
            {weekDays.map((day) => {
              const rows = data.rows.filter(
                (row) =>
                  DateTime.fromISO(row.startsAt, {
                    zone: row.timezone,
                  }).toISODate() === day.toISODate(),
              );
              return (
                <section className="coach-week-day" key={day.toISODate()}>
                  <header>
                    <span>{day.toFormat("ccc")}</span>
                    <strong>{day.toFormat("d")}</strong>
                    <small>{day.toFormat("LLL")}</small>
                  </header>
                  <div className="coach-week-events">
                    {rows.map((row) => {
                      const startsAt = DateTime.fromISO(row.startsAt, {
                        zone: row.timezone,
                      });
                      return (
                        <Link
                          className="coach-week-event"
                          to={`/coach/classes/${row.id}`}
                          key={row.id}
                        >
                          <time dateTime={row.startsAt}>
                            {startsAt.toFormat("h:mm a")}
                          </time>
                          <strong>{row.className}</strong>
                          <span>{row.location}</span>
                          <small>
                            {row.enrolled}/{row.capacity} booked
                          </small>
                        </Link>
                      );
                    })}
                    {!rows.length && <p>No classes</p>}
                  </div>
                </section>
              );
            })}
          </div>
        </section>
      ) : (
        <section
          className="coach-schedule-list"
          aria-label="Your class registrations"
        >
          {data.rows.length ? (
            <div className="record-list">
              {data.rows.map((row) => {
                const startsAt = DateTime.fromISO(row.startsAt, {
                  zone: row.timezone,
                }).setLocale("en-AU");
                const endsAt = DateTime.fromISO(row.endsAt, {
                  zone: row.timezone,
                });
                const occupancy = row.capacity
                  ? Math.min(
                      100,
                      Math.round((row.enrolled / row.capacity) * 100),
                    )
                  : 0;
                return (
                  <article className="coach-schedule-card" key={row.id}>
                    <div className="coach-date-tile" aria-hidden="true">
                      <span>{startsAt.toFormat("ccc")}</span>
                      <strong>{startsAt.toFormat("d")}</strong>
                      <small>{startsAt.toFormat("LLL")}</small>
                    </div>
                    <div className="coach-schedule-body">
                      <div className="coach-card-topline">
                        <p>
                          <time dateTime={row.startsAt}>
                            {startsAt.toFormat("h:mm a")}
                          </time>{" "}
                          –{" "}
                          <time dateTime={row.endsAt}>
                            {endsAt.toFormat("h:mm a")}
                          </time>
                        </p>
                        <Status>{row.status}</Status>
                      </div>
                      <h3>{row.className}</h3>
                      <p className="muted">{row.location}</p>
                      <div
                        className="coach-capacity-bar"
                        aria-label={`${row.enrolled} of ${row.capacity} places enrolled`}
                      >
                        <span style={{ width: `${occupancy}%` }} />
                      </div>
                      <p className="coach-attendance-summary">
                        {row.enrolled}/{row.capacity} enrolled · {row.remaining}{" "}
                        open · {row.attended} attended · {row.noShow} no-show
                      </p>
                    </div>
                    <Link
                      className="button coach-roster-link"
                      to={`/coach/classes/${row.id}`}
                    >
                      View roster
                    </Link>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="coach-empty" role="status">
              <strong>No sessions in this date range</strong>
              <p>Try the next 30 days or choose custom dates.</p>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
