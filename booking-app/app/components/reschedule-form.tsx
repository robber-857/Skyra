import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { DateTime } from "luxon";
import { Field } from "./admin-ui";
export function RescheduleForm({
  bookingId,
  version,
  idempotencyKey,
  options,
}: {
  bookingId: string;
  version: number;
  idempotencyKey: string;
  options: {
    id: string;
    startsAt: string;
    timezone: string;
    coachName: string;
    locationName: string;
  }[];
}) {
  const [confirmed, setConfirmed] = useState(false);
  const busy = useNavigation().state !== "idle";
  if (!options.length) return null;
  return (
    <section className="panel">
      <h2>Change class time</h2>
      <p className="muted">
        Move to the same class type at least 12 hours before the current start
        time. The new time must be eligible for the original Pass. If
        unavailable, the original booking stays in place.
      </p>
      <Form method="post">
        <input type="hidden" name="action" value="RESCHEDULE" />
        <input type="hidden" name="bookingId" value={bookingId} />
        <input type="hidden" name="expectedVersion" value={version} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <Field label="New class time">
          <select required name="targetSessionId" defaultValue="">
            <option value="" disabled>
              Select a time
            </option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {DateTime.fromISO(o.startsAt, { zone: o.timezone }).toFormat(
                  "d LLL yyyy h:mm a",
                )}{" "}
                · {o.coachName} · {o.locationName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason">
          <textarea name="reason" required minLength={3} maxLength={500} />
        </Field>
        <label className="check-field">
          <input
            type="checkbox"
            required
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I have confirmed the new class time with the customer.
        </label>
        <button disabled={busy || !confirmed}>Confirm new class time</button>
      </Form>
    </section>
  );
}
