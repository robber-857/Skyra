import { z } from "zod";
import { DomainError } from "../lib/errors.server";
import { priceInCents } from "./purchase-mapping.server";
import type { GraphQL } from "./shopify-catalog.server";
import { PRODUCTION_BOOKING_SHOP } from "./commerce-capabilities.server";

export const CART_CREATE = `mutation BookingCartCreate($input: CartInput!) {
 cartCreate(input: $input) {
  cart { id checkoutUrl totalQuantity
buyerIdentity { countryCode }
lines(first: 2) {
  nodes {
    id quantity attributes { key value }
    merchandise { ... on ProductVariant { id product { id } } }
    sellingPlanAllocation { sellingPlan { id } }
    cost { amountPerQuantity { amount currencyCode } }
  }
  pageInfo { hasNextPage }
} }
  userErrors { code field message }
  warnings { code message }
 }
}`;
export const CART_READ = `query BookingCartRead($id: ID!) { cart(id: $id) { id checkoutUrl totalQuantity
buyerIdentity { countryCode }
lines(first: 2) {
  nodes {
    id quantity attributes { key value }
    merchandise { ... on ProductVariant { id product { id } } }
    sellingPlanAllocation { sellingPlan { id } }
    cost { amountPerQuantity { amount currencyCode } }
  }
  pageInfo { hasNextPage }
} } }`;
export const BOOKING_REFERENCE_KEY = "_skyra_booking_ref";

const cartSchema = z.object({
  id: z.string().min(1),
  checkoutUrl: z.string().url(),
  totalQuantity: z.number().int(),
  buyerIdentity: z.object({ countryCode: z.string().nullable() }),
  lines: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        quantity: z.number().int(),
        attributes: z.array(z.object({ key: z.string(), value: z.string() })),
        merchandise: z.object({
          id: z.string(),
          product: z.object({ id: z.string() }),
        }),
        sellingPlanAllocation: z
          .object({ sellingPlan: z.object({ id: z.string() }) })
          .nullable(),
        cost: z.object({
          amountPerQuantity: z.object({
            amount: z.string(),
            currencyCode: z.string(),
          }),
        }),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});
export type BookingCart = z.infer<typeof cartSchema>;
export type CartTarget = {
  reference: string;
  productGid: string;
  variantGid: string;
  priceCents: number;
};

