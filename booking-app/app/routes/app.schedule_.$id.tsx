import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { DateTime } from "luxon";
import { adminContext } from "../services/context.server";
import { adminSessionDetail } from "../services/admin-session.server";
import { DomainError } from "../lib/errors.server";
import { AdminSessionDetailView } from "../components/admin-session-detail";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { actor, shop } = await adminContext(request);
  try {
    const session = await adminSessionDetail(actor, params.id);
    const week = DateTime.fromJSDate(session.startsAt, { zone: shop.timezone })
      .startOf("week")
      .toISODate()!;
    return { session, week };
  } catch (error) {
    if (error instanceof DomainError)
      throw new Response(error.message, { status: error.status });
    throw error;
  }
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function SessionDetail() {
  return <AdminSessionDetailView {...useLoaderData<typeof loader>()} />;
}
