import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import {
  restoreCatalogOwnership,
  OWNERSHIP_READ,
  OWNERSHIP_RESTORE,
} from "../app/services/catalog-ownership.server";
import {
  authenticatedStorefrontClient,
  STOREFRONT_PRODUCT_SCOPE,
} from "../app/services/storefront-access.server";

const appKey = "a".repeat(32);
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Tests require skyra_booking_test.");
});
afterAll(async () => {
  await db.$disconnect();
});

async function fixture(kind: "SERVICE" | "PASS_PLAN" = "PASS_PLAN") {
  const shop = await db.shop.create({
    data: { domain: randomUUID() + ".myshopify.com" },
  });
  const location = await db.location.create({
    data: { shopId: shop.id, name: "Test studio" },
  });
  const owner =
    kind === "SERVICE"
      ? await db.service.create({
          data: {
            shopId: shop.id,
            name: "Test class",
            durationMin: 60,
            capacity: 8,
            status: "ACTIVE",
            requestedPriceCents: 4900,
            locationId: location.id,
          },
        })
      : await db.passPlan.create({
          data: {
            shopId: shop.id,
            name: "Test pass",
            credits: 5,
            validityDays: 90,
            status: "ACTIVE",
            requestedPriceCents: 4900,
          },
        });
  const mapping = await db.productMapping.create({
    data: {
      shopId: shop.id,
      ownerId: owner.id,
      ownerType: kind,
      productGid: "gid://shopify/Product/123",
      variantGid: "gid://shopify/ProductVariant/456",
      productStatus: "ACTIVE",
      syncStatus: "SYNCED",
      requestedVersion: 1,
      shopifyVersion: 1,
      publishedPrice: "49.00",
    },
  });
  const actor = {
    shopId: shop.id,
    actorId: "test-admin",
    role: "ADMIN" as const,
  };
  const live = {
    shop: { myshopifyDomain: shop.domain },
    currentAppInstallation: { app: { apiKey: appKey } },
    metafieldDefinitions: {
      nodes: ["booking_owner_id", "entitlement_kind"].map((key) => ({
        key,
        type: { name: "single_line_text_field" },
      })),
    },
    product: {
      id: mapping.productGid!,
      handle: "skyra-booking-" + owner.id,
      bookingOwner: null as { jsonValue: unknown } | null,
      entitlementKind: null as { jsonValue: unknown } | null,
      variants: { nodes: [{ id: mapping.variantGid!, price: "49.00" }] },
    },
  };
  const graphql = vi.fn(
    async (query: string, options: { variables: Record<string, unknown> }) => {
      if (query === OWNERSHIP_READ) return Response.json({ data: live });
      expect(query).toBe(OWNERSHIP_RESTORE);
      for (const field of options.variables.metafields as {
        key: string;
        value: string;
        compareDigest: unknown;
      }[]) {
        expect(field.compareDigest).toBe(null);
        if (field.key === "booking_owner_id")
          live.product.bookingOwner = { jsonValue: field.value };
        else live.product.entitlementKind = { jsonValue: field.value };
      }
      return Response.json({
        data: { metafieldsSet: { metafields: [], userErrors: [] } },
      });
    },
  );
  const run = () => restoreCatalogOwnership(actor, mapping.id, appKey, graphql);
  const mutations = () =>
    graphql.mock.calls.filter(([query]) => query === OWNERSHIP_RESTORE);
  return { shop, owner, mapping, actor, live, graphql, run, mutations };
}

