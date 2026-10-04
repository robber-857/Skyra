import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { DomainError } from "../app/lib/errors.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import { bookingTerms } from "../app/services/booking-terms.server";
import { claimPassPurchaseInTransaction } from "../app/services/membership-purchases.server";
import {
  receiveMembershipOrderPaid,
  settlePassPurchasePayment,
} from "../app/services/membership-payments.server";
import { cancelPassMembership } from "../app/services/membership-lifecycle.server";
import {
  bindMembershipContract,
  claimDueMembershipCycle,
  processMembershipBilling,
  sweepMembershipWork,
} from "../app/services/membership-worker.server";
import {
  staffChangeBooking,
  settleDefaultAttendanceWork,
} from "../app/services/booking-lifecycle.server";
import { AUTO_RENEW_TERMS_VERSION } from "../app/services/membership-capabilities.server";
import type { GraphQL } from "../app/services/shopify-catalog.server";

const sdk = vi.hoisted(() => ({
  contract: vi.fn(),
  context: vi.fn(),
  submit: vi.fn(),
  billing: vi.fn(),
  order: vi.fn(),
  closeCheckout: vi.fn(),
}));
vi.mock("../app/services/membership-checkout-guard.server", () => ({
  closeMembershipCheckoutForRenewal: sdk.closeCheckout,
}));
vi.mock("../app/services/membership-capabilities.server", () => ({
  AUTO_RENEW_TERMS_VERSION: "2026-10-02.v1",
  membershipCapabilities: () => ({
    checkoutAvailable: true,
    autoRenewAvailable: true,
  }),
}));
vi.mock(
  "../app/services/shopify-membership.server",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../app/services/shopify-membership.server")
    >()),
    readSubscriptionContract: sdk.contract,
    readMembershipBillingContext: sdk.context,
    submitMembershipBilling: sdk.submit,
    readMembershipBilling: sdk.billing,
    readMembershipOrder: sdk.order,
  }),
);

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Tests require skyra_booking_test.");
});
beforeEach(() => {
  vi.resetAllMocks();
  sdk.closeCheckout.mockResolvedValue(undefined);
});
afterAll(() => db.$disconnect());

async function fixture(
  book = true,
  options: {
    mode?: "ONCE" | "AUTO_RENEW";
    validityMonths?: number;
    free?: boolean;
  } = {},
) {
  const f = await paidFixture(
    "NEW_PASS",
    false,
    "CLASS",
    options.validityMonths,
  );
  const mode = options.mode ?? "AUTO_RENEW";
  const plan = await db.passPlan.update({
    where: { id: f.plan.id },
    data: {
      autoRenewEnabled: true,
      sellingPlanGid: "gid://shopify/SellingPlan/789",
    },
  });
  const claimInput = {
    shopId: f.shop.id,
    customerId: f.customer.id,
    passPlanId: plan.id,
    mode,
    bookingCheckoutId: f.checkout.id,
    idempotencyKey: randomUUID(),
    productMappingId: f.mapping.id,
    productGid: f.mapping.productGid!,
    variantGid: f.mapping.variantGid!,
    sellingPlanGid: mode === "AUTO_RENEW" ? plan.sellingPlanGid : null,
    priceCents: plan.requestedPriceCents,
    currency: "AUD" as const,
    credits: plan.credits,
    validityDays: plan.validityDays,
    validityMonths: plan.validityMonths,
    timezone: "Australia/Sydney",
    termsVersion: bookingTerms.version,
    autoRenewTermsVersion:
      mode === "AUTO_RENEW" ? AUTO_RENEW_TERMS_VERSION : undefined,
  };
  const { purchase } = await db.$transaction((tx) =>
    claimPassPurchaseInTransaction(tx, claimInput),
  );
  await db.passPurchase.update({
    where: { id: purchase.id },
    data: { status: "CHECKOUT_READY" },
  });
  f.payload.line_items[0].properties.push({
    name: "_skyra_pass_purchase_ref",
    value: purchase.reference,
  });
  const webhook = {
    shopDomain: f.shop.domain,
    payload: f.payload,
    rawBody: JSON.stringify(f.payload),
    webhookId: randomUUID(),
  };
  if (options.free) {
    f.payload.current_total_price = "0.00";
    f.payload.current_subtotal_price = "0.00";
    f.payload.total_discounts = (plan.requestedPriceCents / 100).toFixed(2);
    webhook.rawBody = JSON.stringify(f.payload);
  }
  await receiveMembershipOrderPaid(webhook);
  if (book) await processPaidBookingEvent((await queuePaid(f)).id);
  const entitlement = await db.entitlement.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  const booking = await db.booking.findFirst({ where: { shopId: f.shop.id } });
  const member = await db.passMembership.findUniqueOrThrow({
    where: { id: purchase.membershipId },
  });
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  const customerActor = {
    shopId: f.shop.id,
    customerGid: f.customer.shopifyCustomerGid,
  };
  const contract = {
    id: "gid://shopify/SubscriptionContract/100",
    status: "ACTIVE",
    originOrder: { id: f.payload.admin_graphql_api_id },
    customer: { id: f.customer.shopifyCustomerGid },
    currencyCode: "AUD",
    deliveryPrice: { amount: "0.00", currencyCode: "AUD" },
    customerPaymentMethod: {
      id: "gid://shopify/CustomerPaymentMethod/1",
      revokedAt: null,
    },
    lines: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          variantId: f.mapping.variantGid,
          productId: f.mapping.productGid,
          quantity: 1,
          sellingPlanId: plan.sellingPlanGid,
          currentPrice: { amount: "220.00", currencyCode: "AUD" },
          requiresShipping: false,
        },
      ],
    },
  };
  sdk.contract.mockResolvedValue(contract);
  sdk.context.mockImplementation(async () => {
    const previous = await db.entitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
    });
    return {
      contract: {
        ...(await sdk.contract()),
        nextBillingDate: previous.expiresAt?.toISOString() ?? null,
      },
      billingCycleSelector: { index: 37 },
    };
  });
  if (mode === "AUTO_RENEW")
    await bindMembershipContract(f.shop.id, contract.id, vi.fn());
  return {
    ...f,
    plan,
    purchase,
    member,
    entitlement,
    booking,
    actor,
    customerActor,
    contract,
    claimInput,
    webhook,
  };
}

