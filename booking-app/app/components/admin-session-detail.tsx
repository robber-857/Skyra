import { DateTime } from "luxon";
import { Form, Link, useNavigation, useRevalidator } from "react-router";
import { EmailStatus } from "./email-status";
import { Status } from "./admin-ui";
import type { adminSessionDetail } from "../services/admin-session.server";

type Session = Awaited<ReturnType<typeof adminSessionDetail>>;
export function AdminSessionDetailView({
  session: s,
  week,
  feedback,
}: {
  session: Session;
  week: string;
  feedback?: { message?: string; error?: string };
}) {
  const busy = useNavigation().state !== "idle";
  const revalidator = useRevalidator();
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
          <details>
            <summary>Student emails ({b.notifications.length})</summary>
            {!b.notifications.length && (
              <p className="muted">No email notification recorded.</p>
            )}
            {b.notifications.map((n) => (
              <div key={n.id} className="record">
                <div>
                  <strong>
                    {n.template === "SESSION_TIME_CHANGED_V1"
                      ? "Class time changed"
                      : n.template === "BOOKING_REMINDER_V1"
                        ? "Class reminder"
                        : n.template === "BOOKING_CANCELLED_V1"
                          ? "Booking cancelled"
                          : "Booking confirmed"}
                  </strong>
                  <p>
                    <EmailStatus
                      status={n.status}
                      deliveryStatus={n.deliveryStatus}
                    />
                  </p>
                  <p className="muted">
                    {n.attempts} attempt(s) ·{" "}
                    {local(n.createdAt).toFormat("d LLL, h:mm a")}
                  </p>
                  {n.template === "BOOKING_REMINDER_V1" &&
                    n.status === "PENDING" && (
                      <p>
                        Scheduled:{" "}
                        {local(n.availableAt).toFormat("d LLL, h:mm a")}
                      </p>
                    )}
                  {n.acceptedAt && (
                    <p className="muted">
                      Accepted: {local(n.acceptedAt).toFormat("d LLL, h:mm a")}
                    </p>
                  )}
                  {n.lastError && <p role="status">{n.lastError}</p>}
                  {n.deliveryError && (
                    <p role="status">
                      {n.deliveryError === "PROVIDER_READ_PERMISSION_REQUIRED"
                        ? "Delivery check unavailable: the mail provider key needs read permission."
                        : "Delivery status could not be checked. Try again later."}
                    </p>
                  )}
                  {n.deliveryCheckedAt && (
                    <p className="muted">
                      Delivery checked:{" "}
                      {local(n.deliveryCheckedAt).toFormat("d LLL, h:mm a")}
                    </p>
                  )}
                </div>
                <div className="record-actions">
                  <Link to={`/app/notifications/${n.id}`}>Preview email</Link>
                  {n.status === "ACCEPTED" && (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="refresh-delivery"
                      />
                      <input type="hidden" name="notificationId" value={n.id} />
                      <button type="submit" disabled={busy}>
                        Check delivery
                      </button>
                    </Form>
                  )}
                </div>
              </div>
            ))}
          </details>
        </li>
      ))}
    </ul>
  );
  return (
    <main className="workspace session-workspace">
      {feedback?.message && <p role="status">{feedback.message}</p>}
      {feedback?.error && <p role="alert">{feedback.error}</p>}
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
      {(s.status === "DRAFT" || s.canEdit) && (
        <Form
          method="post"
          onSubmit={(event) => {
            if (
              !window.confirm(
                `Delete ${s.service.name} from Weekly Schedule? This removes this session only.`,
              )
            )
              event.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="version" value={s.version} />
          <button className="danger-text" disabled={busy}>
            Delete session
          </button>
          <p className="muted">
            Bookings must be resolved and active checkout holds cleared before
            deletion.
          </p>
        </Form>
      )}
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
          Email records show sending and provider delivery status. Delivery does
          not confirm that a student has read the email.
        </p>
        <button
          type="button"
          disabled={revalidator.state !== "idle"}
          onClick={() => revalidator.revalidate()}
        >
          Refresh email statuses
        </button>
        {s.timeChange && s.timeChange.missingCount > 0 && (
          <div className="panel">
            <h3>Time-change emails not yet queued</h3>
            <p>
              {DateTime.fromJSDate(new Date(s.timeChange.previous.startsAt), {
                zone: s.timeChange.previous.timezone,
              }).toFormat("d LLL yyyy, h:mm a")}{" "}
              →{" "}
              {local(s.timeChange.next.startsAt).toFormat("d LLL yyyy, h:mm a")}{" "}
              ({s.timezone})
            </p>
            <p>
              {s.timeChange.missingCount} student(s):{" "}
              {s.timeChange.missingNames.join(", ")}
            </p>
            <p>
              This sends the recorded time change to these students and notifies
              the assigned coach and Admin. Existing notification records are
              not sent again.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="backfill-time-change" />
              <input
                type="hidden"
                name="auditId"
                value={s.timeChange.auditId}
              />
              <button type="submit" disabled={busy}>
                Send missing time-change emails
              </button>
            </Form>
          </div>
        )}
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
