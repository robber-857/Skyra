import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import {
  startAttempt,
  releaseSeatHold,
  createSeatHold,
} from "../app/services/booking.server";
import { prepareBookingCheckout } from "../app/services/booking-checkout.server";
import {
  createBookingCart,
  BOOKING_REFERENCE_KEY,
  type BookingCart,
} from "../app/services/shopify-cart.server";
import type { GraphQL } from "../app/services/shopify-catalog.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Tests require skyra_booking_test.");
});
afterAll(async () => {
  await db.$disconnect();
});
async function fixture(kind: "NEW_PASS" | "DROP_IN" = "NEW_PASS") {
  const shop = await db.shop.create({
    data: {
      domain: randomUUID() + ".myshopify.com",
      rulesApprovedAt: new Date(),
      rules: {
        bookingWindowDays: 14,
        bookingClosesBeforeMinutes: 120,
        seatHoldMinutes: 15,
        onlineBookingsEnabled: true,
      },
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
      capacity: 1,
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
  const startsAt = new Date(Date.now() + 2 * 86400000),
    endsAt = new Date(startsAt.getTime() + 3600000);
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
      capacity: 1,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  const owner = kind === "NEW_PASS" ? pass : service;
  const price = (owner.requestedPriceCents / 100).toFixed(2);
  const mapping = await db.productMapping.create({
    data: {
      shopId,
      ownerType: kind === "NEW_PASS" ? "PASS_PLAN" : "SERVICE",
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
  const actor = { shopId, customerGid: "gid://shopify/Customer/123" };
  const attempt = await startAttempt(actor, {
    sessionId: session.id,
    surface: "PROGRAMS",
  });
  const input = {
    token: attempt.token,
    purchaseKind: kind,
    idempotencyKey: randomUUID(),
    ...(kind === "NEW_PASS" ? { passPlanId: pass.id } : {}),
  };
  const variant = {
    id: mapping.variantGid!,
    availableForSale: true,
    requiresComponents: false,
  };
  const adminData = {
    shop: { myshopifyDomain: shop.domain, currencyCode: "AUD" },
    product: {
      id: mapping.productGid,
      status: "ACTIVE",
      onlineStoreUrl: null,
      publishedAt: new Date(Date.now() - 60000).toISOString(),
      requiresSellingPlan: false,
      bookingOwner: { jsonValue: owner.id },
      entitlementKind: { jsonValue: kind === "NEW_PASS" ? "PACK" : "DROP_IN" },
      variants: { nodes: [{ ...variant, price }] },
    },
  };
  const storeData = {
    product: {
      id: mapping.productGid,
      availableForSale: true,
      requiresSellingPlan: false,
      variants: {
        nodes: [
          {
            ...variant,
            requiresShipping: false,
            price: { amount: price, currencyCode: "AUD" },
          },
        ],
      },
    },
  };
  const cart: BookingCart = {
    id: "gid://shopify/Cart/" + randomUUID() + "?key=test-secret",
    checkoutUrl: "https://" + shop.domain + "/checkouts/test-cart",
    totalQuantity: 1,
    buyerIdentity: { countryCode: "AU" },
    lines: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: "gid://shopify/CartLine/test",
          quantity: 1,
          attributes: [],
          merchandise: {
            id: mapping.variantGid!,
            product: { id: mapping.productGid! },
          },
          sellingPlanAllocation: null,
          cost: { amountPerQuantity: { amount: price, currencyCode: "AUD" } },
        },
      ],
    },
  };
  const cartCreate = vi.fn<GraphQL>(async (_query, options) => {
    const value = options.variables.input as {
      lines: { attributes: { key: string; value: string }[] }[];
    };
    cart.lines.nodes[0].attributes = value.lines[0].attributes;
    return Response.json({
      data: { cartCreate: { cart, userErrors: [], warnings: [] } },
    });
  });
  const cartRead = vi.fn<GraphQL>(async () =>
    Response.json({ data: { cart } }),
  );
  const admin = vi.fn<GraphQL>(async () => Response.json({ data: adminData }));
  const storefront = vi.fn<GraphQL>(async (query, options) =>
    query.includes("BookingCartCreate")
      ? cartCreate(query, options)
      : query.includes("BookingCartRead")
        ? cartRead(query, options)
        : Response.json({ data: storeData }),
  );
  const clients = vi.fn(async () => ({ admin, storefront }));
  const run = () => prepareBookingCheckout(actor, input, clients);
  const intent = () =>
    db.bookingCheckout.findFirstOrThrow({ where: { shopId } });
  return {
    shop,
    session,
    pass,
    service,
    mapping,
    actor,
    input,
    cart,
    cartCreate,
    cartRead,
    admin,
    adminData,
    storeData,
    clients,
    run,
    intent,
  };
}

test.each(["NEW_PASS", "DROP_IN"] as const)(
  "creates and reuses one %s Cart without exposing its secret",
  async (kind) => {
    const f = await fixture(kind);
    const first = await f.run();
    expect(first).toMatchObject({
      status: "CHECKOUT_READY",
      checkoutUrl: f.cart.checkoutUrl,
    });
    expect(first.returnPath).toBe(
      "/pages/programs?skyra_attempt=" +
        f.input.token +
        "#skyra-booking-programs",
    );
    const intent = await f.intent();
    expect(intent.status).toBe("READY");
    expect(intent.cartId).toBe(f.cart.id);
    expect(intent.reference).toHaveLength(43);
    expect(intent.reference).not.toBe(f.input.token);
    expect(f.cartCreate.mock.calls[0][1]).toMatchObject({
      tries: 1,
      signal: expect.any(AbortSignal),
      variables: {
        input: {
          buyerIdentity: { countryCode: "AU" },
          lines: [
            {
              merchandiseId: f.mapping.variantGid,
              quantity: 1,
              attributes: [
                { key: BOOKING_REFERENCE_KEY, value: intent.reference },
              ],
            },
          ],
        },
      },
    });
    f.input.idempotencyKey = randomUUID();
    expect(await f.run()).toEqual(first);
    expect(f.cartCreate).toHaveBeenCalledTimes(1);
    expect(f.cartRead).toHaveBeenCalledTimes(1);
    expect(await db.bookingHold.count({ where: { shopId: f.shop.id } })).toBe(
      1,
    );
    expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(0);
    const audit = await db.auditLog.findMany({
      where: { shopId: f.shop.id, action: { startsWith: "CHECKOUT_" } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual([
      "CHECKOUT_CREATING",
      "CHECKOUT_READY",
    ]);
    expect(JSON.stringify({ first, audit })).not.toContain("test-secret");
    expect(JSON.stringify(first)).not.toContain(intent.reference);
  },
);

test("10 concurrent retries create only one Cart and do not extend the Hold", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => f.run()),
  );
  expect(results.some((r) => r.status === "fulfilled")).toBe(true);
  expect(f.cartCreate).toHaveBeenCalledTimes(1);
  expect(await db.bookingCheckout.count({ where: { shopId: f.shop.id } })).toBe(
    1,
  );
  const hold = await db.bookingHold.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  expect(hold.expiresAt.getTime() - hold.createdAt.getTime()).toBe(900000);
  for (const result of results)
    if (result.status === "rejected")
      expect(result.reason.code).toBe("CART_PENDING");
});

test.each([
  "anonymous",
  "other-customer",
  "other-shop",
  "extra-input",
  "disabled",
] as const)("%s cannot create a Cart or Hold", async (mode) => {
  const f = await fixture();
  let actor = f.actor;
  let input: unknown = f.input;
  if (mode === "anonymous") actor = { ...actor, customerGid: "" };
  if (mode === "other-customer")
    actor = { ...actor, customerGid: "gid://shopify/Customer/999" };
  if (mode === "other-shop") actor = { ...actor, shopId: randomUUID() };
  if (mode === "extra-input")
    input = { ...f.input, variantId: "evil", price: 1 };
  if (mode === "disabled")
    await db.shop.update({ where: { id: f.shop.id }, data: { rules: {} } });
  await expect(
    prepareBookingCheckout(actor, input, f.clients),
  ).rejects.toThrow();
  expect(f.clients).not.toHaveBeenCalled();
  expect(await db.bookingHold.count({ where: { shopId: f.shop.id } })).toBe(0);
});

test("failed live purchasability creates neither a Hold nor Cart", async () => {
  const f = await fixture();
  f.storeData.product.availableForSale = false;
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_CHANGED" });
  expect(f.cartCreate).not.toHaveBeenCalled();
  expect(await db.bookingHold.count({ where: { shopId: f.shop.id } })).toBe(0);
});

test.each(["network", "body", "graphql", "malformed"] as const)(
  "unknown %s result is durable and never retries cartCreate",
  async (mode) => {
    const f = await fixture();
    if (mode === "network")
      f.cartCreate.mockRejectedValue(new Error("private-secret"));
    if (mode === "body")
      f.cartCreate.mockResolvedValue(new Response("bad-json"));
    if (mode === "graphql")
      f.cartCreate.mockResolvedValue(
        Response.json({ errors: [{ message: "private-secret" }] }),
      );
    if (mode === "malformed")
      f.cartCreate.mockResolvedValue(
        Response.json({ data: { cartCreate: {} } }),
      );
    await expect(f.run()).rejects.toMatchObject({
      code: "CART_REQUEST_UNKNOWN",
    });
    expect((await f.intent()).status).toBe("UNKNOWN");
    await expect(f.run()).rejects.toMatchObject({
      code: "CART_RECOVERY_REQUIRED",
    });
    expect(f.cartCreate).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(
        await db.auditLog.findMany({ where: { shopId: f.shop.id } }),
      ),
    ).not.toContain("private-secret");
  },
);

test("known rejection is retained and cannot be reset to create again", async () => {
  const f = await fixture();
  f.cartCreate.mockResolvedValue(
    Response.json({
      data: {
        cartCreate: {
          cart: null,
          userErrors: [{ message: "not available" }],
          warnings: [],
        },
      },
    }),
  );
  await expect(f.run()).rejects.toMatchObject({ code: "CART_REJECTED" });
  const intent = await f.intent();
  expect(intent.status).toBe("REJECTED");
  await expect(f.run()).rejects.toMatchObject({
    code: "CART_RECOVERY_REQUIRED",
  });
  await expect(
    db.bookingCheckout.update({
      where: { id: intent.id },
      data: { status: "CREATING" },
    }),
  ).rejects.toThrow();
  await expect(
    db.bookingCheckout.delete({ where: { id: intent.id } }),
  ).rejects.toThrow();
  expect(f.cartCreate).toHaveBeenCalledTimes(1);
});

const mutations: [string, (c: BookingCart) => void][] = [
  [
    "quantity",
    (c) => {
      c.lines.nodes[0].quantity = 2;
    },
  ],
  [
    "total quantity",
    (c) => {
      c.totalQuantity = 2;
    },
  ],
  [
    "extra line",
    (c) => {
      c.lines.nodes.push(c.lines.nodes[0]);
    },
  ],
  [
    "pagination",
    (c) => {
      c.lines.pageInfo.hasNextPage = true;
    },
  ],
  [
    "variant",
    (c) => {
      c.lines.nodes[0].merchandise.id = "gid://shopify/ProductVariant/999";
    },
  ],
  [
    "product",
    (c) => {
      c.lines.nodes[0].merchandise.product.id = "gid://shopify/Product/999";
    },
  ],
  [
    "reference",
    (c) => {
      c.lines.nodes[0].attributes = [
        { key: BOOKING_REFERENCE_KEY, value: "wrong" },
      ];
    },
  ],
  [
    "duplicate reference",
    (c) => {
      c.lines.nodes[0].attributes.push(c.lines.nodes[0].attributes[0]);
    },
  ],
  [
    "selling plan",
    (c) => {
      c.lines.nodes[0].sellingPlanAllocation = { sellingPlan: { id: "plan" } };
    },
  ],
  [
    "price",
    (c) => {
      c.lines.nodes[0].cost.amountPerQuantity.amount = "1.00";
    },
  ],
  [
    "currency",
    (c) => {
      c.lines.nodes[0].cost.amountPerQuantity.currencyCode = "USD";
    },
  ],
  [
    "country",
    (c) => {
      c.buyerIdentity.countryCode = "US";
    },
  ],
  [
    "checkout host",
    (c) => {
      c.checkoutUrl = "https://evil.example/checkouts/test";
    },
  ],
  [
    "checkout protocol",
    (c) => {
      c.checkoutUrl = c.checkoutUrl.replace("https:", "http:");
    },
  ],
  [
    "checkout credentials",
    (c) => {
      c.checkoutUrl = c.checkoutUrl.replace("https://", "https://user@");
    },
  ],
  [
    "cart without key",
    (c) => {
      c.id = c.id.split("?")[0];
    },
  ],
];
test.each(mutations)(
  "rejects a changed %s without handing off a checkout URL",
  async (_name, change) => {
    const f = await fixture();
    const original = f.cartCreate.getMockImplementation()!;
    f.cartCreate.mockImplementation(async (...args) => {
      await original(...args);
      change(f.cart);
      return Response.json({
        data: { cartCreate: { cart: f.cart, userErrors: [], warnings: [] } },
      });
    });
    await expect(f.run()).rejects.toMatchObject({ code: "CART_CHANGED" });
    expect((await f.intent()).status).toBe("INVALIDATED");
    await expect(f.run()).rejects.toMatchObject({
      code: "CART_RECOVERY_REQUIRED",
    });
    expect(f.cartCreate).toHaveBeenCalledTimes(1);
  },
);

test.each(["expiry", "cancel", "price", "disable"] as const)(
  "rechecks %s after the network call, without holding the Session lock",
  async (mode) => {
    const f = await fixture();
    const original = f.cartCreate.getMockImplementation()!;
    f.cartCreate.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (mode === "expiry")
        await db.bookingHold.updateMany({
          where: { shopId: f.shop.id },
          data: {
            createdAt: new Date(Date.now() - 960000),
            expiresAt: new Date(Date.now() - 60000),
          },
        });
      if (mode === "cancel")
        await db.classSession.update({
          where: { id: f.session.id },
          data: { status: "CANCELLED" },
        });
      if (mode === "price")
        await db.passPlan.update({
          where: { id: f.pass.id },
          data: { version: { increment: 1 }, requestedPriceCents: 23000 },
        });
      if (mode === "disable")
        await db.shop.update({ where: { id: f.shop.id }, data: { rules: {} } });
      return result;
    });
    await expect(f.run()).rejects.toThrow();
    expect((await f.intent()).status).toBe("INVALIDATED");
    expect((await f.intent()).cartId).toBe(f.cart.id);
  },
);

