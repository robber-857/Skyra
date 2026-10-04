import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { DomainError } from "../app/lib/errors.server";
import { bookingTerms } from "../app/services/booking-terms.server";
import { startAttempt } from "../app/services/booking.server";
import { prepareBookingCheckout } from "../app/services/booking-checkout.server";
import { membershipCatalog } from "../app/services/membership-catalog.server";
import {
  membershipPurchaseResult,
  prepareMembershipCheckout,
} from "../app/services/membership-checkout.server";
import { AUTO_RENEW_TERMS_VERSION } from "../app/services/membership-capabilities.server";

const mocked = vi.hoisted(() => ({
  create: vi.fn(),
  read: vi.fn(),
  inspect: vi.fn(),
  billing: vi.fn(),
  authorize: vi.fn(),
  sellingPlan: vi.fn(),
}));
vi.mock("../app/services/membership-capabilities.server", () => ({
  AUTO_RENEW_TERMS_VERSION: "2026-10-02.v1",
  membershipCapabilities: () => ({
    checkoutAvailable: true,
    autoRenewAvailable: true,
    checkoutGuardReady: true,
  }),
}));
vi.mock("../app/services/membership-checkout-guard.server", () => ({
  prepareMembershipCheckoutAuthorization: mocked.authorize,
}));
vi.mock("../app/services/membership-selling-plan.server", () => ({
  assertMembershipSellingPlan: mocked.sellingPlan,
}));
vi.mock("../app/services/shopify-purchasability.server", () => ({
  inspectCatalogPurchase: mocked.inspect,
}));
vi.mock("../app/services/shopify-membership.server", () => ({
  createMembershipCart: mocked.create,
  readMembershipCart: mocked.read,
  readMembershipBilling: mocked.billing,
  assertMembershipCart: (cart: { checkoutUrl: string }) => cart.checkoutUrl,
}));

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Tests require skyra_booking_test.");
});
beforeEach(() => {
  vi.clearAllMocks();
  mocked.authorize.mockResolvedValue(undefined);
  mocked.sellingPlan.mockResolvedValue(undefined);
  mocked.inspect.mockResolvedValue({ ready: true, issues: [] });
  mocked.create.mockImplementation(async () => ({
    cart: {
      id: `gid://shopify/Cart/${randomUUID()}?key=test-only`,
      checkoutUrl: "https://example.myshopify.com/checkouts/test",
    },
    clean: true,
  }));
  mocked.read.mockImplementation(async (_client, id) => ({
    id,
    checkoutUrl: "https://example.myshopify.com/checkouts/test",
  }));
});
afterAll(() => db.$disconnect());

async function fixture() {
  const shop = await db.shop.create({
    data: {
      domain: `membership-${randomUUID()}.myshopify.com`,
      rulesApprovedAt: new Date(),
      rules: {
        bookingWindowDays: 14,
        bookingClosesBeforeMinutes: 120,
        seatHoldMinutes: 15,
        onlineBookingsEnabled: true,
      },
    },
  });
  const customer = await db.customerProfile.create({
    data: { shopId: shop.id, shopifyCustomerGid: "gid://shopify/Customer/123" },
  });
  const plan = await db.passPlan.create({
    data: {
      shopId: shop.id,
      name: "Monthly Pass",
      credits: 12,
      validityDays: 30,
      validityMonths: 1,
      status: "ACTIVE",
      requestedPriceCents: 29900,
      standalonePurchaseEnabled: true,
      autoRenewEnabled: true,
      sellingPlanGid: "gid://shopify/SellingPlan/789",
    },
  });
  const mapping = await db.productMapping.create({
    data: {
      shopId: shop.id,
      ownerType: "PASS_PLAN",
      ownerId: plan.id,
      productGid: "gid://shopify/Product/321",
      variantGid: "gid://shopify/ProductVariant/654",
      syncStatus: "SYNCED",
      productStatus: "ACTIVE",
      requestedVersion: 1,
      shopifyVersion: 1,
      publishedPrice: "299.00",
    },
  });
  const actor = {
    shopId: shop.id,
    shopDomain: shop.domain,
    customerGid: customer.shopifyCustomerGid,
  };
  const input = {
    passPlanId: plan.id,
    expectedVersion: plan.version,
    expectedPriceCents: plan.requestedPriceCents,
    autoRenew: true,
    idempotencyKey: randomUUID(),
    termsAcceptance: { accepted: true, version: bookingTerms.version },
    autoRenewAcceptance: { accepted: true, version: AUTO_RENEW_TERMS_VERSION },
  };
  const clients = vi.fn(async () => ({ admin: vi.fn(), storefront: vi.fn() }));
  return {
    shop,
    customer,
    plan,
    mapping,
    actor,
    input,
    clients,
    run: () => prepareMembershipCheckout(actor, input, clients),
  };
}

