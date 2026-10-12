import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import type { GraphQL } from "./shopify-catalog.server";

const phoneInput = z
  .string()
  .trim()
  .max(40)
  .default("")
  .transform((value) => value.replace(/[\s().-]/g, ""))
  .refine(
    (value) => !value || /^\+[1-9]\d{6,14}$/.test(value),
    "Enter a phone number with country code, for example +61 412 345 678.",
  );

const contactsQuery = `#graphql
  query ClientContacts($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Customer { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
    }
  }`;
const importQuery = `#graphql
  query ClientImport($after: String) {
    customers(first: 100, after: $after) {
      nodes { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
      pageInfo { hasNextPage endCursor }
    }
  }`;
const contact = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/Customer\/\d+$/),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  defaultEmailAddress: z.object({ emailAddress: z.string() }).nullable(),
  defaultPhoneNumber: z.object({ phoneNumber: z.string() }).nullable(),
});
const unavailable = () =>
  new DomainError(
    "CUSTOMER_DATA_UNAVAILABLE",
    "Shopify customer details could not be read. Grant Skyra Booking access to customers, names, email and phone, then refresh. Existing profiles and Pass balances are still available.",
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
  phone: node.defaultPhoneNumber?.phoneNumber || null,
  contactSyncedAt: new Date(),
});

export const findClientQuery = `#graphql
  query FindClient($query: String!) {
    customers(first: 100, query: $query) {
      nodes { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
      pageInfo { hasNextPage }
    }
  }`;
export const createClientMutation = `#graphql
  mutation CreateClient($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
      userErrors { field message }
    }
  }`;

export const updateClientMutation = `#graphql
  mutation UpdateClient($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
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
      phone: phoneInput,
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
  const updatingPhone = !!customer;
  if (
    !customer ||
    (input.phone && input.phone !== customer.defaultPhoneNumber?.phoneNumber)
  ) {
    const operation = updatingPhone ? "customerUpdate" : "customerCreate";
    const mutationInput = updatingPhone
      ? { id: customer.id, phone: input.phone }
      : {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          ...(input.phone ? { phone: input.phone } : {}),
        };
    let body;
    try {
      const response = await graphql(
        updatingPhone ? updateClientMutation : createClientMutation,
        {
          variables: { input: mutationInput },
          signal: AbortSignal.timeout(8000),
        },
      );
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
        [operation]: z.object({
          customer: contact.nullable(),
          userErrors: z.array(z.object({ message: z.string() })),
        }),
      })
      .safeParse(body.data);
    if (!payload.success) throw unavailable();
    if (payload.data[operation].userErrors.length) {
      throw new DomainError(
        "CLIENT_CREATE_FAILED",
        payload.data[operation].userErrors.map((e) => e.message).join("; "),
      );
    }
    if (!payload.data[operation].customer) throw unavailable();
    customer = payload.data[operation].customer;
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
          : {
              shopifyName: "",
              email: null,
              phone: null,
              contactSyncedAt: new Date(),
            },
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

async function editableProfile(actor: Actor, rawId: unknown) {
  await activeShop(actor);
  const id = z.string().uuid().parse(rawId);
  const profile = await db.customerProfile.findFirst({
    where: { shopId: actor.shopId, id },
    select: { id: true, shopifyCustomerGid: true, preferredName: true },
  });
  if (!profile) throw new DomainError("NOT_FOUND", "Client not found.", 404);
  return profile;
}

export async function adminClientEdit(
  actor: Actor,
  graphql: GraphQL,
  rawId: unknown,
) {
  const profile = await editableProfile(actor, rawId);
  const data = await read(graphql, contactsQuery, {
    ids: [profile.shopifyCustomerGid],
  });
  const parsed = z
    .object({ nodes: z.array(contact.nullable()).length(1) })
    .safeParse(data);
  if (!parsed.success) throw unavailable();
  const customer = parsed.data.nodes[0];
  if (!customer || customer.id !== profile.shopifyCustomerGid)
    throw new DomainError(
      "NOT_FOUND",
      "This Shopify customer is no longer available.",
      404,
    );
  return {
    id: profile.id,
    firstName: customer.firstName || "",
    lastName: customer.lastName || "",
    email: customer.defaultEmailAddress?.emailAddress || "",
    phone: customer.defaultPhoneNumber?.phoneNumber || "",
    preferredName: profile.preferredName,
  };
}

export async function updateAdminClient(
  actor: Actor,
  graphql: GraphQL,
  rawId: unknown,
  raw: unknown,
) {
  const profile = await editableProfile(actor, rawId);
  const input = z
    .object({
      firstName: z.string().trim().min(1, "First name is required.").max(100),
      lastName: z.string().trim().max(100),
      email: z.string().trim().toLowerCase().email().max(254),
      phone: phoneInput,
      preferredName: z.string().trim().max(100),
    })
    .strict()
    .parse(raw);
  let body;
  try {
    const response = await graphql(updateClientMutation, {
      variables: {
        input: {
          id: profile.shopifyCustomerGid,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone || null,
        },
      },
      signal: AbortSignal.timeout(8000),
    });
    body = await response.json();
    if (!response.ok || body.errors?.length || !body.data) throw new Error();
  } catch {
    throw new DomainError(
      "CLIENT_UPDATE_UNAVAILABLE",
      "Could not confirm the Shopify update. Check customer access (write_customers), then reload the client before retrying.",
      503,
    );
  }
  const parsed = z
    .object({
      customerUpdate: z.object({
        customer: contact.nullable(),
        userErrors: z.array(z.object({ message: z.string() })),
      }),
    })
    .safeParse(body.data);
  if (!parsed.success) throw unavailable();
  const payload = parsed.data.customerUpdate;
  if (payload.userErrors.length)
    throw new DomainError(
      "CLIENT_UPDATE_FAILED",
      payload.userErrors.map((e) => e.message).join("; "),
    );
  if (!payload.customer || payload.customer.id !== profile.shopifyCustomerGid)
    throw unavailable();
  try {
    const saved = await db.customerProfile.updateMany({
      where: {
        shopId: actor.shopId,
        id: profile.id,
        shopifyCustomerGid: profile.shopifyCustomerGid,
      },
      data: { ...values(payload.customer), preferredName: input.preferredName },
    });
    if (saved.count !== 1) throw new Error();
  } catch {
    throw new DomainError(
      "CLIENT_SAVE_FAILED",
      "Shopify was updated, but Booking could not save the profile. Reload and retry to save the preferred name.",
      503,
    );
  }
}