test("100 percent discounted first Pass grants once, books only its course and retains a zero receipt", async () => {
  const f = await fixture(true, {
    mode: "ONCE",
    validityMonths: 1,
    free: true,
  });
  expect(f.booking?.status).toBe("CONFIRMED");
  expect(f.entitlement.startsAt).toBeNull();
  expect(
    await db.passPurchase.findUnique({ where: { id: f.purchase.id } }),
  ).toMatchObject({
    status: "PAID",
    paidPriceCents: 0,
    priceCents: f.plan.requestedPriceCents,
  });
  expect(
    await db.membershipReceipt.findUnique({
      where: { purchaseId: f.purchase.id },
    }),
  ).toMatchObject({ priceCents: 0 });
  await receiveMembershipOrderPaid(f.webhook);
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
});

async function change(
  f: Awaited<ReturnType<typeof fixture>>,
  action: "CHECK_IN" | "COMPLETE" | "NO_SHOW" | "CANCEL",
) {
  const booking = await db.booking.findUniqueOrThrow({
    where: { id: f.booking!.id },
  });
  return staffChangeBooking(f.actor, {
    bookingId: booking.id,
    expectedVersion: booking.version,
    action,
    reason: "Verified class attendance",
    idempotencyKey: randomUUID(),
  });
}
async function classAt(
  f: Awaited<ReturnType<typeof fixture>>,
  startDelta: number,
  endDelta: number,
) {
  const startsAt = new Date(Date.now() + startDelta),
    endsAt = new Date(Date.now() + endDelta);
  await db.classSession.update({
    where: { id: f.session.id },
    data: { startsAt, endsAt, busyStartsAt: startsAt, busyEndsAt: endsAt },
  });
  return startsAt;
}
async function expire(f: Awaited<ReturnType<typeof fixture>>) {
  await db.entitlement.update({
    where: { id: f.entitlement.id },
    data: {
      startsAt: new Date(Date.now() - 32 * 86400000),
      expiresAt: new Date(Date.now() - 1000),
    },
  });
  await db.passMembership.update({
    where: { id: f.member.id },
    data: { status: "ACTIVE", autoRenew: true },
  });
}

async function queueMembershipEvent(
  shopId: string,
  kind: string,
  payload: Prisma.InputJsonObject,
  availableAt = new Date(),
) {
  const receipt = await db.webhookReceipt.create({
    data: {
      shopId,
      webhookId: randomUUID(),
      topic: kind,
      payloadHash: "a".repeat(64),
      status: "QUEUED",
    },
  });
  return db.outboxEvent.create({
    data: {
      shopId,
      kind,
      aggregateId: receipt.id,
      version: 1,
      payload,
      availableAt,
    },
  });
}

test("verified paid webhook replay grants one first-attendance pass and booking does not activate it", async () => {
  const f = await fixture();
  await Promise.all([
    receiveMembershipOrderPaid(f.webhook),
    receiveMembershipOrderPaid({ ...f.webhook, webhookId: randomUUID() }),
  ]);
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    await db.entitlementLedgerEntry.count({
      where: { entitlementId: f.entitlement.id, kind: "GRANT" },
    }),
  ).toBe(1);
  expect(
    await db.membershipReceipt.count({ where: { purchaseId: f.purchase.id } }),
  ).toBe(1);
  expect(
    await db.membershipNotification.count({
      where: { purchaseId: f.purchase.id, event: "PAID" },
    }),
  ).toBe(1);
  expect(
    await db.entitlement.findUnique({ where: { id: f.entitlement.id } }),
  ).toMatchObject({
    activationMode: "FIRST_ATTENDANCE",
    startsAt: null,
    expiresAt: null,
  });
  expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
});

