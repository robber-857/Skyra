import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import type { Actor } from "./authorization";
import { audit, lockShop } from "./catalog.server";
import { priceInCents, purchaseMappingReady } from "./purchase-mapping.server";
import type { GraphQL } from "./shopify-catalog.server";

export const OWNERSHIP_READ = `#graphql
query BookingOwnershipRecovery($id: ID!) {
 shop { myshopifyDomain }
 currentAppInstallation { app { apiKey } }
 metafieldDefinitions(first: 20, ownerType: PRODUCT, namespace: "$app") {
  nodes { key type { name } }
 }
 product(id: $id) {
  id handle
  bookingOwner: metafield(namespace: "$app", key: "booking_owner_id") { jsonValue }
  entitlementKind: metafield(namespace: "$app", key: "entitlement_kind") { jsonValue }
  variants(first: 2) { nodes { id price } }
 }
}
`;
export const OWNERSHIP_RESTORE = `#graphql
mutation BookingOwnershipRestore($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { key jsonValue }
    userErrors { field message code }
  }
}`;
const field = z.object({ jsonValue: z.unknown() }).nullable();
const ownershipData = z.object({
  shop: z.object({ myshopifyDomain: z.string() }),
  currentAppInstallation: z.object({ app: z.object({ apiKey: z.string() }) }),
  metafieldDefinitions: z.object({
    nodes: z.array(
      z.object({
        key: z.string(),
        type: z.object({ name: z.string() }),
      }),
    ),
  }),
  product: z
    .object({
      id: z.string(),
      handle: z.string(),
      bookingOwner: field,
      entitlementKind: field,
      variants: z.object({
        nodes: z.array(z.object({ id: z.string(), price: z.string() })),
      }),
    })
    .nullable(),
});
async function request(
  graphql: GraphQL,
  query: string,
  variables: Record<string, unknown>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await graphql(query, { variables });
        const body = await response.json();
        if (!response.ok || body.errors?.length) throw new Error();
        return body.data;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 6000);
      }),
    ]);
  } catch {
    throw new DomainError(
      "SHOPIFY_UNAVAILABLE",
      "Shopify ownership verification failed. Retry the check.",
      503,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Explicit maintenance operation: only fills absent fields. Never changes product
// publication, variants, prices, titles, or existing ownership. No automatic retry.
export async function restoreCatalogOwnership(
  actor: Actor,
  mappingId: string,
  expectedAppApiKey: string,
  graphql: GraphQL,
) {
  if (actor.role !== "ADMIN")
    throw new DomainError("FORBIDDEN", "Administrator access required.", 403);
  z.string().uuid().parse(mappingId);
  if (!/^[a-f0-9]{32}$/i.test(expectedAppApiKey))
    throw new DomainError(
      "APP_IDENTITY_REQUIRED",
      "Configure the expected Booking App identity.",
      409,
    );
  return db.$transaction(
    async (tx) => {
      // Catalog writers use the same lock. Recovery is rare and scoped to one product.
      await lockShop(tx, actor.shopId);
      const shop = await tx.shop.findUnique({ where: { id: actor.shopId } });
      const mapping = await tx.productMapping.findFirst({
        where: { id: mappingId, shopId: actor.shopId },
      });
      if (!shop || shop.status !== "ACTIVE" || !mapping)
        throw new DomainError("NOT_FOUND", "Booking product not found.", 404);
      const owner =
        mapping.ownerType === "SERVICE"
          ? await tx.service.findFirst({
              where: { id: mapping.ownerId, shopId: actor.shopId },
            })
          : mapping.ownerType === "PASS_PLAN"
            ? await tx.passPlan.findFirst({
                where: { id: mapping.ownerId, shopId: actor.shopId },
              })
            : null;
      if (
        !owner ||
        !purchaseMappingReady(mapping, owner) ||
        !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(
          mapping.productGid || "",
        ) ||
        !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(
          mapping.variantGid || "",
        )
      )
        throw new DomainError(
          "MAPPING_REVIEW_REQUIRED",
          "Review the existing synchronized product mapping first.",
          409,
        );
      const read = async () =>
        ownershipData.parse(
          await request(graphql, OWNERSHIP_READ, { id: mapping.productGid }),
        );
      const expected = {
        booking_owner_id: owner.id,
        entitlement_kind: mapping.ownerType === "SERVICE" ? "DROP_IN" : "PACK",
      };
      const verify = (live: z.infer<typeof ownershipData>) => {
        if (
          live.shop.myshopifyDomain !== shop.domain ||
          live.currentAppInstallation.app.apiKey !== expectedAppApiKey
        )
          throw new DomainError(
            "APP_IDENTITY_MISMATCH",
            "The Shopify connection belongs to another app or store.",
            409,
          );
        for (const key of Object.keys(expected)) {
          if (
            !live.metafieldDefinitions.nodes.some(
              (definition) =>
                definition.key === key &&
                definition.type.name === "single_line_text_field",
            )
          )
            throw new DomainError(
              "DEFINITIONS_REQUIRED",
              "Apply the Booking App TOML metafield definitions before restoring values.",
              409,
            );
        }
        const product = live.product;
        if (
          !product ||
          product.id !== mapping.productGid ||
          product.handle !== "skyra-booking-" + owner.id ||
          product.variants.nodes.length !== 1 ||
          product.variants.nodes[0].id !== mapping.variantGid ||
          priceInCents(product.variants.nodes[0].price) !==
            owner.requestedPriceCents
        )
          throw new DomainError(
            "MAPPING_REVIEW_REQUIRED",
            "The Shopify product no longer matches the stable Booking mapping.",
            409,
          );
        const current = {
          booking_owner_id: product.bookingOwner,
          entitlement_kind: product.entitlementKind,
        };
        for (const key of Object.keys(expected) as (keyof typeof expected)[])
          if (current[key] && current[key].jsonValue !== expected[key])
            throw new DomainError(
              "OWNERSHIP_CONFLICT",
              "Existing Booking ownership conflicts. No fields were overwritten.",
              409,
            );
        return current;
      };
      const before = verify(await read());
      const missing = (
        Object.keys(expected) as (keyof typeof expected)[]
      ).filter((key) => before[key] === null);
      if (missing.length) {
        const result = await request(graphql, OWNERSHIP_RESTORE, {
          metafields: missing.map((key) => ({
            ownerId: mapping.productGid,
            namespace: "$app",
            key,
            type: "single_line_text_field",
            value: expected[key],
            compareDigest: null,
          })),
        });
        if (
          !result?.metafieldsSet ||
          !Array.isArray(result.metafieldsSet.userErrors) ||
          result.metafieldsSet.userErrors.length
        )
          throw new DomainError(
            "OWNERSHIP_CHANGED",
            "Shopify rejected recovery or ownership changed concurrently. Recheck before retrying.",
            409,
          );
        const after = verify(await read());
        if (Object.values(after).some((value) => value === null))
          throw new DomainError(
            "READBACK_FAILED",
            "Ownership restoration was not confirmed. Recheck Shopify before retrying.",
            503,
          );
        await audit(
          tx,
          actor,
          "CATALOG_OWNERSHIP_RESTORED",
          mapping.id,
          { productGid: mapping.productGid, missingKeys: missing },
          { productGid: mapping.productGid, restoredKeys: missing },
        );
      }
      return {
        mappingId: mapping.id,
        productGid: mapping.productGid,
        restoredKeys: missing,
      };
    },
    { timeout: 30000, maxWait: 5000 },
  );
}
