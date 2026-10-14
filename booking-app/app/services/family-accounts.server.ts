import { createHash } from "node:crypto";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import type { BookingActor } from "./booking.server";
import { clientName } from "./client-identity";
import type { GraphQL } from "./shopify-catalog.server";

const customerGid = z.string().regex(/^gid:\/\/shopify\/Customer\/[1-9]\d*$/);
const contact = z.object({
  id: customerGid,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  defaultEmailAddress: z
    .object({ emailAddress: z.string().email() })
    .nullable(),
  defaultPhoneNumber: z.object({ phoneNumber: z.string() }).nullable(),
  tags: z.array(z.string()).default([]),
});
const familyInput = z
  .object({
    firstName: z.string().trim().min(1, "First name is required.").max(100),
    lastName: z.string().trim().max(100),
    emailPrefix: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^[a-z0-9][a-z0-9-]{0,39}$/,
        "Use 1–40 letters, numbers or hyphens for the email prefix.",
      ),
    phone: z
      .string()
      .trim()
      .max(40)
      .default("")
      .transform((value) => value.replace(/[\s().-]/g, ""))
      .refine(
        (value) => !value || /^\+[1-9]\d{6,14}$/.test(value),
        "Enter a phone number with country code, for example +61 412 345 678.",
      ),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export const FAMILY_CONTACT_QUERY = `#graphql
  query FamilyAccountContact($id: ID!) {
    customer(id: $id) { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } tags }
  }`;
export const FAMILY_FIND_QUERY = `#graphql
  query FindFamilyMember($query: String!) {
    customers(first: 100, query: $query) {
      nodes { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } tags }
      pageInfo { hasNextPage }
    }
  }`;
export const FAMILY_CREATE_MUTATION = `#graphql
  mutation CreateFamilyMember($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer { id firstName lastName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } tags }
      userErrors { field message }
    }
  }`;
const unavailable = () =>
  new DomainError(
    "FAMILY_PROVIDER_UNAVAILABLE",
    "Could not confirm the family member's Shopify details. Retry with the same email prefix and request.",
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
    if (!response.ok || body.errors?.length || !body.data) throw unavailable();
    return body.data;
  } catch {
    throw unavailable();
  }
}
async function shopFor(shopId: string) {
  if (!(await db.shop.findFirst({ where: { id: shopId, status: "ACTIVE" } })))
    throw new DomainError("NOT_FOUND", "Studio not found.", 404);
}
const contactValues = (node: z.infer<typeof contact>) => ({
  shopifyName: [node.firstName, node.lastName].filter(Boolean).join(" ").trim(),
  email: node.defaultEmailAddress?.emailAddress.toLowerCase() || null,
  phone: node.defaultPhoneNumber?.phoneNumber || null,
  contactSyncedAt: new Date(),
});
async function accountProfile(actor: BookingActor, requireParent = false) {
  await shopFor(actor.shopId);
  const gid = customerGid.safeParse(
    actor.accountCustomerGid || actor.customerGid,
  );
  if (!gid.success)
    throw new DomainError(
      "LOGIN_REQUIRED",
      "Sign in to manage your family.",
      401,
    );
  const account = await db.customerProfile.upsert({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: actor.shopId,
        shopifyCustomerGid: gid.data,
      },
    },
    create: { shopId: actor.shopId, shopifyCustomerGid: gid.data },
    update: {},
  });
  if (requireParent && account.familyParentId)
    throw new DomainError(
      "FAMILY_PARENT_REQUIRED",
      "Use the parent account to manage family members.",
      403,
    );
  return account;
}
async function providerContact(graphql: GraphQL, gid: string) {
  const parsed = z
    .object({ customer: contact.nullable() })
    .safeParse(await read(graphql, FAMILY_CONTACT_QUERY, { id: gid }));
  if (!parsed.success || parsed.data.customer?.id !== gid) throw unavailable();
  return parsed.data.customer;
}
const summary = (profile: {
  id: string;
  preferredName: string;
  shopifyName: string;
  email: string | null;
}) => ({ id: profile.id, name: clientName(profile), email: profile.email });