test("one-time monthly purchase waits for actual attendance and never schedules billing", async () => {
  const f = await fixture(true, { mode: "ONCE", validityMonths: 1 });
  expect(
    await db.entitlement.findUnique({ where: { id: f.entitlement.id } }),
  ).toMatchObject({
    activationMode: "FIRST_ATTENDANCE",
    startsAt: null,
    expiresAt: null,
  });
  const start = await classAt(f, -35 * 86400000, -35 * 86400000 + 3600000);
  await settleDefaultAttendanceWork({ shopId: f.shop.id });
  expect(
    await db.entitlement.findUnique({ where: { id: f.entitlement.id } }),
  ).toMatchObject({ startsAt: null, expiresAt: null });
  await change(f, "COMPLETE");
  const attended = await db.entitlement.findUniqueOrThrow({
    where: { id: f.entitlement.id },
  });
  const expectedStart = DateTime.fromJSDate(start, {
    zone: "Australia/Sydney",
  }).startOf("day");
  expect(attended.startsAt!.getTime()).toBe(expectedStart.toMillis());
  expect(attended.expiresAt!.getTime()).toBe(
    expectedStart.plus({ months: 1 }).toMillis(),
  );
  expect(attended.expiresAt!.getTime()).toBeLessThan(Date.now());
  expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(
    await db.passMembership.findUnique({ where: { id: f.member.id } }),
  ).toMatchObject({ autoRenew: false, contractGid: null });
});

test.each(["NO_SHOW", "CANCEL"] as const)(
  "one-time monthly %s keeps the paid pass unactivated",
  async (action) => {
    const f = await fixture(true, { mode: "ONCE", validityMonths: 1 });
    if (action === "NO_SHOW") await classAt(f, -7200000, -3600000);
    await change(f, action);
    expect(
      await db.entitlement.findUnique({ where: { id: f.entitlement.id } }),
    ).toMatchObject({ startsAt: null, expiresAt: null });
    expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
    expect(sdk.submit).not.toHaveBeenCalled();
  },
);

test("one-time non-monthly pass retains its first-booking activation", async () => {
  const f = await fixture(true, { mode: "ONCE", validityMonths: 2 });
  expect(
    await db.entitlement.findUnique({ where: { id: f.entitlement.id } }),
  ).toMatchObject({
    activationMode: "FIRST_BOOKING",
    activationBookingId: f.booking!.id,
    startsAt: expect.any(Date),
    expiresAt: expect.any(Date),
  });
});

test.each(["CHECK_IN", "COMPLETE"] as const)(
  "explicit %s activates first-attendance pass",
  async (action) => {
    const f = await fixture();
    const start = await classAt(
      f,
      -7200000,
      action === "CHECK_IN" ? 3600000 : -3600000,
    );
    await change(f, action);
    const entitlement = await db.entitlement.findUniqueOrThrow({
      where: { id: f.entitlement.id },
    });
    expect(
      DateTime.fromJSDate(entitlement.startsAt!, {
        zone: "Australia/Sydney",
      }).toISODate(),
    ).toBe(
      DateTime.fromJSDate(start, { zone: "Australia/Sydney" }).toISODate(),
    );
    expect(
      DateTime.fromJSDate(entitlement.startsAt!, { zone: "Australia/Sydney" })
        .hour,
    ).toBe(0);
    expect(entitlement.expiresAt!.getTime()).toBeGreaterThan(
      start.getTime() + 27 * 86400000,
    );
    expect(entitlement.activationBookingId).toBe(f.booking!.id);
    expect(
      await db.passMembership.findUnique({ where: { id: f.member.id } }),
    ).toMatchObject({ status: "ACTIVE" });
  },
);

test("automatic attendance settlement cannot activate a first-attendance pass", async () => {
  const f = await fixture();
  await classAt(f, -7200000, -3600000);
  await settleDefaultAttendanceWork({ shopId: f.shop.id });
  expect(
    await db.entitlement.findUnique({ where: { id: f.entitlement.id } }),
  ).toMatchObject({ startsAt: null, expiresAt: null });
  expect(
    await db.booking.findUnique({ where: { id: f.booking!.id } }),
  ).toMatchObject({ status: "CONFIRMED" });
  expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
});

test.each(["NO_SHOW", "CANCEL"] as const)(
  "%s does not activate or schedule renewal",
  async (action) => {
    const f = await fixture();
    if (action === "NO_SHOW") await classAt(f, -7200000, -3600000);
    await change(f, action);
    expect(
      await db.entitlement.findUnique({ where: { id: f.entitlement.id } }),
    ).toMatchObject({ startsAt: null, expiresAt: null });
    expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
  },
);

test("concurrent expiry workers claim one next cycle and waiting prevents another charge", async () => {
  const f = await fixture(false);
  await expire(f);
  const claims = await Promise.all(
    Array.from({ length: 6 }, () => claimDueMembershipCycle(f.member.id)),
  );
  expect(claims.filter(Boolean)).toHaveLength(1);
  const renewal = claims.find(Boolean)!;
  expect(renewal.cycle).toBe(2);
  expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
  await settlePassPurchasePayment(renewal.id, {
    orderGid: "gid://shopify/Order/1002",
    lineItemGid: "gid://shopify/LineItem/2002",
    customerGid: f.customer.shopifyCustomerGid,
    productGid: f.mapping.productGid!,
    variantGid: f.mapping.variantGid!,
    priceCents: 22000,
    currency: "AUD",
    quantity: 1,
  });
  expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
  expect(
    await db.passPurchase.count({ where: { membershipId: f.member.id } }),
  ).toBe(2);
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(2);
  const paid = await db.passPurchase.findUniqueOrThrow({
    where: { id: renewal.id },
  });
  expect(
    await db.entitlement.findUnique({ where: { id: paid.entitlementId! } }),
  ).toMatchObject({ startsAt: null, expiresAt: null });
});

