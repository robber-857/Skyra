import { useState } from "react";
import { DateTime } from "luxon";
import {
  Form,
  useLoaderData,
  useActionData,
  useNavigation,
  Link,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import { adminContext } from "../services/context.server";
import { catalogData } from "../services/catalog.server";
import {
  addSessions,
  publishWeek,
  copyPreviousWeek,
  cancelDraft,
  scheduleData,
} from "../services/schedule.server";
import { publicError } from "../lib/errors.server";
import { Feedback, Field, Status } from "../components/admin-ui";
export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  const day =
    new URL(request.url).searchParams.get("week") ||
    DateTime.now().setZone(shop.timezone).toISODate()!;
  return {
    ...(await scheduleData(actor.shopId, day)),
    ...(await catalogData(actor.shopId)),
    requestId: crypto.randomUUID(),
  };
}
export async function action({ request }: ActionFunctionArgs) {
  const { actor } = await adminContext(request);
  const form = await request.formData();
  try {
    if (form.get("intent") === "add") {
      const sessions = await addSessions(actor, Object.fromEntries(form));
      return { message: sessions.length + " draft session(s) saved." };
    }
    if (form.get("intent") === "copy")
      return {
        message:
          (await copyPreviousWeek(actor, String(form.get("week")))) +
          " draft session(s) copied.",
      };
    if (form.get("intent") === "publish")
      return {
        message:
          (await publishWeek(actor, String(form.get("week")))) +
          " session(s) published.",
      };
    if (form.get("intent") === "remove") {
      await cancelDraft(actor, String(form.get("id")));
      return { message: "Draft removed." };
    }
    return { error: "Unknown action." };
  } catch (error) {
    return publicError(error);
  }
}
export default function Schedule() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const [open, setOpen] = useState(false);
  const [serviceId, setServiceId] = useState("");
  const selected = data.services.find((x) => x.id === serviceId);
  const coachIds = selected?.coaches.map((x) => x.coachId) || [];
  const week = DateTime.fromISO(data.week);
  return (
    <main className="workspace">
      <header className="page-head">
        <div>
          <h1>Weekly Schedule</h1>
          <p className="muted">
            Assign dates, times and coaches. Times shown in {data.timezone}.
          </p>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          Add session
        </button>
      </header>
      <div className="week-bar">
        <Link
          className="button"
          to={"?week=" + week.minus({ weeks: 1 }).toISODate()}
        >
          Previous
        </Link>
        <Form method="get">
          <label>
            Week of{" "}
            <input
              type="date"
              name="week"
              defaultValue={data.week}
              key={data.week}
              required
            />
          </label>{" "}
          <button>Go</button>
        </Form>
        <Link
          className="button"
          to={"?week=" + week.plus({ weeks: 1 }).toISODate()}
        >
          Next
        </Link>
      </div>
      <Form method="post" className="actions">
        <input type="hidden" name="intent" value="copy" />
        <input type="hidden" name="week" value={data.week} />
        <button disabled={busy}>Copy previous week</button>
      </Form>
      <Feedback result={result} />
      {open && (
        <section className="panel">
          <h2>New session</h2>
          <Form method="post">
            <input type="hidden" name="intent" value="add" />
            <input type="hidden" name="requestId" value={data.requestId} />
            <div className="form-grid">
              <Field label="Class">
                <select
                  name="serviceId"
                  required
                  value={serviceId}
                  onChange={(event) => setServiceId(event.target.value)}
                >
                  <option value="">Choose a class</option>
                  {data.services
                    .filter((x) => x.status === "ACTIVE" && x.kind === "CLASS")
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Coach">
                <select name="coachId" required key={serviceId} defaultValue="">
                  <option value="">Choose an eligible coach</option>
                  {data.coaches
                    .filter((x) => coachIds.includes(x.id))
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field
                label={
                  "Date and start time (" +
                  (data.locations.find((x) => x.id === selected?.locationId)
                    ?.timezone || data.timezone) +
                  ")"
                }
              >
                <input type="datetime-local" name="localStart" required />
              </Field>
              <Field label="Repeat weekly">
                <select name="weeks" defaultValue="1">
                  <option value="1">This session only</option>
                  <option value="4">4 weeks</option>
                  <option value="8">8 weeks</option>
                  <option value="13">13 weeks</option>
                </select>
              </Field>
            </div>
            <div className="actions">
              <button className="primary" disabled={busy}>
                Save draft
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </Form>
        </section>
      )}
      <section className="panel">
        <div className="page-head">
          <h2>
            {week.toFormat("d MMM")} –{" "}
            {week.plus({ days: 6 }).toFormat("d MMM yyyy")}
          </h2>
          <Form method="post">
            <input type="hidden" name="intent" value="publish" />
            <input type="hidden" name="week" value={data.week} />
            <button
              disabled={
                busy || !data.sessions.some((x) => x.status === "DRAFT")
              }
            >
              Publish week
            </button>
          </Form>
        </div>
        {data.sessions.length === 0 && (
          <p className="empty">
            No sessions this week. Add a class to start planning.
          </p>
        )}
        {data.sessions.map((session) => (
          <article className="record" key={session.id}>
            <div>
              <h3>{session.service.name}</h3>
              <p className="muted">
                {DateTime.fromJSDate(new Date(session.startsAt), {
                  zone: data.timezone,
                }).toFormat("ccc d MMM · HH:mm")}{" "}
                · {session.coach.name} · {session.location.name} ·{" "}
                {session.capacity} places
              </p>
              <Status>{session.status}</Status>
            </div>
            {session.status === "DRAFT" && (
              <Form method="post">
                <input name="intent" type="hidden" value="remove" />
                <input name="id" type="hidden" value={session.id} />
                <button disabled={busy}>Remove draft</button>
              </Form>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
