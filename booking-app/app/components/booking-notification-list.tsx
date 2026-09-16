import { DateTime } from "luxon";
import { Form, Link } from "react-router";

export type BookingNotificationItem = {
  id: string;
  bookingId: string;
  sessionId: string;
  unread: boolean;
  createdAt: string;
  emailStatus: string;
  template: string;
  className: string;
  startsAt: string;
  timezone: string;
  customerName: string;
};

export function BookingNotificationList({
  notifications,
  audience,
}: {
  notifications: BookingNotificationItem[];
  audience: "admin" | "coach";
}) {
  const unread = notifications.filter((item) => item.unread).length;
  return (
    <section
      className={audience === "coach" ? "coach-section" : "panel"}
      id="notifications"
      aria-labelledby={`${audience}-notifications-title`}
    >
      <div className="notification-heading">
        <div>
          <p className="coach-kicker">
            {audience === "coach" ? "Updates" : "Admin inbox"}
          </p>
          <h2 id={`${audience}-notifications-title`}>Booking notifications</h2>
        </div>
        <span className="notification-count" aria-label={`${unread} unread`}>
          {unread} unread
        </span>
      </div>
      {notifications.length ? (
        <div className="notification-list">
          {notifications.map((item) => (
            <article
              className={`notification-item ${item.unread ? "unread" : ""}`}
              key={item.id}
            >
              <div>
                <div className="notification-meta">
                  <span>
                    {item.template === "BOOKING_CANCELLED_V1"
                      ? "Booking cancelled"
                      : "New booking"}
                  </span>
                  <time dateTime={item.createdAt}>
                    {DateTime.fromISO(item.createdAt, {
                      zone: item.timezone,
                    }).toFormat("d LLL · h:mm a")}
                  </time>
                </div>
                <h3>{item.className}</h3>
                <p>
                  {item.customerName} ·{" "}
                  {DateTime.fromISO(item.startsAt, {
                    zone: item.timezone,
                  }).toFormat("d LLL · h:mm a")}
                </p>
                <p className="muted">
                  Email job: {item.emailStatus.toLowerCase().replaceAll("_", " ")}
                </p>
              </div>
              <div className="record-actions">
                <Link
                  className="button"
                  to={
                    audience === "coach"
                      ? `/coach/classes/${item.sessionId}`
                      : `/app/bookings/${item.bookingId}`
                  }
                >
                  View booking
                </Link>
                {item.unread && (
                  <Form method="post">
                    <input
                      type="hidden"
                      name="intent"
                      value="read-notification"
                    />
                    <input
                      type="hidden"
                      name="notificationId"
                      value={item.id}
                    />
                    <button>Mark read</button>
                  </Form>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="empty">No booking notifications yet.</p>
      )}
    </section>
  );
}
