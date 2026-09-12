import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import { priceInCents, purchaseMappingReady } from "./purchase-mapping.server";
import type { GraphQL } from "./shopify-catalog.server";

export const PURCHASABILITY_QUERY = `#graphql
query BookingPurchasability($id: ID!) {
  shop { myshopifyDomain currencyCode }
  product(id: $id) {
    id status onlineStoreUrl publishedAt requiresSellingPlan
    bookingOwner: metafield(namespace: "$app", key: "booking_owner_id") { jsonValue }
    entitlementKind: metafield(namespace: "$app", key: "entitlement_kind") { jsonValue }
    variants(first: 2) { nodes { id price availableForSale requiresComponents } }
  }
}
`;
export const STOREFRONT_PURCHASABILITY_QUERY = `#graphql
query BookingStorefrontPurchasability($id: ID!) @inContext(country: AU) {
  product(id: $id) {
    id availableForSale requiresSellingPlan
    variants(first: 2) { nodes {
      id availableForSale requiresComponents requiresShipping
      price { amount currencyCode }
    } }
  }
}
`;

export type CommerceClients = { admin: GraphQL; storefront: GraphQL };
export type CatalogPurchaseReport = {
  mappingId: string;
  name: string;
  checkedAt: string;
  ready: boolean;
  issues: { code: string; message: string }[];
};
const variant = z.object({
  id: z.string(),
  availableForSale: z.boolean(),
  requiresComponents: z.boolean(),
});
const adminData = z.object({
  shop: z.object({ myshopifyDomain: z.string(), currencyCode: z.string() }),
  product: z
    .object({
      id: z.string(),
      status: z.string(),
      onlineStoreUrl: z.string().url().nullable(),
      publishedAt: z.string().datetime({ offset: true }).nullable(),
      requiresSellingPlan: z.boolean(),
      bookingOwner: z.object({ jsonValue: z.unknown() }).nullable(),
      entitlementKind: z.object({ jsonValue: z.unknown() }).nullable(),
      variants: z.object({
        nodes: z.array(variant.extend({ price: z.string() })),
      }),
    })
    .nullable(),
});
const storefrontData = z.object({
  product: z
    .object({
      id: z.string(),
      availableForSale: z.boolean(),
      requiresSellingPlan: z.boolean(),
      variants: z.object({
        nodes: z.array(
          variant.extend({
            requiresShipping: z.boolean(),
            price: z.object({ amount: z.string(), currencyCode: z.string() }),
          }),
        ),
      }),
    })
    .nullable(),
});

