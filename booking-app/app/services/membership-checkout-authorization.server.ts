import { z } from "zod";
import { DomainError } from "../lib/errors.server";
import type { GraphQL } from "./shopify-catalog.server";

// The customer definition is app-owned JSON in shopify.app.toml. The identical
// cart proof is enforced by the checkout validation Function. Neither proofs
// nor compare digests belong in public purchase status or logs.
export const MEMBERSHIP_CHECKOUT_AUTHORIZATION_KEY = "membership_checkout";
export const MEMBERSHIP_CHECKOUT_PROTECTION_READ = `#graphql
query MembershipCheckoutProtection($productGid: ID!, $validationGid: ID!) {
  validation(id: $validationGid) {
    id enabled blockOnFailure
    shopifyFunction { id handle appKey apiVersion }
  }
  product(id: $productGid) {
    id
    managedMonthlyPass: metafield(namespace: "$app", key: "managed_monthly_pass") {
      jsonValue
    }
  }
}`;
export const PUBLIC_MEMBERSHIP_STOREFRONT_TOKENS = `#graphql
query MembershipPublicStorefrontTokens($after: String) {
  shop {
    storefrontAccessTokens(first: 100, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
export const MEMBERSHIP_CHECKOUT_AUTHORIZATION_READ = `#graphql
query MembershipCheckoutAuthorization($customerGid: ID!) {
  customer(id: $customerGid) {
    id
    authorization: metafield(namespace: "$app", key: "membership_checkout") {
      type jsonValue compareDigest
    }
  }
}`;
export const MEMBERSHIP_CHECKOUT_AUTHORIZATION_SET = `#graphql
mutation MembershipCheckoutAuthorizationSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { key type jsonValue compareDigest owner { ... on Customer { id } } }
    userErrors { code }
  }
}`;

const gid = (resource: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${resource}/[1-9]\\d*$`));
const authorizationSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["OPEN", "CLOSED"]),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    purchaseId: z.string().uuid(),
    membershipId: z.string().uuid(),
    cycle: z.number().int().positive().safe(),
    customerGid: gid("Customer"),
    productGid: gid("Product"),
    variantGid: gid("ProductVariant"),
    sellingPlanGid: gid("SellingPlan").nullable(),
    priceCents: z.number().int().nonnegative().safe(),
    currency: z.literal("AUD"),
  })
  .strict();
export type MembershipCheckoutAuthorization = z.infer<
  typeof authorizationSchema
>;
export type MembershipCheckoutAuthorizationRead = {
  customerGid: string;
  authorization: MembershipCheckoutAuthorization | null;
  compareDigest: string | null;
};
const digest = z.string().min(1).max(256);
const metafield = z.object({
  type: z.literal("json"),
  jsonValue: authorizationSchema,
  compareDigest: digest,
});
const readSchema = z.object({
  customer: z
    .object({ id: gid("Customer"), authorization: metafield.nullable() })
    .nullable(),
});
const tokensSchema = z.object({
  shop: z.object({
    storefrontAccessTokens: z.object({
      nodes: z.array(z.object({ id: gid("StorefrontAccessToken") })),
      pageInfo: z.object({
        hasNextPage: z.boolean(),
        endCursor: z.string().min(1).nullable(),
      }),
    }),
  }),
});
const protectionSchema = z.object({
  validation: z
    .object({
      id: gid("Validation"),
      enabled: z.boolean(),
      blockOnFailure: z.boolean(),
      shopifyFunction: z
        .object({
          id: z.string().min(1),
          handle: z.string(),
          appKey: z.string(),
          apiVersion: z.string(),
        })
        .nullable(),
    })
    .nullable(),
  product: z
    .object({
      id: gid("Product"),
      managedMonthlyPass: z.object({ jsonValue: z.unknown() }).nullable(),
    })
    .nullable(),
});
const writeSchema = z.object({
  metafieldsSet: z.object({
    metafields: z
      .array(
        metafield.extend({
          key: z.literal(MEMBERSHIP_CHECKOUT_AUTHORIZATION_KEY),
          owner: z.object({ id: gid("Customer") }),
        }),
      )
      .nullable(),
    userErrors: z.array(z.object({ code: z.string().nullable() })),
  }),
});

