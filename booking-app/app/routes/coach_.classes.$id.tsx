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
    <main className="workspace coach-workspace">
      <Link to="/coach">Back to your classes</Link>
      <h1>Class roster</h1>
      <Feedback result={useActionData<typeof action>()} />
      <section className="panel">
        <h2>{s.service.name}</h2>
        <p>
          {DateTime.fromJSDate(new Date(s.startsAt), { zone: s.timezone }).toFormat(
            "d LLL yyyy · h:mm a",
          )}{" "}
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
            <h3>Customer {b.customerId.slice(-8)}</h3>
            <p className="muted">Booking {b.id}</p>
            <Status>{b.status}</Status>
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
    </main>
  );
}