// Never forward an Admin token to the storefront or accept a browser-supplied domain.
export function storefrontReadClient(domain: string): GraphQL {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain))
    throw new DomainError("INVALID_SHOP", "Invalid Shopify store.", 400);
  return (query, { variables }) =>
    fetch("https://" + domain + "/api/2026-07/graphql.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(6000),
      redirect: "error",
    });
}
async function readTarget(shopId: string, mappingId: string) {
  const [shop, mapping] = await Promise.all([
    db.shop.findUnique({ where: { id: shopId } }),
    db.productMapping.findFirst({ where: { id: mappingId, shopId } }),
  ]);
  if (!shop || shop.status !== "ACTIVE" || !mapping)
    throw new DomainError("NOT_FOUND", "Booking product not found.", 404);
  const owner =
    mapping.ownerType === "SERVICE"
      ? await db.service.findFirst({ where: { id: mapping.ownerId, shopId } })
      : mapping.ownerType === "PASS_PLAN"
        ? await db.passPlan.findFirst({
            where: { id: mapping.ownerId, shopId },
          })
        : null;
  if (!owner)
    throw new DomainError("NOT_FOUND", "Booking product not found.", 404);
  return { shop, mapping, owner };
}
function fingerprint({
  shop,
  mapping,
  owner,
}: Awaited<ReturnType<typeof readTarget>>) {
  return JSON.stringify([
    shop.domain,
    shop.status,
    mapping.productGid,
    mapping.variantGid,
    mapping.syncStatus,
    mapping.productStatus,
    mapping.requestedVersion,
    mapping.shopifyVersion,
    mapping.publishedPrice,
    mapping.ownerType,
    mapping.ownerId,
    owner.version,
    owner.status,
    owner.requestedPriceCents,
  ]);
}
async function readData<T>(
  graphql: GraphQL,
  query: string,
  id: string,
  schema: z.ZodType<T>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await graphql(query, { variables: { id } });
        const payload = await response.json();
        if (
          payload.errors?.some(
            (error: { message?: string }) =>
              error.message === "Online Store channel is locked.",
          )
        )
          throw new DomainError(
            "STOREFRONT_LOCKED",
            "Online Store channel is locked.",
            503,
          );
        if (!response.ok) throw new Error("Shopify HTTP error");
        if (payload.errors?.length) throw new Error("Shopify GraphQL error");
        return schema.parse(payload.data);
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Shopify timeout")), 6000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A fresh read-only observation, not permission to charge or a durable availability cache.
// No remote request is made while a Session/Attempt database lock is held.
export async function inspectCatalogPurchase(
  shopId: string,
  mappingId: string,
  clients: CommerceClients,
): Promise<CatalogPurchaseReport> {
  const target = await readTarget(shopId, mappingId);
  const { shop, mapping, owner } = target;
  const issues: CatalogPurchaseReport["issues"] = [];
  const add = (code: string, message: string) => {
    if (!issues.some((issue) => issue.code === code))
      issues.push({ code, message });
  };
  const report = () => ({
    mappingId,
    name: owner.name,
    checkedAt: new Date().toISOString(),
    ready: issues.length === 0,
    issues,
  });
  if (owner.status !== "ACTIVE")
    add("OWNER_INACTIVE", "Activate this class or Pass before selling it.");
  if (
    !purchaseMappingReady(mapping, owner) ||
    !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(mapping.productGid || "") ||
    !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(
      mapping.variantGid || "",
    )
  )
    add(
      "SYNC_REQUIRED",
      "Finish Shopify synchronization before checking availability.",
    );
  if (issues.length) return report();

  const [adminResult, storefrontResult] = await Promise.allSettled([
    readData(
      clients.admin,
      PURCHASABILITY_QUERY,
      mapping.productGid!,
      adminData,
    ),
    readData(
      clients.storefront,
      STOREFRONT_PURCHASABILITY_QUERY,
      mapping.productGid!,
      storefrontData,
    ),
  ]);
  if (adminResult.status === "rejected") {
    add(
      "SHOPIFY_UNAVAILABLE",
      "Could not verify Shopify Admin availability. Check app access and try again.",
    );
  }
  if (storefrontResult.status === "rejected") {
    const accessRequired =
      storefrontResult.reason instanceof DomainError &&
      storefrontResult.reason.code === "STOREFRONT_ACCESS_REQUIRED";
    const locked =
      storefrontResult.reason instanceof DomainError &&
      storefrontResult.reason.code === "STOREFRONT_LOCKED";
    add(
      accessRequired
        ? "STOREFRONT_ACCESS_REQUIRED"
        : locked
          ? "STOREFRONT_LOCKED"
          : "SHOPIFY_UNAVAILABLE",
      accessRequired
        ? "Approve Storefront product access for Skyra Booking, then reconnect the app and check again."
        : locked
          ? "The Online Store is locked. Check authenticated Storefront access; do not remove store protection to bypass this check."
          : "Could not verify Australian storefront availability. Please try again.",
    );
  }
  if (adminResult.status === "fulfilled") {
    const live = adminResult.value;
    if (live.shop.myshopifyDomain !== shop.domain)
      add("SHOP_MISMATCH", "The Shopify connection belongs to another store.");
    if (live.shop.currencyCode !== "AUD")
      add(
        "CURRENCY_MISMATCH",
        "Booking currently requires the store currency to be AUD.",
      );
    const product = live.product;
    if (!product || product.id !== mapping.productGid) {
      add("PRODUCT_MISSING", "The mapped Shopify product is missing.");
    } else {
      if (product.bookingOwner?.jsonValue !== owner.id)
        add(
          "OWNER_MISMATCH",
          "The Shopify product is no longer linked to this class or Pass.",
        );
      if (
        product.entitlementKind?.jsonValue !==
        (mapping.ownerType === "SERVICE" ? "DROP_IN" : "PACK")
      )
        add(
          "ENTITLEMENT_KIND_MISMATCH",
          "The Shopify entitlement type differs from this class or Pass.",
        );
      if (product.status !== "ACTIVE")
        add("PRODUCT_INACTIVE", "Activate the product in Shopify.");
      // A protected dev store can return a null URL for an already-published
      // product. Use the Online Store publication timestamp, then independently
      // require the live AU Storefront product/variant/price checks below.
      if (
        !product.publishedAt ||
        Date.parse(product.publishedAt) > Date.now()
      )
        add(
          "ONLINE_STORE_UNPUBLISHED",
          "Publish this product to the Online Store sales channel in Shopify.",
        );
      if (product.requiresSellingPlan)
        add(
          "SELLING_PLAN_REQUIRED",
          "This product requires a subscription. Booking supports one-time purchases.",
        );
      const current = product.variants.nodes[0];
      if (
        product.variants.nodes.length !== 1 ||
        current?.id !== mapping.variantGid
      ) {
        add(
          "VARIANT_CHANGED",
          "The Shopify variant structure changed. Review the product mapping.",
        );
      } else {
        if (!current.availableForSale)
          add(
            "VARIANT_UNAVAILABLE",
            "The Shopify variant is not available for sale.",
          );
        if (current.requiresComponents)
          add(
            "BUNDLE_UNSUPPORTED",
            "Booking does not support bundle-only variants.",
          );
        if (priceInCents(current.price) !== owner.requestedPriceCents)
          add(
            "PRICE_CHANGED",
            "The Shopify price differs from Booking. Review and synchronize the price.",
          );
      }
    }
  }
  if (storefrontResult.status === "fulfilled") {
    const visible = storefrontResult.value.product;
    if (!visible || visible.id !== mapping.productGid) {
      add(
        "MARKET_UNAVAILABLE",
        "The product is not visible through the Storefront API for Australia.",
      );
    } else {
      const current = visible.variants.nodes[0];
      if (
        visible.variants.nodes.length !== 1 ||
        current?.id !== mapping.variantGid
      ) {
        add(
          "STOREFRONT_VARIANT_CHANGED",
          "The storefront variant differs from the Booking mapping.",
        );
      } else {
        if (!visible.availableForSale || !current.availableForSale)
          add(
            "STOREFRONT_UNAVAILABLE",
            "This product cannot currently be purchased in Australia.",
          );
        if (visible.requiresSellingPlan || current.requiresComponents)
          add(
            "PURCHASE_OPTION_UNSUPPORTED",
            "The storefront requires an unsupported subscription or bundle.",
          );
        if (current.requiresShipping)
          add(
            "SHIPPING_REQUIRED",
            "Booking products must not require shipping.",
          );
        if (
          current.price.currencyCode !== "AUD" ||
          priceInCents(current.price.amount) !== owner.requestedPriceCents
        )
          add(
            "MARKET_PRICE_CHANGED",
            "The Australian storefront price differs from the Booking AUD price.",
          );
      }
    }
  }
  try {
    if (
      fingerprint(await readTarget(shopId, mappingId)) !== fingerprint(target)
    )
      add(
        "CATALOG_CHANGED",
        "The class, Pass or mapping changed during this check. Check again.",
      );
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    add(
      "CATALOG_CHANGED",
      "The class, Pass or store changed during this check. Check again.",
    );
  }
  return report();
}

export async function checkCatalogPurchase(
  actor: Actor,
  mappingId: string,
  clients: CommerceClients,
) {
  requireOperations(actor);
  z.string().uuid().parse(mappingId);
  return inspectCatalogPurchase(actor.shopId, mappingId, clients);
}
