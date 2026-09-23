import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { Field } from "./admin-ui";
import type { staffBookingOptions } from "../services/staff-booking.server";

export function StaffBookingForm({
  options,
  clientName,
  idempotencyKey,
}: {
  options: Awaited<ReturnType<typeof staffBookingOptions>>;
  clientName: string;
  idempotencyKey: string;
}) {
  const [sessionId, setSessionId] = useState(options[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const session = options.find((s) => s.id === sessionId);
  const busy = useNavigation().state !== "idle";
  return (
    <section className="panel">
      <h2>Book a class for {clientName}</h2>
      <p>
        Choose a published class and reserve one credit from the selected Pass.
        The usual 14-day booking window and 2-hour cutoff apply.
      </p>
      {!options.length ? (
        <p>
          No available classes in the booking window, or this client is already
          booked.
        </p>
      ) : (
        <Form
          method="post"
          className="booking-action-form"
          onChange={() => setConfirmed(false)}
        >
          <input type="hidden" name="intent" value="book-class" />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <Field label="Class session">
            <select
              name="sessionId"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            >
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {new Intl.DateTimeFormat("en-AU", {
                    timeZone: s.timezone,
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(s.startsAt))}{" "}
                  · {s.name} · {s.coach}
                </option>
              ))}
            </select>
          </Field>
          {session && (
            <p>
              {session.location} · {session.timezone} · {session.remaining}{" "}
              places available
            </p>
          )}
          {session?.passes.length ? (
            <Field label="Client's Pass">
              <select key={sessionId} name="entitlementId" required>
                {session.passes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.available} available · {p.id.slice(-8)}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <p role="status">
              No eligible Pass with available credits. Add or adjust credits
              for this client first, then return to this form.
            </p>
          )}
          <Field label="Booking reason">
            <textarea
              name="reason"
              minLength={3}
              maxLength={500}
              rows={2}
              required
            />
          </Field>
          <label className="booking-confirm-check">
            <input
              type="checkbox"
              name="confirmed"
              required
              checked={confirmed}
              onChange={(e) => {
                e.stopPropagation();
                setConfirmed(e.target.checked);
              }}
            />{" "}
            I have checked the client, class and Pass. Reserve one credit and
            create the booking.
          </label>
          <button
            className="primary"
            disabled={busy || !confirmed || !session?.passes.length}
          >
            {busy ? "Booking…" : "Confirm booking"}
          </button>
        </Form>
      )}
    </section>
  );
}