test("standalone checkout requires authenticated customer and explicit renewal consent before any cart", async () => {
  const f = await fixture();
  await expect(
    prepareMembershipCheckout(
      { ...f.actor, customerGid: null },
      f.input,
      f.clients,
    ),
  ).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
  const { autoRenewAcceptance: _, ...withoutConsent } = f.input;
  void _;
  await expect(
    prepareMembershipCheckout(f.actor, withoutConsent, f.clients),
  ).rejects.toMatchObject({ code: "AUTO_RENEW_TERMS_REQUIRED" });
  expect(mocked.create).not.toHaveBeenCalled();
  expect(await db.passPurchase.count({ where: { shopId: f.shop.id } })).toBe(0);
});

test("an unknown Shopify authorization cannot create a cart or authorize a replacement", async () => {
  const f = await fixture();
  mocked.authorize.mockRejectedValueOnce(
    new DomainError(
      "MEMBERSHIP_AUTHORIZATION_UNKNOWN",
      "Authorization needs review.",
      503,
    ),
  );
  await expect(f.run()).rejects.toMatchObject({
    code: "MEMBERSHIP_AUTHORIZATION_UNKNOWN",
  });
  expect(mocked.create).not.toHaveBeenCalled();
  const purchase = await db.passPurchase.findFirstOrThrow({
    where: { shopId: f.shop.id },
  });
  expect(purchase).toMatchObject({ status: "REVIEW", cartId: null });
  await expect(f.run()).rejects.toMatchObject({ code: "PASS_PAYMENT_REVIEW" });
  expect(mocked.create).not.toHaveBeenCalled();
  expect(await db.passPurchase.count({ where: { shopId: f.shop.id } })).toBe(1);
});

test("a foreign or unsafe selling plan stops both checkout authorization and cart creation", async () => {
  const f = await fixture();
  mocked.sellingPlan.mockRejectedValueOnce(
    new DomainError(
      "MEMBERSHIP_SELLING_PLAN_UNSAFE",
      "Plan needs review.",
      409,
    ),
  );
  await expect(f.run()).rejects.toMatchObject({
    code: "MEMBERSHIP_SELLING_PLAN_UNSAFE",
  });
  expect(mocked.authorize).not.toHaveBeenCalled();
  expect(mocked.create).not.toHaveBeenCalled();
  expect(
    await db.passPurchase.findFirst({ where: { shopId: f.shop.id } }),
  ).toMatchObject({ status: "REVIEW", cartId: null });
  await expect(f.run()).rejects.toMatchObject({ code: "PASS_PAYMENT_REVIEW" });
  expect(mocked.create).not.toHaveBeenCalled();
});

test("selling plan validation receives only the immutable subscription target", async () => {
  const f = await fixture();
  await f.run();
  const clients = await f.clients.mock.results[0].value;
  expect(mocked.sellingPlan).toHaveBeenCalledWith(clients.admin, {
    trustedGroupGid: process.env.SKYRA_MEMBERSHIPS_SELLING_PLAN_GROUP_GID || "",
    productGid: f.mapping.productGid,
    variantGid: f.mapping.variantGid,
    sellingPlanGid: f.plan.sellingPlanGid,
    priceCents: 29900,
    currency: "AUD",
  });
});

test("two standalone devices create one durable purchase and only one cart", async () => {
  const f = await fixture();
  const results = await Promise.allSettled([
    f.run(),
    prepareMembershipCheckout(
      f.actor,
      { ...f.input, idempotencyKey: randomUUID() },
      f.clients,
    ),
  ]);
  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect(await db.passPurchase.count({ where: { shopId: f.shop.id } })).toBe(1);
  expect(mocked.create).toHaveBeenCalledTimes(1);
  const next = await f.run();
  expect(next.status).toBe("CHECKOUT_READY");
  expect(mocked.create).toHaveBeenCalledTimes(1);
});

