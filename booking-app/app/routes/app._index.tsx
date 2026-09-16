import { DateTime } from "luxon";
import { z } from "zod";
import {
  Link,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import db from "../db.server";
import { BookingNotificationList } from "../components/booking-notification-list";
import { adminContext } from "../services/context.server";
import { adminOverview } from "../services/admin-overview.server";
import {
  adminNotifications,
  markAdminNotificationRead,
} from "../services/in-app-notifications.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  const [overview, notifications, noShowLogs] = await Promise.all([
    adminOverview(actor),
    adminNotifications(actor),
    db.auditLog.findMany({
      where: { shopId: actor.shopId, action: "BOOKING_NO_SHOW" },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);
  const noShowBookings = await db.booking.findMany({
    where: {
      shopId: actor.shopId,
      id: { in: noShowLogs.map((entry) => entry.entityId) },
    },
    select: {
      id: true,
      customerId: true,
      customer: { select: { preferredName: true } },
      entitlementLedgerEntries: {
        where: { kind: "RELEASE" },
        select: { id: true },
        take: 1,
      },
      session: {
        select: {
          startsAt: true,
          timezone: true,
          service: { select: { name: true } },
          coach: { select: { name: true } },
        },
      },
    },
  });
  return {
    overview,
    notifications,
    rulesApproved: Boolean(shop.rulesApprovedAt),
    noShowAlerts: noShowLogs.flatMap((entry) => {
      const booking = noShowBookings.find(
        (candidate) => candidate.id === entry.entityId,
      );
      if (!booking || booking.entitlementLedgerEntries.length === 0) return [];
      return [
        {
          bookingId: booking.id,
          customerName:
            booking.customer.preferredName ||
            `Customer ${booking.customerId.slice(-8)}`,
          className: booking.session.service.name,
          coachName: booking.session.coach.name,
          startsAt: booking.session.startsAt.toISOString(),
          timezone: booking.session.timezone,
        },
      ];
    }),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { actor } = await adminContext(request);
  const form = await request.formData();
  z.literal("read-notification").parse(form.get("intent"));
  const notificationId = z.string().uuid().parse(form.get("notificationId"));
  await markAdminNotificationRead(actor, notificationId);
  return { ok: true };
}

export default function Overview() {
  const data = useLoaderData<typeof loader>();
  const overview = data.overview;
  return (
    <main className="workspace overview-workspace">
      <header className="page-head overview-head">
        <div>
          <p className="page-kicker">Admin · Start here</p>
          <h1>Overview</h1>
          <p className="muted">
            Today’s work, booking issues and customer Passes nearing expiry.
          </p>
        </div>
        <Link to="/app/settings">Settings</Link>
      </header>

      <nav className="workflow-strip" aria-label="Admin workflow">
        <Link to="/app/catalog">
          <strong>1 · Define</strong>
          <span>Create class types and Pass packages.</span>
        </Link>
        <Link to="/app/schedule">
          <strong>2 · Schedule</strong>
          <span>Choose this week’s time and coach.</span>
        </Link>
        <Link to="/app/bookings">
          <strong>3 · Operate</strong>
          <span>Manage bookings and exceptions.</span>
        </Link>
        <Link to="/app/reports">
          <strong>4 · Review</strong>
          <span>Export spend and unused Pass reports.</span>
        </Link>
      </nav>

      <section className="overview-metrics" aria-label="Today summary">
        <article className="metric-card">
          <span>Classes today</span>
          <strong>{overview.metrics.classesToday}</strong>
          <small>
            {overview.metrics.bookedToday} / {overview.metrics.capacityToday}{" "}
            places booked
          </small>
        </article>
        <article className="metric-card">
          <span>Bookings needing action</span>
          <strong>{overview.metrics.attention}</strong>
          <small>Failed or review-required payment events</small>
        </article>
        <article className="metric-card">
          <span>Passes expiring in 30 days</span>
          <strong>{overview.metrics.expiringPasses}</strong>
          <small>{overview.metrics.expiringCredits} unused class credits</small>
        </article>
      </section>

      <div className="overview-columns">
        <section className="panel overview-table-panel">
          <div className="panel-title-row">
            <h2>Today’s classes</h2>
            <Link className="button" to="/app/schedule">
              View schedule
            </Link>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Class</th>
                  <th>Coach</th>
                  <th>Booked</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {overview.sessions.map((session) => (
                  <tr key={session.id}>
                    <td>
                      {DateTime.fromISO(session.startsAt, {
                        zone: session.timezone,
                      }).toFormat("HH:mm")}
                    </td>
                    <td>
                      <Link to={`/app/schedule?date=${overview.date}`}>
                        {session.service.name}
                      </Link>
                    </td>
                    <td>{session.coach.name}</td>
                    <td>
                      {session.booked} / {session.capacity}
                    </td>
                    <td>
                      <span
                        className={`status-pill ${
                          session.booked >= session.capacity ? "warn" : "ok"
                        }`}
                      >
                        {session.booked >= session.capacity ? "Full" : "Ready"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!overview.sessions.length && (
            <p className="empty">No published classes today.</p>
          )}
        </section>

        <section className="panel overview-table-panel">
          <div className="panel-title-row">
            <h2>Pass expiry alerts</h2>
            <Link className="button" to="/app/reports">
              All customers
            </Link>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Customer / Pass</th>
                  <th>Remaining</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {overview.expiringPasses.map((pass) => (
                  <tr key={pass.entitlementId}>
                    <td>
                      <strong>{pass.customerName}</strong>
                      <small>{pass.passName}</small>
                    </td>
                    <td>
                      {pass.remaining} / {pass.granted}
                    </td>
                    <td>
                      <span
                        className={`status-pill ${
                          pass.daysRemaining <= 7 ? "danger" : "warn"
                        }`}
                      >
                        {pass.daysRemaining} days
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!overview.expiringPasses.length && (
            <p className="empty">No active Passes expire in the next 30 days.</p>
          )}
        </section>
      </div>

      {!overview.operationsEmailConfigured && (
        <p className="feedback">
          Admin in-app notifications are active. Add an operations email in{" "}
          <Link to="/app/settings">Settings</Link> before connecting a mail
          provider.
        </p>
      )}
      <BookingNotificationList
        notifications={data.notifications}
        audience="admin"
      />

      {data.noShowAlerts.length > 0 && (
        <section className="panel feedback" aria-labelledby="no-show-alerts">
          <h2 id="no-show-alerts">No-show credits returned</h2>
          <p>
            Coach-recorded no-shows return the reserved class credit to the
            customer’s Pass. Review these exceptions if follow-up is needed.
          </p>
          <div className="record-list">
            {data.noShowAlerts.map((alert) => (
              <article className="record" key={alert.bookingId}>
                <div>
                  <h3>{alert.customerName}</h3>
                  <p>
                    {alert.className} · {alert.coachName}
                  </p>
                  <p className="muted">
                    {new Intl.DateTimeFormat("en-AU", {
                      dateStyle: "medium",
                      timeStyle: "short",
                      timeZone: alert.timezone,
                    }).format(new Date(alert.startsAt))}
                  </p>
                </div>
                <Link className="button" to={`/app/bookings/${alert.bookingId}`}>
                  Review booking
                </Link>
              </article>
            ))}
          </div>
        </section>
      )}
      {!data.rulesApproved && (
        <p className="feedback">
          Online bookings are closed while booking and cancellation rules are
          being confirmed.
        </p>
      )}
    </main>
  );
}
