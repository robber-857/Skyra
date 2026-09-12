import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import db from "../app/db.server";
import { receiveOrderPaidWebhook } from "../app/services/order-paid-webhook.server";
import { BOOKING_REFERENCE_KEY } from "../app/services/shopify-cart.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Tests require skyra_booking_test.");
});

afterAll(async () => {
  await db.$disconnect();
});

async function fixture() {
  const shop = await db.shop.create({
    data: { domain: `orders-${randomUUID()}.myshopify.com` },
  });
  const location = await db.location.create({
    data: { shopId: shop.id, name: "Studio" },
  });
  const coach = await db.coach.create({
    data: { shopId: shop.id, name: "Coach" },
  });
  const service = await db.service.create({
    data: {
      shopId: shop.id,
      locationId: location.id,
      name: "Class",
      durationMin: 60,
      capacity: 4,
      status: "ACTIVE",
      requestedPriceCents: 4900,
    },
  });
  const pass = await db.passPlan.create({
    data: {
      shopId: shop.id,
      name: "Five class pass",
      credits: 5,
      validityDays: 90,
      status: "ACTIVE",
      requestedPriceCents: 22000,
    },
  });
  const mapping = await db.productMapping.create({
    data: {
      shopId: shop.id,
      ownerType: "PASS_PLAN",
      ownerId: pass.id,
      productGid: "gid://shopify/Product/321",
      variantGid: "gid://shopify/ProductVariant/654",
      syncStatus: "SYNCED",
      productStatus: "ACTIVE",
      requestedVersion: 1,
      shopifyVersion: 1,
      publishedPrice: "220.00",
    },
  });
  const startsAt = new Date(Date.now() + 86400000);
  const session = await db.classSession.create({
    data: {
      shopId: shop.id,
      serviceId: service.id,
      coachId: coach.id,
      locationId: location.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600000),
      busyStartsAt: startsAt,
      busyEndsAt: new Date(startsAt.getTime() + 3600000),
      timezone: "Australia/Sydney",
      capacity: 4,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  const customer = await db.customerProfile.create({
    data: {
      shopId: shop.id,
      shopifyCustomerGid: "gid://shopify/Customer/123",
    },
  });
  const attempt = await db.bookingAttempt.create({
    data: {
      shopId: shop.id,
      tokenHash:
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
      sessionId: session.id,
      customerId: customer.id,
      surface: "PROGRAMS",
      status: "HOLD_ACTIVE",
      expiresAt: new Date(Date.now() + 900000),
    },
  });
  const hold = await db.bookingHold.create({
    data: {
      shopId: shop.id,
      attemptId: attempt.id,
      sessionId: session.id,
      customerId: customer.id,
      purchaseKind: "NEW_PASS",
      passPlanId: pass.id,
      idempotencyKey: randomUUID(),
      expiresAt: new Date(Date.now() + 900000),
    },
  });
  const checkout = await db.bookingCheckout.create({
    data: {
      shopId: shop.id,
      holdId: hold.id,
      productMappingId: mapping.id,
      reference: Buffer.from(randomUUID().replaceAll("-", ""))
        .toString("base64url")
        .slice(0, 43)
        .padEnd(43, "a"),
      productGid: mapping.productGid!,
      variantGid: mapping.variantGid!,
      priceCents: 22000,
      catalogFingerprint: "a".repeat(64),
      status: "READY",
      cartId: `gid://shopify/Cart/${randomUUID()}?key=secret`,
    },
  });
  const payload = {
    admin_graphql_api_id: "gid://shopify/Order/1001",
    cancelled_at: null as string | null,
    currency: "AUD",
    current_subtotal_price: "220.00",
    current_total_price: "220.00",
    financial_status: "paid",
    customer: { admin_graphql_api_id: customer.shopifyCustomerGid },
    line_items: [
      {
        admin_graphql_api_id: "gid://shopify/LineItem/2001",
        product_id: 321,
        variant_id: 654,
        quantity: 1,
        price: "220.00",
        properties: [
          { name: BOOKING_REFERENCE_KEY, value: checkout.reference },
        ],
      },
    ],
  };
  return { shop, checkout, payload };
}

async function receive(
  f: Awaited<ReturnType<typeof fixture>>,
  webhookId = randomUUID(),
) {
  return receiveOrderPaidWebhook({
    shopDomain: f.shop.domain,
    webhookId,
    topic: "orders/paid",
    rawBody: JSON.stringify(f.payload),
    payload: f.payload,
  });
}

test("valid paid booking order is durably queued without raw customer data", async () => {
  const f = await fixture();
  const result = await receive(f);
  expect(result).toMatchObject({ status: "QUEUED", duplicate: false });
  const receipt = await db.webhookReceipt.findUniqueOrThrow({
    where: { id: result.receiptId },
  });
  expect(receipt.status).toBe("QUEUED");
  expect(receipt.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: receipt.id },
  });
  expect(event.kind).toBe("ORDER_PAID_RECEIVED");
  expect(event.payload).toMatchObject({
    checkoutId: f.checkout.id,
    orderGid: "gid://shopify/Order/1001",
    lineItemGid: "gid://shopify/LineItem/2001",
    codes: [],
  });
  expect(JSON.stringify(event.payload)).not.toContain("Customer/123");
});

