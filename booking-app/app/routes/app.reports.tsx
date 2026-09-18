import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { adminContext } from "../services/context.server";
import { bookingReports } from "../services/booking-reports.server";
import { publicError } from "../lib/errors.server";
import { refreshClientContacts } from "../services/client-contacts.server";
import { AdminReportsView } from "../components/admin-reports-view";

export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, admin } = await adminContext(request);
  let warning: string | null = null;
  try {
    await refreshClientContacts(actor, admin.graphql);
  } catch (error) {
    warning = publicError(error).error;
  }
  const url = new URL(request.url);
  const raw = Object.fromEntries(
    ["range", "from", "to", "customer"].flatMap((key) => {
      const value = url.searchParams.get(key);
      return value ? [[key, value]] : [];
    }),
  );
  try {
    return { data: await bookingReports(actor, raw), error: null, warning };
  } catch (error) {
    return { data: null, error: publicError(error).error, warning };
  }
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function Reports() {
  return <AdminReportsView {...useLoaderData<typeof loader>()} />;
}