function unavailable(write = false) {
  return new DomainError(
    write
      ? "MEMBERSHIP_AUTHORIZATION_UNKNOWN"
      : "MEMBERSHIP_AUTHORIZATION_UNAVAILABLE",
    write
      ? "Shopify has not confirmed this checkout authorization. Do not start another payment while we check it."
      : "We could not verify safe membership checkout with Shopify.",
    503,
  );
}
function conflict() {
  return new DomainError(
    "MEMBERSHIP_AUTHORIZATION_CONFLICT",
    "Another membership checkout authorization exists. Resolve that purchase before starting another.",
    409,
  );
}
async function request(
  admin: GraphQL,
  query: string,
  variables: Record<string, unknown>,
  write = false,
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        // CAS writes must never be retried after an ambiguous provider response.
        const response = await admin(query, {
          variables,
          tries: 1,
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok || payload.errors?.length || !payload.data)
          throw unavailable(write);
        return payload.data as unknown;
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(unavailable(write));
        }, 6000);
      }),
    ]);
  } catch {
    // Never expose upstream errors that may contain customer data or tokens.
    throw unavailable(write);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
function validateAuthorization(value: MembershipCheckoutAuthorization) {
  const parsed = authorizationSchema.safeParse(value);
  if (!parsed.success)
    throw new DomainError(
      "INVALID_MEMBERSHIP_AUTHORIZATION",
      "This membership checkout authorization is invalid.",
      400,
    );
  return parsed.data;
}
function equal(
  left: MembershipCheckoutAuthorization,
  right: MembershipCheckoutAuthorization,
) {
  // Schema parsing gives both objects the same key order and rejects extras.
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function assertMembershipCheckoutProtection(
  admin: GraphQL,
  productGid: string,
  validationGid: string,
  appKey: string,
) {
  if (
    !gid("Product").safeParse(productGid).success ||
    !gid("Validation").safeParse(validationGid).success ||
    !appKey ||
    appKey.trim() !== appKey
  )
    throw unavailable();
  const parsed = protectionSchema.safeParse(
    await request(admin, MEMBERSHIP_CHECKOUT_PROTECTION_READ, {
      productGid,
      validationGid,
    }),
  );
  if (!parsed.success) throw unavailable();
  const { validation, product } = parsed.data;
  if (
    validation?.id !== validationGid ||
    !validation.enabled ||
    !validation.blockOnFailure ||
    validation.shopifyFunction?.handle !== "skyra-membership-checkout-guard" ||
    validation.shopifyFunction.appKey !== appKey ||
    validation.shopifyFunction.apiVersion !== "2026-07" ||
    product?.id !== productGid ||
    product.managedMonthlyPass?.jsonValue !== true
  )
    throw new DomainError(
      "MEMBERSHIP_CHECKOUT_PROTECTION_UNAVAILABLE",
      "Shopify monthly Pass checkout protection could not be verified.",
      503,
    );
}

export async function assertNoPublicMembershipStorefrontTokens(admin: GraphQL) {
  let after: string | null = null;
  const cursors = new Set<string>();
  // An incomplete listing is never evidence that no public token exists.
  for (let page = 0; page < 5; page++) {
    const parsed = tokensSchema.safeParse(
      await request(admin, PUBLIC_MEMBERSHIP_STOREFRONT_TOKENS, { after }),
    );
    if (!parsed.success) throw unavailable();
    const connection = parsed.data.shop.storefrontAccessTokens;
    if (connection.nodes.length)
      throw new DomainError(
        "PUBLIC_MEMBERSHIP_STOREFRONT_TOKEN",
        "Membership checkout requires a private Storefront client.",
        409,
      );
    if (!connection.pageInfo.hasNextPage) return;
    const cursor = connection.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor)) throw unavailable();
    cursors.add(cursor);
    after = cursor;
  }
  throw unavailable();
}