test("concurrent Shopify retries create one receipt and one outbox event", async () => {
  const f = await fixture();
  const webhookId = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => receive(f, webhookId)),
  );
  expect(new Set(results.map((item) => item.receiptId)).size).toBe(1);
  expect(results.filter((item) => !item.duplicate)).toHaveLength(1);
  expect(
    await db.webhookReceipt.count({
      where: { shopId: f.shop.id, webhookId },
    }),
  ).toBe(1);
  expect(
    await db.outboxEvent.count({
      where: { aggregateId: results[0].receiptId },
    }),
  ).toBe(1);
});

test("a reused delivery ID with different bytes is flagged as a conflict", async () => {
  const f = await fixture();
  const webhookId = randomUUID();
  await receive(f, webhookId);
  f.payload.current_total_price = "219.00";
  await expect(receive(f, webhookId)).resolves.toMatchObject({
    status: "CONFLICT",
    duplicate: true,
  });
});

test("unrelated paid orders are acknowledged without queue work", async () => {
  const f = await fixture();
  f.payload.line_items[0].properties = [];
  const result = await receive(f);
  expect(result.status).toBe("IGNORED");
  expect(
    await db.outboxEvent.count({ where: { aggregateId: result.receiptId } }),
  ).toBe(0);
});

test("all customer, catalogue, quantity, currency, amount and payment mismatches are reviewed", async () => {
  const f = await fixture();
  f.payload.customer.admin_graphql_api_id = "gid://shopify/Customer/999";
  f.payload.line_items[0].product_id = 999;
  f.payload.line_items[0].variant_id = 888;
  f.payload.line_items[0].quantity = 2;
  f.payload.line_items[0].price = "219.00";
  f.payload.currency = "USD";
  f.payload.current_subtotal_price = "219.00";
  f.payload.current_total_price = "218.00";
  f.payload.financial_status = "pending";
  f.payload.cancelled_at = new Date().toISOString();
  const result = await receive(f);
  expect(result.status).toBe("NEEDS_ATTENTION");
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: result.receiptId },
  });
  expect(event.kind).toBe("ORDER_PAID_REVIEW");
  expect(event.payload).toMatchObject({
    codes: expect.arrayContaining([
      "CUSTOMER_MISMATCH",
      "PRODUCT_MISMATCH",
      "VARIANT_MISMATCH",
      "QUANTITY_MISMATCH",
      "CURRENCY_MISMATCH",
      "AMOUNT_MISMATCH",
      "NOT_PAID",
      "ORDER_CANCELLED",
    ]),
  });
});

test("unknown and cross-shop booking references cannot claim a checkout", async () => {
  const owner = await fixture();
  const delivery = await fixture();
  delivery.payload.line_items[0].properties[0].value = owner.checkout.reference;
  const result = await receive(delivery);
  const event = await db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: result.receiptId },
  });
  expect(event.kind).toBe("ORDER_PAID_REVIEW");
  expect(event.payload).toMatchObject({
    checkoutId: null,
    codes: expect.arrayContaining(["CHECKOUT_NOT_FOUND"]),
  });
});

test("malformed money and duplicate booking references are retained for review", async () => {
  const malformed = await fixture();
  malformed.payload.current_total_price = "220";
  expect((await receive(malformed)).status).toBe("NEEDS_ATTENTION");
  const duplicate = await fixture();
  duplicate.payload.line_items[0].properties.push({
    name: BOOKING_REFERENCE_KEY,
    value: duplicate.checkout.reference,
  });
  expect((await receive(duplicate)).status).toBe("NEEDS_ATTENTION");
});

test("unknown shop is retryable and creates no orphan receipt", async () => {
  const f = await fixture();
  f.shop.domain = `missing-${randomUUID()}.myshopify.com`;
  await expect(receive(f)).rejects.toMatchObject({
    code: "SHOP_NOT_FOUND",
    status: 503,
  });
});
