import { z } from "zod";
import type { GraphQL } from "./shopify-catalog.server";

export const CUSTOMER_NOTIFICATION_EMAIL_QUERY = `#graphql
  query CustomerNotificationEmail($id: ID!) {
    customer(id: $id) {
      id
      defaultEmailAddress { emailAddress }
    }
  }`;

const result = z.object({
  customer: z
    .object({
      id: z.string(),
      defaultEmailAddress: z
        .object({ emailAddress: z.string().email() })
        .nullable(),
    })
    .nullable(),
});

export async function resolveShopifyCustomerEmail(
  graphql: GraphQL,
  customerGid: string,
) {
  const response = await graphql(CUSTOMER_NOTIFICATION_EMAIL_QUERY, {
    variables: { id: customerGid },
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length || !body.data)
    throw new Error("Shopify customer email lookup failed.");
  const parsed = result.safeParse(body.data);
  if (!parsed.success || parsed.data.customer?.id !== customerGid)
    throw new Error("Shopify customer email lookup returned invalid data.");
  return parsed.data.customer.defaultEmailAddress?.emailAddress || null;
}
