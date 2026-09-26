import { useState } from "react";
import { Form, useNavigation, useSearchParams } from "react-router";
import { Field } from "./admin-ui";
import type { attendanceBackfillOptions } from "../services/attendance-backfill.server";

export function AttendanceBackfillForm({
  data,
  clientName,
  idempotencyKey,
}: {
  data: Awaited<ReturnType<typeof attendanceBackfillOptions>>;
  clientName: string;
  idempotencyKey: string;
}) {
  const [searchParams] = useSearchParams();
  const [sessionId, setSessionId] = useState(data.options[0]?.id ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const session = data.options.find((option) => option.id === sessionId);
  const busy = useNavigation().state !== "idle";
  return (
    <section className="panel" id="attendance-backfill">
      <h2>Record past attendance for {clientName}</h2>
      <p>
        Select an ended class. This records the client as attended and uses one
        Pass credit immediately.
      </p>
      <Form method="get" className="booking-action-form" preventScrollReset>
        {[...searchParams]
          .filter(([name]) => name !== "attendanceDate")
          .map(([name, value], index) => (
            <input
              key={`${name}:${index}`}
              type="hidden"
              name={name}
              value={value}
            />
          ))}
        <Field label={`Class date (${data.timezone})`}>
          <input
            type="date"
            name="attendanceDate"
            defaultValue={data.date}
            max={data.today}
            required
          />
        </Field>
        <button disabled={busy}>Show classes</button>
      </Form>
      {!data.options.length ? (
        <p>
          No ended classes available for this client on this date. Classes with
          an existing booking are excluded.
        </p>
      ) : (
        <Form
          method="post"
          className="booking-action-form"
          onChange={() => setConfirmed(false)}
        >
          <input type="hidden" name="intent" value="backfill-attendance" />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <Field label="Class session">
            <select
              name="sessionId"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            >
              {data.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {new Intl.DateTimeFormat("en-AU", {
                    timeZone: option.timezone,
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(option.startsAt))}
                  {" · "}
                  {option.name}
                  {" · "}
                  {option.coach}
                </option>
              ))}
            </select>
          </Field>
          {session && (
            <p>
              {session.location} · {session.timezone} · {session.enrolled}/
              {session.capacity} enrolled
            </p>
          )}
          {session && session.enrolled >= session.capacity && (
            <p role="status">
              This class is at capacity. Only record a client who actually
              attended.
            </p>
          )}
          <Field label="Client's Pass">
            <select
              key={sessionId}
              name="entitlementId"
              required
              disabled={!session?.passes.length}
            >
              {!session?.passes.length && (
                <option value="">No eligible Pass</option>
              )}
              {session?.passes.map((pass) => (
                <option key={pass.id} value={pass.id}>
                  {pass.name} · {pass.available} available · {pass.id.slice(-8)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reason for recording attendance">
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
              type="checkbox"
              name="confirmed"
              required
              checked={confirmed}
              onChange={(e) => {
                e.stopPropagation();
                setConfirmed(e.target.checked);
              }}
            />{" "}
            This client attended the selected class. Mark as attended and use
            one credit from the selected Pass.
          </label>
          <button
            className="primary"
            disabled={busy || !confirmed || !session?.passes.length}
          >
            {busy ? "Recording…" : "Record attendance · Use 1 credit"}
          </button>
        </Form>
      )}
    </section>
  );
}
