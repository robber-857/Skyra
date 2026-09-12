import { createHash, randomBytes, randomUUID } from "node:crypto";
import db from "../app/db.server";
import { receiveOrderPaidWebhook } from "../app/services/order-paid-webhook.server";

export async function paidFixture(
  kind: "NEW_PASS" | "DROP_IN" = "NEW_PASS",
  expiredHold = false,
) {
  const shop = await db.shop.create({
    data: {
      domain: `paid-${randomUUID()}.myshopify.com`,
      rulesApprovedAt: new Date(),
      rules: {
        bookingWindowDays: 14,
        bookingClosesBeforeMinutes: 120,
        seatHoldMinutes: 15,
        onlineBookingsEnabled: false,
      },
    },
  });
  const location = await db.location.create({
    data: { shopId: shop.id, name: "Studio" },
  });
  const coach = await db.coach.create({
    data: { shopId: shop.id, name: "Development Coach" },
  });
  const service = await db.service.create({
    data: {
      shopId: shop.id,
      locationId: location.id,
      name: "Aerial Foundations",
      durationMin: 60,
      capacity: 8,
      requestedPriceCents: 4900,
      status: "ACTIVE",
    },
  });
  const plan = await db.passPlan.create({
    data: {
      shopId: shop.id,
      name: "Five Class Pass",
      credits: 5,
      validityDays: 30,
      requestedPriceCents: 22000,
      status: "ACTIVE",
    },
  });
  await db.passEligibility.create({
    data: { shopId: shop.id, passPlanId: plan.id, serviceId: service.id },
  });
  const mapping = await db.productMapping.create({
    data: {
      shopId: shop.id,
      ownerType: kind === "NEW_PASS" ? "PASS_PLAN" : "SERVICE",
      ownerId: kind === "NEW_PASS" ? plan.id : service.id,
      productGid: "gid://shopify/Product/321",
      variantGid: "gid://shopify/ProductVariant/654",
    },
  });
  const start = new Date(Date.now() + 3 * 86400000);
  const end = new Date(start.getTime() + 3600000);
  const session = await db.classSession.create({
    data: {
      shopId: shop.id,
      serviceId: service.id,
      coachId: coach.id,
      locationId: location.id,
      startsAt: start,
      endsAt: end,
      busyStartsAt: start,
      busyEndsAt: end,
      timezone: "Australia/Sydney",
      capacity: 8,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  const customer = await db.customerProfile.create({
    data: { shopId: shop.id, shopifyCustomerGid: "gid://shopify/Customer/123" },
  });
  const token = randomBytes(32).toString("base64url");
  const attempt = await db.bookingAttempt.create({
    data: {
      shopId: shop.id,
      sessionId: session.id,
      customerId: customer.id,
      surface: "HOME",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      status: expiredHold ? "RECOVERY" : "HOLD_ACTIVE",
      expiresAt: new Date(Date.now() + 1800000),
    },
  });
  const hold = await db.bookingHold.create({
    data: {
      shopId: shop.id,
      sessionId: session.id,
      customerId: customer.id,
      attemptId: attempt.id,
      purchaseKind: kind,
      passPlanId: kind === "NEW_PASS" ? plan.id : null,
      idempotencyKey: randomUUID(),
      status: expiredHold ? "EXPIRED" : "ACTIVE",
      createdAt: new Date(Date.now() - (expiredHold ? 960000 : 30000)),
      expiresAt: new Date(Date.now() + (expiredHold ? -60000 : 840000)),
    },
  });
  const checkout = await db.bookingCheckout.create({
    data: {
      shopId: shop.id,
      holdId: hold.id,
      productMappingId: mapping.id,
      reference: randomBytes(32).toString("base64url"),
      productGid: mapping.productGid!,
      variantGid: mapping.variantGid!,
      priceCents: kind === "NEW_PASS" ? 22000 : 4900,
      catalogFingerprint: "a".repeat(64),
      status: "READY",
      cartId: `gid://shopify/Cart/${randomUUID()}?key=test-only`,
      createdAt: new Date(Date.now() - 20000),
      purchaseTerms: {
        version: 1,
        credits: kind === "NEW_PASS" ? 5 : 1,
        validityDays: 30,
        timezone: session.timezone,
        sessionStartsAt: start.toISOString(),
        sessionEndsAt: end.toISOString(),
        coachId: coach.id,
        locationId: location.id,
        serviceId: service.id,
        introOnly: false,
      },
    },
  });
  const price = (checkout.priceCents / 100).toFixed(2);
  const payload = {
    admin_graphql_api_id: "gid://shopify/Order/1001",
    processed_at: new Date(Date.now() - 10000).toISOString(),
    cancelled_at: null,
    currency: "AUD",
    current_subtotal_price: price,
    current_total_price: price,
    financial_status: "paid",
    customer: { admin_graphql_api_id: customer.shopifyCustomerGid },
    line_items: [
      {
        admin_graphql_api_id: "gid://shopify/LineItem/2001",
        product_id: 321,
        variant_id: 654,
        quantity: 1,
        price,
        properties: [{ name: "_skyra_booking_ref", value: checkout.reference }],
      },
    ],
  };
  return {
    token,
    shop,
    location,
    coach,
    service,
    plan,
    mapping,
    session,
    customer,
    attempt,
    hold,
    checkout,
    payload,
  };
}
export async function queuePaid(
  f: Awaited<ReturnType<typeof paidFixture>>,
  order = "1001",
) {
  const payload = {
    ...f.payload,
    admin_graphql_api_id: `gid://shopify/Order/${order}`,
  };
  const receipt = await receiveOrderPaidWebhook({
    shopDomain: f.shop.domain,
    webhookId: randomUUID(),
    topic: "orders/paid",
    rawBody: JSON.stringify(payload),
    payload,
  });
  return db.outboxEvent.findFirstOrThrow({
    where: { aggregateId: receipt.receiptId, kind: "ORDER_PAID_RECEIVED" },
  });
}
