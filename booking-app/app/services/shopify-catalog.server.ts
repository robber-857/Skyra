import db from "../db.server";
import { Prisma } from "@prisma/client";
export type GraphQL = (
  query: string,
  options: { variables: Record<string, unknown> },
) => Promise<Response>;
export const PRODUCT_SET = `#graphql
mutation BookingProductSet($identifier: ProductSetIdentifiers!, $input: ProductSetInput!) {
  productSet(identifier: $identifier, input: $input, synchronous: true) {
    product { id title status variants(first: 2) { nodes { id price } } }
    userErrors { field message code }
  }
}`;
export const METAFIELDS_SET = `#graphql
mutation BookingMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { metafields { key jsonValue } userErrors { field message code } }
}`;
export const MAPPING_READ = `#graphql
query BookingMapping($id: ID!) {
  product(id: $id) {
    id title status
    bookingOwner: metafield(namespace: "$app", key: "booking_owner_id") { jsonValue }
    variants(first: 2) { nodes { id price } }
  }
}`;
export const METAOBJECT_UPSERT = `#graphql
mutation BookingContent($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
  metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
    metaobject { id handle }
    userErrors { field message code }
  }
}`;
export const METAOBJECT_DEFINITION_READ = `#graphql
query BookingMetaobjectDefinition($type: String!) {
  metaobjectDefinitionByType(type: $type) { id type name }
}`;
export const METAOBJECT_DEFINITION_CREATE = `#graphql
mutation BookingMetaobjectDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
  metaobjectDefinitionCreate(definition: $definition) {
    metaobjectDefinition { id type name }
    userErrors { field message code }
  }
}`;
export const CONTENT_READ = `#graphql
query BookingContentRead($handle: MetaobjectHandleInput!) {
  metaobjectByHandle(handle: $handle) { id handle name: field(key: "name") { jsonValue } }
}`;
async function graphqlData(
  graphql: GraphQL,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await graphql(query, { variables });
  const json = await response.json();
  if (!response.ok || json.errors?.length)
    throw new Error(
      "Shopify API request failed; retry or check app permissions.",
    );
  for (const value of Object.values(json.data ?? {}) as {
    userErrors?: { code?: string; message?: string }[];
  }[])
    if (value?.userErrors?.length)
      throw new Error(
        "Shopify rejected catalogue data: " +
          (value.userErrors[0].code || "VALIDATION") +
          (value.userErrors[0].message
            ? ` (${value.userErrors[0].message})`
            : ""),
      );
  return json.data;
}
async function ensureServiceContentDefinition(graphql: GraphQL) {
  const type = "$app:booking_service_content_v1";
  const existing = await graphqlData(graphql, METAOBJECT_DEFINITION_READ, {
    type,
  });
  if (existing.metaobjectDefinitionByType) return;

  await graphqlData(graphql, METAOBJECT_DEFINITION_CREATE, {
    definition: {
      type,
      name: "Booking service content",
      displayNameKey: "name",
      access: { admin: "MERCHANT_READ", storefront: "PUBLIC_READ" },
      fieldDefinitions: [
        {
          key: "name",
          name: "Name",
          type: "single_line_text_field",
          required: true,
        },
        {
          key: "description",
          name: "Description",
          type: "multi_line_text_field",
        },
      ],
    },
  });
}

