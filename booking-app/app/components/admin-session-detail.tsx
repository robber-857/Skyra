import { DateTime } from "luxon";
import { Link } from "react-router";
import { Status } from "./admin-ui";
import type { adminSessionDetail } from "../services/admin-session.server";

type Session = Awaited<ReturnType<typeof adminSessionDetail>>;
export function AdminSessionDetailView({
  session: s,
  week,
}: {
  session: Session;
  week: string;
}) {
  const scheduleUrl = `/app/schedule?week=${week}`;
  const local = (date: Date | string) =>
    DateTime.fromJSDate(new Date(date), { zone: s.timezone });
  const enrolled = s.bookings.filter((b) => b.enrolled);
  const other = s.bookings.filter((b) => !b.enrolled);
  const roster = (bookings: Session["bookings"]) => (
    <ul className="session-roster">
      {bookings.map((b) => (
        <li className="session-student" key={b.id}>
          <div className="session-student-head">
            <Link
              className="session-client-link"
              to={`/app/clients/${b.customer.id}`}
            >
              {b.customer.avatarDataUrl ? (
                <img
                  className="client-avatar"
                  src={b.customer.avatarDataUrl}
                  alt=""
                />
              ) : (
                <span
                  className="client-avatar client-initial"
                  aria-hidden="true"
                >
                  {b.customer.name.charAt(0).toUpperCase()}
                </span>
              )}
              <span>
                <strong>{b.customer.name}</strong>
                <small>View profile</small>
              </span>
            </Link>
            <div className="session-student-actions">
              <Status>{b.status.replaceAll("_", " ")}</Status>
              {b.checkedInAt && <span className="muted">Checked in</span>}
              <Link to={`/app/bookings/${b.id}`}>View booking</Link>
            </div>
          </div>
          {b.customerComment && (
            <p className="client-note">
              <strong>Booking note: </strong>
              {b.customerComment}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <main className="workspace session-workspace">
      <Link className="client-back" to={scheduleUrl}>
        ← Back to Weekly Schedule
      </Link>
      <header className="page-head">
        <div>
          <p className="page-kicker">Session details</p>
          <h1>{s.service.name}</h1>
          <p className="muted">
            {local(s.startsAt).toFormat("cccc d MMM yyyy · h:mm a")} –{" "}
            {local(s.endsAt).toFormat("h:mm a")} · {s.timezone}
          </p>
        </div>
        {s.canEdit && (
          <Link
            className="button"
            to={`${scheduleUrl}&edit=${s.id}#schedule-editor`}
          >
            Edit session
          </Link>
        )}
      </header>
      <section className="panel" aria-label="Session summary">
        <div className="schedule-calendar-head">
          <p>
            {s.coach.name} · {s.location.name}
          </p>
          <Status>{s.status}</Status>
        </div>
        <dl className="session-stats">
          <div>
            <dt>Enrolled / capacity</dt>
            <dd>
              {s.enrolled} / {s.capacity}
            </dd>
          </div>
          <div>
            <dt>Attended</dt>
            <dd>{s.attended}</dd>
          </div>
          <div>
            <dt>No-shows</dt>
            <dd>{s.noShows}</dd>
          </div>
          <div>
            <dt>Checkout holds</dt>
            <dd>{s.holds}</dd>
          </div>
        </dl>
        <p className="muted">
          Enrolled includes confirmed, attended and no-show bookings. Temporary
          checkout holds are shown separately.
        </p>
      </section>
      <section className="panel" aria-labelledby="session-roster-title">
        <h2 id="session-roster-title">Enrolled students ({enrolled.length})</h2>
        <p className="muted">
          Select a student’s avatar or name to view their profile, Passes and
          booking history.
        </p>
        {enrolled.length ? (
          roster(enrolled)
        ) : (
          <p className="empty">No enrolled students for this session yet.</p>
        )}
      </section>
      {other.length > 0 && (
        <section className="panel" aria-labelledby="session-other-title">
          <h2 id="session-other-title">Other bookings ({other.length})</h2>
          <p className="muted">
            Cancelled and other inactive bookings are excluded from the enrolled
            count.
          </p>
          {roster(other)}
        </section>
      )}
    </main>
  );
}
