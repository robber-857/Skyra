import { useState } from "react";
import { Form, useNavigation } from "react-router";
import { Field } from "./admin-ui";

export function PassCreditAdjustmentForm({
  pass,
  idempotencyKey,
}: {
  pass: {
    id: string;
    name: string;
    available: number;
    reserved: number;
    status: string;
  };
  idempotencyKey: string;
}) {
  const [available, setAvailable] = useState(String(pass.available));
  const [confirmed, setConfirmed] = useState(false);
  const busy = useNavigation().state !== "idle";
  if (!["ACTIVE", "UNACTIVATED", "UPCOMING", "EXHAUSTED"].includes(pass.status))
    return null;
  const target = Number(available);
  const valid =
    available !== "" &&
    Number.isInteger(target) &&
    target >= 0 &&
    target <= 10000 &&
    target !== pass.available;
  return (
    <details className="pass-credit-adjustment">
      <summary>Adjust credits</summary>
      <Form
        method="post"
        className="booking-action-form"
        onChange={() => setConfirmed(false)}
      >
        <input type="hidden" name="intent" value="adjust-pass" />
        <input type="hidden" name="entitlementId" value={pass.id} />
        <input type="hidden" name="expectedAvailable" value={pass.available} />
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <p>
          Set available credits for {pass.name}. Reserved and used credits,
          expiry and payment records stay unchanged.
        </p>
        <Field label="New available credits">
          <input
            name="available"
            type="number"
            min="0"
            max="10000"
            step="1"
            required
            value={available}
            onChange={(e) => setAvailable(e.target.value)}
          />
        </Field>
        {valid && (
          <p role="status">
            Available: {pass.available} → {target} (
            {target > pass.available ? "+" : ""}
            {target - pass.available}). Reserved: {pass.reserved}.
          </p>
        )}
        <Field label="Adjustment reason">
          <textarea
            name="reason"
            required
            minLength={3}
            maxLength={500}
            rows={2}
          />
        </Field>
        <label className="booking-confirm-check">
          <input
            name="confirmed"
            type="checkbox"
            required
            checked={confirmed}
            onChange={(e) => {
              e.stopPropagation();
              setConfirmed(e.target.checked);
            }}
          />{" "}
          I have checked the client, Pass and new credit balance.
        </label>
        <button className="primary" disabled={busy || !valid || !confirmed}>
          {busy ? "Saving…" : "Save adjustment"}
        </button>
      </Form>
    </details>
  );
}
