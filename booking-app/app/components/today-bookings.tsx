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
                  to={
                    coach ? `/coach/classes/${s.id}` : `/app/bookings/${b.id}`
                  }
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
