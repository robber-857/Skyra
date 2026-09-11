import { z } from "zod";
import { DateTime } from "luxon";
import {
  Form,
  useLoaderData,
  useActionData,
  useNavigation,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import db from "../db.server";
import { adminContext } from "../services/context.server";
import { audit, lockShop } from "../services/catalog.server";
import { publicError } from "../lib/errors.server";
import { Feedback, Field } from "../components/admin-ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  const rules = shop.rules as Record<string, unknown>;
  return {
    locations: await db.location.findMany({ where: { shopId: actor.shopId } }),
    rulesApproved: Boolean(shop.rulesApprovedAt),
    seatHoldMinutes:
      typeof rules.seatHoldMinutes === "number" ? rules.seatHoldMinutes : null,
    bookingWindowDays:
      typeof rules.bookingWindowDays === "number" ? rules.bookingWindowDays : null,
    bookingClosesBeforeMinutes:
      typeof rules.bookingClosesBeforeMinutes === "number"
        ? rules.bookingClosesBeforeMinutes
        : null,
    freeCancellationHours:
      typeof rules.freeCancellationHours === "number"
        ? rules.freeCancellationHours
        : null,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { actor } = await adminContext(request);
  try {
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        timezone: z
          .string()
          .refine(
            (zone) => DateTime.now().setZone(zone).isValid,
            "Enter an IANA timezone.",
          ),
      })
      .parse(Object.fromEntries(await request.formData()));
    await db.$transaction(async (tx) => {
      await lockShop(tx, actor.shopId);
      const location = await tx.location.upsert({
        where: { shopId_name: { shopId: actor.shopId, name: input.name } },
        create: { shopId: actor.shopId, ...input },
        update: {},
      });
      await audit(tx, actor, "LOCATION_CREATED", location.id, null, location);
    });
    return { message: "Location saved." };
  } catch (error) {
    return publicError(error);
  }
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const { locations } = data;
  const busy = useNavigation().state !== "idle";
  return (
    <main className="workspace">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Locations and booking readiness.</p>
        </div>
      </header>
      <Feedback result={useActionData<typeof action>()} />
      <p className="feedback">
        {data.rulesApproved
          ? "Class booking rules are approved. Customer reservations stay disabled until the booking engine and checkout recovery are complete."
          : "Booking rules are awaiting business approval. Customer reservations and checkout are not enabled."}
      </p>
      {data.rulesApproved && (
        <section className="panel">
          <h2>Class booking rules</h2>
          <ul>
            <li>Booking opens {data.bookingWindowDays} days before class.</li>
            <li>
              Booking closes {data.bookingClosesBeforeMinutes} minutes before
              class.
            </li>
            <li>
              Free cancellation ends {data.freeCancellationHours} hours before
              class.
            </li>
            <li>
              New Pass checkout holds a seat for {data.seatHoldMinutes} minutes.
            </li>
            <li>
              Paid orders received after an expired hold go to Needs Attention;
              capacity is never exceeded.
            </li>
          </ul>
        </section>
      )}
      <section className="panel">
        <h2>Add location</h2>
        <Form method="post">
          <div className="form-grid">
            <Field label="Location name">
              <input name="name" required minLength={2} maxLength={100} />
            </Field>
            <Field label="Timezone">
              <input name="timezone" required defaultValue="Australia/Sydney" />
            </Field>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy}>
              Save location
            </button>
          </div>
        </Form>
      </section>
      <section className="panel">
        <h2>Locations</h2>
        {locations.length === 0 && <p className="empty">No locations yet.</p>}
        {locations.map((location) => (
          <article className="record" key={location.id}>
            <div>
              <h3>{location.name}</h3>
              <p className="muted">{location.timezone}</p>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}