import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import type { GraphQL } from "./shopify-catalog.server";

const contactsQuery = `#graphql
  query ClientContacts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Customer { id firstName lastName defaultEmailAddress { emailAddress } }
    }
  }`;
const importQuery = `#graphql
  query ClientImport($after: String) {
    customers(first: 100, after: $after) {
      nodes { id firstName lastName defaultEmailAddress { emailAddress } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
const contact = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Customer\/\d+$/),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  defaultEmailAddress: z.object({ emailAddress: z.string() }).nullable(),
});
const unavailable = () =>
  new DomainError(
    "CUSTOMER_DATA_UNAVAILABLE",
    "Shopify customer details could not be read. Grant Skyra Booking access to customers, names and email, then refresh. Existing profiles and Pass balances are still available.",
    503,
  );
async function read(
  graphql: GraphQL,
  query: string,
  variables: Record<string, unknown>,
) {
  try {
    const response = await graphql(query, {
      variables,
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    // Partial or redacted results must not overwrite an existing contact cache.
    if (!response.ok || body.errors?.length || !body.data) throw unavailable();
    return body.data;
  } catch {
    throw unavailable();
  }
}
async function activeShop(actor: Actor) {
  requireOperations(actor);
  if (
    !(await db.shop.findFirst({
      where: { id: actor.shopId, status: "ACTIVE" },
    }))
  )
    throw new DomainError("NOT_FOUND", "Studio not found.", 404);
}
const values = (node: z.infer<typeof contact>) => ({
  shopifyName: [node.firstName, node.lastName].filter(Boolean).join(" ").trim(),
  email: node.defaultEmailAddress?.emailAddress || null,
  contactSyncedAt: new Date(),
});
export async function refreshClientContacts(
  actor: Actor,
  graphql: GraphQL,
  ids?: string[],
) {
  await activeShop(actor);
  // Refresh only identities recorded in this shop. Never accept a caller's Shopify GID.
  const rows = await db.customerProfile.findMany({
    where: {
      shopId: actor.shopId,
      ...(ids ? { id: { in: ids } } : {}),
      OR: [
        { contactSyncedAt: null },
        { contactSyncedAt: { lt: new Date(Date.now() - 3600000) } },
      ],
    },
    select: { id: true, shopifyCustomerGid: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  if (!rows.length) return;
  const data = await read(graphql, contactsQuery, {
    ids: rows.map((c) => c.shopifyCustomerGid),
  });
  const parsed = z
    .object({ nodes: z.array(contact.nullable()) })
    .safeParse(data);
  if (!parsed.success || parsed.data.nodes.length !== rows.length)
    throw unavailable();
  if (
    parsed.data.nodes.some(
      (n, index) => n && n.id !== rows[index].shopifyCustomerGid,
    )
  )
    throw unavailable();
  await db.$transaction(
    rows.map((row) => {
      const node = parsed.data.nodes.find(
        (n) => n?.id === row.shopifyCustomerGid,
      );
      return db.customerProfile.updateMany({
        where: { shopId: actor.shopId, id: row.id },
        data: node
          ? values(node)
          : { shopifyName: "", email: null, contactSyncedAt: new Date() },
      });
    }),
  );
}
export async function importShopifyClients(
  actor: Actor,
  graphql: GraphQL,
  raw: unknown,
) {
  await activeShop(actor);
  const input = z
    .object({ after: z.string().max(1024).optional() })
    .strict()
    .parse(raw);
  const data = await read(graphql, importQuery, { after: input.after || null });
  const parsed = z
    .object({
      customers: z.object({
        nodes: z.array(contact),
        pageInfo: z.object({
          hasNextPage: z.boolean(),
          endCursor: z.string().nullable(),
        }),
      }),
    })
    .safeParse(data);
  if (!parsed.success) throw unavailable();
  const { nodes, pageInfo } = parsed.data.customers;
  if (pageInfo.hasNextPage && !pageInfo.endCursor) throw unavailable();
  await db.$transaction(
    nodes.map((node) =>
      db.customerProfile.upsert({
        where: {
          shopId_shopifyCustomerGid: {
            shopId: actor.shopId,
            shopifyCustomerGid: node.id,
          },
        },
        create: {
          shopId: actor.shopId,
          shopifyCustomerGid: node.id,
          ...values(node),
        },
        update: values(node),
      }),
    ),
  );
  return {
    message: `${nodes.length} Shopify clients synced.`,
    nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
  };
}
