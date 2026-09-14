import { z } from "zod";
import {
  data,
  Form,
  useLoaderData,
  useActionData,
  useNavigation,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import db from "../db.server";
import { adminContext } from "../services/context.server";
import { audit, lockShop } from "../services/catalog.server";
import { publicError } from "../lib/errors.server";
import { Feedback, Field } from "../components/admin-ui";
import {
  canTestCoachPortal,
  coachTestLogin,
} from "../services/coach-test-access.server";
const privateHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};
export const headers: HeadersFunction = ({ parentHeaders }) => {
  const result = new Headers(parentHeaders);
  for (const [name, value] of Object.entries(privateHeaders))
    result.set(name, value);
  return result;
};
export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  return data(
    {
      testAccessAvailable: canTestCoachPortal(actor, shop.domain),
      coaches: await db.coach.findMany({
        where: { shopId: actor.shopId },
        orderBy: { name: "asc" },
      }),
    },
    { headers: privateHeaders },
  );
}
export async function action({ request }: ActionFunctionArgs) {
  const { actor } = await adminContext(request);
  try {
    const form = await request.formData();
    if (form.get("intent") === "coach-test-login") {
      const coachId = z.string().uuid().parse(form.get("coachId"));
      return data(
        {
          message: "Test link ready. Open it within 15 minutes; it works once.",
          coachLoginUrl: await coachTestLogin(actor, coachId),
        },
        { headers: privateHeaders },
      );
    }
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        bufferBeforeMin: z.coerce.number().int().min(0).max(120),
        bufferAfterMin: z.coerce.number().int().min(0).max(120),
      })
      .parse(Object.fromEntries(form));
    await db.$transaction(async (tx) => {
      await lockShop(tx, actor.shopId);
      const coach = await tx.coach.create({
        data: { shopId: actor.shopId, ...input },
      });
      await audit(tx, actor, "COACH_CREATED", coach.id, null, coach);
    });
    return {
      message: "Coach added. Assign eligible classes in Classes & Passes.",
    };
  } catch (error) {
    return publicError(error);
  }
}
export default function People() {
  const { coaches, testAccessAvailable } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  return (
    <main className="workspace">
      <header className="page-head">
        <div>
          <h1>People</h1>
          <p className="muted">
            Manage the coaches available for your timetable.
          </p>
        </div>
      </header>
      <Feedback result={result} />
      {result && "coachLoginUrl" in result && (
        <p>
          <a
            className="button"
            href={result.coachLoginUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open coach test portal
          </a>
        </p>
      )}
      <section className="panel">
        <h2>Add coach</h2>
        <p className="muted">
          Buffers reserve preparation and recovery time around each class. They
          do not change the class time shown to customers.
        </p>
        <Form method="post">
          <div className="form-grid">
            <Field label="Public name">
              <input name="name" required minLength={2} maxLength={100} />
            </Field>
            <Field label="Buffer before (minutes)">
              <input
                name="bufferBeforeMin"
                type="number"
                min={0}
                max={120}
                defaultValue={0}
                required
              />
            </Field>
            <Field label="Buffer after (minutes)">
              <input
                name="bufferAfterMin"
                type="number"
                min={0}
                max={120}
                defaultValue={0}
                required
              />
            </Field>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy}>
              Add coach
            </button>
          </div>
        </Form>
      </section>
      <section className="panel">
        <h2>Coaches</h2>
        {testAccessAvailable && (
          <p className="muted">
            Development testing: create a one-time link to view a coach’s
            portal. Email invitations are not connected yet.
          </p>
        )}
        {coaches.length === 0 && <p className="empty">No coaches yet.</p>}
        {coaches.map((coach) => (
          <article className="record" key={coach.id}>
            <div>
              <h3>{coach.name}</h3>
              <p className="muted">
                {coach.bufferBeforeMin} min before · {coach.bufferAfterMin} min
                after
              </p>
            </div>
            {testAccessAvailable && coach.status === "ACTIVE" && (
              <Form method="post">
                <input type="hidden" name="intent" value="coach-test-login" />
                <input type="hidden" name="coachId" value={coach.id} />
                <button disabled={busy}>Create test sign-in link</button>
              </Form>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