test("unknown cart response is retained and a new request cannot create another payable cart", async () => {
  const f = await fixture();
  mocked.create.mockRejectedValueOnce(
    new DomainError("CART_REQUEST_UNKNOWN", "unknown", 503),
  );
  await expect(f.run()).rejects.toMatchObject({ code: "CART_REQUEST_UNKNOWN" });
  await expect(
    prepareMembershipCheckout(
      f.actor,
      { ...f.input, idempotencyKey: randomUUID() },
      f.clients,
    ),
  ).rejects.toMatchObject({ code: "PASS_PAYMENT_REVIEW" });
  expect(mocked.create).toHaveBeenCalledTimes(1);
  expect(
    await db.passPurchase.findFirst({ where: { shopId: f.shop.id } }),
  ).toMatchObject({ status: "UNKNOWN" });
});

test("paid response replay survives disabled catalog and never reopens checkout", async () => {
  const f = await fixture();
  const ready = await f.run();
  await db.passPurchase.update({
    where: { id: ready.purchaseId },
    data: { status: "PAID" },
  });
  await db.passPlan.update({
    where: { id: f.plan.id },
    data: { status: "INACTIVE" },
  });
  const paid = await f.run();
  expect(paid).toMatchObject({
    status: "PAID",
    purchaseId: ready.purchaseId,
    name: f.plan.name,
  });
  expect(mocked.create).toHaveBeenCalledTimes(1);
});

test("a stale reviewed price or plan version cannot create a new checkout", async () => {
  const f = await fixture();
  await expect(
    prepareMembershipCheckout(
      f.actor,
      { ...f.input, expectedPriceCents: f.plan.requestedPriceCents - 100 },
      f.clients,
    ),
  ).rejects.toMatchObject({ code: "PASS_QUOTE_CHANGED" });
  await expect(
    prepareMembershipCheckout(
      f.actor,
      { ...f.input, expectedVersion: f.plan.version + 1 },
      f.clients,
    ),
  ).rejects.toMatchObject({ code: "PASS_QUOTE_CHANGED" });
  expect(mocked.create).not.toHaveBeenCalled();
  expect(await db.passPurchase.count({ where: { shopId: f.shop.id } })).toBe(0);
});