test("a known Cart read can retry after a network failure but never re-create", async () => {
  const f = await fixture();
  await f.run();
  f.cartRead.mockRejectedValueOnce(new Error("private-secret"));
  await expect(f.run()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  expect((await f.intent()).status).toBe("READY");
  await f.run();
  expect(f.cartCreate).toHaveBeenCalledTimes(1);
  expect(f.cartRead).toHaveBeenCalledTimes(2);
});

test("a changed known Cart ID is rejected", async () => {
  const f = await fixture();
  await f.run();
  f.cart.id += "different";
  await expect(f.run()).rejects.toMatchObject({ code: "CART_CHANGED" });
  expect((await f.intent()).status).toBe("INVALIDATED");
});

test("released Holds and changed purchase selections cannot reuse a Cart", async () => {
  const f = await fixture();
  await f.run();
  await expect(
    prepareBookingCheckout(
      f.actor,
      {
        token: f.input.token,
        purchaseKind: "DROP_IN",
        idempotencyKey: randomUUID(),
      },
      f.clients,
    ),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await releaseSeatHold(f.actor, f.input.token);
  await expect(f.run()).rejects.toThrow();
  expect(f.cartCreate).toHaveBeenCalledTimes(1);
});

test("checkout binding, price and Cart secret cannot be reassigned, including across shops", async () => {
  const f = await fixture();
  await f.run();
  const intent = await f.intent();
  for (const data of [
    { reference: "a".repeat(43) },
    { shopId: randomUUID() },
    { priceCents: 1 },
    { cartId: "gid://shopify/Cart/other?key=other" },
    { holdId: randomUUID() },
  ])
    await expect(
      db.bookingCheckout.update({ where: { id: intent.id }, data }),
    ).rejects.toThrow();
  const other = await fixture();
  const otherHold = await createSeatHold(other.actor, other.input);
  await expect(
    db.bookingCheckout.create({
      data: {
        ...intent,
        purchaseTerms: intent.purchaseTerms ?? undefined,
        id: randomUUID(),
        holdId: otherHold.id,
        reference: "b".repeat(43),
        cartId: null,
        status: "CREATING",
      },
    }),
  ).rejects.toThrow();
  await expect(
    db.bookingCheckout.create({
      data: {
        ...intent,
        purchaseTerms: intent.purchaseTerms ?? undefined,
        id: randomUUID(),
        shopId: other.shop.id,
        holdId: otherHold.id,
        reference: "b".repeat(43),
        cartId: null,
        status: "CREATING",
      },
    }),
  ).rejects.toThrow();
});

test("two customers racing the last seat create only one Cart", async () => {
  const f = await fixture();
  const otherActor = { ...f.actor, customerGid: "gid://shopify/Customer/789" };
  const otherAttempt = await startAttempt(otherActor, {
    sessionId: f.session.id,
    surface: "HOME",
  });
  const results = await Promise.allSettled([
    f.run(),
    prepareBookingCheckout(
      otherActor,
      {
        ...f.input,
        token: otherAttempt.token,
        idempotencyKey: randomUUID(),
      },
      f.clients,
    ),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.cartCreate).toHaveBeenCalledTimes(1);
  expect(await db.bookingHold.count({ where: { shopId: f.shop.id } })).toBe(1);
});

test("Shopify cart warnings retain the known Cart but do not hand off", async () => {
  const f = await fixture();
  const original = f.cartCreate.getMockImplementation()!;
  f.cartCreate.mockImplementation(async (...args) => {
    await original(...args);
    return Response.json({
      data: {
        cartCreate: {
          cart: f.cart,
          userErrors: [],
          warnings: [{ message: "adjusted" }],
        },
      },
    });
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CART_CHANGED" });
  expect(await f.intent()).toMatchObject({
    status: "INVALIDATED",
    cartId: f.cart.id,
  });
  await expect(f.run()).rejects.toMatchObject({
    code: "CART_RECOVERY_REQUIRED",
  });
});

test("catalog changes during availability checks cannot create a Hold or Cart", async () => {
  const f = await fixture();
  f.admin.mockImplementation(async () => {
    await db.passPlan.update({
      where: { id: f.pass.id },
      data: { version: { increment: 1 } },
    });
    return Response.json({ data: f.adminData });
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_CHANGED" });
  expect(f.cartCreate).not.toHaveBeenCalled();
  expect(await db.bookingHold.count({ where: { shopId: f.shop.id } })).toBe(0);
});

test("cartCreate has a deadline covering a stalled response body and disables SDK retries", async () => {
  const graphql = vi.fn<GraphQL>(
    async () =>
      ({
        ok: true,
        json: () => new Promise(() => {}),
      }) as unknown as Response,
  );
  await expect(
    createBookingCart(graphql, {
      reference: "r".repeat(43),
      productGid: "gid://shopify/Product/1",
      variantGid: "gid://shopify/ProductVariant/1",
      priceCents: 100,
    }),
  ).rejects.toMatchObject({ code: "CART_REQUEST_UNKNOWN" });
  expect(graphql).toHaveBeenCalledTimes(1);
  expect(graphql.mock.calls[0][1].tries).toBe(1);
  expect(graphql.mock.calls[0][1].signal?.aborted).toBe(true);
}, 10000);
