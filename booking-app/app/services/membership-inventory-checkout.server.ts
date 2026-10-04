import type { PassPurchase } from "@prisma/client";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import type { GraphQL } from "./shopify-catalog.server";
import { assertNoPublicMembershipStorefrontTokens } from "./membership-checkout-authorization.server";

export const inventoryMembershipCheckout = () =>
  process.env.SKYRA_MEMBERSHIPS_CHECKOUT_PROTECTION === "INVENTORY";

export const PRIVATE_PASS_CREATE = `#graphql
mutation PrivatePassCreate($input: ProductSetInput!) {
  productSet(input: $input, synchronous: true) {
    product { id variants(first: 2) { nodes { id inventoryItem { id } } } }
    userErrors { field message }
  }
}`;
export const PRIVATE_PASS_ATTACH = `#graphql
mutation PrivatePassAttach($id: ID!, $variants: [ID!]!) {
  sellingPlanGroupAddProductVariants(id: $id, productVariantIds: $variants) {
    sellingPlanGroup { id } userErrors { field message }
  }
}`;
export const PRIVATE_PASS_PUBLISH = `#graphql
mutation PrivatePassPublish($id: ID!, $input: [PublicationInput!]!) {
  publishablePublish(id: $id, input: $input) { userErrors { field message } }
}`;
export const PRIVATE_PASS_CONTEXT = `#graphql
query PrivatePassContext($location: ID!) {
  publications(first: 100, catalogType: APP) { nodes { id name } pageInfo { hasNextPage } }
  location(id: $location) { id isActive fulfillsOnlineOrders }
}`;
export const PRIVATE_PASS_READ = `#graphql
query PrivatePassRead($id: ID!, $location: ID!) {
  productVariant(id: $id) {
    id inventoryPolicy price
    product { id status handle requiresSellingPlan resourcePublications(first: 100) { nodes { isPublished publication { id } } pageInfo { hasNextPage } } }
    inventoryItem { id tracked inventoryLevels(first: 100) { nodes { location { id } quantities(names: ["available"]) { name quantity } } pageInfo { hasNextPage } } inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } }
  }
}`;

