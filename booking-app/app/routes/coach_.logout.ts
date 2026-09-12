import { redirect, type ActionFunctionArgs } from "react-router";
import {
  coachCookie,
  requestCoachToken,
  requireCoachFormOrigin,
  revokeCoachSession,
} from "../services/coach-auth.server";
export async function action({ request }: ActionFunctionArgs) {
  requireCoachFormOrigin(request);
  const token = requestCoachToken(request);
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) await revokeCoachSession(token);
  return redirect("/coach/login", {
    headers: {
      "Set-Cookie": coachCookie("", true),
      "Cache-Control": "private, no-store",
    },
  });
}
export const loader = () => new Response(null, { status: 405 });