test("cancelled renewal preserves paid pass and blocks provider submit", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  await cancelPassMembership(f.customerActor, f.member.id);
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(
    await db.entitlement.findUnique({ where: { id: f.entitlement.id } }),
  ).not.toBeNull();
  expect(
    await db.passMembership.findUnique({ where: { id: f.member.id } }),
  ).toMatchObject({ autoRenew: false, status: "CANCELLED" });
});

test("cancellation during an already submitted payment retains that paid pass and blocks later billing", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  const billing = {
    id: `gid://shopify/SubscriptionBillingAttempt/${Date.now()}${Math.floor(Math.random() * 100000)}`,
    contractGid: f.contract.id,
    idempotencyKey: renewal.idempotencyKey,
    ready: true,
    orderGid: "gid://shopify/Order/1002",
    errorCode: null,
    nextActionUrl: null,
  };
  sdk.submit.mockImplementation(async () => {
    const response = await cancelPassMembership(f.customerActor, f.member.id);
    expect(response.message).toContain("already in progress");
    return billing;
  });
  sdk.order.mockResolvedValue({
    orderGid: billing.orderGid,
    lineItemGid: "gid://shopify/LineItem/2002",
    customerGid: f.customer.shopifyCustomerGid,
    productGid: f.mapping.productGid!,
    variantGid: f.mapping.variantGid!,
    priceCents: 22000,
    currency: "AUD",
    quantity: 1,
    contractGid: f.contract.id,
    sellingPlanGid: f.plan.sellingPlanGid,
  });
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).toHaveBeenCalledTimes(1);
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ status: "PAID", entitlementId: expect.any(String) });
  expect(
    await db.passMembership.findUnique({ where: { id: f.member.id } }),
  ).toMatchObject({ autoRenew: false, status: "CANCELLED" });
  expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).toHaveBeenCalledTimes(1);
});

test("unmatched paid order arriving after renewal claim blocks the provider charge", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  const payload = {
    ...f.payload,
    admin_graphql_api_id: "gid://shopify/Order/9999",
  };
  expect(
    await receiveMembershipOrderPaid({
      ...f.webhook,
      payload,
      rawBody: JSON.stringify(payload),
      webhookId: randomUUID(),
    }),
  ).toEqual({ skipBooking: true });
  await Promise.all([
    processMembershipBilling(renewal.id, vi.fn()),
    processMembershipBilling(renewal.id, vi.fn()),
  ]);
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({
    status: "BILLING_PENDING",
    submittedAt: null,
    billingAttemptGid: null,
    entitlementId: null,
  });
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    await db.outboxEvent.count({
      where: {
        shopId: f.shop.id,
        kind: "MEMBERSHIP_ORDER_RECONCILE",
        status: { not: "DONE" },
      },
    }),
  ).toBe(1);
});

test("lost provider response parks the same renewal and never submits a replacement", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  sdk.submit.mockRejectedValue(new Error("response lost"));
  await Promise.all([
    processMembershipBilling(renewal.id, vi.fn()),
    processMembershipBilling(renewal.id, vi.fn()),
  ]);
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).toHaveBeenCalledTimes(1);
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ status: "UNKNOWN", billingAttemptGid: null });
  expect(
    await db.passPurchase.count({ where: { membershipId: f.member.id } }),
  ).toBe(2);
});

test("unverified native billing context cannot claim a provider submission", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  sdk.context.mockRejectedValueOnce(
    new DomainError(
      "BILLING_CONTEXT_UNSAFE",
      "Native cycle needs review.",
      409,
    ),
  );
  await expect(
    processMembershipBilling(renewal.id, vi.fn()),
  ).rejects.toMatchObject({ code: "BILLING_CONTEXT_UNSAFE" });
  expect(sdk.closeCheckout).not.toHaveBeenCalled();
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ status: "BILLING_PENDING", submittedAt: null });
});

test("a native billing date different from attended Pass expiry cannot charge", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  const previous = await db.entitlement.findUniqueOrThrow({
    where: { id: f.entitlement.id },
  });
  sdk.context.mockResolvedValueOnce({
    contract: {
      ...f.contract,
      nextBillingDate: new Date(
        previous.expiresAt!.getTime() - 1,
      ).toISOString(),
    },
    billingCycleSelector: { index: 37 },
  });
  await expect(
    processMembershipBilling(renewal.id, vi.fn()),
  ).rejects.toMatchObject({ code: "BILLING_DATE_MISMATCH" });
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ status: "BILLING_PENDING", submittedAt: null });
});

test("renewal explicitly submits the verified native cycle rather than the local cycle", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  sdk.submit.mockRejectedValueOnce(new Error("simulated transport loss"));
  await processMembershipBilling(renewal.id, vi.fn());
  expect(renewal.cycle).toBe(2);
  expect(sdk.submit).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      idempotencyKey: renewal.idempotencyKey,
      billingCycleSelector: { index: 37 },
    }),
  );
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).toHaveBeenCalledTimes(1);
});

