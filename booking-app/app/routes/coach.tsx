import { coachToday } from "../services/today-bookings.server";
import { TodayBookings } from "../components/today-bookings";
import {
  data,
  redirect,
  useLoaderData,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import { z, ZodError } from "zod";
import { DomainError } from "../lib/errors.server";
import {
  requestCoachToken,
  requireCoachFormOrigin,
} from "../services/coach-auth.server";
import { coachSchedule } from "../services/coach-schedule.server";
import { CoachScheduleView } from "../components/coach-schedule";
import { CoachPortalShell } from "../components/coach-portal-shell";
import { BookingNotificationList } from "../components/booking-notification-list";
import {
  coachNotifications,
  markCoachNotificationRead,
} from "../services/in-app-notifications.server";
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
    const token = requestCoachToken(request);
    const result = await coachSchedule(
      token,
      Object.fromEntries(params),
    );
    const inbox = await coachNotifications(token);
    return data(
      {
        ...result,
        today: await coachToday(token),
        notifications: inbox.notifications,
      },
      { headers: headers() },
    );
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
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  requireCoachFormOrigin(request);
  try {
    const form = await request.formData();
    z.literal("read-notification").parse(form.get("intent"));
    const notificationId = z.string().uuid().parse(form.get("notificationId"));
    await markCoachNotificationRead(requestCoachToken(request), notificationId);
    return { message: "Notification marked read." };
  } catch (error) {
    if (error instanceof DomainError && error.status === 401)
      throw redirect("/coach/login", { headers: headers() });
    throw error;
  }
}
export default function CoachPortal() {
  const info = useLoaderData<typeof loader>();
  return (
    <CoachPortalShell coachName={info.coachName} active="today">
      <TodayBookings data={info.today} coach />
      <BookingNotificationList
        notifications={info.notifications}
        audience="coach"
      />
      <CoachScheduleView data={info} />
    </CoachPortalShell>
  );
}
