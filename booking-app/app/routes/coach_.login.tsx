import { useEffect, useState } from "react";
import {
  data,
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
} from "react-router";
import {
  coachCookie,
  exchangeCoachLogin,
  requireCoachFormOrigin,
} from "../services/coach-auth.server";
import { DomainError } from "../lib/errors.server";
import {
  coachSelfServiceReady,
  requestCoachEmailLogin,
} from "../services/coach-self-service.server";
import { z } from "zod";
import {
  coachRegistrationAvailable,
  requestCoachAccount,
} from "../services/coach-account-requests.server";
import styles from "../styles/admin.css?url";
export const links = () => [{ rel: "stylesheet", href: styles }];
export const headers = () => ({
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "same-origin",
});
export const loader = async () =>
  data(
    {
      emailSignInAvailable: coachSelfServiceReady(),
      registrationAvailable: await coachRegistrationAvailable(),
    },
    { headers: headers() },
  );
export async function action({ request }: ActionFunctionArgs) {
  requireCoachFormOrigin(request);
  try {
    const form = await request.formData();
    if (form.get("intent") === "request-account") {
      if (!form.get("website"))
        await requestCoachAccount({
          name: String(form.get("name") || ""),
          email: String(form.get("email") || ""),
        });
      return data(
        {
          message:
            "Request received. The studio Admin will review your name and email in People. You cannot access a roster until approved and your email is verified.",
        },
        { status: 202, headers: headers() },
      );
    }
    if (form.get("intent") === "request-email-login") {
      await requestCoachEmailLogin(String(form.get("email") || ""));
      return data(
        {
          message:
            "If this email is authorized by Skyra, a sign-in link will arrive shortly. Check your inbox and spam folder.",
        },
        { status: 202, headers: headers() },
      );
    }
    const token = await exchangeCoachLogin(String(form.get("token") || ""));
    return redirect("/coach", {
      headers: { ...headers(), "Set-Cookie": coachCookie(token) },
    });
  } catch (error) {
    if (error instanceof DomainError)
      return data(
        {
          error: ["MAIL_NOT_CONFIGURED", "REGISTRATION_UNAVAILABLE"].includes(
            error.code,
          )
            ? error.message
            : "This sign-in link has expired or was already used. Request a new link.",
        },
        { status: error.status, headers: headers() },
      );
    if (error instanceof z.ZodError)
      return data(
        {
          error:
            "Enter your name (2–100 characters) and a valid email address.",
        },
        { status: 422, headers: headers() },
      );
    throw error;
  }
}
export default function CoachLogin() {
  const [token, setToken] = useState("");
  useEffect(() => {
    const readLink = () => {
      const value =
        new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
      if (/^[A-Za-z0-9_-]{43}$/.test(value)) {
        setToken(value);
        window.history.replaceState(null, "", "/coach/login");
      }
    };
    readLink();
    window.addEventListener("hashchange", readLink);
    return () => window.removeEventListener("hashchange", readLink);
  }, []);
  const result = useActionData<typeof action>();
  const { emailSignInAvailable, registrationAvailable } =
    useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";
  return (
    <main className="workspace coach-login-workspace">
      <section className="panel">
        <p className="muted">SKYRA · COACH</p>
        <h1>Your coach portal</h1>
        {result && "error" in result && (
          <p role="alert" className="feedback error">
            {result.error}
          </p>
        )}
        {result && "message" in result && <p role="status">{result.message}</p>}
        {token ? (
          <form method="post" action="/coach/login">
            <input type="hidden" name="token" value={token} />
            <p>Continue to view your classes and registration counts.</p>
            <button className="primary">Continue to my schedule</button>
          </form>
        ) : (
          <>
            <p>
              View your classes, weekly schedule and students’ Training
              profiles. No password or Shopify Admin account is needed.
            </p>
            {emailSignInAvailable ? (
              <Form method="post" className="form-grid">
                <input
                  type="hidden"
                  name="intent"
                  value="request-email-login"
                />
                <label>
                  Email
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                  />
                </label>
                <div className="actions">
                  <button className="primary" disabled={busy}>
                    {busy ? "Requesting…" : "Email me a sign-in link"}
                  </button>
                </div>
              </Form>
            ) : (
              <p className="muted">
                Email activation is not connected yet. Contact Skyra for access.
              </p>
            )}
            <hr />
            <h2>New coach? Request an account</h2>
            <p className="muted">
              Enter your own email. The studio Admin will link your request to
              your existing coach record in People.
            </p>
            {registrationAvailable ? (
              <Form method="post" className="form-grid">
                <input type="hidden" name="intent" value="request-account" />
                <label className="field">
                  Your name
                  <input
                    name="name"
                    autoComplete="name"
                    minLength={2}
                    maxLength={100}
                    required
                  />
                </label>
                <label className="field">
                  Your email
                  <input
                    name="email"
                    type="email"
                    autoComplete="email"
                    maxLength={254}
                    required
                  />
                </label>
                <label className="visually-hidden" aria-hidden="true">
                  Leave empty
                  <input name="website" tabIndex={-1} autoComplete="off" />
                </label>
                <div className="actions">
                  <button className="primary" disabled={busy}>
                    Request coach account
                  </button>
                </div>
              </Form>
            ) : (
              <p>Contact Skyra to request access.</p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
