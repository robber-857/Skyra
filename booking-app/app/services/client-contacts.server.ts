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

export const findClientQuery = `#graphql
  query FindClient($query: String!) {
    customers(first: 100, query: $query) {
      nodes { id firstName lastName defaultEmailAddress { emailAddress } }
      pageInfo { hasNextPage }
    }
  }`;
export const createClientMutation = `#graphql
  mutation CreateClient($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id firstName lastName defaultEmailAddress { emailAddress } }
      userErrors { field message }
    }
  }`;

export async function addAdminClient(
  actor: Actor,
  graphql: GraphQL,
  raw: unknown,
) {
  await activeShop(actor);
  const input = z
    .object({
      firstName: z.string().trim().min(1, "First name is required.").max(100),
      lastName: z.string().trim().max(100),
      email: z.string().trim().toLowerCase().email().max(254),
    })
    .strict()
    .parse(raw);
  const found = await read(graphql, findClientQuery, {
    query: `email:"${input.email.replace(/[\\"]/g, "\\$&")}"`,
  });
  const matches = z
    .object({
      customers: z.object({
        nodes: z.array(contact),
        pageInfo: z.object({ hasNextPage: z.boolean() }),
      }),
    })
    .safeParse(found);
  if (!matches.success || matches.data.customers.pageInfo.hasNextPage)
    throw unavailable();
  const exact = matches.data.customers.nodes.filter(
    (c) => c.defaultEmailAddress?.emailAddress.toLowerCase() === input.email,
  );
  if (exact.length > 1)
    throw new DomainError(
      "DUPLICATE_CLIENT",
      "Multiple Shopify customers use this email. Resolve the duplicate customers in Shopify first.",
    );
  let customer = exact[0];
  if (!customer) {
    let body;
    try {
      const response = await graphql(createClientMutation, {
        variables: { input },
        signal: AbortSignal.timeout(8000),
      });
      body = await response.json();
      if (!response.ok || body.errors?.length || !body.data) throw new Error();
    } catch {
      throw new DomainError(
        "CLIENT_CREATE_UNAVAILABLE",
        "Could not confirm the Shopify customer was saved. Check customer access (write_customers), then retry with the same email or sync Shopify clients.",
        503,
      );
    }
    const payload = z
      .object({
        customerCreate: z.object({
          customer: contact.nullable(),
          userErrors: z.array(z.object({ message: z.string() })),
        }),
      })
      .safeParse(body.data);
    if (!payload.success) throw unavailable();
    if (payload.data.customerCreate.userErrors.length) {
      throw new DomainError(
        "CLIENT_CREATE_FAILED",
        payload.data.customerCreate.userErrors.map((e) => e.message).join("; "),
      );
    }
    if (!payload.data.customerCreate.customer) throw unavailable();
    customer = payload.data.customerCreate.customer;
  }
  try {
    return await db.customerProfile.upsert({
      where: {
        shopId_shopifyCustomerGid: {
          shopId: actor.shopId,
          shopifyCustomerGid: customer.id,
        },
      },
      create: {
        shopId: actor.shopId,
        shopifyCustomerGid: customer.id,
        ...values(customer),
      },
      update: values(customer),
      select: { id: true },
    });
  } catch {
    throw new DomainError(
      "CLIENT_SAVE_FAILED",
      "The customer exists in Shopify, but could not be added to Booking. Retry with the same email or sync Shopify clients.",
      503,
    );
  }
}
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
  if (
    pageInfo.hasNextPage &&
    (!pageInfo.endCursor || pageInfo.endCursor === input.after)
  )
    throw unavailable();
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
    synced: nodes.length,
    nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
  };
}