test("purchase result and idempotency replay reject another customer", async () => {
  const f = await fixture();
  const ready = await f.run();
  const intruder = { ...f.actor, customerGid: "gid://shopify/Customer/456" };
  await expect(
    membershipPurchaseResult(intruder, { purchaseId: ready.purchaseId }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    prepareMembershipCheckout(intruder, f.input, f.clients),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

async function bookingInput(f: Awaited<ReturnType<typeof fixture>>) {
  const location = await db.location.create({
    data: { shopId: f.shop.id, name: "Studio" },
  });
  const coach = await db.coach.create({
    data: { shopId: f.shop.id, name: "Coach" },
  });
  const service = await db.service.create({
    data: {
      shopId: f.shop.id,
      locationId: location.id,
      name: "Class",
      durationMin: 60,
      capacity: 10,
      status: "ACTIVE",
      requestedPriceCents: 4900,
    },
  });
  await db.passEligibility.create({
    data: { shopId: f.shop.id, serviceId: service.id, passPlanId: f.plan.id },
  });
  const startsAt = new Date(Date.now() + 2 * 86400000),
    endsAt = new Date(startsAt.getTime() + 3600000);
  const session = await db.classSession.create({
    data: {
      shopId: f.shop.id,
      serviceId: service.id,
      coachId: coach.id,
      locationId: location.id,
      startsAt,
      endsAt,
      busyStartsAt: startsAt,
      busyEndsAt: endsAt,
      timezone: "Australia/Sydney",
      capacity: 10,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  const attempt = await startAttempt(f.actor, {
    sessionId: session.id,
    surface: "HOME",
  });
  return {
    token: attempt.token,
    purchaseKind: "NEW_PASS",
    passPlanId: f.plan.id,
    idempotencyKey: randomUUID(),
    termsAcceptance: f.input.termsAcceptance,
  };
}

test.each([false, true])(
  "membership purchase blocks a concurrent booking purchase (autoRenew=%s)",
  async (autoRenew) => {
    const f = await fixture();
    await f.run();
    const input = await bookingInput(f);
    await expect(
      prepareBookingCheckout(
        f.actor,
        {
          ...input,
          autoRenew,
          ...(autoRenew
            ? { autoRenewAcceptance: f.input.autoRenewAcceptance }
            : {}),
        },
        f.clients,
      ),
    ).rejects.toMatchObject({ code: "PASS_PAYMENT_IN_PROGRESS" });
    expect(mocked.create).toHaveBeenCalledTimes(1);
    expect(
      await db.bookingCheckout.count({ where: { shopId: f.shop.id } }),
    ).toBe(0);
  },
);

test.each([false, true])(
  "booking and standalone race share one payment claim (autoRenew=%s)",
  async (autoRenew) => {
    const f = await fixture();
    const input = await bookingInput(f);
    const results = await Promise.allSettled([
      prepareMembershipCheckout(f.actor, { ...f.input, autoRenew }, f.clients),
      prepareBookingCheckout(
        f.actor,
        {
          ...input,
          autoRenew,
          ...(autoRenew
            ? { autoRenewAcceptance: f.input.autoRenewAcceptance }
            : {}),
        },
        f.clients,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(mocked.create).toHaveBeenCalledTimes(1);
    expect(await db.passPurchase.count({ where: { shopId: f.shop.id } })).toBe(
      1,
    );
  },
);

test("each renewal checkout verifies its own Pass group instead of a shared environment group", async () => {
  for (const group of ["901", "902"]) {
    const f = await fixture();
    await db.passPlan.update({
      where: { id: f.plan.id },
      data: {
        sellingPlanGroupGid: `gid://shopify/SellingPlanGroup/${group}`,
        renewalSetupState: "READY",
      },
    });
    await f.run();
    expect(mocked.sellingPlan).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({
        trustedGroupGid: `gid://shopify/SellingPlanGroup/${group}`,
      }),
    );
  }
});

test("catalog exposes only configured standalone plans and reads customer-owned state", async () => {
  const f = await fixture();
  await f.run();
  const catalog = await membershipCatalog(f.actor, {});
  expect(catalog.passes).toHaveLength(1);
  expect(catalog.memberships).toHaveLength(1);
  expect(catalog.memberships[0]).toMatchObject({
    passPlanId: f.plan.id,
    hasPendingPayment: true,
  });
  const guest = await membershipCatalog({ ...f.actor, customerGid: null }, {});
  expect(guest.authenticated).toBe(false);
  expect(guest.memberships).toHaveLength(0);
  await db.passPlan.update({
    where: { id: f.plan.id },
    data: { standalonePurchaseEnabled: false },
  });
  expect((await membershipCatalog(f.actor, {})).passes).toHaveLength(0);
});

test("payment challenge is returned only to its owner after verifying the existing billing context", async () => {
  const f = await fixture();
  const ready = await f.run();
  const purchase = await db.passPurchase.update({
    where: { id: ready.purchaseId },
    data: {
      status: "ACTION_REQUIRED",
      billingAttemptGid: `gid://shopify/SubscriptionBillingAttempt/${Date.now()}${Math.floor(Math.random() * 100000)}`,
    },
  });
  const contractGid = "gid://shopify/SubscriptionContract/123";
  await db.passMembership.update({
    where: { id: purchase.membershipId },
    data: { contractGid },
  });
  const admin = vi.fn(async () => vi.fn());
  mocked.billing.mockResolvedValue({
    contractGid,
    idempotencyKey: purchase.idempotencyKey,
    nextActionUrl: "https://checkout.shopify.com/authenticate/test",
    errorCode: null,
  });
  await expect(
    membershipPurchaseResult(
      { ...f.actor, customerGid: "gid://shopify/Customer/456" },
      { purchaseId: purchase.id },
      admin,
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(admin).not.toHaveBeenCalled();
  expect(
    await membershipPurchaseResult(f.actor, { purchaseId: purchase.id }, admin),
  ).toEqual({
    status: "ACTION_REQUIRED",
    name: f.plan.name,
    actionUrl: "https://checkout.shopify.com/authenticate/test",
  });
  expect(mocked.create).toHaveBeenCalledTimes(1);
  mocked.billing.mockResolvedValue({
    contractGid,
    idempotencyKey: "wrong-period",
    nextActionUrl: "https://checkout.shopify.com/authenticate/test",
    errorCode: null,
  });
  await expect(
    membershipPurchaseResult(f.actor, { purchaseId: purchase.id }, admin),
  ).rejects.toMatchObject({ code: "BILLING_CONTEXT_MISMATCH" });
  mocked.billing.mockResolvedValue({
    contractGid,
    idempotencyKey: purchase.idempotencyKey,
    nextActionUrl: "http://checkout.shopify.com/authenticate/test",
    errorCode: null,
  });
  await expect(
    membershipPurchaseResult(f.actor, { purchaseId: purchase.id }, admin),
  ).rejects.toMatchObject({ code: "BILLING_ACTION_UNAVAILABLE" });
});
