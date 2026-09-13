import { RescheduleForm } from "../components/reschedule-form";
import {
  rescheduleOptions,
  staffReschedule,
} from "../services/booking-reschedule.server";
import { redirect } from "react-router";
import { randomUUID } from "node:crypto";
import {
  Link,
  useLoaderData,
  useActionData,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import { DateTime } from "luxon";
import { adminContext } from "../services/context.server";
import {
  staffBookingDetail,
  staffChangeBooking,
} from "../services/booking-lifecycle.server";
import { publicError } from "../lib/errors.server";
import { BookingActions } from "../components/booking-actions";
import { Feedback, Status } from "../components/admin-ui";
export const headers = () => ({ "Cache-Control": "private, no-store" });
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  const detail = await staffBookingDetail(actor, params.id!);
  let options: Awaited<ReturnType<typeof rescheduleOptions>>["options"] = [];
  let optionsError: string | null = null;
  if (
    detail.booking.status === "CONFIRMED" &&
    !detail.booking.checkedInAt &&
    new Date(detail.now).getTime() <=
      detail.booking.session.startsAt.getTime() - 12 * 3600000
  ) {
    try {
      options = (
        await rescheduleOptions(
          { kind: "STAFF", actor },
          { bookingId: params.id! },
        )
      ).options;
    } catch (e) {
      optionsError = publicError(e).error;
    }
  }
  return {
    ...detail,
    options,
    optionsError,
    idempotencyKey: randomUUID(),
  };
}
export async function action({ request, params }: ActionFunctionArgs) {
  const { actor } = await adminContext(request);
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  try {
    const input = Object.fromEntries(await request.formData());
    if (input.bookingId !== params.id)
      throw new Response("Booking mismatch", { status: 400 });
    if (input.action === "RESCHEDULE") {
      const moved = await staffReschedule(actor, input);
      return redirect(`/app/bookings/${moved.bookingId}`);
    }
    const result = await staffChangeBooking(actor, input);
    return {
      message:
        "Booking updated: " + result.status.toLowerCase().replaceAll("_", " "),
    };
  } catch (error) {
    if (error instanceof Response) throw error;
    return publicError(error);
  }
}
export default function BookingDetail() {
  const {
    booking: b,
    timeline,
    rescheduledFrom,
    rescheduledTo,
    now,
    idempotencyKey,
    options,
    optionsError,
  } = useLoaderData<typeof loader>();
  return (
    <main className="workspace">
      <Link to="/app/bookings">Back to bookings</Link>
      <h1>{b.session.service.name}</h1>
      <Feedback result={useActionData<typeof action>()} />
      <section className="panel">
        <h2>Booking details</h2>
        {rescheduledFrom && (
          <p>
            Moved from{" "}
            <Link to={`/app/bookings/${rescheduledFrom}`}>
              previous booking
            </Link>
            .
          </p>
        )}
        {rescheduledTo && (
          <p>
            Moved to{" "}
            <Link to={`/app/bookings/${rescheduledTo}`}>new booking</Link>.
          </p>
        )}
        <p>
          {DateTime.fromJSDate(new Date(b.session.startsAt), {
            zone: b.session.timezone,
          }).toFormat("d LLL yyyy · h:mm a")}{" "}
          · {b.session.timezone}
        </p>
        <p>
          {b.session.coach.name} · {b.session.location.name}
        </p>
        <p className="muted">Booking {b.id}</p>
        <p className="muted">Customer reference {b.customerId}</p>
        <Status>{b.status}</Status>
        {b.checkedInAt && (
          <p>
            Checked in at{" "}
            {DateTime.fromJSDate(new Date(b.checkedInAt), {
              zone: b.session.timezone,
            }).toFormat("h:mm a")}
          </p>
        )}
        {optionsError && (
          <p role="alert" className="feedback error">
            {optionsError}
          </p>
        )}
        <RescheduleForm
          bookingId={b.id}
          version={b.version}
          idempotencyKey={idempotencyKey}
          options={options}
        />
        <BookingActions
          key={b.version}
          booking={b}
          startsAt={b.session.startsAt}
          endsAt={b.session.endsAt}
          now={now}
          idempotencyKey={idempotencyKey}
        />
      </section>
      <section className="panel">
        <h2>Credit history</h2>
        {b.entitlementLedgerEntries.map((e) => (
          <p key={e.id}>
            {e.kind} · Available {e.availableDelta} · Reserved {e.reservedDelta}{" "}
            · Used {e.consumedDelta}
          </p>
        ))}
        {!b.entitlementLedgerEntries.length && (
          <p>No linked credit history. This booking requires review.</p>
        )}
      </section>
      <section className="panel">
        <h2>Booking timeline</h2>
        {timeline.map((e) => (
          <article className="record" key={e.id}>
            <div>
              <h3>{e.action.replaceAll("_", " ")}</h3>
              <p>
                {e.fromStatus} → {e.toStatus}
              </p>
              <p>{e.reason}</p>
              <p className="muted">
                {DateTime.fromJSDate(new Date(e.createdAt), {
                  zone: b.session.timezone,
                }).toFormat("d LLL yyyy · h:mm a")}{" "}
                · {e.actorKind}
              </p>
            </div>
          </article>
        ))}
        {!timeline.length && <p className="muted">No booking changes yet.</p>}
      </section>
    </main>
  );
}