export async function syncCatalogEvent(eventId: string, graphql: GraphQL) {
  // Per-shop serialization spans the remote call: old workers cannot overwrite a newer save.
  // Shopify upsert handle is deterministic, so a crash before DB commit does not duplicate products.
  return db.$transaction(
    async (tx) => {
      const initial = await tx.outboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      await tx.$queryRaw`SELECT id FROM "Shop" WHERE id = ${initial.shopId}::uuid FOR UPDATE`;
      const event = await tx.outboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      if (event.status === "DONE") return;
      const shop = await tx.shop.findUniqueOrThrow({
        where: { id: event.shopId },
      });
      if (shop.status !== "ACTIVE") throw new Error("Shop is not active.");
      const ownerType = (event.payload as Prisma.JsonObject)
        .ownerType as string;
      const mapping = await tx.productMapping.findUniqueOrThrow({
        where: {
          shopId_ownerType_ownerId: {
            shopId: event.shopId,
            ownerType,
            ownerId: event.aggregateId,
          },
        },
      });
      if (event.version < mapping.requestedVersion) {
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: "DONE" },
        });
        return;
      }
      const owner =
        ownerType === "SERVICE"
          ? await tx.service.findFirstOrThrow({
              where: { shopId: event.shopId, id: event.aggregateId },
            })
          : await tx.passPlan.findFirstOrThrow({
              where: { shopId: event.shopId, id: event.aggregateId },
            });
      const handle = "skyra-booking-" + owner.id;
      // A stable mapping owns exactly one variant. Refuse destructive reconciliation if a merchant adds variants.
      if (mapping.productGid) {
        const live = await graphqlData(graphql, MAPPING_READ, {
          id: mapping.productGid,
        });
        if (
          !live.product ||
          live.product.variants.nodes.length !== 1 ||
          live.product.bookingOwner?.jsonValue !== owner.id
        )
          throw new Error(
            "Mapped product missing or manually restructured; review in Shopify before syncing.",
          );
      }
      const data = await graphqlData(graphql, PRODUCT_SET, {
        identifier: mapping.productGid
          ? { id: mapping.productGid }
          : { handle },
        input: {
          title: owner.name,
          handle,
          status:
            owner.status === "ACTIVE"
              ? "ACTIVE"
              : owner.status === "INACTIVE"
                ? "ARCHIVED"
                : "DRAFT",
          productOptions: [
            { name: "Title", values: [{ name: "Default Title" }] },
          ],
          variants: [
            {
              ...(mapping.variantGid ? { id: mapping.variantGid } : {}),
              price: (owner.requestedPriceCents / 100).toFixed(2),
              optionValues: [{ optionName: "Title", name: "Default Title" }],
              inventoryPolicy: "CONTINUE",
              inventoryItem: { requiresShipping: false, tracked: false },
            },
          ],
        },
      });
      const product = data.productSet.product;
      if (!product || product.variants.nodes.length !== 1)
        throw new Error("Expected exactly one sellable variant.");
      await graphqlData(graphql, METAFIELDS_SET, {
        metafields: [
          {
            ownerId: product.id,
            namespace: "$app",
            key: "booking_owner_id",
            type: "single_line_text_field",
            value: owner.id,
          },
          {
            ownerId: product.id,
            namespace: "$app",
            key: "entitlement_kind",
            type: "single_line_text_field",
            value: ownerType === "SERVICE" ? "DROP_IN" : "PACK",
          },
        ],
      });
      if (ownerType === "SERVICE") {
        await ensureServiceContentDefinition(graphql);
        const contentHandle = {
          type: "$app:booking_service_content_v1",
          handle: owner.id,
        };
        await graphqlData(graphql, METAOBJECT_UPSERT, {
          handle: contentHandle,
          metaobject: {
            fields: [
              { key: "name", value: owner.name },
              {
                key: "description",
                value: "description" in owner ? owner.description : "",
              },
            ],
          },
        });
        const content = await graphqlData(graphql, CONTENT_READ, {
          handle: contentHandle,
        });
        if (!content.metaobjectByHandle)
          throw new Error("Shopify service content read-back failed.");
      }
      const verified = await graphqlData(graphql, MAPPING_READ, {
        id: product.id,
      });
      if (verified.product?.bookingOwner?.jsonValue !== owner.id)
        throw new Error("Shopify mapping read-back failed.");
      await tx.productMapping.update({
        where: { id: mapping.id },
        data: {
          productGid: product.id,
          variantGid: product.variants.nodes[0].id,
          publishedTitle: product.title,
          publishedPrice: product.variants.nodes[0].price,
          productStatus: product.status,
          shopifyVersion: event.version,
          syncStatus: "SYNCED",
          lastError: null,
          syncedAt: new Date(),
        },
      });
      await tx.outboxEvent.update({
        where: { id: event.id },
        data: { status: "DONE", lastError: null },
      });
    },
    { timeout: 60000, maxWait: 10000 },
  );
}
export async function recordSyncFailure(id: string) {
  await db.$transaction(async (tx) => {
    const initial = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
    await tx.$queryRaw`SELECT id FROM "Shop" WHERE id = ${initial.shopId}::uuid FOR UPDATE`;
    const event = await tx.outboxEvent.findUniqueOrThrow({ where: { id } });
    if (event.status === "DONE") return;
    const attempts = event.attempts + 1;
    await tx.outboxEvent.update({
      where: { id },
      data: {
        attempts,
        status: attempts >= 5 ? "FAILED" : "PENDING",
        availableAt: new Date(Date.now() + Math.min(300, 2 ** attempts) * 1000),
        lastError:
          "Shopify sync failed. Check permissions and product structure, then retry.",
      },
    });
    await tx.productMapping.updateMany({
      where: {
        shopId: event.shopId,
        ownerId: event.aggregateId,
        requestedVersion: event.version,
      },
      data: {
        syncStatus: "ERROR",
        lastError:
          "Shopify sync failed. Check permissions and product structure, then retry.",
      },
    });
  });
}
