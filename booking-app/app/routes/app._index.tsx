import { useLoaderData, Link, type LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { adminContext } from "../services/context.server";
export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  const [classes, passes, drafts, errors] = await Promise.all([
    db.service.count({ where: { shopId: actor.shopId } }),
    db.passPlan.count({ where: { shopId: actor.shopId } }),
    db.classSession.count({ where: { shopId: actor.shopId, status: "DRAFT" } }),
    db.productMapping.count({
      where: { shopId: actor.shopId, syncStatus: "ERROR" },
    }),
  ]);
  return {
    classes,
    passes,
    drafts,
    errors,
    rulesApproved: Boolean(shop.rulesApprovedAt),
  };
}
export default function Overview() {
  const data = useLoaderData<typeof loader>();
  return (
    <main className="workspace">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">
            Prepare your classes, passes and weekly timetable.
          </p>
        </div>
        <Link to="/app/settings">Settings</Link>
      </header>
      <section className="panel summary" aria-label="Setup summary">
        <div>
          <strong>{data.classes}</strong>Classes
        </div>
        <div>
          <strong>{data.passes}</strong>Passes
        </div>
        <div>
          <strong>{data.drafts}</strong>Draft sessions
        </div>
        <div>
          <strong>{data.errors}</strong>Sync errors
        </div>
      </section>
      {!data.rulesApproved && (
        <p className="feedback">
          Online bookings are closed while booking and cancellation rules are
          being confirmed.
        </p>
      )}
      <section className="panel">
        <h2>Set up your timetable</h2>
        <p className="muted">
          Add coaches and locations, define classes and passes, then assign
          actual dates and times.
        </p>
        <div className="actions">
          <Link className="button" to="/app/people">
            Add coaches
          </Link>
          <Link className="button" to="/app/catalog">
            Classes &amp; Passes
          </Link>
          <Link className="button" to="/app/schedule">
            Weekly Schedule
          </Link>
        </div>
      </section>
    </main>
  );
}