test.each(["SERVICE", "PASS_PLAN"] as const)(
  "restores missing %s fields using CAS, verifies and audits without changing commerce",
  async (kind) => {
    const f = await fixture(kind);
    const before = await db.productMapping.findUnique({
      where: { id: f.mapping.id },
    });
    const result = await f.run();
    expect(result.restoredKeys).toEqual([
      "booking_owner_id",
      "entitlement_kind",
    ]);
    expect(f.live.product.bookingOwner?.jsonValue).toBe(f.owner.id);
    expect(f.live.product.entitlementKind?.jsonValue).toBe(
      kind === "SERVICE" ? "DROP_IN" : "PACK",
    );
    expect(f.mutations()).toHaveLength(1);
    expect(
      await db.productMapping.findUnique({ where: { id: f.mapping.id } }),
    ).toEqual(before);
    expect(
      await db.auditLog.count({
        where: { shopId: f.shop.id, action: "CATALOG_OWNERSHIP_RESTORED" },
      }),
    ).toBe(1);
    expect(await db.bookingHold.count({ where: { shopId: f.shop.id } })).toBe(
      0,
    );
    expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
    expect((await f.run()).restoredKeys).toEqual([]);
    expect(f.mutations()).toHaveLength(1);
  },
);
test("only restores the absent key, never resends an existing value", async () => {
  const f = await fixture();
  f.live.product.bookingOwner = { jsonValue: f.owner.id };
  expect((await f.run()).restoredKeys).toEqual(["entitlement_kind"]);
  expect(f.mutations()[0][1].variables.metafields).toEqual([
    {
      ownerId: f.mapping.productGid,
      namespace: "$app",
      key: "entitlement_kind",
      type: "single_line_text_field",
      value: "PACK",
      compareDigest: null,
    },
  ]);
});
test.each(["OPERATIONS", "COACH"] as const)(
  "blocks %s maintenance before Shopify",
  async (role) => {
    const f = await fixture();
    await expect(
      restoreCatalogOwnership(
        { ...f.actor, role },
        f.mapping.id,
        appKey,
        f.graphql,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(f.graphql).not.toHaveBeenCalled();
  },
);
type Fixture = Awaited<ReturnType<typeof fixture>>;
test.each([
  [
    "wrong app",
    (f: Fixture) => {
      f.live.currentAppInstallation.app.apiKey = "b".repeat(32);
    },
    "APP_IDENTITY_MISMATCH",
  ],
  [
    "wrong store",
    (f: Fixture) => {
      f.live.shop.myshopifyDomain = "other.myshopify.com";
    },
    "APP_IDENTITY_MISMATCH",
  ],
  [
    "missing definitions",
    (f: Fixture) => {
      f.live.metafieldDefinitions.nodes = [];
    },
    "DEFINITIONS_REQUIRED",
  ],
  [
    "wrong definition type",
    (f: Fixture) => {
      f.live.metafieldDefinitions.nodes[0].type.name = "number_integer";
    },
    "DEFINITIONS_REQUIRED",
  ],
  [
    "changed product",
    (f: Fixture) => {
      f.live.product.id = "gid://shopify/Product/999";
    },
    "MAPPING_REVIEW_REQUIRED",
  ],
  [
    "changed handle",
    (f: Fixture) => {
      f.live.product.handle = "merchant-product";
    },
    "MAPPING_REVIEW_REQUIRED",
  ],
  [
    "changed variant",
    (f: Fixture) => {
      f.live.product.variants.nodes[0].id = "gid://shopify/ProductVariant/999";
    },
    "MAPPING_REVIEW_REQUIRED",
  ],
  [
    "extra variant",
    (f: Fixture) => {
      f.live.product.variants.nodes.push({
        ...f.live.product.variants.nodes[0],
      });
    },
    "MAPPING_REVIEW_REQUIRED",
  ],
  [
    "changed price",
    (f: Fixture) => {
      f.live.product.variants.nodes[0].price = "50.00";
    },
    "MAPPING_REVIEW_REQUIRED",
  ],
  [
    "conflicting owner",
    (f: Fixture) => {
      f.live.product.bookingOwner = { jsonValue: randomUUID() };
    },
    "OWNERSHIP_CONFLICT",
  ],
  [
    "conflicting kind",
    (f: Fixture) => {
      f.live.product.entitlementKind = { jsonValue: "DROP_IN" };
    },
    "OWNERSHIP_CONFLICT",
  ],
] as const)("refuses %s without mutation", async (_name, mutate, code) => {
  const f = await fixture();
  mutate(f);
  await expect(f.run()).rejects.toMatchObject({ code });
  expect(f.mutations()).toHaveLength(0);
});
test("does not access another shop's mapping", async () => {
  const a = await fixture();
  const b = await fixture();
  await expect(
    restoreCatalogOwnership(a.actor, b.mapping.id, appKey, a.graphql),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(a.graphql).not.toHaveBeenCalled();
});
test("requires local synchronization before attempting recovery", async () => {
  const f = await fixture();
  await db.productMapping.update({
    where: { id: f.mapping.id },
    data: { syncStatus: "ERROR" },
  });
  await expect(f.run()).rejects.toMatchObject({
    code: "MAPPING_REVIEW_REQUIRED",
  });
  expect(f.graphql).not.toHaveBeenCalled();
});
test("CAS conflict never retries or writes a successful audit", async () => {
  const f = await fixture();
  f.graphql.mockImplementation(async (query) =>
    query === OWNERSHIP_READ
      ? Response.json({ data: f.live })
      : Response.json({
          data: {
            metafieldsSet: { userErrors: [{ code: "INVALID_COMPARE_DIGEST" }] },
          },
        }),
  );
  await expect(f.run()).rejects.toMatchObject({ code: "OWNERSHIP_CHANGED" });
  expect(f.mutations()).toHaveLength(1);
  expect(await db.auditLog.count({ where: { shopId: f.shop.id } })).toBe(0);
});
test("mutation success is insufficient without readback", async () => {
  const f = await fixture();
  f.graphql.mockImplementation(async (query) =>
    query === OWNERSHIP_READ
      ? Response.json({ data: f.live })
      : Response.json({ data: { metafieldsSet: { userErrors: [] } } }),
  );
  await expect(f.run()).rejects.toMatchObject({ code: "READBACK_FAILED" });
  expect(await db.auditLog.count({ where: { shopId: f.shop.id } })).toBe(0);
});
test("remote exceptions never expose credentials", async () => {
  const f = await fixture();
  f.graphql.mockRejectedValue(new Error("private-token-value"));
  await expect(f.run()).rejects.toMatchObject({ code: "SHOPIFY_UNAVAILABLE" });
  await expect(f.run()).rejects.not.toThrow("private-token-value");
});
test("requires an explicit app key and mapping UUID", async () => {
  const f = await fixture();
  await expect(
    restoreCatalogOwnership(f.actor, f.mapping.id, "", f.graphql),
  ).rejects.toMatchObject({ code: "APP_IDENTITY_REQUIRED" });
  await expect(
    restoreCatalogOwnership(f.actor, "invalid", appKey, f.graphql),
  ).rejects.toThrow();
  expect(f.graphql).not.toHaveBeenCalled();
});

function storefrontFixture() {
  const graphql = vi.fn(async () => Response.json({ data: { product: null } }));
  const context = {
    session: {
      shop: "test.myshopify.com",
      isOnline: false,
      scope: STOREFRONT_PRODUCT_SCOPE,
    },
    storefront: { graphql },
  };
  const load = vi.fn(async () => context);
  return {
    graphql,
    context,
    load,
    client: authenticatedStorefrontClient(context.session.shop, load),
  };
}
test("authenticated Storefront uses the approved offline SDK context and forwards only query variables", async () => {
  const f = storefrontFixture();
  const options = { variables: { id: "gid://shopify/Product/123" } };
  await f.client(OWNERSHIP_READ, options);
  expect(f.load).toHaveBeenCalledWith("test.myshopify.com");
  expect(f.graphql).toHaveBeenCalledWith(OWNERSHIP_READ, options);
});
test.each(["", "read_products", "unauthenticated_read_product_listings_extra"])(
  "missing exact Storefront scope %s fails closed",
  async (scope) => {
    const f = storefrontFixture();
    f.context.session.scope = scope;
    await expect(
      f.client(OWNERSHIP_READ, { variables: {} }),
    ).rejects.toMatchObject({ code: "STOREFRONT_ACCESS_REQUIRED" });
    expect(f.graphql).not.toHaveBeenCalled();
  },
);
test.each(["another shop", "online session"])(
  "rejects %s SDK context",
  async (kind) => {
    const f = storefrontFixture();
    if (kind === "another shop") f.context.session.shop = "other.myshopify.com";
    else f.context.session.isOnline = true;
    await expect(
      f.client(OWNERSHIP_READ, { variables: {} }),
    ).rejects.toMatchObject({ code: "STOREFRONT_ACCESS_REQUIRED" });
    expect(f.graphql).not.toHaveBeenCalled();
  },
);
test("failed offline reconnect is sanitized and does not fall back to tokenless", async () => {
  const f = storefrontFixture();
  f.load.mockRejectedValue(new Error("private-token-value"));
  await expect(
    f.client(OWNERSHIP_READ, { variables: {} }),
  ).rejects.toMatchObject({ code: "STOREFRONT_ACCESS_REQUIRED" });
  expect(f.graphql).not.toHaveBeenCalled();
});
test.each([
  "evil.example",
  "test.myshopify.com@evil.example",
  "https://test.myshopify.com",
  "test.myshopify.com/path",
])("rejects untrusted Storefront domain %s", (domain) => {
  expect(() => authenticatedStorefrontClient(domain, vi.fn())).toThrow();
});