export async function familyAccountData(
  actor: BookingActor,
  graphql?: GraphQL,
) {
  let account = await accountProfile(actor);
  if (graphql) {
    const node = await providerContact(graphql, account.shopifyCustomerGid);
    account = await db.customerProfile.update({
      where: { shopId_id: { shopId: actor.shopId, id: account.id } },
      data: contactValues(node),
    });
  }
  const children = account.familyParentId
    ? []
    : await db.customerProfile.findMany({
        where: { shopId: actor.shopId, familyParentId: account.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
  return {
    account: summary(account),
    canAddMembers: !account.familyParentId,
    members: [
      { ...summary(account), relationship: "SELF" as const },
      ...children.map((child) => ({
        ...summary(child),
        relationship: "CHILD" as const,
      })),
    ],
  };
}

// The account GID comes only from verified Shopify authentication, never the request envelope.
export async function resolveFamilyActor(
  actor: BookingActor,
  rawMemberId?: unknown,
): Promise<BookingActor> {
  const account = await accountProfile(actor);
  const id =
    rawMemberId === undefined || rawMemberId === null || rawMemberId === ""
      ? account.id
      : z.string().uuid().parse(rawMemberId);
  const member =
    id === account.id
      ? account
      : account.familyParentId
        ? null
        : await db.customerProfile.findFirst({
            where: { shopId: actor.shopId, id, familyParentId: account.id },
          });
  if (!member)
    throw new DomainError(
      "FORBIDDEN",
      "This family member is not available to your account.",
      403,
    );
  return {
    ...actor,
    customerGid: member.shopifyCustomerGid,
    accountCustomerGid: account.shopifyCustomerGid,
  };
}

export function familyEmailAlias(parentEmail: string, prefix: string) {
  const email = z
    .string()
    .email()
    .max(254)
    .parse(parentEmail.trim().toLowerCase());
  const split = email.lastIndexOf("@");
  const localpart = `${email.slice(0, split)}+${prefix}`;
  if (localpart.length > 64)
    throw new DomainError(
      "FAMILY_EMAIL_TOO_LONG",
      "Use a shorter email prefix for this parent's email.",
    );
  return z
    .string()
    .email()
    .max(254)
    .parse(`${localpart}${email.slice(split)}`);
}

async function addMember(
  shopId: string,
  parentId: string,
  graphql: GraphQL,
  raw: unknown,
) {
  const input = familyInput.parse(raw);
  const parent = await db.customerProfile.findFirst({
    where: { shopId, id: parentId },
  });
  if (!parent)
    throw new DomainError("NOT_FOUND", "Parent client not found.", 404);
  if (parent.familyParentId)
    throw new DomainError(
      "FAMILY_PARENT_REQUIRED",
      "Choose the parent client to add a family member.",
      409,
    );
  const node = await providerContact(graphql, parent.shopifyCustomerGid);
  if (!node.defaultEmailAddress)
    throw new DomainError(
      "FAMILY_PARENT_EMAIL_REQUIRED",
      "Add an email to the parent client before adding a family member.",
    );
  await db.customerProfile.updateMany({
    where: { shopId, id: parent.id, familyParentId: null },
    data: contactValues(node),
  });
  const email = familyEmailAlias(
    node.defaultEmailAddress.emailAddress,
    input.emailPrefix,
  );
  const { idempotencyKey, ...details } = input;
  const inputHash = createHash("sha256")
    .update(JSON.stringify(details))
    .digest("hex");
  const identity = { shopId, parentId, idempotencyKey };
  let intent = await db.familyMemberCreation.findUnique({
    where: { shopId_parentId_idempotencyKey: identity },
  });
  if (!intent) {
    try {
      intent = await db.familyMemberCreation.create({
        data: { ...identity, inputHash, email },
      });
    } catch {
      intent = await db.familyMemberCreation.findUnique({
        where: { shopId_parentId_idempotencyKey: identity },
      });
      if (!intent)
        throw new DomainError(
          "FAMILY_EMAIL_IN_USE",
          "This family email prefix is already reserved. Choose another prefix.",
          409,
        );
    }
  }
  if (intent.inputHash !== inputHash)
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "This request was already used for different family member details.",
      409,
    );
  if (intent.status === "DONE" && intent.customerId) {
    const saved = await db.customerProfile.findFirst({
      where: {
        shopId,
        id: intent.customerId,
        familyParentId: parentId,
        shopifyCustomerGid: intent.shopifyCustomerGid || "",
      },
    });
    if (!saved)
      throw new DomainError(
        "FAMILY_SAVE_CONFLICT",
        "This family member requires review.",
        409,
      );
    return { id: saved.id };
  }
  const claim = await db.familyMemberCreation.updateMany({
    where: {
      id: intent.id,
      shopId,
      OR: [
        { status: { in: ["PENDING", "UNKNOWN", "FAILED", "PROVIDER_SAVED"] } },
        { status: "CREATING", claimedAt: { lt: new Date(Date.now() - 30000) } },
      ],
    },
    data: { status: "CREATING", claimedAt: new Date() },
  });
  if (claim.count !== 1)
    throw new DomainError(
      "FAMILY_CREATE_IN_PROGRESS",
      "This family member is being saved. Wait a moment and retry the same request.",
      409,
    );
  const marker = `skyra-family-${intent.id}`;
  try {
    const found = z
      .object({
        customers: z.object({
          nodes: z.array(contact),
          pageInfo: z.object({ hasNextPage: z.boolean() }),
        }),
      })
      .safeParse(
        await read(graphql, FAMILY_FIND_QUERY, {
          query: `email:"${intent.email.replace(/[\\"]/g, "\\$&")}"`,
        }),
      );
    if (!found.success || found.data.customers.pageInfo.hasNextPage)
      throw unavailable();
    const exact = found.data.customers.nodes.filter(
      (customer) =>
        customer.defaultEmailAddress?.emailAddress.toLowerCase() ===
        intent.email,
    );
    if (exact.length > 1 || (exact.length && !exact[0].tags.includes(marker)))
      throw new DomainError(
        "FAMILY_EMAIL_IN_USE",
        "A Shopify customer already uses this family email. Choose another prefix; existing clients cannot be claimed as family members.",
        409,
      );
    let child = exact[0];
    if (intent.shopifyCustomerGid && child?.id !== intent.shopifyCustomerGid)
      throw new DomainError(
        "FAMILY_SAVE_CONFLICT",
        "The saved Shopify family member requires review before retrying.",
        409,
      );
    if (!child) {
      const created = z
        .object({
          customerCreate: z.object({
            customer: contact.nullable(),
            userErrors: z.array(z.object({ message: z.string() })),
          }),
        })
        .safeParse(
          await read(graphql, FAMILY_CREATE_MUTATION, {
            input: {
              firstName: input.firstName,
              lastName: input.lastName,
              email: intent.email,
              tags: [marker],
              ...(input.phone ? { phone: input.phone } : {}),
            },
          }),
        );
      if (!created.success) throw unavailable();
      if (created.data.customerCreate.userErrors.length)
        throw new DomainError(
          "FAMILY_CREATE_FAILED",
          created.data.customerCreate.userErrors
            .map((error) => error.message)
            .join("; "),
          409,
        );
      if (!created.data.customerCreate.customer) throw unavailable();
      child = created.data.customerCreate.customer;
      if (
        child.defaultEmailAddress?.emailAddress.toLowerCase() !==
          intent.email ||
        !child.tags.includes(marker)
      )
        throw unavailable();
    }
    await db.familyMemberCreation.update({
      where: { id: intent.id },
      // Keep the lease until local identity and family link commit together.
      data: { shopifyCustomerGid: child.id },
    });
    const saved = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "CustomerProfile" WHERE "shopId" = ${shopId}::uuid AND id = ${parentId}::uuid FOR UPDATE`;
      const root = await tx.customerProfile.findFirst({
        where: { shopId, id: parentId, familyParentId: null },
      });
      if (!root)
        throw new DomainError(
          "FAMILY_PARENT_REQUIRED",
          "The parent client is no longer available.",
          409,
        );
      const existing = await tx.customerProfile.findUnique({
        where: {
          shopId_shopifyCustomerGid: { shopId, shopifyCustomerGid: child.id },
        },
        include: { _count: { select: { familyMembers: true } } },
      });
      if (
        existing &&
        ((existing.familyParentId && existing.familyParentId !== parentId) ||
          existing._count.familyMembers)
      )
        throw new DomainError(
          "FAMILY_SAVE_CONFLICT",
          "This Shopify client already belongs to a different family.",
          409,
        );
      const profile = await tx.customerProfile.upsert({
        where: {
          shopId_shopifyCustomerGid: { shopId, shopifyCustomerGid: child.id },
        },
        create: {
          shopId,
          shopifyCustomerGid: child.id,
          familyParentId: parentId,
          ...contactValues(child),
        },
        update: { familyParentId: parentId, ...contactValues(child) },
      });
      await tx.familyMemberCreation.update({
        where: { id: intent.id },
        data: {
          customerId: profile.id,
          shopifyCustomerGid: child.id,
          status: "DONE",
        },
      });
      return profile;
    });
    return { id: saved.id };
  } catch (error) {
    await db.familyMemberCreation.updateMany({
      where: { id: intent.id, shopId, status: { not: "DONE" } },
      data: {
        status:
          error instanceof DomainError && error.status < 500
            ? "FAILED"
            : "UNKNOWN",
      },
    });
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "FAMILY_SAVE_UNAVAILABLE",
      "The family member may exist in Shopify. Retry this same request to safely finish saving.",
      503,
    );
  }
}

export async function addCustomerFamilyMember(
  actor: BookingActor,
  graphql: GraphQL,
  raw: unknown,
) {
  const parent = await accountProfile(actor, true);
  return addMember(actor.shopId, parent.id, graphql, raw);
}
export async function addAdminFamilyMember(
  actor: Actor,
  graphql: GraphQL,
  rawParentId: unknown,
  raw: unknown,
) {
  requireOperations(actor);
  await shopFor(actor.shopId);
  return addMember(
    actor.shopId,
    z.string().uuid().parse(rawParentId),
    graphql,
    raw,
  );
}