test("an unknown checkout closure stops renewal before the provider charge", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  sdk.closeCheckout.mockRejectedValue(new Error("closure response unknown"));
  await expect(processMembershipBilling(renewal.id, vi.fn())).rejects.toThrow();
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ status: "BILLING_PENDING", submittedAt: null });
});

test("explicit billing failure remains unpaid and blocks alternate manual purchase", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  sdk.submit.mockResolvedValue({
    id: `gid://shopify/SubscriptionBillingAttempt/${Date.now()}${Math.floor(Math.random() * 100000)}`,
    contractGid: f.contract.id,
    idempotencyKey: renewal.idempotencyKey,
    ready: true,
    orderGid: null,
    errorCode: "PAYMENT_FAILED",
    nextActionUrl: null,
  });
  await processMembershipBilling(renewal.id, vi.fn());
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ status: "FAILED", entitlementId: null });
  await expect(
    db.$transaction((tx) =>
      claimPassPurchaseInTransaction(tx, {
        ...f.claimInput,
        bookingCheckoutId: undefined,
        mode: "ONCE",
        idempotencyKey: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ code: "PASS_PAYMENT_IN_PROGRESS" });
  expect(sdk.submit).toHaveBeenCalledTimes(1);
});

test("duplicate successful orders stop renewal without granting a second pass", async () => {
  const f = await fixture(false);
  const result = await settlePassPurchasePayment(f.purchase.id, {
    orderGid: "gid://shopify/Order/9000",
    lineItemGid: "gid://shopify/LineItem/9001",
    customerGid: f.customer.shopifyCustomerGid,
    productGid: f.mapping.productGid!,
    variantGid: f.mapping.variantGid!,
    priceCents: 22000,
    currency: "AUD",
    quantity: 1,
  });
  expect(result.status).toBe("NEEDS_ATTENTION");
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    await db.passMembership.findUnique({ where: { id: f.member.id } }),
  ).toMatchObject({ status: "PAYMENT_REVIEW", autoRenew: false });
  await bindMembershipContract(f.shop.id, f.contract.id, vi.fn());
  expect(
    await db.passMembership.findUnique({ where: { id: f.member.id } }),
  ).toMatchObject({ status: "PAYMENT_REVIEW", autoRenew: false });
});

test("first managed booking payment continues booking fulfillment but recurring copied references do not", async () => {
  const f = await fixture();
  expect(await receiveMembershipOrderPaid(f.webhook)).toEqual({
    skipBooking: false,
  });
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  await db.passPurchase.update({
    where: { id: renewal.id },
    data: { submittedAt: new Date(), status: "SUBMITTING" },
  });
  const payload = {
    ...f.payload,
    admin_graphql_api_id: "gid://shopify/Order/1002",
  };
  const webhookId = randomUUID();
  expect(
    await receiveMembershipOrderPaid({
      ...f.webhook,
      payload,
      rawBody: JSON.stringify(payload),
      webhookId,
    }),
  ).toEqual({ skipBooking: true });
  expect(await db.booking.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(
    await db.outboxEvent.count({
      where: { shopId: f.shop.id, kind: "MEMBERSHIP_ORDER_RECONCILE" },
    }),
  ).toBe(1);
});

test("provider success through worker grants exactly one next pass awaiting activation", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  const billing = {
    id: `gid://shopify/SubscriptionBillingAttempt/${Date.now()}${Math.floor(Math.random() * 100000)}`,
    contractGid: f.contract.id,
    idempotencyKey: renewal.idempotencyKey,
    ready: true,
    orderGid: "gid://shopify/Order/1002",
    errorCode: null,
    nextActionUrl: null,
  };
  sdk.submit.mockResolvedValue(billing);
  sdk.billing.mockResolvedValue(billing);
  sdk.order.mockResolvedValue({
    orderGid: billing.orderGid,
    lineItemGid: "gid://shopify/LineItem/2002",
    customerGid: f.customer.shopifyCustomerGid,
    productGid: f.mapping.productGid!,
    variantGid: f.mapping.variantGid!,
    priceCents: 22000,
    currency: "AUD",
    quantity: 1,
    contractGid: f.contract.id,
    sellingPlanGid: f.plan.sellingPlanGid,
  });
  await Promise.all([
    processMembershipBilling(renewal.id, vi.fn()),
    processMembershipBilling(renewal.id, vi.fn()),
  ]);
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).toHaveBeenCalledTimes(1);
  const paid = await db.passPurchase.findUniqueOrThrow({
    where: { id: renewal.id },
  });
  expect(paid.status).toBe("PAID");
  expect(
    await db.entitlement.findUnique({ where: { id: paid.entitlementId! } }),
  ).toMatchObject({
    startsAt: null,
    expiresAt: null,
    activationMode: "FIRST_ATTENDANCE",
  });
  expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(2);
  expect(
    await db.membershipReceipt.count({ where: { shopId: f.shop.id } }),
  ).toBe(2);
  expect(
    await db.membershipNotification.count({
      where: { shopId: f.shop.id, event: "PAID" },
    }),
  ).toBe(2);
});

