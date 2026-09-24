import { z } from "zod";
import {
  data,
  Form,
  useLoaderData,
  useActionData,
  useNavigation,
  useSearchParams,
  type HeadersFunction,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import db from "../db.server";
import {
  coachListData,
  coachPhoneInput,
  saveCoachPhone,
} from "../services/people.server";
import { adminContext } from "../services/context.server";
import { audit, lockShop } from "../services/catalog.server";
import { publicError } from "../lib/errors.server";
import { Feedback, Field } from "../components/admin-ui";
import {
  canTestCoachPortal,
  coachTestLogin,
} from "../services/coach-test-access.server";
import {
  bindCoachLoginEmail,
  coachSelfServiceReady,
  requestCoachEmailLogin,
} from "../services/coach-self-service.server";
import { reviewCoachAccount } from "../services/coach-account-requests.server";
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
      canBindLogin: actor.role === "ADMIN",
      emailSignInAvailable: coachSelfServiceReady(),
      accountRequests:
        actor.role === "ADMIN"
          ? await db.coachAccountRequest.findMany({
              where: { shopId: actor.shopId, status: "PENDING" },
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              take: 100,
            })
          : [],
      ...(await coachListData(
        actor,
        Number(new URL(request.url).searchParams.get("coachPage") || 1),
      )),
    },
    { headers: privateHeaders },
  );
}
export async function action({ request }: ActionFunctionArgs) {
  const { actor } = await adminContext(request);
  try {
    const form = await request.formData();
    if (form.get("intent") === "coach-phone") {
      await saveCoachPhone(
        actor,
        z.string().uuid().parse(form.get("coachId")),
        form.get("phone"),
      );
      return { message: "Coach phone saved." };
    }
    if (form.get("intent") === "review-coach-account") {
      const result = await reviewCoachAccount(
        actor,
        form.get("decision") === "approve"
          ? {
              requestId: form.get("requestId"),
              decision: "approve",
              coachId: form.get("coachId"),
            }
          : { requestId: form.get("requestId"), decision: "reject" },
      );
      let queued = false;
      if (result.approved && coachSelfServiceReady()) {
        try {
          await requestCoachEmailLogin(result.email);
          queued = true;
        } catch {
          /* Approval is durable; coach can request another link. */
        }
      }
      return {
        message: result.approved
          ? queued
            ? "Account approved. Activation email requested; the coach can also request a sign-in link on the login page."
            : "Account approved. Email delivery is not ready; configure it before the coach can verify and sign in."
          : "Account request rejected. No coach access was granted.",
      };
    }
    if (form.get("intent") === "coach-login-email") {
      const coachId = z.string().uuid().parse(form.get("coachId"));
      await bindCoachLoginEmail(
        actor,
        coachId,
        String(form.get("loginEmail") || ""),
      );
      return {
        message:
          "Login email authorization saved. This does not send an email. The coach must request a sign-in link on the coach sign-in page. Changing or clearing this email revokes existing access.",
      };
    }
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
    if (form.get("intent") === "coach-notification-email") {
      const input = z
        .object({
          intent: z.literal("coach-notification-email"),
          coachId: z.string().uuid(),
          notificationEmail: z
            .string()
            .trim()
            .toLowerCase()
            .email()
            .max(254)
            .or(z.literal("")),
        })
        .parse(Object.fromEntries(form));
      await db.$transaction(async (tx) => {
        await lockShop(tx, actor.shopId);
        const before = await tx.coach.findFirstOrThrow({
          where: { shopId: actor.shopId, id: input.coachId },
        });
        const coach = await tx.coach.update({
          where: { id: before.id },
          data: { notificationEmail: input.notificationEmail || null },
        });
        await audit(
          tx,
          actor,
          "COACH_NOTIFICATION_EMAIL_UPDATED",
          coach.id,
          { notificationEmail: before.notificationEmail },
          { notificationEmail: coach.notificationEmail },
        );
      });
      return { message: "Coach booking-notification email saved." };
    }
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        phone: coachPhoneInput.default(""),
        notificationEmail: z
          .string()
          .trim()
          .toLowerCase()
          .email()
          .max(254)
          .or(z.literal("")),
        bufferBeforeMin: z.coerce.number().int().min(0).max(120),
        bufferAfterMin: z.coerce.number().int().min(0).max(120),
      })
      .parse(Object.fromEntries(form));
    await db.$transaction(async (tx) => {
      await lockShop(tx, actor.shopId);
      const coach = await tx.coach.create({
        data: {
          shopId: actor.shopId,
          ...input,
          notificationEmail: input.notificationEmail || null,
          phone: input.phone || null,
        },
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
  const {
    coaches,
    coachOptions,
    pagination,
    testAccessAvailable,
    canBindLogin,
    emailSignInAvailable,
    accountRequests,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { page, pageSize, totalCount, totalPages } = pagination;
  function changePage(value: number) {
    const params = new URLSearchParams(searchParams);
    params.set("coachPage", String(value));
    setSearchParams(params, { preventScrollReset: true });
  }
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
      {canBindLogin && (
        <section className="panel" id="coach-account-requests">
          <h2>Coach account requests</h2>
          <p>
            <a href="/coach/login" target="_blank" rel="noopener noreferrer">
              Open coach sign-in / registration page
            </a>
          </p>
          <p className="muted">
            Coaches submit their own email on the login page. Approve only
            someone you recognize, and link them to their existing coach record.
            Approval does not create another coach or change their assigned
            classes.
          </p>
          {!accountRequests.length && (
            <p className="empty">No account requests awaiting approval.</p>
          )}
          {accountRequests.map((account) => (
            <article className="record" key={account.id}>
              <div>
                <h3>{account.name}</h3>
                <p>{account.email}</p>
                <span className="status-pill warn">Awaiting approval</span>
              </div>
              <Form method="post" className="coach-request-review">
                <input
                  type="hidden"
                  name="intent"
                  value="review-coach-account"
                />
                <input type="hidden" name="requestId" value={account.id} />
                <label className="field">
                  Existing coach record
                  <select
                    name="coachId"
                    aria-label={`Link ${account.name} to coach`}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Choose a coach
                    </option>
                    {coachOptions.map((coach) => (
                      <option key={coach.id} value={coach.id}>
                        {coach.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  name="decision"
                  value="approve"
                  className="primary"
                  disabled={busy}
                >
                  Approve login
                </button>
                <button name="decision" value="reject" disabled={busy}>
                  Reject
                </button>
              </Form>
            </article>
          ))}
        </section>
      )}
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
            <Field label="Booking-notification email">
              <input
                name="notificationEmail"
                type="email"
                maxLength={254}
                placeholder="coach@example.com"
              />
            </Field>
            <Field label="Phone">
              <input name="phone" type="tel" maxLength={40} />
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
      <section className="panel" aria-label="Coaches">
        <div className="catalog-list-head notification-head">
          <h2>Coaches</h2>
          <p className="muted" role="status" aria-live="polite">
            {totalCount
              ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, totalCount)} of ${totalCount}`
              : "0 coaches"}{" "}
            · 8 per page
          </p>
        </div>
        <p className="muted">
          Login email grants access after verification. Booking-notification
          email is separate and does not grant access.{" "}
          {emailSignInAvailable
            ? "Email sign-in transport is configured."
            : "Email sign-in transport is not configured yet."}
        </p>
        <details className="booking-email-help">
          <summary>How does coach login activation work?</summary>
          <p className="muted">
            Admin saves an authorized login email below. The coach then opens
            the{" "}
            <a href="/coach/login" target="_blank" rel="noopener noreferrer">
              coach sign-in page
            </a>
            , requests a link using that email, and follows the email link to
            verify and sign in. The login status then changes to Verified
            automatically. Coach scheduling status is separate.
          </p>
          {!emailSignInAvailable && (
            <p className="muted">
              Email verification is currently unavailable. Configure the
              server’s coach sign-in mail service before coaches can activate by
              email.
            </p>
          )}
        </details>
        {testAccessAvailable && (
          <p className="muted">
            Development testing: create a one-time link to view a coach’s
            portal. Email invitations are not connected yet.
          </p>
        )}
        {coaches.length === 0 && <p className="empty">No coaches yet.</p>}
        {coaches.map((coach) => (
          <article className="record coach-record" key={coach.id}>
            <div className="coach-record-details">
              <h3>{coach.name}</h3>
              <p className="muted">
                {coach.bufferBeforeMin} min before · {coach.bufferAfterMin} min
                after
              </p>
              <div className="coach-email-settings">
                <Form method="post" className="coach-email-setting">
                  <input type="hidden" name="intent" value="coach-phone" />
                  <input type="hidden" name="coachId" value={coach.id} />
                  <label className="field">
                    <span>Phone for {coach.name}</span>
                    <input
                      name="phone"
                      type="tel"
                      maxLength={40}
                      defaultValue={coach.phone || ""}
                    />
                  </label>
                  <div className="actions">
                    <button disabled={busy}>Save phone</button>
                  </div>
                </Form>
                {canBindLogin && coach.status === "ACTIVE" && (
                  <Form method="post" className="coach-email-setting">
                    <input
                      type="hidden"
                      name="intent"
                      value="coach-login-email"
                    />
                    <input type="hidden" name="coachId" value={coach.id} />
                    <div className="coach-email-setting-head">
                      <strong>Authorized login email</strong>
                      <span className="muted">
                        {coach.loginVerifiedAt
                          ? "Verified"
                          : coach.loginEmail
                            ? "Awaiting email verification"
                            : "Not authorized"}
                      </span>
                    </div>
                    <p className="muted">
                      Authorizing saves access permission without sending an
                      email. The coach must request a link on the{" "}
                      <a
                        href="/coach/login"
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        coach sign-in page
                      </a>{" "}
                      to verify and sign in.
                    </p>
                    <label className="field">
                      <span className="visually-hidden">
                        Authorized login email for {coach.name}
                      </span>
                      <input
                        name="loginEmail"
                        type="email"
                        maxLength={254}
                        defaultValue={coach.loginEmail || ""}
                        placeholder="Not authorized"
                      />
                    </label>
                    <div className="actions">
                      <button disabled={busy}>Authorize login email</button>
                    </div>
                  </Form>
                )}
                <Form
                  method="post"
                  className="coach-email-setting coach-email-setting-notification"
                >
                  <input
                    type="hidden"
                    name="intent"
                    value="coach-notification-email"
                  />
                  <input type="hidden" name="coachId" value={coach.id} />
                  <div className="coach-email-setting-head">
                    <strong>Booking-notification email</strong>
                  </div>
                  <p className="muted">
                    Receives booking updates; does not grant login access.
                  </p>
                  <label className="field">
                    <span className="visually-hidden">
                      Booking-notification email for {coach.name}
                    </span>
                    <input
                      name="notificationEmail"
                      type="email"
                      maxLength={254}
                      defaultValue={coach.notificationEmail || ""}
                      placeholder="Not configured"
                    />
                  </label>
                  <div className="actions">
                    <button disabled={busy}>Save email</button>
                  </div>
                </Form>
              </div>
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
      {totalCount > 0 && (
        <nav className="catalog-pagination" aria-label="Coaches pagination">
          <div className="catalog-page-controls">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => changePage(page - 1)}
            >
              Previous
            </button>
            <span
              className="catalog-page-count"
              role="status"
              aria-live="polite"
            >
              <span className="visually-hidden">Page </span>
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page === totalPages}
              onClick={() => changePage(page + 1)}
            >
              Next
            </button>
          </div>
          <form
            className="catalog-page-jump"
            onSubmit={(event) => {
              event.preventDefault();
              const target = Number(
                new FormData(event.currentTarget).get("page"),
              );
              if (
                Number.isInteger(target) &&
                target >= 1 &&
                target <= totalPages
              )
                changePage(target);
            }}
          >
            <label htmlFor="coach-page">Go to page</label>
            <input
              key={`${page}:${totalPages}`}
              id="coach-page"
              name="page"
              type="number"
              inputMode="numeric"
              min={1}
              max={totalPages}
              step={1}
              required
              defaultValue={page}
            />
            <button type="submit">Go</button>
          </form>
        </nav>
      )}
    </main>
  );
}
