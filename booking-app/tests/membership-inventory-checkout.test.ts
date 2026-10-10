import { randomUUID } from "node:crypto";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { claimPassPurchaseInTransaction } from "../app/services/membership-purchases.server";
import {
  prepareInventoryPass,
  assertInventoryPassClosedOrOpen,
  PRIVATE_PASS_CONTEXT,
  PRIVATE_PASS_CREATE,
  PRIVATE_PASS_READ,
  PRIVATE_PASS_ATTACH,
} from "../app/services/membership-inventory-checkout.server";
import { PUBLIC_MEMBERSHIP_STOREFRONT_TOKENS } from "../app/services/membership-checkout-authorization.server";

afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.$disconnect());
async function fixture(months = 1, autoRenew = false) {
  vi.stubEnv("SKYRA_MEMBERSHIPS_CHECKOUT_PROTECTION", "INVENTORY");
  vi.stubEnv(
    "SKYRA_MEMBERSHIPS_INVENTORY_LOCATION_GID",
    "gid://shopify/Location/1",
  );
  const f = await paidFixture("NEW_PASS", false, "CLASS", months);
  if (autoRenew) await db.passPlan.update({ where: { id: f.plan.id }, data: { autoRenewEnabled: true, sellingPlanGid: "gid://shopify/SellingPlan/789", sellingPlanGroupGid: "gid://shopify/SellingPlanGroup/700" } });
  const { purchase } = await db.$transaction((tx) =>
    claimPassPurchaseInTransaction(tx, {
      shopId: f.shop.id,
      customerId: f.customer.id,
      passPlanId: f.plan.id,
      mode: autoRenew ? "AUTO_RENEW" : "ONCE",
      sellingPlanGid: autoRenew ? "gid://shopify/SellingPlan/789" : null,
      autoRenewTermsVersion: autoRenew ? "test" : undefined,
      bookingCheckoutId: f.checkout.id,
      idempotencyKey: randomUUID(),
      productMappingId: f.mapping.id,
      productGid: f.mapping.productGid!,
      variantGid: f.mapping.variantGid!,
      priceCents: f.plan.requestedPriceCents,
      currency: "AUD",
      credits: f.plan.credits,
      validityDays: f.plan.validityDays,
      validityMonths: months,
      timezone: "Australia/Sydney",
      termsVersion: "test",
    }),
  );
  const serial = String(
    BigInt(Date.now()) * 100000n + BigInt(Math.floor(Math.random() * 100000)),
  );
  const item = {
    id: `gid://shopify/ProductVariant/${serial}`,
    price: (purchase.priceCents / 100).toFixed(2),
    inventoryPolicy: "DENY",
    product: {
      id: `gid://shopify/Product/${serial}`,
      status: "UNLISTED",
      handle: `skyra-checkout-${purchase.id}`,
      requiresSellingPlan: autoRenew,
      resourcePublications: {
        nodes: [
          {
            isPublished: true,
            publication: { id: "gid://shopify/Publication/1" },
          },
        ],
        pageInfo: { hasNextPage: false },
      },
    },
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${serial}`,
      tracked: true,
      inventoryLevels: {
        nodes: [
          {
            location: { id: "gid://shopify/Location/1" },
            quantities: [{ name: "available", quantity: 1 }],
          },
        ],
        pageInfo: { hasNextPage: false },
      },
      inventoryLevel: { quantities: [{ name: "available", quantity: 1 }] },
    },
  };
  const admin = vi.fn(async (query: string) => {
    if (query === PUBLIC_MEMBERSHIP_STOREFRONT_TOKENS)
      return Response.json({
        data: {
          shop: {
            storefrontAccessTokens: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    if (query === PRIVATE_PASS_CONTEXT)
      return Response.json({
        data: {
          publications: { nodes: [{ id: "gid://shopify/Publication/1", name: "Online Store" }], pageInfo: { hasNextPage: false } },
          location: {
            id: "gid://shopify/Location/1",
            isActive: true,
            fulfillsOnlineOrders: true,
          },
        },
      });
    if (query === PRIVATE_PASS_CREATE)
      return Response.json({
        data: {
          productSet: {
            product: {
              id: item.product.id,
              variants: {
                nodes: [
                  { id: item.id, inventoryItem: { id: item.inventoryItem.id } },
                ],
              },
            },
            userErrors: [],
          },
        },
      });
    if (query === PRIVATE_PASS_ATTACH) return Response.json({ data: { sellingPlanGroupAddProductVariants: { userErrors: [] } } });
    if (query === PRIVATE_PASS_READ)
      return Response.json({ data: { productVariant: item } });
    return Response.json({ data: { publishablePublish: { userErrors: [] } } });
  });
  return { ...f, purchase, item, admin };
}

test("Basic purchase uses one private stock unit and replays without creating or replenishing it", async () => {
  const f = await fixture();
  const ready = await prepareInventoryPass(f.purchase, f.admin);
  expect(ready.variantGid).toBe(f.item.id);
  expect(
    (
      await db.bookingCheckout.findUniqueOrThrow({
        where: { id: f.checkout.id },
      })
    ).variantGid,
  ).toBe(f.checkout.variantGid);
  await prepareInventoryPass(ready, f.admin);
  expect(
    f.admin.mock.calls.filter(([q]) => q === PRIVATE_PASS_CREATE),
  ).toHaveLength(1);
  await expect(
    assertInventoryPassClosedOrOpen(ready.id, f.admin, "CLOSED"),
  ).rejects.toMatchObject({ code: "MEMBERSHIP_INVENTORY_UNVERIFIED" });
  await db.passPurchase.update({
    where: { id: ready.id },
    data: { status: "PAID" },
  });
  f.item.inventoryItem.inventoryLevel.quantities[0].quantity = 0;
  await expect(
    assertInventoryPassClosedOrOpen(ready.id, f.admin, "CLOSED"),
  ).resolves.toMatchObject({ state: "READY" });
  await expect(prepareInventoryPass(ready, f.admin)).rejects.toMatchObject({
    code: "MEMBERSHIP_INVENTORY_UNVERIFIED",
  });
  expect(
    f.admin.mock.calls.filter(([q]) => q === PRIVATE_PASS_CREATE),
  ).toHaveLength(1);
});

test("concurrent resource creation has exactly one native product mutation", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => prepareInventoryPass(f.purchase, f.admin)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    f.admin.mock.calls.filter(([q]) => q === PRIVATE_PASS_CREATE),
  ).toHaveLength(1);
});

test("lost native creation response is parked permanently rather than making a replacement", async () => {
  const f = await fixture();
  const original = f.admin.getMockImplementation()!;
  f.admin.mockImplementation(async (q) => {
    if (q === PRIVATE_PASS_CREATE) throw Error("lost");
    return original(q);
  });
  await expect(prepareInventoryPass(f.purchase, f.admin)).rejects.toThrow(
    "lost",
  );
  await expect(prepareInventoryPass(f.purchase, f.admin)).rejects.toMatchObject(
    { code: "MEMBERSHIP_INVENTORY_UNVERIFIED" },
  );
  expect(
    f.admin.mock.calls.filter(([q]) => q === PRIVATE_PASS_CREATE),
  ).toHaveLength(1);
});

test.each([
  "oversell",
  "untracked",
  "public",
  "restocked",
  "wrong_item",
  "extra_location",
])("renewal cannot proceed with %s inventory protection", async (fault) => {
  const f = await fixture();
  await prepareInventoryPass(f.purchase, f.admin);
  await db.passPurchase.update({
    where: { id: f.purchase.id },
    data: { status: "PAID" },
  });
  f.item.inventoryItem.inventoryLevel.quantities[0].quantity = 0;
  if (fault === "oversell") f.item.inventoryPolicy = "CONTINUE";
  if (fault === "untracked") f.item.inventoryItem.tracked = false;
  if (fault === "public")
    f.item.product.resourcePublications.nodes.push({
      isPublished: true,
      publication: { id: "gid://shopify/Publication/2" },
    });
  if (fault === "restocked")
    f.item.inventoryItem.inventoryLevel.quantities[0].quantity = 1;
  if (fault === "wrong_item")
    f.item.inventoryItem.id = "gid://shopify/InventoryItem/999";
  if (fault === "extra_location")
    f.item.inventoryItem.inventoryLevels.pageInfo.hasNextPage = true;
  await expect(
    assertInventoryPassClosedOrOpen(f.purchase.id, f.admin, "CLOSED"),
  ).rejects.toMatchObject({ code: "MEMBERSHIP_INVENTORY_UNVERIFIED" });
});


test.each([3, 6, 12])("%s-month auto-renew uses a protected subscription-only private product", async (months) => {
  const f = await fixture(months, true);
  const ready = await prepareInventoryPass(f.purchase, f.admin);
  expect(ready.variantGid).toBe(f.item.id);
  expect(ready.validityMonths).toBe(months);
  expect(f.admin.mock.calls.some(([query]) => query === PRIVATE_PASS_ATTACH)).toBe(true);
  await prepareInventoryPass(ready, f.admin);
  expect(f.admin.mock.calls.filter(([query]) => query === PRIVATE_PASS_CREATE)).toHaveLength(1);
});


test.each([3, 6, 12])("one-time purchase of a configured %s-month Pass still uses checkout protection", async (months) => {
  const f = await fixture(months);
  await db.passPlan.update({ where: { id: f.plan.id }, data: { sellingPlanGid: "gid://shopify/SellingPlan/789", sellingPlanGroupGid: "gid://shopify/SellingPlanGroup/700" } });
  const ready = await prepareInventoryPass(f.purchase, f.admin);
  expect(ready.variantGid).toBe(f.item.id);
  expect(f.admin.mock.calls.some(([query]) => query === PRIVATE_PASS_ATTACH)).toBe(false);
});
