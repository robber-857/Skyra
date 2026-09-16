import { randomUUID } from "node:crypto";
import {
  Link,
  redirect,
  useLoaderData,
  useActionData,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import { DateTime } from "luxon";
import { DomainError, publicError } from "../lib/errors.server";
import {
  coachRoster,
  coachChangeBooking,
} from "../services/booking-lifecycle.server";
import {
  requestCoachToken,
  requireCoachFormOrigin,
} from "../services/coach-auth.server";
import { BookingActions } from "../components/booking-actions";
import { Feedback, Status } from "../components/admin-ui";
import { CoachPortalShell } from "../components/coach-portal-shell";
export { links, headers } from "./coach";
export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const result = await coachRoster(requestCoachToken(request), params.id!);
    return {
      ...result,
      keys: Object.fromEntries(
        result.session.bookings.map((b) => [b.id, randomUUID()]),
      ),
    };
  } catch (e) {
    if (e instanceof DomainError && e.status === 401)
      throw redirect("/coach/login");
    throw e;
  }
}
export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  requireCoachFormOrigin(request);
  try {
    const token = requestCoachToken(request);
    const roster = await coachRoster(token, params.id!);
    const input = Object.fromEntries(await request.formData());
    if (!roster.session.bookings.some((b) => b.id === input.bookingId))
      throw new Response("Booking not found", { status: 404 });
    const result = await coachChangeBooking(token, input);
    return {
      message:
        "Booking updated: " + result.status.toLowerCase().replaceAll("_", " "),
    };
  } catch (e) {
    if (e instanceof DomainError && e.status === 401)
      throw redirect("/coach/login");
    if (e instanceof Response) throw e;
    return publicError(e);
  }
}
export default function Roster() {
  const { session: s, coachName, now, keys } = useLoaderData<typeof loader>();
  return (
    <CoachPortalShell coachName={coachName} active="schedule">
      <Link className="coach-back-link" to="/coach#schedule">
        <span aria-hidden="true">←</span> Back to my schedule
      </Link>
      <div className="coach-section-head coach-roster-head">
        <div>
          <p className="coach-kicker">Session detail</p>
          <h1>Class roster</h1>
        </div>
        <p className="coach-section-note">
          Only operational details for this assigned session are shown.
        </p>
      </div>
      <Feedback result={useActionData<typeof action>()} />
      <section className="panel">
        <h2>{s.service.name}</h2>
        <p>
          {DateTime.fromJSDate(new Date(s.startsAt), {
            zone: s.timezone,
          }).toFormat("d LLL yyyy · h:mm a")}{" "}
          · {s.timezone}
        </p>
        <p>
          {coachName} · {s.location.name}
        </p>
        <p>
          {
            s.bookings.filter((b) =>
              ["CONFIRMED", "ATTENDED", "NO_SHOW"].includes(b.status),
            ).length
          }{" "}
          / {s.capacity} enrolled
        </p>
      </section>
      <section className="panel">
        <h2>Registrations</h2>
        <p className="muted">
          Use the booking reference to match a registration.
        </p>
        {s.bookings.map((b) => (
          <article className="roster-booking" key={b.id}>
            <div className="coach-customer-head">
              {b.customer.avatarDataUrl ? (
                <img
                  className="coach-customer-avatar"
                  src={b.customer.avatarDataUrl}
                  alt=""
                />
              ) : (
                <span className="coach-customer-avatar" aria-hidden="true">
                  {(b.customer.preferredName || "C").charAt(0).toUpperCase()}
                </span>
              )}
              <div>
                <h3>
                  {b.customer.preferredName ||
                    `Customer ${b.customerId.slice(-8)}`}
                </h3>
                <p className="muted">Booking {b.id}</p>
              </div>
            </div>
            <Status>{b.status}</Status>
            <section
              className="coach-training-profile"
              aria-label={`Training profile for ${
                b.customer.preferredName || "customer"
              }`}
            >
              <h4>Training profile</h4>
              {b.customer.signature && (
                <p className="coach-profile-signature">
                  “{b.customer.signature}”
                </p>
              )}
              <div>
                <strong>Training goals</strong>
                <p>
                  {b.customer.trainingGoals ||
                    "No training goals have been added."}
                </p>
              </div>
            </section>
            {b.customerComment && (
              <div className="booking-comment">
                <h4>Customer note for this booking</h4>
                <p>{b.customerComment}</p>
              </div>
            )}
            {b.checkedInAt && <p>Checked in</p>}
            {s.status !== "CANCELLED" && (
              <BookingActions
                key={b.version}
                booking={b}
                startsAt={s.startsAt}
                endsAt={s.endsAt}
                now={now}
                idempotencyKey={keys[b.id]}
                coach
              />
            )}
          </article>
        ))}
        {!s.bookings.length && <p>No registrations yet.</p>}
      </section>
    </CoachPortalShell>
  );
}
