import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { adminContext } from "../services/context.server";
import { bookingReports } from "../services/booking-reports.server";
import { publicError } from "../lib/errors.server";
import { AdminReportsView } from "../components/admin-reports-view";

export async function loader({ request }: LoaderFunctionArgs) {
  const { actor } = await adminContext(request);
  const url = new URL(request.url);
  const raw = Object.fromEntries(
    ["range", "from", "to", "customer"].flatMap((key) => {
      const value = url.searchParams.get(key);
      return value ? [[key, value]] : [];
    }),
  );
  try {
    return { data: await bookingReports(actor, raw), error: null };
  } catch (error) {
    return { data: null, error: publicError(error).error };
  }
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function Reports() {
  return <AdminReportsView {...useLoaderData<typeof loader>()} />;
}
