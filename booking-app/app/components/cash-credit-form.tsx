import { Form, useNavigation } from "react-router";
import { useState } from "react";
import { Field } from "./admin-ui";
import type { manualCreditOptions } from "../services/manual-credits.server";
export function CashCreditForm({
  options,
  idempotencyKey,
}: {
  options: Awaited<ReturnType<typeof manualCreditOptions>>;
  idempotencyKey: string;
}) {
  const [target, setTarget] = useState(options[0]?.value || "");
  const [confirmed, setConfirmed] = useState(false);
  const option = options.find((o) => o.value === target);
  const busy = useNavigation().state !== "idle";
  return (
    <section className="panel" aria-labelledby="cash-credits-title">
      <h2 id="cash-credits-title">Add credits — cash payment</h2>
      <p>
        Record a cash payment received by the studio and add class credits to
        this client.
      </p>
      {!options.length ? (
        <p>Create an active class or Pass in Classes &amp; Passes first.</p>
      ) : (
        <Form method="post" className="booking-action-form">
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <Field label="Class or Pass">
            <select
              name="target"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                setConfirmed(false);
              }}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Credits to add">
            <input
              key={target}
              name="units"
              type="number"
              min="1"
              max="1000"
              required
              defaultValue={option?.units || 1}
            />
          </Field>
          {option?.validity ? (
            <>
              <p>Validity: {option.validity}.</p>
              <input type="hidden" name="validityDays" value="30" />
            </>
          ) : (
            <Field label="Valid for (days from today)">
              <input
                name="validityDays"
                type="number"
                min="1"
                max="3650"
                required
                defaultValue="30"
              />
            </Field>
          )}
          <Field label="Cash received (AUD)">
            <input
              name="amount"
              type="number"
              min="0.01"
              max="100000"
              step="0.01"
              required
            />
          </Field>
          <Field label="Reason / receipt reference">
            <textarea
              name="reason"
              minLength={3}
              maxLength={500}
              required
              rows={2}
            />
          </Field>
          <label className="booking-confirm-check">
            <input
              name="confirmed"
              type="checkbox"
              required
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{" "}
            I have received the cash and checked the client, credits and
            validity.
          </label>
          <button className="primary" disabled={busy || !confirmed}>
            {busy ? "Saving…" : "Add credits"}
          </button>
        </Form>
      )}
    </section>
  );
}
