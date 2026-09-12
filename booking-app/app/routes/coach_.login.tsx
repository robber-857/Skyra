import { useEffect, useState } from "react";
import {
  data,
  redirect,
  useActionData,
  type ActionFunctionArgs,
} from "react-router";
import {
  coachCookie,
  exchangeCoachLogin,
  requireCoachFormOrigin,
} from "../services/coach-auth.server";
import { DomainError } from "../lib/errors.server";
import styles from "../styles/admin.css?url";
export const links = () => [{ rel: "stylesheet", href: styles }];
export const headers = () => ({
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "same-origin",
});
export const loader = () => data(null, { headers: headers() });
export async function action({ request }: ActionFunctionArgs) {
  requireCoachFormOrigin(request);
  try {
    const form = await request.formData();
    const token = await exchangeCoachLogin(String(form.get("token") || ""));
    return redirect("/coach", {
      headers: { ...headers(), "Set-Cookie": coachCookie(token) },
    });
  } catch (error) {
    if (error instanceof DomainError)
      return data(
        {
          error:
            "This sign-in link has expired or was already used. Ask Skyra for a new link.",
        },
        { status: 401, headers: headers() },
      );
    throw error;
  }
}
export default function CoachLogin() {
  const [token, setToken] = useState("");
  useEffect(() => {
    const readLink = () => {
      const value = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
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
  return (
    <main className="workspace">
      <section className="panel">
        <p className="muted">SKYRA · COACH</p>
        <h1>Your coach portal</h1>
        {result?.error && (
          <p role="alert" className="feedback error">
            {result.error}
          </p>
        )}
        {token ? (
          <form method="post" action="/coach/login">
            <input type="hidden" name="token" value={token} />
            <p>Continue to view your classes and registration counts.</p>
            <button className="primary">Continue to my schedule</button>
          </form>
        ) : (
          <p>
            Use the secure sign-in link provided by Skyra to view your classes.
          </p>
        )}
      </section>
    </main>
  );
}