test("first attendance cannot clear a payment review or reenable renewal", async () => {
  const f = await fixture();
  await db.passMembership.update({
    where: { id: f.member.id },
    data: { status: "PAYMENT_REVIEW", autoRenew: false },
  });
  await classAt(f, -7200000, -3600000);
  await change(f, "COMPLETE");
  expect(
    await db.entitlement.findUnique({ where: { id: f.entitlement.id } }),
  ).toMatchObject({ activationBookingId: f.booking!.id });
  await bindMembershipContract(f.shop.id, f.contract.id, vi.fn());
  expect(
    await db.passMembership.findUnique({ where: { id: f.member.id } }),
  ).toMatchObject({ status: "PAYMENT_REVIEW", autoRenew: false });
});

test("late billing event recovers an unknown response and duplicate delivery grants only one next pass", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  sdk.submit.mockRejectedValue(
    new Error("response lost after provider accepted"),
  );
  await processMembershipBilling(renewal.id, vi.fn());
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ status: "UNKNOWN", billingAttemptGid: null });
  const billing = {
    id: `gid://shopify/SubscriptionBillingAttempt/${Date.now()}${Math.floor(Math.random() * 100000)}`,
    contractGid: f.contract.id,
    idempotencyKey: renewal.idempotencyKey,
    ready: true,
    orderGid: "gid://shopify/Order/1002",
    errorCode: null,
    nextActionUrl: null,
  };
  sdk.billing.mockResolvedValue(billing);
  sdk.order.mockResolvedValue({
    orderGid: billing.orderGid,
    lineItemGid: "gid://shopify/LineItem/2002",
    customerGid: f.customer.shopifyCustomerGid,
    productGid: f.mapping.productGid!,
    variantGid: f.mapping.variantGid!,
    priceCents: 22000,
    currency: "AUD",
    quantity: 1,
    contractGid: f.contract.id,
    sellingPlanGid: f.plan.sellingPlanGid,
  });
  const event = () =>
    queueMembershipEvent(f.shop.id, "MEMBERSHIP_BILLING_RECEIVED", {
      attemptGid: billing.id,
    });
  const first = await event();
  // Scope the scheduler inventory to this test's shop; every ledger and state
  // transition still executes against PostgreSQL and the real worker code.
  const shops = vi.spyOn(db.shop, "findMany").mockResolvedValue([f.shop]);
  try {
    await sweepMembershipWork(async () => vi.fn<GraphQL>());
    const duplicate = await event();
    await Promise.all([
      sweepMembershipWork(async () => vi.fn<GraphQL>()),
      processMembershipBilling(renewal.id, vi.fn()),
    ]);
    expect(
      await db.outboxEvent.findUnique({ where: { id: first.id } }),
    ).toMatchObject({ status: "DONE" });
    expect(
      await db.outboxEvent.findUnique({ where: { id: duplicate.id } }),
    ).toMatchObject({ status: "DONE" });
    expect(
      await db.webhookReceipt.findUnique({ where: { id: first.aggregateId } }),
    ).toMatchObject({ status: "PROCESSED" });
    expect(
      await db.webhookReceipt.findUnique({
        where: { id: duplicate.aggregateId },
      }),
    ).toMatchObject({ status: "PROCESSED" });
  } finally {
    shops.mockRestore();
  }
  const paid = await db.passPurchase.findUniqueOrThrow({
    where: { id: renewal.id },
  });
  expect(paid).toMatchObject({ status: "PAID", billingAttemptGid: billing.id });
  expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(2);
  expect(
    await db.entitlementLedgerEntry.count({
      where: { entitlementId: paid.entitlementId!, kind: "GRANT" },
    }),
  ).toBe(1);
  expect(sdk.submit).toHaveBeenCalledTimes(1);
});

test("verified contract event completes its persisted webhook receipt", async () => {
  const f = await fixture(false);
  const event = await queueMembershipEvent(
    f.shop.id,
    "MEMBERSHIP_CONTRACT_RECEIVED",
    { contractGid: f.contract.id },
  );
  const shops = vi.spyOn(db.shop, "findMany").mockResolvedValue([f.shop]);
  try {
    await sweepMembershipWork(async () => vi.fn<GraphQL>());
  } finally {
    shops.mockRestore();
  }
  expect(
    await db.outboxEvent.findUnique({ where: { id: event.id } }),
  ).toMatchObject({ status: "DONE" });
  expect(
    await db.webhookReceipt.findUnique({ where: { id: event.aggregateId } }),
  ).toMatchObject({ status: "PROCESSED" });
  expect(sdk.submit).not.toHaveBeenCalled();
});

