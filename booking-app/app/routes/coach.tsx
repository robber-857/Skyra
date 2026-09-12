import {
  data,
  redirect,
  useLoaderData,
  type LoaderFunctionArgs,
} from "react-router";
import { ZodError } from "zod";
import { DomainError } from "../lib/errors.server";
import { requestCoachToken } from "../services/coach-auth.server";
import { coachSchedule } from "../services/coach-schedule.server";
import { CoachScheduleView } from "../components/coach-schedule";
import styles from "../styles/admin.css?url";
import coachStyles from "../styles/coach.css?url";
export const links = () => [
  { rel: "stylesheet", href: styles },
  { rel: "stylesheet", href: coachStyles },
];
export const headers = () => ({
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "same-origin",
});
export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const params = new URL(request.url).searchParams;
    const result = await coachSchedule(
      requestCoachToken(request),
      Object.fromEntries(params),
    );
    return data(result, { headers: headers() });
  } catch (error) {
    if (error instanceof DomainError && error.status === 401)
      throw redirect("/coach/login", { headers: headers() });
    if (
      error instanceof ZodError ||
      (error instanceof DomainError && error.status === 400)
    )
      throw new Response("Choose a valid date range.", {
        status: 400,
        headers: headers(),
      });
    throw error;
  }
}
export default function CoachPortal() {
  return <CoachScheduleView data={useLoaderData<typeof loader>()} />;
}
