import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { Field } from "./admin-ui";
export function BookingActions({
  booking,
  startsAt,
  endsAt,
  now,
  idempotencyKey,
  coach = false,
}: {
  booking: {
    id: string;
    status: string;
    version: number;
    checkedInAt: Date | string | null;
  };
  startsAt: Date | string;
  endsAt: Date | string;
  now: string;
  idempotencyKey: string;
  coach?: boolean;
}) {
  const start = new Date(startsAt).getTime(),
    end = new Date(endsAt).getTime(),
    clock = new Date(now).getTime();
  const actions = [];
  if (!coach && clock < start && !booking.checkedInAt)
    actions.push({
      value: "CANCEL",
      label: "Cancel under booking policy",
      note:
        clock <= start - 12 * 3600000
          ? "Release the reserved class credit. The Pass keeps its original expiry."
          : "Late cancellation uses one class credit.",
    });
  if (!coach)
    actions.push({
      value: "CANCEL_WAIVE",
      label: "Cancel and release credit (staff exception)",
      note: "Release the reserved credit regardless of the cancellation deadline. Record the reason for this exception.",
    });
  if (clock >= start && clock < end && !booking.checkedInAt)
    actions.push({
      value: "CHECK_IN",
      label: "Check in",
      note: "Record arrival. The credit remains reserved until the class is completed.",
    });
  if (clock >= end) {
    actions.push({
      value: "COMPLETE",
      label: "Mark attended / complete",
      note: "Settle one reserved class credit as used.",
    });
    if (!booking.checkedInAt)
      actions.push({
        value: "NO_SHOW",
        label: "Mark no-show",
        note: "Record a missed class and settle one reserved credit as used.",
      });
  }
  const [selected, setSelected] = useState(actions[0]?.value || "");
  const [confirmed, setConfirmed] = useState(false);
  const busy = useNavigation().state !== "idle";
  if (booking.status !== "CONFIRMED")
    return (
      <p className="muted">
        This booking is {booking.status.toLowerCase().replaceAll("_", " ")}. No
        further changes are available here.
      </p>
    );
  if (!actions.length)
    return (
      <p className="muted">
        Check-in opens when the class starts. Record attendance or no-show after
        it ends.
      </p>
    );
  const current = actions.find((x) => x.value === selected) || actions[0];
  return (
    <Form method="post" className="booking-action-form">
      <input type="hidden" name="bookingId" value={booking.id} />
      <input type="hidden" name="expectedVersion" value={booking.version} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field label="Booking action">
        <select
          name="action"
          value={current.value}
          onChange={(e) => {
            setSelected(e.target.value);
            setConfirmed(false);
          }}
        >
          {actions.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
      </Field>
      <p className="muted">{current.note}</p>
      {!coach && (
        <p className="muted">
          These actions change the booking and class credits. Payment refunds
          are handled separately by the studio.
        </p>
      )}
      <Field label="Reason">
        <textarea
          name="reason"
          required
          minLength={3}
          maxLength={500}
          rows={2}
          placeholder="Record the reason for this change"
        />
      </Field>
      <label className="booking-confirm-check">
        <input
          type="checkbox"
          required
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I have checked the booking and the effect on class credits.
      </label>
      <button className="primary" disabled={busy || !confirmed}>
        {busy ? "Saving…" : "Apply booking action"}
      </button>
    </Form>
  );
}
