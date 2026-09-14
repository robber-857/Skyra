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
import { DomainError, publicError } from "../lib/errors.server";
import {
  commerceCapabilities,
  developmentReleaseReady,
  isDevelopmentBookingShop,
} from "../services/commerce-capabilities.server";
import { Feedback, Field } from "../components/admin-ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  const rules = shop.rules as Record<string, unknown>;
  const capabilities = commerceCapabilities(shop.domain);
  return {
    locations: await db.location.findMany({ where: { shopId: actor.shopId } }),
    rulesApproved: Boolean(shop.rulesApprovedAt),
    seatHoldMinutes:
      typeof rules.seatHoldMinutes === "number" ? rules.seatHoldMinutes : null,
    bookingWindowDays:
      typeof rules.bookingWindowDays === "number"
        ? rules.bookingWindowDays
        : null,
    bookingClosesBeforeMinutes:
      typeof rules.bookingClosesBeforeMinutes === "number"
        ? rules.bookingClosesBeforeMinutes
        : null,
    freeCancellationHours:
      typeof rules.freeCancellationHours === "number"
        ? rules.freeCancellationHours
        : null,
    developmentReleaseTarget: isDevelopmentBookingShop(shop.domain),
    checkoutGateOpen: capabilities.checkoutAvailable,
    ownedPassesGateOpen: capabilities.ownedPassesAvailable,
    onlineBookingsEnabled: rules.onlineBookingsEnabled === true,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  try {
    const formData = await request.formData();
    if (formData.get("intent") === "development-booking") {
      if (actor.role !== "ADMIN")
        throw new DomainError(
          "FORBIDDEN",
          "Only the store owner can change the development booking release.",
          403,
        );
      if (!isDevelopmentBookingShop(shop.domain))
        throw new DomainError(
          "FORBIDDEN",
          "Development booking controls are unavailable for this store.",
          403,
        );
      const enabled =
        z.enum(["true", "false"]).parse(formData.get("enabled")) === "true";
      if (enabled && !developmentReleaseReady(shop.domain))
        throw new DomainError(
          "RELEASE_GATE_CLOSED",
          "Open both Render development gates before enabling online bookings.",
          409,
        );
      await db.$transaction(async (tx) => {
        await lockShop(tx, actor.shopId);
        const current = await tx.shop.findUniqueOrThrow({
          where: { id: actor.shopId },
        });
        const before = current.rules as Record<string, unknown>;
        if (
          enabled &&
          (!current.rulesApprovedAt ||
            before.bookingWindowDays !== 14 ||
            before.bookingClosesBeforeMinutes !== 120 ||
            before.seatHoldMinutes !== 15)
        )
          throw new DomainError(
            "RULES_NOT_READY",
            "Approve the booking window and hold rules before enabling bookings.",
            409,
          );
        const after = { ...before, onlineBookingsEnabled: enabled };
        await tx.shop.update({
          where: { id: actor.shopId },
          data: { rules: after },
        });
        await audit(
          tx,
          actor,
          enabled
            ? "DEVELOPMENT_BOOKING_ENABLED"
            : "DEVELOPMENT_BOOKING_DISABLED",
          actor.shopId,
          before,
          after,
        );
      });
      return {
        message: enabled
          ? "Development-store online booking enabled."
          : "Development-store online booking disabled.",
      };
    }
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
      .parse(Object.fromEntries(formData));
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
      {data.developmentReleaseTarget && (
        <section className="panel">
          <h2>Development booking release</h2>
          <p className="muted">
            These controls apply only to skyra-booking-dev.myshopify.com.
            Production stores stay blocked in code.
          </p>
          <ul>
            <li>
              Shopify Checkout gate: {data.checkoutGateOpen ? "open" : "closed"}
            </li>
            <li>
              Existing Pass gate: {data.ownedPassesGateOpen ? "open" : "closed"}
            </li>
            <li>
              Online booking rule:{" "}
              {data.onlineBookingsEnabled ? "open" : "closed"}
            </li>
          </ul>
          <Form method="post">
            <input type="hidden" name="intent" value="development-booking" />
            <input
              type="hidden"
              name="enabled"
              value={data.onlineBookingsEnabled ? "false" : "true"}
            />
            <button
              className="primary"
              disabled={
                busy ||
                (!data.onlineBookingsEnabled &&
                  (!data.checkoutGateOpen || !data.ownedPassesGateOpen))
              }
            >
              {data.onlineBookingsEnabled
                ? "Disable development bookings"
                : "Enable development bookings"}
            </button>
          </Form>
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