test("unmatched order backoff lets a later verified receipt reconcile without another charge", async () => {
  const f = await fixture(false);
  const blocked = await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      queueMembershipEvent(
        f.shop.id,
        "MEMBERSHIP_ORDER_RECONCILE",
        {
          orderGid: `gid://shopify/Order/${9000 + index}`,
          membershipId: f.member.id,
        },
        new Date(Date.now() - 3000),
      ),
    ),
  );
  const valid = await queueMembershipEvent(
    f.shop.id,
    "MEMBERSHIP_ORDER_RECONCILE",
    {
      orderGid: f.payload.admin_graphql_api_id,
      membershipId: f.member.id,
    },
    new Date(Date.now() - 1000),
  );
  const shops = vi.spyOn(db.shop, "findMany").mockResolvedValue([f.shop]);
  try {
    await sweepMembershipWork(async () => vi.fn<GraphQL>());
    expect(
      await db.outboxEvent.findUnique({ where: { id: valid.id } }),
    ).toMatchObject({ status: "PENDING" });
    const firstBlocked = await db.outboxEvent.findUniqueOrThrow({
      where: { id: blocked[0].id },
    });
    expect(firstBlocked).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastError: "UNMATCHED_PAID_ORDER",
    });
    expect(firstBlocked.availableAt.getTime()).toBeGreaterThan(Date.now());
    await sweepMembershipWork(async () => vi.fn<GraphQL>());
  } finally {
    shops.mockRestore();
  }
  expect(
    await db.outboxEvent.findUnique({ where: { id: valid.id } }),
  ).toMatchObject({ status: "DONE", lastError: null });
  expect(
    await db.webhookReceipt.findUnique({ where: { id: valid.aggregateId } }),
  ).toMatchObject({ status: "PROCESSED" });
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(await db.passPurchase.count({ where: { shopId: f.shop.id } })).toBe(1);
});

test.each(["idempotencyKey", "contractGid"] as const)(
  "unmatched late billing event (%s) cannot claim an unknown payment",
  async (mismatch) => {
    const f = await fixture(false);
    await expire(f);
    const renewal = (await claimDueMembershipCycle(f.member.id))!;
    sdk.submit.mockRejectedValue(new Error("response lost"));
    await processMembershipBilling(renewal.id, vi.fn());
    const billing = {
      id: `gid://shopify/SubscriptionBillingAttempt/${Date.now()}${Math.floor(Math.random() * 100000)}`,
      contractGid: f.contract.id,
      idempotencyKey: renewal.idempotencyKey,
      ready: true,
      orderGid: "gid://shopify/Order/1002",
      errorCode: null,
      nextActionUrl: null,
      [mismatch]:
        mismatch === "idempotencyKey"
          ? randomUUID()
          : "gid://shopify/SubscriptionContract/999",
    };
    sdk.billing.mockResolvedValue(billing);
    const event = await db.outboxEvent.create({
      data: {
        shopId: f.shop.id,
        kind: "MEMBERSHIP_BILLING_RECEIVED",
        aggregateId: randomUUID(),
        version: 1,
        payload: { attemptGid: billing.id },
        availableAt: new Date(Date.now() - 1000),
      },
    });
    const shops = vi.spyOn(db.shop, "findMany").mockResolvedValue([f.shop]);
    try {
      await sweepMembershipWork(async () => vi.fn<GraphQL>());
    } finally {
      shops.mockRestore();
    }
    expect(
      await db.outboxEvent.findUnique({ where: { id: event.id } }),
    ).toMatchObject({
      status: "PENDING",
      attempts: 1,
      lastError: "MEMBERSHIP_SYNC_REQUIRES_REVIEW",
    });
    expect(
      await db.passPurchase.findUnique({ where: { id: renewal.id } }),
    ).toMatchObject({
      status: "UNKNOWN",
      billingAttemptGid: null,
      entitlementId: null,
    });
    expect(await db.entitlement.count({ where: { shopId: f.shop.id } })).toBe(
      1,
    );
    expect(sdk.submit).toHaveBeenCalledTimes(1);
    expect(sdk.order).not.toHaveBeenCalled();
  },
);

test.each([null, { id: "gid://shopify/Order/9999" }])(
  "unbound original contract order (%j) cannot submit a renewal",
  async (originOrder) => {
    const f = await fixture(false);
    await expire(f);
    const renewal = (await claimDueMembershipCycle(f.member.id))!;
    sdk.contract.mockResolvedValue({ ...f.contract, originOrder });
    await expect(
      processMembershipBilling(renewal.id, vi.fn()),
    ).rejects.toMatchObject({ code: "BILLING_CONTRACT_UNBOUND" });
    expect(sdk.submit).not.toHaveBeenCalled();
    expect(
      await db.passPurchase.findUnique({ where: { id: renewal.id } }),
    ).toMatchObject({
      status: "BILLING_PENDING",
      submittedAt: null,
      billingAttemptGid: null,
    });
  },
);

test.each(["unactivated", "not-expired"] as const)(
  "a queued renewal cannot bill an %s prior Pass",
  async (state) => {
    const f = await fixture(false);
    if (state === "not-expired")
      await db.entitlement.update({
        where: { id: f.entitlement.id },
        data: {
          startsAt: new Date(Date.now() - 86400000),
          expiresAt: new Date(Date.now() + 29 * 86400000),
        },
      });
    await db.passMembership.update({
      where: { id: f.member.id },
      data: { status: "ACTIVE", autoRenew: true },
    });
    expect(await claimDueMembershipCycle(f.member.id)).toBeNull();
    // A stale or manually queued job cannot bypass the submit-time check.
    // Keep the prior Pass dates immutable, just as in the production schema.
    const renewal = await db.passPurchase.create({
      data: {
        shopId: f.shop.id,
        membershipId: f.member.id,
        cycle: 2,
        mode: "AUTO_RENEW",
        status: "BILLING_PENDING",
        reference: randomUUID(),
        idempotencyKey: randomUUID(),
        productMappingId: f.purchase.productMappingId,
        productGid: f.purchase.productGid,
        variantGid: f.purchase.variantGid,
        sellingPlanGid: f.purchase.sellingPlanGid,
        priceCents: f.purchase.priceCents,
        currency: f.purchase.currency,
        credits: f.purchase.credits,
        validityDays: f.purchase.validityDays,
        validityMonths: f.purchase.validityMonths,
        timezone: f.purchase.timezone,
        termsVersion: f.purchase.termsVersion,
        autoRenewTermsVersion: f.purchase.autoRenewTermsVersion,
      },
    });
    await db.passMembership.update({
      where: { id: f.member.id },
      data: { currentCycle: renewal.cycle, status: "WAITING_PAYMENT" },
    });
    await processMembershipBilling(renewal.id, vi.fn());
    expect(sdk.submit).not.toHaveBeenCalled();
    expect(
      await db.passPurchase.findUnique({ where: { id: renewal.id } }),
    ).toMatchObject({
      status: "BILLING_PENDING",
      submittedAt: null,
      billingAttemptGid: null,
    });
  },
);