export async function readMembershipCheckoutAuthorization(
  admin: GraphQL,
  customerGid: string,
): Promise<MembershipCheckoutAuthorizationRead> {
  if (!gid("Customer").safeParse(customerGid).success) throw unavailable();
  const parsed = readSchema.safeParse(
    await request(admin, MEMBERSHIP_CHECKOUT_AUTHORIZATION_READ, {
      customerGid,
    }),
  );
  if (!parsed.success || parsed.data.customer?.id !== customerGid)
    throw unavailable();
  const current = parsed.data.customer.authorization;
  if (current && current.jsonValue.customerGid !== customerGid)
    throw unavailable();
  return {
    customerGid,
    authorization: current?.jsonValue ?? null,
    compareDigest: current?.compareDigest ?? null,
  };
}

async function setAuthorization(
  admin: GraphQL,
  current: MembershipCheckoutAuthorizationRead,
  desired: MembershipCheckoutAuthorization,
): Promise<MembershipCheckoutAuthorizationRead> {
  const parsed = writeSchema.safeParse(
    await request(
      admin,
      MEMBERSHIP_CHECKOUT_AUTHORIZATION_SET,
      {
        metafields: [
          {
            ownerId: desired.customerGid,
            namespace: "$app",
            key: MEMBERSHIP_CHECKOUT_AUTHORIZATION_KEY,
            type: "json",
            value: JSON.stringify(desired),
            // Explicit null means create only if the metafield is still absent.
            compareDigest: current.compareDigest,
          },
        ],
      },
      true,
    ),
  );
  if (!parsed.success) throw unavailable(true);
  const result = parsed.data.metafieldsSet;
  if (result.userErrors.length) {
    if (
      result.userErrors.some((error) =>
        ["INVALID_COMPARE_DIGEST", "STALE_OBJECT"].includes(error.code ?? ""),
      )
    )
      throw conflict();
    throw new DomainError(
      "MEMBERSHIP_AUTHORIZATION_REJECTED",
      "Shopify rejected this membership checkout authorization.",
      409,
    );
  }
  const written = result.metafields?.[0];
  if (
    result.metafields?.length !== 1 ||
    !written ||
    written.owner.id !== desired.customerGid ||
    !equal(written.jsonValue, desired)
  )
    throw unavailable(true);
  return {
    customerGid: desired.customerGid,
    authorization: written.jsonValue,
    compareDigest: written.compareDigest,
  };
}

export async function authorizeMembershipCheckout(
  admin: GraphQL,
  proof: MembershipCheckoutAuthorization,
) {
  const desired = validateAuthorization(proof);
  if (desired.state !== "OPEN") throw conflict();
  await assertNoPublicMembershipStorefrontTokens(admin);
  const current = await readMembershipCheckoutAuthorization(
    admin,
    desired.customerGid,
  );
  if (current.authorization) {
    if (equal(current.authorization, desired)) return current;
    if (
      current.authorization.state === "OPEN" ||
      current.authorization.purchaseId === desired.purchaseId ||
      current.authorization.nonce === desired.nonce
    )
      throw conflict();
  }
  return setAuthorization(admin, current, desired);
}

export async function closeMembershipCheckout(
  admin: GraphQL,
  proof: MembershipCheckoutAuthorization,
) {
  const desired = { ...validateAuthorization(proof), state: "CLOSED" as const };
  const current = await readMembershipCheckoutAuthorization(
    admin,
    desired.customerGid,
  );
  if (current.authorization) {
    if (equal(current.authorization, desired)) return current;
    if (!equal({ ...current.authorization, state: "CLOSED" }, desired))
      throw conflict();
  }
  // Closing must still work when public token issuance disables new checkout.
  return setAuthorization(admin, current, desired);
}
