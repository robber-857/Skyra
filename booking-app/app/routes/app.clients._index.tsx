import {
  useLoaderData,
  useActionData,
  type LoaderFunctionArgs,
  type ActionFunctionArgs,
} from "react-router";
import { adminContext } from "../services/context.server";
import { adminClients } from "../services/admin-clients.server";
import {
  importShopifyClients,
  refreshClientContacts,
} from "../services/client-contacts.server";
import { publicError } from "../lib/errors.server";
import { AdminClientsView } from "../components/admin-clients-view";
export async function loader({ request }: LoaderFunctionArgs) {
  const { actor, admin } = await adminContext(request),
    url = new URL(request.url);
  let warning: string | null = null;
  try {
    await refreshClientContacts(actor, admin.graphql);
  } catch (error) {
    warning = publicError(error).error;
  }
  return {
    data: await adminClients(actor, {
      q: url.searchParams.get("q") || "",
      page: url.searchParams.get("page") || 1,
    }),
    warning,
  };
}
export async function action({ request }: ActionFunctionArgs) {
  const { actor, admin } = await adminContext(request);
  const form = await request.formData(),
    after = form.get("after");
  try {
    return await importShopifyClients(
      actor,
      admin.graphql,
      after ? { after } : {},
    );
  } catch (error) {
    return publicError(error);
  }
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export default function Clients() {
  return (
    <AdminClientsView
      {...useLoaderData<typeof loader>()}
      result={useActionData<typeof action>()}
    />
  );
}
