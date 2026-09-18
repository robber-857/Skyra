import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { adminContext } from "../services/context.server";
import { adminClientDetail } from "../services/admin-clients.server";
import { refreshClientContacts } from "../services/client-contacts.server";
import { publicError } from "../lib/errors.server";
import { AdminClientDetailView } from "../components/admin-clients-view";
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { actor, admin } = await adminContext(request),
    url = new URL(request.url);
  const query = { passPage: url.searchParams.get("passPage") || 1 };
  // Verify the profile belongs to this shop before requesting any contact data.
  await adminClientDetail(actor, params.clientId, query);
  let warning: string | null = null;
  try {
    await refreshClientContacts(actor, admin.graphql, [params.clientId!]);
  } catch (error) {
    warning = publicError(error).error;
  }
  return {
    data: await adminClientDetail(actor, params.clientId, query),
    warning,
  };
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function Client() {
  return <AdminClientDetailView {...useLoaderData<typeof loader>()} />;
}