function unavailable(): never {
  throw new DomainError(
    "MEMBERSHIP_INVENTORY_UNVERIFIED",
    "This Pass checkout needs verification. Do not start another payment.",
    503,
  );
}
const gid = (type: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${type}/[1-9]\\d*$`));
async function request(
  admin: GraphQL,
  query: string,
  variables: Record<string, unknown>,
) {
  const response = await admin(query, {
    variables,
    tries: 1,
    signal: AbortSignal.timeout(12000),
  });
  const payload = await response.json();
  if (payload.errors?.length || !payload.data) unavailable();
  return payload.data;
}
function checked(result: { userErrors?: unknown[] } | undefined) {
  if (!result || !Array.isArray(result.userErrors) || result.userErrors.length)
    unavailable();
}

// One unlisted, single-stock product per durable purchase claim. Unlisted hides
// discovery, not access: native DENY inventory is the payment-exclusion boundary.
// Never replenish or
// recreate it after a timeout, cancellation, or successful checkout. Recurring
// billing uses the existing contract and does not reopen this purchase channel.
export async function prepareInventoryPass(
  purchase: PassPurchase,
  admin: GraphQL,
) {
  if (!inventoryMembershipCheckout() || purchase.validityMonths !== 1)
    return purchase;
  let resource = await db.membershipCheckoutResource.findUnique({
    where: { purchaseId: purchase.id },
  });
  if (resource) {
    if (resource.state !== "READY") unavailable();
    await assertInventoryPassClosedOrOpen(purchase.id, admin, "OPEN");
    return db.passPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
  }
  const locationGid = gid("Location").parse(
    process.env.SKYRA_MEMBERSHIPS_INVENTORY_LOCATION_GID,
  );
  await assertNoPublicMembershipStorefrontTokens(admin);
  const context = await request(admin, PRIVATE_PASS_CONTEXT, {
    location: locationGid,
  });
  const channels = context.publications?.nodes?.filter((p: {name: string}) => p.name === "Online Store");
  if (context.publications?.pageInfo?.hasNextPage !== false || channels?.length !== 1) unavailable();
  const publicationGid = gid("Publication").parse(channels[0].id);
  if (
    context.location?.id !== locationGid ||
    context.location?.isActive !== true ||
    context.location?.fulfillsOnlineOrders !== true
  )
    unavailable();
  const member = await db.passMembership.findUniqueOrThrow({
    where: { id: purchase.membershipId },
  });
  const plan = await db.passPlan.findUniqueOrThrow({
    where: { id: member.passPlanId },
  });
  if (
    purchase.mode === "AUTO_RENEW" &&
    (!plan.sellingPlanGroupGid ||
      plan.sellingPlanGid !== purchase.sellingPlanGid)
  )
    unavailable();
  // Unique purchaseId wins BEFORE creating anything at Shopify. A loser cannot
  // issue another product, even when the winner's response is lost.
  resource = await db.membershipCheckoutResource.create({
    data: {
      purchaseId: purchase.id,
      shopId: purchase.shopId,
      state: "CREATING",
      locationGid,
      publicationGid,
      sellingPlanGroupGid: plan.sellingPlanGroupGid,
    },
  });
  try {
    const created = await request(admin, PRIVATE_PASS_CREATE, {
      input: {
        title: plan.name,
        handle: `skyra-checkout-${purchase.id}`,
        status: "UNLISTED",
        requiresSellingPlan: purchase.mode === "AUTO_RENEW",
        productOptions: [
          { name: "Title", values: [{ name: "Default Title" }] },
        ],
        variants: [
          {
            optionValues: [{ optionName: "Title", name: "Default Title" }],
            price: (purchase.priceCents / 100).toFixed(2),
            taxable: false,
            inventoryPolicy: "DENY",
            inventoryItem: { tracked: true, requiresShipping: false },
            inventoryQuantities: [
              { locationId: locationGid, name: "available", quantity: 1 },
            ],
          },
        ],
      },
    });
    checked(created.productSet);
    const product = z
      .object({
        id: gid("Product"),
        variants: z.object({
          nodes: z
            .array(
              z.object({
                id: gid("ProductVariant"),
                inventoryItem: z.object({ id: gid("InventoryItem") }),
              }),
            )
            .length(1),
        }),
      })
      .parse(created.productSet.product);
    const variant = product.variants.nodes[0];
    // Persist native IDs before publishing. Unknown creation never retries.
    await db.$transaction(async (tx) => {
      await tx.membershipCheckoutResource.update({
        where: { purchaseId: purchase.id },
        data: {
          state: "VERIFYING",
          productGid: product.id,
          variantGid: variant.id,
          inventoryItemGid: variant.inventoryItem.id,
        },
      });
      await tx.passPurchase.update({
        where: { id: purchase.id },
        data: { productGid: product.id, variantGid: variant.id },
      });
    });
    if (purchase.mode === "AUTO_RENEW") {
      const attached = await request(admin, PRIVATE_PASS_ATTACH, {
        id: plan.sellingPlanGroupGid,
        variants: [variant.id],
      });
      checked(attached.sellingPlanGroupAddProductVariants);
    }
    const published = await request(admin, PRIVATE_PASS_PUBLISH, {
      id: product.id,
      input: [{ publicationId: publicationGid }],
    });
    checked(published.publishablePublish);
    await assertInventoryPassClosedOrOpen(purchase.id, admin, "OPEN");
    await db.membershipCheckoutResource.update({
      where: { purchaseId: purchase.id },
      data: { state: "READY" },
    });
    return db.passPurchase.findUniqueOrThrow({ where: { id: purchase.id } });
  } catch (error) {
    await db.membershipCheckoutResource.update({
      where: { purchaseId: purchase.id },
      data: { state: "REVIEW" },
    });
    throw error;
  }
}

export async function assertInventoryPassClosedOrOpen(
  purchaseId: string,
  admin: GraphQL,
  expected: "OPEN" | "CLOSED",
) {
  const resource = await db.membershipCheckoutResource.findUnique({
    where: { purchaseId },
  });
  const purchase = await db.passPurchase.findUnique({
    where: { id: purchaseId },
  });
  if (
    !resource ||
    !purchase ||
    !["VERIFYING", "READY"].includes(resource.state) ||
    resource.productGid !== purchase.productGid ||
    resource.variantGid !== purchase.variantGid
  )
    unavailable();
  await assertNoPublicMembershipStorefrontTokens(admin);
  const data = await request(admin, PRIVATE_PASS_READ, {
    id: resource.variantGid,
    location: resource.locationGid,
  });
  const variant = data.productVariant;
  const levels = variant?.inventoryItem?.inventoryLevels;
  const publications = variant?.product?.resourcePublications;
  const available = variant?.inventoryItem?.inventoryLevel?.quantities?.find(
    (q: { name: string }) => q.name === "available",
  )?.quantity;
  if (
    !variant ||
    variant.id !== resource.variantGid ||
    variant.inventoryPolicy !== "DENY" ||
    variant.price !== (purchase.priceCents / 100).toFixed(2) ||
    variant.product?.id !== resource.productGid ||
    variant.product?.status !== "UNLISTED" ||
    variant.product?.handle !== `skyra-checkout-${purchaseId}` ||
    variant.product?.requiresSellingPlan !== (purchase.mode === "AUTO_RENEW") ||
    variant.inventoryItem?.id !== resource.inventoryItemGid ||
    variant.inventoryItem?.tracked !== true ||
    !levels ||
    levels.pageInfo?.hasNextPage !== false ||
    levels.nodes?.length !== 1 ||
    levels.nodes[0].location.id !== resource.locationGid ||
    !publications ||
    publications.pageInfo?.hasNextPage !== false ||
    publications.nodes.filter((p: { isPublished: boolean }) => p.isPublished)
      .length !== 1 ||
    !publications.nodes.some(
      (p: { isPublished: boolean; publication: { id: string } }) =>
        p.isPublished && p.publication.id === resource.publicationGid,
    ) ||
    !Number.isInteger(available) ||
    (expected === "OPEN" ? available !== 1 : available > 0)
  )
    unavailable();
  if (expected === "CLOSED" && purchase.status !== "PAID") unavailable();
  return resource;
}
