import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import {
  checkCatalogPurchase,
  storefrontReadClient,
  type CommerceClients,
} from "../app/services/shopify-purchasability.server";
import { bookingPurchaseReview } from "../app/services/booking-purchase-review.server";
import { DomainError } from "../app/lib/errors.server";
import { startAttempt } from "../app/services/booking.server";
import type { Actor } from "../app/services/authorization";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Tests require skyra_booking_test.");
});
afterAll(async () => {
  await db.$disconnect();
});

async function fixture(ownerType: "SERVICE" | "PASS_PLAN" = "PASS_PLAN") {
  const shop = await db.shop.create({
    data: {
      domain: randomUUID() + "-purchasability.myshopify.com",
      rules: {
        bookingWindowDays: 14,
        bookingClosesBeforeMinutes: 120,
        seatHoldMinutes: 15,
        onlineBookingsEnabled: false,
      },
      rulesApprovedAt: new Date(),
    },
  });
  const shopId = shop.id;
  const location = await db.location.create({
    data: { shopId, name: "Studio" },
  });
  const coach = await db.coach.create({ data: { shopId, name: "Coach" } });
  const service = await db.service.create({
    data: {
      shopId,
      locationId: location.id,
      name: "Class",
      durationMin: 60,
      capacity: 8,
      status: "ACTIVE",
      requestedPriceCents: 4900,
    },
  });
  const pass = await db.passPlan.create({
    data: {
      shopId,
      name: "Pass",
      credits: 5,
      validityDays: 90,
      status: "ACTIVE",
      requestedPriceCents: 22000,
    },
  });
  await db.passEligibility.create({
    data: { shopId, serviceId: service.id, passPlanId: pass.id },
  });
  const startsAt = new Date(Date.now() + 2 * 86400000);
  const endsAt = new Date(startsAt.getTime() + 3600000);
  const session = await db.classSession.create({
    data: {
      shopId,
      serviceId: service.id,
      coachId: coach.id,
      locationId: location.id,
      startsAt,
      endsAt,
      busyStartsAt: startsAt,
      busyEndsAt: endsAt,
      timezone: "Australia/Sydney",
      capacity: 8,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  const owner = ownerType === "SERVICE" ? service : pass;
  const price = (owner.requestedPriceCents / 100).toFixed(2);
  const mapping = await db.productMapping.create({
    data: {
      shopId,
      ownerType,
      ownerId: owner.id,
      productGid: "gid://shopify/Product/321",
      variantGid: "gid://shopify/ProductVariant/654",
      syncStatus: "SYNCED",
      productStatus: "ACTIVE",
      requestedVersion: 1,
      shopifyVersion: 1,
      publishedPrice: price,
    },
  });
  const adminData = {
    shop: { myshopifyDomain: shop.domain, currencyCode: "AUD" },
    product: {
      id: mapping.productGid,
      status: "ACTIVE",
      onlineStoreUrl: ("https://" + shop.domain + "/products/test") as
        string | null,
      publishedAt: new Date(Date.now() - 60000).toISOString() as string | null,
      requiresSellingPlan: false,
      bookingOwner: { jsonValue: owner.id },
      entitlementKind: {
        jsonValue: ownerType === "SERVICE" ? "DROP_IN" : "PACK",
      },
      variants: {
        nodes: [
          {
            id: mapping.variantGid,
            price,
            availableForSale: true,
            requiresComponents: false,
          },
        ],
      },
    },
  };
  const storefrontData = {
    product: {
      id: mapping.productGid,
      availableForSale: true,
      requiresSellingPlan: false,
      variants: {
        nodes: [
          {
            id: mapping.variantGid,
            availableForSale: true,
            requiresComponents: false,
            requiresShipping: false,
            price: { amount: price, currencyCode: "AUD" },
          },
        ],
      },
    },
  };
  const admin = vi.fn(async () => Response.json({ data: adminData }));
  const storefront = vi.fn(async () => Response.json({ data: storefrontData }));
  const clients: CommerceClients = { admin, storefront };
  const actor: Actor = { shopId, actorId: "test-admin", role: "ADMIN" };
  const customer = { shopId, customerGid: "gid://shopify/Customer/987" };
  const check = () => checkCatalogPurchase(actor, mapping.id, clients);
  const begin = () =>
    startAttempt(customer, { sessionId: session.id, surface: "PROGRAMS" });
  const selection =
    ownerType === "SERVICE"
      ? { purchaseKind: "DROP_IN" as const }
      : { purchaseKind: "NEW_PASS" as const, passPlanId: pass.id };
  return {
    shop,
    mapping,
    actor,
    customer,
    service,
    session,
    pass,
    owner,
    adminData,
    storefrontData,
    admin,
    storefront,
    clients,
    check,
    begin,
    selection,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

test.each(["SERVICE", "PASS_PLAN"] as const)(
  "checks %s against Admin and AU storefront without writing commerce data",
  async (kind) => {
    const f = await fixture(kind);
    const before = await db.productMapping.findUniqueOrThrow({
      where: { id: f.mapping.id },
    });
    expect(await f.check()).toMatchObject({ ready: true, issues: [] });
    expect(f.admin).toHaveBeenCalledTimes(1);
    expect(f.storefront).toHaveBeenCalledTimes(1);
    expect(
      await db.productMapping.findUniqueOrThrow({
        where: { id: f.mapping.id },
      }),
    ).toEqual(before);
    expect(await db.bookingHold.count({ where: { shopId: f.shop.id } })).toBe(
      0,
    );
    expect(await db.outboxEvent.count({ where: { shopId: f.shop.id } })).toBe(
      0,
    );
  },
);
const failures: [string, (f: Fixture) => void][] = [
  [
    "SHOP_MISMATCH",
    (f) => {
      f.adminData.shop.myshopifyDomain = "another.myshopify.com";
    },
  ],
  [
    "CURRENCY_MISMATCH",
    (f) => {
      f.adminData.shop.currencyCode = "USD";
    },
  ],
  [
    "OWNER_MISMATCH",
    (f) => {
      f.adminData.product.bookingOwner.jsonValue = randomUUID();
    },
  ],
  [
    "PRODUCT_INACTIVE",
    (f) => {
      f.adminData.product.status = "DRAFT";
    },
  ],
  [
    "ONLINE_STORE_UNPUBLISHED",
    (f) => {
      f.adminData.product.publishedAt = null;
    },
  ],
  [
    "SELLING_PLAN_REQUIRED",
    (f) => {
      f.adminData.product.requiresSellingPlan = true;
    },
  ],
  [
    "VARIANT_CHANGED",
    (f) => {
      f.adminData.product.variants.nodes.push({
        ...f.adminData.product.variants.nodes[0],
        id: "gid://shopify/ProductVariant/999",
      });
    },
  ],
  [
    "VARIANT_UNAVAILABLE",
    (f) => {
      f.adminData.product.variants.nodes[0].availableForSale = false;
    },
  ],
  [
    "BUNDLE_UNSUPPORTED",
    (f) => {
      f.adminData.product.variants.nodes[0].requiresComponents = true;
    },
  ],
  [
    "PRICE_CHANGED",
    (f) => {
      f.adminData.product.variants.nodes[0].price = "221.00";
    },
  ],
  [
    "STOREFRONT_VARIANT_CHANGED",
    (f) => {
      f.storefrontData.product.variants.nodes[0].id =
        "gid://shopify/ProductVariant/999";
    },
  ],
  [
    "STOREFRONT_UNAVAILABLE",
    (f) => {
      f.storefrontData.product.availableForSale = false;
    },
  ],
  [
    "SHIPPING_REQUIRED",
    (f) => {
      f.storefrontData.product.variants.nodes[0].requiresShipping = true;
    },
  ],
  [
    "MARKET_PRICE_CHANGED",
    (f) => {
      f.storefrontData.product.variants.nodes[0].price.currencyCode = "USD";
    },
  ],
  [
    "MARKET_PRICE_CHANGED",
    (f) => {
      f.storefrontData.product.variants.nodes[0].price.amount = "219.00";
    },
  ],
];
test.each(failures)(
  "blocks %s instead of trusting the synchronized DB snapshot",
  async (code, change) => {
    const f = await fixture();
    change(f);
    const result = await f.check();
    expect(result.ready).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  },
);
test("missing Shopify product or Australian publication cannot pass", async () => {
  const f = await fixture();
  f.admin.mockResolvedValue(
    Response.json({ data: { shop: f.adminData.shop, product: null } }),
  );
  f.storefront.mockResolvedValue(Response.json({ data: { product: null } }));
  const result = await f.check();
  expect(result.ready).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["PRODUCT_MISSING", "MARKET_UNAVAILABLE"]),
  );
});
test("pending sync blocks before API calls", async () => {
  const f = await fixture();
  await db.productMapping.update({
    where: { id: f.mapping.id },
    data: { requestedVersion: 2 },
  });
  expect(await f.check()).toMatchObject({
    ready: false,
    issues: [{ code: "SYNC_REQUIRED" }],
  });
  expect(f.admin).not.toHaveBeenCalled();
  expect(f.storefront).not.toHaveBeenCalled();
});
test("coach and cross-shop access cannot inspect another store's products", async () => {
  const f = await fixture();
  await expect(
    checkCatalogPurchase(
      { ...f.actor, role: "COACH" },
      f.mapping.id,
      f.clients,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    checkCatalogPurchase(
      { ...f.actor, shopId: randomUUID() },
      f.mapping.id,
      f.clients,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(f.admin).not.toHaveBeenCalled();
});
test.each(["http", "graphql", "malformed", "network"])(
  "fails closed on %s errors with no credential or upstream error leak",
  async (kind) => {
    const f = await fixture();
    if (kind === "network")
      f.admin.mockRejectedValue(new Error("private-upstream-detail"));
    else
      f.admin.mockResolvedValue(
        kind === "http"
          ? new Response("", { status: 503 })
          : kind === "graphql"
            ? Response.json({
                errors: [{ message: "private-upstream-detail" }],
              })
            : Response.json({ data: { product: null } }),
      );
    const result = await f.check();
    expect(result).toMatchObject({
      ready: false,
      issues: [{ code: "SHOPIFY_UNAVAILABLE" }],
    });
    expect(JSON.stringify(result)).not.toContain("private-upstream-detail");
  },
);
test("an edit during Shopify requests invalidates a previously matching price", async () => {
  const f = await fixture();
  f.admin.mockImplementation(async () => {
    await db.passPlan.update({
      where: { id: f.pass.id },
      data: { version: { increment: 1 }, requestedPriceCents: 23000 },
    });
    return Response.json({ data: f.adminData });
  });
  expect(await f.check()).toMatchObject({
    ready: false,
    issues: [{ code: "CATALOG_CHANGED" }],
  });
});
test.each(["SERVICE", "PASS_PLAN"] as const)(
  "Review verifies %s and leaves Checkout and Hold disabled",
  async (kind) => {
    const f = await fixture(kind);
    const attempt = await f.begin();
    const factory = vi.fn(async () => f.clients);
    const result = await bookingPurchaseReview(
      f.customer,
      { token: attempt.token, ...f.selection },
      factory,
    );
    expect(factory).toHaveBeenCalledWith(f.shop.domain);
    expect(result).toMatchObject({
      checkoutAvailable: false,
      ownedPassesAvailable: false,
      availabilityCheckedAt: expect.any(String),
    });
    expect(await db.bookingHold.count({ where: { shopId: f.shop.id } })).toBe(
      0,
    );
    expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
  },
);
test("listing choices makes no remote requests; unauthorized Review stops before remote access", async () => {
  const f = await fixture();
  const attempt = await f.begin();
  const factory = vi.fn(async () => f.clients);
  await bookingPurchaseReview(f.customer, { token: attempt.token }, factory);
  await expect(
    bookingPurchaseReview(
      { ...f.customer, customerGid: null },
      { token: attempt.token, ...f.selection },
      factory,
    ),
  ).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
  await expect(
    bookingPurchaseReview(
      { ...f.customer, customerGid: "gid://shopify/Customer/998" },
      { token: attempt.token, ...f.selection },
      factory,
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(factory).not.toHaveBeenCalled();
});
test("unpublished product returns existing customer recovery error", async () => {
  const f = await fixture();
  const attempt = await f.begin();
  f.adminData.product.publishedAt = null;
  await expect(
    bookingPurchaseReview(
      f.customer,
      { token: attempt.token, ...f.selection },
      async () => f.clients,
    ),
  ).rejects.toMatchObject({ code: "PASS_UNAVAILABLE", status: 409 });
});
test("network or offline-session failure offers retry instead of allowing Review", async () => {
  const f = await fixture();
  const attempt = await f.begin();
  f.admin.mockRejectedValue(new Error("private error"));
  await expect(
    bookingPurchaseReview(
      f.customer,
      { token: attempt.token, ...f.selection },
      async () => f.clients,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
  await expect(
    bookingPurchaseReview(
      f.customer,
      { token: attempt.token, ...f.selection },
      async () => {
        throw new Error("no session");
      },
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
});
test("class cancellation during a successful remote check is revalidated before Review", async () => {
  const f = await fixture();
  const attempt = await f.begin();
  f.admin.mockImplementation(async () => {
    await db.classSession.update({
      where: { id: f.session.id },
      data: { status: "CANCELLED" },
    });
    return Response.json({ data: f.adminData });
  });
  await expect(
    bookingPurchaseReview(
      f.customer,
      { token: attempt.token, ...f.selection },
      async () => f.clients,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
test("a locked storefront preserves actionable Admin findings and blocks Review", async () => {
  const f = await fixture();
  const attempt = await f.begin();
  f.adminData.product.publishedAt = null;
  f.storefront.mockImplementation(async () =>
    Response.json(
      {
        errors: [
          {
            message: "Online Store channel is locked.",
            extensions: { code: "BAD_REQUEST" },
          },
        ],
      },
      { status: 400 },
    ),
  );
  const result = await f.check();
  expect(result.ready).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(["STOREFRONT_LOCKED", "ONLINE_STORE_UNPUBLISHED"]),
  );
  await expect(
    bookingPurchaseReview(
      f.customer,
      { token: attempt.token, ...f.selection },
      async () => f.clients,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
});

test.each(["SERVICE", "PASS_PLAN"] as const)(
  "a published %s can pass without an Online Store URL",
  async (kind) => {
    const f = await fixture(kind);
    f.adminData.product.onlineStoreUrl = null;
    expect(await f.check()).toMatchObject({ ready: true, issues: [] });
    // Publication alone still cannot replace the authenticated market check.
    f.storefrontData.product.availableForSale = false;
    expect(await f.check()).toMatchObject({
      ready: false,
      issues: [{ code: "STOREFRONT_UNAVAILABLE" }],
    });
  },
);

test("future Online Store publication is not ready even with a URL", async () => {
  const f = await fixture();
  f.adminData.product.publishedAt = new Date(Date.now() + 86400000).toISOString();
  expect(await f.check()).toMatchObject({
    ready: false,
    issues: [{ code: "ONLINE_STORE_UNPUBLISHED" }],
  });
});

test("malformed publication dates fail closed", async () => {
  const f = await fixture();
  f.adminData.product.publishedAt = "invalid-date";
  expect(await f.check()).toMatchObject({
    ready: false,
    issues: [{ code: "SHOPIFY_UNAVAILABLE" }],
  });
});

test("Storefront reads never send Admin credentials and reject untrusted domains", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ data: { product: null } }));
  try {
    const client = storefrontReadClient("skyra-booking-dev.myshopify.com");
    await client('query Product { product(id: "test") { id } }', {
      variables: {},
    });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://skyra-booking-dev.myshopify.com/api/2026-07/graphql.json",
    );
    expect(fetch.mock.calls[0][1]?.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(() => storefrontReadClient("evil.example")).toThrow();
    expect(() =>
      storefrontReadClient("skyra.myshopify.com@evil.example"),
    ).toThrow();
  } finally {
    fetch.mockRestore();
  }
});

test("mismatched entitlement kind blocks the purchase", async () => {
  const f = await fixture();
  f.adminData.product.entitlementKind.jsonValue = "DROP_IN";
  const result = await f.check();
  expect(result.ready).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toContain(
    "ENTITLEMENT_KIND_MISMATCH",
  );
});

test("missing Storefront access is actionable in Admin and recoverable in Review", async () => {
  const f = await fixture();
  const attempt = await f.begin();
  f.storefront.mockRejectedValue(
    new DomainError("STOREFRONT_ACCESS_REQUIRED", "private details", 503),
  );
  const result = await f.check();
  expect(result.ready).toBe(false);
  expect(result.issues.map((issue) => issue.code)).toContain(
    "STOREFRONT_ACCESS_REQUIRED",
  );
  expect(JSON.stringify(result)).not.toContain("private details");
  await expect(
    bookingPurchaseReview(
      f.customer,
      { token: attempt.token, ...f.selection },
      async () => f.clients,
    ),
  ).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
});
