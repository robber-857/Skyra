import { CashCreditForm } from "../components/cash-credit-form";
import { randomUUID } from "node:crypto";
import {
  useActionData,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { Feedback } from "../components/admin-ui";
import {
  grantCashCredits,
  manualCreditOptions,
} from "../services/manual-credits.server";
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
    creditOptions: await manualCreditOptions(actor),
    idempotencyKey: randomUUID(),
  };
}
export const headers = () => ({ "Cache-Control": "private, no-store" });
export async function action({ request, params }: ActionFunctionArgs) {
  const { actor } = await adminContext(request);
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  const form = await request.formData();
  try {
    if (form.get("confirmed") !== "on")
      return { error: "Confirm the cash payment and credit grant." };
    await grantCashCredits(actor, {
      customerId: params.clientId,
      target: form.get("target"),
      units: form.get("units"),
      validityDays: form.get("validityDays"),
      amount: form.get("amount"),
      reason: form.get("reason"),
      idempotencyKey: form.get("idempotencyKey"),
    });
    return {
      message:
        "Cash payment recorded and credits added. No Shopify checkout was created.",
    };
  } catch (error) {
    return publicError(error);
  }
}

export default function Client() {
  const data = useLoaderData<typeof loader>();
  return (
    <AdminClientDetailView
      {...data}
      creditForm={
        <>
          <Feedback result={useActionData<typeof action>()} />
          <CashCreditForm
            key={data.idempotencyKey}
            options={data.creditOptions}
            idempotencyKey={data.idempotencyKey}
          />
        </>
      }
    />
  );
}
