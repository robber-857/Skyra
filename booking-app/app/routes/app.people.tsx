import { z } from "zod";
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
  const { actor } = await adminContext(request);
  return {
    coaches: await db.coach.findMany({
      where: { shopId: actor.shopId },
      orderBy: { name: "asc" },
    }),
  };
}
export async function action({ request }: ActionFunctionArgs) {
  const { actor } = await adminContext(request);
  try {
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        bufferBeforeMin: z.coerce.number().int().min(0).max(120),
        bufferAfterMin: z.coerce.number().int().min(0).max(120),
      })
      .parse(Object.fromEntries(await request.formData()));
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
  const { coaches } = useLoaderData<typeof loader>();
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
      <Feedback result={useActionData<typeof action>()} />
      <section className="panel">
        <h2>Add coach</h2>
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
          </article>
        ))}
      </section>
    </main>
  );
}
