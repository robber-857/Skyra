import { Link } from "react-router";
import { DateTime } from "luxon";
import type { adminToday } from "../services/today-bookings.server";
export function TodayBookings({
  data,
  coach = false,
}: {
  data: Awaited<ReturnType<typeof adminToday>>;
  coach?: boolean;
}) {
  if (coach)
    return (
      <section
        className="coach-section coach-today"
        id="today"
        aria-labelledby="coach-today-title"
      >
        <div className="coach-section-head">
          <div>
            <p className="coach-kicker">Your day</p>
            <h1 id="coach-today-title">Today</h1>
            <p className="muted">
              {DateTime.fromISO(data.date, { zone: data.timezone })
                .setLocale("en-AU")
                .toFormat("cccc, d LLLL")}{" "}
              · {data.timezone}
            </p>
          </div>
          <p className="coach-section-note">
            Open a session to view its roster, Training profiles and no-shows.
          </p>
        </div>
        {data.sessions.length ? (
          <div className="coach-today-grid">
            {data.sessions.map((session) => {
              const startsAt = DateTime.fromJSDate(
                new Date(session.startsAt),
                { zone: session.timezone },
              );
              const isPrivate = session.service.kind === "APPOINTMENT";
              return (
                <article className="coach-today-card" key={session.id}>
                  <div className="coach-card-topline">
                    <time dateTime={new Date(session.startsAt).toISOString()}>
                      {startsAt.toFormat("h:mm a")}
                    </time>
                    <span
                      className={`coach-kind ${isPrivate ? "private" : "class"}`}
                    >
                      {isPrivate ? "Private" : "Class"}
                    </span>
                  </div>
                  <h2>{session.service.name}</h2>
                  <p className="muted">
                    {session.bookings.length} of {session.capacity} places booked
                  </p>
                  <Link
                    className="button coach-card-action"
                    to={`/coach/classes/${session.id}`}
                  >
                    Open roster
                    <span aria-hidden="true">→</span>
                  </Link>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="coach-empty" role="status">
            <strong>No sessions today</strong>
            <p>Your next assigned sessions are listed in My schedule.</p>
            <a className="button" href="#schedule">
              View my schedule
            </a>
          </div>
        )}
        {data.truncated && (
          <p className="muted">
            Showing the first 100 sessions. Use My schedule for more.
          </p>
        )}
      </section>
    );
  return (
    <section className="panel">
      <h2>Today’s bookings</h2>
      <p className="muted">
        {data.date} · {data.timezone}
      </p>
      {data.sessions.map((s) => (
        <article className="record" key={s.id}>
          <div>
            <h3>
              {s.service.name}{" "}
              {s.service.kind === "APPOINTMENT" ? "· Private appointment" : ""}
            </h3>
            <p>
              {DateTime.fromJSDate(new Date(s.startsAt), {
                zone: s.timezone,
              }).toFormat("h:mm a")}{" "}
              · {s.coach.name} · {s.bookings.length}/{s.capacity} booked
            </p>
            {s.bookings.map((b) => (
              <p key={b.id}>
                <Link
                  to={`/app/bookings/${b.id}`}
                >
                  Customer {b.customerId.slice(-8)} · Booking {b.id.slice(-8)}
                </Link>{" "}
                · {b.status.toLowerCase().replaceAll("_", " ")}
              </p>
            ))}
            {!s.bookings.length && <p className="muted">No bookings yet.</p>}
          </div>
        </article>
      ))}
      {!data.sessions.length && <p>No sessions scheduled for today.</p>}
      {data.truncated && (
        <p>Showing the first 100 sessions. Use the schedule for more.</p>
      )}
    </section>
  );
}