test("revoking the prior Pass after the cycle claim prevents billing", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  await db.entitlement.update({
    where: { id: f.entitlement.id },
    data: { status: "REVOKED" },
  });
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ submittedAt: null, billingAttemptGid: null });
});

test("renewal amount snapshot cannot differ from agreed previous period before charging", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  await db.passPurchase.update({
    where: { id: renewal.id },
    data: { priceCents: 29900 },
  });
  await expect(
    processMembershipBilling(renewal.id, vi.fn()),
  ).rejects.toMatchObject({ code: "BILLING_TERMS_MISMATCH" });
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ submittedAt: null, billingAttemptGid: null });
});

test.each(["PAUSED", "CANCELLED", "FAILED"])(
  "externally %s contract is not resumed or billed",
  async (status) => {
    const f = await fixture(false);
    await expire(f);
    const renewal = (await claimDueMembershipCycle(f.member.id))!;
    sdk.contract.mockResolvedValue({ ...f.contract, status });
    await processMembershipBilling(renewal.id, vi.fn());
    expect(sdk.submit).not.toHaveBeenCalled();
    expect(
      await db.passMembership.findUnique({ where: { id: f.member.id } }),
    ).toMatchObject({ autoRenew: false });
  },
);

test.each(["price", "payment-method"])(
  "contract %s change blocks provider billing before any charge",
  async (field) => {
    const f = await fixture(false);
    await expire(f);
    const renewal = (await claimDueMembershipCycle(f.member.id))!;
    sdk.contract.mockResolvedValue(
      field === "price"
        ? {
            ...f.contract,
            lines: {
              ...f.contract.lines,
              nodes: [
                {
                  ...f.contract.lines.nodes[0],
                  currentPrice: { amount: "299.00", currencyCode: "AUD" },
                },
              ],
            },
          }
        : {
            ...f.contract,
            customerPaymentMethod: {
              ...f.contract.customerPaymentMethod,
              revokedAt: new Date().toISOString(),
            },
          },
    );
    await expect(
      processMembershipBilling(renewal.id, vi.fn()),
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_CONTRACT_MISMATCH" });
    expect(sdk.submit).not.toHaveBeenCalled();
  },
);

test("cancellation during contract recheck prevents the submit claim", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  sdk.contract.mockImplementation(async () => {
    await cancelPassMembership(f.customerActor, f.member.id);
    return f.contract;
  });
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).not.toHaveBeenCalled();
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ submittedAt: null, billingAttemptGid: null });
});

test("bank challenge takes precedence over an order and only the original attempt can settle later", async () => {
  const f = await fixture(false);
  await expire(f);
  const renewal = (await claimDueMembershipCycle(f.member.id))!;
  const billing = {
    id: `gid://shopify/SubscriptionBillingAttempt/${Date.now()}${Math.floor(Math.random() * 100000)}`,
    contractGid: f.contract.id,
    idempotencyKey: renewal.idempotencyKey,
    ready: true,
    orderGid: "gid://shopify/Order/1002",
    errorCode: null,
    nextActionUrl: "https://verified-provider.example/authenticate",
  };
  sdk.submit.mockResolvedValue(billing);
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).toHaveBeenCalledTimes(1);
  expect(sdk.order).not.toHaveBeenCalled();
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({
    status: "ACTION_REQUIRED",
    entitlementId: null,
    billingAttemptGid: billing.id,
  });
  sdk.billing.mockResolvedValue({ ...billing, nextActionUrl: null });
  sdk.order.mockResolvedValue({
    orderGid: billing.orderGid,
    lineItemGid: "gid://shopify/LineItem/2002",
    customerGid: f.customer.shopifyCustomerGid,
    productGid: f.mapping.productGid!,
    variantGid: f.mapping.variantGid!,
    priceCents: 22000,
    currency: "AUD",
    quantity: 1,
    contractGid: f.contract.id,
    sellingPlanGid: f.plan.sellingPlanGid,
  });
  await processMembershipBilling(renewal.id, vi.fn());
  expect(sdk.submit).toHaveBeenCalledTimes(1);
  expect(sdk.billing).toHaveBeenCalledWith(expect.anything(), billing.id);
  expect(
    await db.passPurchase.findUnique({ where: { id: renewal.id } }),
  ).toMatchObject({ status: "PAID", billingAttemptGid: billing.id });
});
