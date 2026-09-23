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
  updateSession,
} from "../services/schedule.server";
import { publicError } from "../lib/errors.server";
import { Feedback, Field, Status } from "../components/admin-ui";
import {
  SCHEDULE_MIN_DATE,
  SCHEDULE_MAX_DATE,
  SCHEDULE_MIN_LOCAL_START,
  SCHEDULE_MAX_LOCAL_START,
} from "../lib/schedule-range";

const periods = [
  { key: "morning", label: "Morning", start: 0, end: 12 },
  { key: "afternoon", label: "Afternoon", start: 12, end: 17 },
  { key: "evening", label: "Evening", start: 17, end: 24 },
] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  const day =
    new URL(request.url).searchParams.get("week") ||
    DateTime.now().setZone(shop.timezone).toISODate()!;
  return {
    ...(await scheduleData(actor.shopId, day)),
    ...(await catalogData(actor.shopId)),
    editId: new URL(request.url).searchParams.get("edit"),
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
    if (form.get("intent") === "update") {
      await updateSession(actor, Object.fromEntries(form));
      return { message: "Session updated." };
    }
    if (form.get("intent") === "copy")
      return {
        message:
          (await copyPreviousWeek(actor, String(form.get("week")))) +
          " draft session(s) copied.",
      };
    if (form.get("intent") === "publish") {
      const publication = await publishWeek(actor, String(form.get("week")));
      return {
        message:
          publication.published +
          " session(s) published." +
          (publication.skipped.length
            ? " " +
              publication.skipped.length +
              " past session(s) skipped and kept as draft."
            : ""),
        skipped: publication.skipped,
      };
    }
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
  const [editingId, setEditingId] = useState<string | null>(data.editId);
  const [editServiceId, setEditServiceId] = useState(
    data.sessions.find((session) => session.id === data.editId)?.serviceId ||
      "",
  );
  const [coachFilter, setCoachFilter] = useState("");
  const activeCoachIds = new Set(
    data.coaches
      .filter((coach) => coach.status === "ACTIVE")
      .map((coach) => coach.id),
  );
  const readyServices = data.services.filter(
    (service) =>
      service.status === "ACTIVE" &&
      service.requestedPriceCents > 0 &&
      service.coaches.some((assignment) =>
        activeCoachIds.has(assignment.coachId),
      ),
  );
  const pendingServices = data.services.filter(
    (service) =>
      service.status !== "INACTIVE" && !readyServices.includes(service),
  );
  const setupReason = (service: (typeof data.services)[number]) =>
    [
      service.requestedPriceCents <= 0 && "price needed",
      !service.coaches.some((assignment) =>
        activeCoachIds.has(assignment.coachId),
      ) && "assign a coach",
      service.status !== "ACTIVE" && "activate when ready",
    ]
      .filter(Boolean)
      .join(" · ");
  const selected = data.services.find((x) => x.id === serviceId);
  const coachIds = selected?.coaches.map((x) => x.coachId) || [];
  const editing = data.sessions.find((x) => x.id === editingId);
  const editService = data.services.find((x) => x.id === editServiceId);
  const editCoachIds = editService?.coaches.map((x) => x.coachId) || [];
  const week = DateTime.fromISO(data.week, { zone: data.timezone });
  const firstWeek = DateTime.fromISO(SCHEDULE_MIN_DATE)
    .startOf("week")
    .toISODate()!;
  const lastWeek = DateTime.fromISO(SCHEDULE_MAX_DATE)
    .startOf("week")
    .toISODate()!;
  const dateWithinRange = (date: string) =>
    date < SCHEDULE_MIN_DATE
      ? SCHEDULE_MIN_DATE
      : date > SCHEDULE_MAX_DATE
        ? SCHEDULE_MAX_DATE
        : date;
  const days = Array.from({ length: 7 }, (_, index) =>
    week.plus({ days: index }),
  );
  const visibleSessions = data.sessions.filter(
    (session) => !coachFilter || session.coachId === coachFilter,
  );
  const drafts = data.sessions.filter((x) => x.status === "DRAFT").length;
  const published = data.sessions.filter(
    (x) => x.status === "PUBLISHED",
  ).length;

  const localStart = (value: Date | string, zone = data.timezone) =>
    DateTime.fromJSDate(new Date(value), { zone });

  const sessionButton = (session: (typeof data.sessions)[number]) => {
    const start = localStart(session.startsAt, session.timezone);
    return (
      <Link
        className={`calendar-event ${session.status === "DRAFT" ? "draft" : "published"}`}
        to={`/app/schedule/${session.id}`}
        aria-label={`View details for ${session.service.name}, ${start.toFormat("cccc h:mm a")}`}
      >
        <span className="calendar-event-time">{start.toFormat("HH:mm")}</span>
        <strong>{session.service.name}</strong>
        <span>
          {session.service.kind === "APPOINTMENT"
            ? "Private appointment"
            : session.service.kind === "COURSE"
              ? "Workshop"
              : "Group class"}
          {" · "}
          {session.coach.name}
        </span>
        <span>
          {session.enrolled}/{session.capacity} enrolled · {session.status}
        </span>
      </Link>
    );
  };

  return (
    <main className="workspace">
      <header className="page-head">
        <div>
          <h1>Weekly Schedule</h1>
          <p className="muted">
            Click any class to view session details and enrolled students. Times
            shown in {data.timezone}.
          </p>
        </div>
        <button
          className="primary"
          onClick={() => {
            setEditingId(null);
            setOpen(true);
          }}
        >
          Add session
        </button>
      </header>

      <section
        className="schedule-purpose"
        aria-label="Weekly schedule purpose"
      >
        <strong>Your week at a glance</strong>
        <span>
          Configure a class and its eligible coaches in Classes &amp; Passes,
          then choose a coach, date and time here. Published sessions feed the
          website Booking section when online booking is open.
        </span>
      </section>

      {pendingServices.length > 0 && (
        <details className="panel" aria-label="Classes awaiting setup">
          <summary>{pendingServices.length} classes awaiting setup</summary>
          <p className="muted">
            Your class catalogue is already here. Complete the price and coach
            assignment, then set the class to ACTIVE before scheduling.
          </p>
          <ul>
            {pendingServices.map((service) => (
              <li key={service.id}>
                <Link to={`/app/catalog?edit=${service.id}`}>
                  {service.name}
                </Link>
                {" — "}
                {setupReason(service)}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="schedule-toolbar">
        <div className="week-bar">
          {data.week > firstWeek ? (
            <Link
              className="button"
              to={
                "?week=" +
                dateWithinRange(week.minus({ weeks: 1 }).toISODate()!)
              }
            >
              Previous week
            </Link>
          ) : (
            <button disabled>Previous week</button>
          )}
          <Form method="get" className="week-picker">
            <label>
              <span className="visually-hidden">Week starting date</span>
              <input
                type="date"
                name="week"
                min={SCHEDULE_MIN_DATE}
                max={SCHEDULE_MAX_DATE}
                defaultValue={dateWithinRange(data.week)}
                key={data.week}
                required
              />
            </label>
            <button>Go</button>
          </Form>
          {data.week < lastWeek ? (
            <Link
              className="button"
              to={
                "?week=" + dateWithinRange(week.plus({ weeks: 1 }).toISODate()!)
              }
            >
              Next week
            </Link>
          ) : (
            <button disabled>Next week</button>
          )}
          <label className="coach-filter">
            <span className="visually-hidden">Filter by coach</span>
            <select
              value={coachFilter}
              onChange={(event) => setCoachFilter(event.target.value)}
            >
              <option value="">All coaches</option>
              {data.coaches
                .filter((coach) => coach.status === "ACTIVE")
                .map((coach) => (
                  <option key={coach.id} value={coach.id}>
                    {coach.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="schedule-actions">
          <Form method="post">
            <input type="hidden" name="intent" value="copy" />
            <input type="hidden" name="week" value={data.week} />
            <button disabled={busy}>Copy previous week</button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value="publish" />
            <input type="hidden" name="week" value={data.week} />
            <button className="primary" disabled={busy || drafts === 0}>
              Publish week
            </button>
          </Form>
        </div>
      </div>

      <Feedback result={result} />
      {result &&
        "skipped" in result &&
        result.skipped &&
        result.skipped.length > 0 && (
          <section className="panel" aria-label="Skipped sessions">
            <h2>Skipped sessions</h2>
            <ul>
              {result.skipped.map((session) => (
                <li key={session.id}>
                  <Link to={"/app/schedule/" + session.id}>
                    {session.className}
                  </Link>
                  {" · " +
                    DateTime.fromISO(session.startsAt, {
                      zone: session.timezone,
                    }).toFormat("d LLL yyyy · h:mm a") +
                    " · " +
                    session.timezone +
                    " — " +
                    session.reason}
                </li>
              ))}
            </ul>
          </section>
        )}

      <section className="panel schedule-calendar-panel">
        <div className="schedule-calendar-head">
          <div>
            <h2>
              {week.toFormat("d MMM")} –{" "}
              {week.plus({ days: 6 }).toFormat("d MMM yyyy")}
            </h2>
            <p className="muted">
              {published} published · {drafts} draft · Click a class for details
            </p>
          </div>
          {coachFilter && (
            <button type="button" onClick={() => setCoachFilter("")}>
              Clear coach filter
            </button>
          )}
        </div>

        {data.sessions.length === 0 ? (
          <p className="empty">
            No sessions this week.{" "}
            {readyServices.length
              ? "Add a session to start planning."
              : "Complete a class in Classes & Passes to start planning."}
          </p>
        ) : (
          <>
            <div className="schedule-calendar-scroll">
              <div
                className="schedule-calendar"
                role="grid"
                aria-label="Week calendar"
              >
                <div className="calendar-corner" role="columnheader">
                  Time
                </div>
                {days.map((day) => (
                  <div
                    className="calendar-day-head"
                    role="columnheader"
                    key={day.toISODate()}
                  >
                    <span>{day.toFormat("ccc")}</span>
                    <strong>{day.toFormat("d")}</strong>
                  </div>
                ))}
                {periods.map((period) => (
                  <div className="calendar-row" role="row" key={period.key}>
                    <div className="calendar-period" role="rowheader">
                      {period.label}
                    </div>
                    {days.map((day) => {
                      const sessions = visibleSessions.filter((session) => {
                        const start = localStart(
                          session.startsAt,
                          session.timezone,
                        );
                        return (
                          start.toISODate() === day.toISODate() &&
                          start.hour >= period.start &&
                          start.hour < period.end
                        );
                      });
                      return (
                        <div
                          className="calendar-cell"
                          role="gridcell"
                          key={day.toISODate()}
                        >
                          {sessions.map((session) => (
                            <div key={session.id}>{sessionButton(session)}</div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div className="schedule-agenda" aria-label="Mobile week agenda">
              {days.map((day) => {
                const sessions = visibleSessions.filter(
                  (session) =>
                    localStart(
                      session.startsAt,
                      session.timezone,
                    ).toISODate() === day.toISODate(),
                );
                return (
                  <section className="agenda-day" key={day.toISODate()}>
                    <h3>{day.toFormat("cccc d MMM")}</h3>
                    {sessions.length ? (
                      sessions.map((session) => (
                        <div key={session.id}>{sessionButton(session)}</div>
                      ))
                    ) : (
                      <p className="muted">No sessions</p>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )}
      </section>

      {editing && (
        <section className="panel schedule-editor" id="schedule-editor">
          <div className="schedule-calendar-head">
            <div>
              <h2>Edit session</h2>
              <p className="muted">
                {editing.status} · {editing.occupied}/{editing.capacity} places
                occupied
              </p>
            </div>
            <Status>{editing.status}</Status>
          </div>
          <Form method="post" key={`${editing.id}-${editing.version}`}>
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="id" value={editing.id} />
            <input type="hidden" name="version" value={editing.version} />
            <div className="form-grid">
              <Field label="Class">
                <select
                  name={editing.occupied > 0 ? undefined : "serviceId"}
                  required
                  value={editServiceId}
                  disabled={editing.occupied > 0}
                  onChange={(event) => setEditServiceId(event.target.value)}
                >
                  {data.services
                    .filter(
                      (service) =>
                        readyServices.includes(service) ||
                        service.id === editing.serviceId,
                    )
                    .map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name} ·{" "}
                        {service.kind === "APPOINTMENT"
                          ? "Private"
                          : service.kind === "COURSE"
                            ? "Workshop"
                            : "Group"}
                      </option>
                    ))}
                </select>
                {editing.occupied > 0 && (
                  <>
                    <input
                      type="hidden"
                      name="serviceId"
                      value={editing.serviceId}
                    />
                    <small>
                      Class type is locked after a booking or checkout hold.
                    </small>
                  </>
                )}
              </Field>
              <Field label="Coach">
                <select name="coachId" required defaultValue={editing.coachId}>
                  {data.coaches
                    .filter(
                      (coach) =>
                        coach.status === "ACTIVE" &&
                        editCoachIds.includes(coach.id),
                    )
                    .map((coach) => (
                      <option key={coach.id} value={coach.id}>
                        {coach.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field
                label={`Date and start time (${data.locations.find((location) => location.id === editService?.locationId)?.timezone || editing.timezone})`}
              >
                <input
                  type="datetime-local"
                  name="localStart"
                  min={SCHEDULE_MIN_LOCAL_START}
                  max={SCHEDULE_MAX_LOCAL_START}
                  required
                  defaultValue={localStart(
                    editing.startsAt,
                    editing.timezone,
                  ).toFormat("yyyy-MM-dd'T'HH:mm")}
                />
              </Field>
              <Field label="Capacity">
                <input
                  type="number"
                  name="capacity"
                  min={Math.max(1, editing.occupied)}
                  max="200"
                  required
                  defaultValue={editing.capacity}
                />
              </Field>
            </div>
            <div className="actions">
              <button className="primary" disabled={busy}>
                Save changes
              </button>
              <button type="button" onClick={() => setEditingId(null)}>
                Close
              </button>
            </div>
          </Form>
          {editing.status === "DRAFT" && (
            <Form method="post" className="schedule-remove-form">
              <input name="intent" type="hidden" value="remove" />
              <input name="id" type="hidden" value={editing.id} />
              <button className="danger-text" disabled={busy}>
                Remove draft
              </button>
            </Form>
          )}
        </section>
      )}

      {open && (
        <section className="panel schedule-editor">
          <h2>New session</h2>
          {readyServices.length === 0 && (
            <p className="muted">
              No classes are ready to schedule yet.{" "}
              <Link to="/app/catalog">
                Assign coaches and confirm prices in Classes &amp; Passes.
              </Link>
            </p>
          )}
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
                  {readyServices.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name} ·{" "}
                      {service.kind === "APPOINTMENT"
                        ? "Private"
                        : service.kind === "COURSE"
                          ? "Workshop"
                          : "Group"}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Coach">
                <select name="coachId" required key={serviceId} defaultValue="">
                  <option value="">Choose an eligible coach</option>
                  {data.coaches
                    .filter(
                      (coach) =>
                        coach.status === "ACTIVE" &&
                        coachIds.includes(coach.id),
                    )
                    .map((coach) => (
                      <option key={coach.id} value={coach.id}>
                        {coach.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field
                label={`Date and start time (${
                  data.locations.find(
                    (location) => location.id === selected?.locationId,
                  )?.timezone || data.timezone
                })`}
              >
                <input
                  type="datetime-local"
                  name="localStart"
                  min={SCHEDULE_MIN_LOCAL_START}
                  max={SCHEDULE_MAX_LOCAL_START}
                  required
                  defaultValue={`${dateWithinRange(data.week)}T10:00`}
                />
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
              <button
                className="primary"
                disabled={busy || readyServices.length === 0}
              >
                Save draft
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          </Form>
        </section>
      )}
    </main>
  );
}