function requestError(mutation: boolean) {
  return new DomainError(
    mutation ? "CART_REQUEST_UNKNOWN" : "UNAVAILABLE",
    mutation
      ? "The cart request could not be confirmed. Do not submit another payment; this booking needs recovery."
      : "We could not verify the cart. Please try again.",
    503,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function cartRequestDiagnostic(error: unknown) {
  const source = record(error);
  const response = record(source?.response);
  const body = record(source?.body) || record(response?.body);
  const errors = record(body?.errors);
  const graphQLErrors = Array.isArray(errors?.graphQLErrors)
    ? errors.graphQLErrors
    : [];
  const graphqlCodes = graphQLErrors
    .map((item) => record(record(item)?.extensions)?.code)
    .filter((code): code is string => typeof code === "string")
    .slice(0, 5);
  const constructorName =
    source?.constructor && typeof source.constructor === "function"
      ? source.constructor.name
      : undefined;
  const responseStatus =
    typeof response?.status === "number"
      ? response.status
      : typeof response?.code === "number"
        ? response.code
        : undefined;
  const kind =
    error instanceof DomainError && error.code === "CART_REQUEST_UNKNOWN"
      ? "DEADLINE_OR_TRANSPORT"
      : constructorName === "GraphqlQueryError"
        ? "SHOPIFY_GRAPHQL"
        : constructorName?.startsWith("Http")
          ? "SHOPIFY_HTTP"
          : "CLIENT_EXCEPTION";
  return {
    kind,
    ...(constructorName ? { constructorName } : {}),
    ...(responseStatus ? { responseStatus } : {}),
    ...(graphqlCodes.length ? { graphqlCodes } : {}),
  };
}

function logCartEvent(
  event: string,
  mutation: boolean,
  details: Record<string, unknown>,
) {
  // Never log Cart IDs, checkout URLs, request bodies, tokens or upstream text.
  console.error(
    JSON.stringify({
      event,
      operation: mutation ? "create" : "read",
      ...details,
    }),
  );
}

async function request(
  client: GraphQL,
  query: string,
  variables: Record<string, unknown>,
  mutation: boolean,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        // Shopify SDK retries are explicitly disabled for non-idempotent cartCreate.
        const response = await client(query, {
          variables,
          tries: 1,
          signal: controller.signal,
        });
        const payload = await response.json();
        if (!response.ok || payload.errors?.length || !payload.data) {
          logCartEvent("BOOKING_CART_RESPONSE_REJECTED", mutation, {
            responseStatus: response.status,
            hasData: Boolean(payload.data),
            hasErrors: Boolean(payload.errors),
          });
          throw new Error();
        }
        return payload.data;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(requestError(mutation));
        }, 6000);
      }),
    ]);
  } catch (error) {
    logCartEvent(
      "BOOKING_CART_REQUEST_FAILED",
      mutation,
      cartRequestDiagnostic(error),
    );
    throw requestError(mutation);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createBookingCart(client: GraphQL, target: CartTarget) {
  const data = await request(
    client,
    CART_CREATE,
    {
      input: {
        buyerIdentity: { countryCode: "AU" },
        lines: [
          {
            merchandiseId: target.variantGid,
            quantity: 1,
            attributes: [
              { key: BOOKING_REFERENCE_KEY, value: target.reference },
            ],
          },
        ],
      },
    },
    true,
  );
  // A signed App Proxy Customer GID is NOT a customerAccessToken. Do not invent
  // customer tokens, email or SSO associations from browser input.
  const result = z
    .object({
      cart: cartSchema.nullable(),
      userErrors: z.array(z.object({ message: z.string() })),
      warnings: z.array(z.object({ message: z.string() })),
    })
    .safeParse(data.cartCreate);
  if (!result.success) {
    logCartEvent("BOOKING_CART_RESPONSE_INVALID", true, {
      issuePaths: [
        ...new Set(result.error.issues.map((issue) => issue.path.join("."))),
      ].slice(0, 10),
    });
    throw requestError(true);
  }
  if (!result.data.cart) {
    if (result.data.userErrors.length)
      throw new DomainError(
        "CART_REJECTED",
        "Shopify did not accept this cart. Start a new booking.",
        409,
      );
    throw requestError(true);
  }
  return {
    cart: result.data.cart,
    clean: !result.data.userErrors.length && !result.data.warnings.length,
  };
}

export async function readBookingCart(client: GraphQL, id: string) {
  const data = await request(client, CART_READ, { id }, false);
  const result = cartSchema.nullable().safeParse(data.cart);
  if (!result.success || !result.data)
    throw new DomainError(
      "CART_CHANGED",
      "This cart is missing or changed. Start a new booking.",
      409,
    );
  return result.data;
}

export function assertBookingCart(
  cart: BookingCart,
  target: CartTarget,
  domain: string,
) {
  const changed = () =>
    new DomainError(
      "CART_CHANGED",
      "This cart changed. Start a new booking.",
      409,
    );
  const line = cart.lines.nodes[0];
  const refs =
    line?.attributes.filter((a) => a.key === BOOKING_REFERENCE_KEY) || [];
  if (
    cart.totalQuantity !== 1 ||
    cart.lines.pageInfo.hasNextPage ||
    cart.lines.nodes.length !== 1 ||
    line?.quantity !== 1 ||
    line.merchandise.id !== target.variantGid ||
    line.merchandise.product.id !== target.productGid ||
    line.sellingPlanAllocation != null ||
    line.attributes.length !== 1 ||
    refs.length !== 1 ||
    refs[0].value !== target.reference ||
    line.cost.amountPerQuantity.currencyCode !== "AUD" ||
    priceInCents(line.cost.amountPerQuantity.amount) !== target.priceCents ||
    cart.buyerIdentity.countryCode !== "AU"
  )
    throw changed();
  let url: URL, cartId: URL;
  try {
    url = new URL(cart.checkoutUrl);
    cartId = new URL(cart.id);
  } catch {
    throw changed();
  }
  // Full Cart IDs are persisted only on the server. Never return/log their key.
  if (
    cartId.protocol !== "gid:" ||
    cartId.hostname !== "shopify" ||
    !cartId.pathname.startsWith("/Cart/") ||
    !cartId.searchParams.get("key")
  )
    throw changed();
  // Owner-confirmed primary domain, scoped to this single merchant. Never derive
  // trusted hosts from the cart URL or browser input. Shared by create and resume.
  const checkoutHosts = [domain, "checkout.shopify.com"];
  if (domain === PRODUCTION_BOOKING_SHOP)
    checkoutHosts.push("skyrastudio.com.au");
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !checkoutHosts.includes(url.hostname) ||
    !/^\/(checkouts|cart)\//.test(url.pathname)
  )
    throw changed();
  return url.href;
}
