import type { PassPurchase } from "@prisma/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DomainError } from "../app/lib/errors.server";
import {
  closeMembershipCheckoutForRenewal,
  membershipCheckoutProof,
  prepareMembershipCheckoutAuthorization,
} from "../app/services/membership-checkout-guard.server";
import { preparePassPurchaseCart } from "../app/services/membership-checkout.server";

const mocked = vi.hoisted(() => ({
  capabilities: vi.fn(),
  read: vi.fn(),
  authorize: vi.fn(),
  close: vi.fn(),
  protection: vi.fn(),
  publicTokens: vi.fn(),
  findPurchase: vi.fn(),
  findCustomer: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  transaction: vi.fn(),
  createCart: vi.fn(),
  readCart: vi.fn(),
  assertCart: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  default: {
    passMembership: { findUnique: async () => null },
    passPurchase: {
      findFirst: mocked.findPurchase,
      update: mocked.update,
      updateMany: mocked.updateMany,
    },
    customerProfile: { findFirst: mocked.findCustomer },
    $transaction: mocked.transaction,
  },
}));
vi.mock("../app/services/membership-capabilities.server", () => ({
  membershipCapabilities: mocked.capabilities,
}));
vi.mock("../app/services/membership-checkout-authorization.server", () => ({
  readMembershipCheckoutAuthorization: mocked.read,
  authorizeMembershipCheckout: mocked.authorize,
  closeMembershipCheckout: mocked.close,
  assertMembershipCheckoutProtection: mocked.protection,
  assertNoPublicMembershipStorefrontTokens: mocked.publicTokens,
}));
// Only the cart handoff is exercised. No Prisma connection or Shopify client
// may be constructed by the checkout module's unrelated imports.
vi.mock("../app/services/booking.server", () => ({ databaseNow: vi.fn() }));
vi.mock("../app/services/booking-terms.server", () => ({
  bookingTerms: { version: "test" },
  requireBookingTerms: vi.fn(),
  recordBookingTerms: vi.fn(),
}));
vi.mock("../app/services/entitlements.server", () => ({
  introOfferEligible: vi.fn(),
}));
vi.mock("../app/services/shopify-purchasability.server", () => ({
  inspectCatalogPurchase: vi.fn(),
}));
vi.mock("../app/services/membership-purchases.server", () => ({
  claimPassPurchaseInTransaction: vi.fn(),
}));
vi.mock("../app/services/membership-catalog.server", () => ({
  AUTO_RENEW_TERMS_VERSION: "test",
}));
vi.mock("../app/services/shopify-membership.server", () => ({
  createMembershipCart: mocked.createCart,
  readMembershipCart: mocked.readCart,
  assertMembershipCart: mocked.assertCart,
  readMembershipBilling: vi.fn(),
}));

const actor = {
  shopId: "3c6ddf3f-33d6-42ea-83ee-6763f5f9b0fa",
  shopDomain: "skyra-booking-dev.myshopify.com",
  customerGid: "gid://shopify/Customer/123",
};
const domain = actor.shopDomain;
const admin = vi.fn();
const clients = { admin, storefront: vi.fn() };

function purchase(overrides: Partial<PassPurchase> = {}): PassPurchase {
  return {
    id: "a3de9e40-948f-48e0-86e0-6ab3ea11c884",
    shopId: actor.shopId,
    membershipId: "c2cbeff6-8853-499f-9ed1-c05a55169061",
    cycle: 1,
    mode: "ONE_TIME",
    status: "CREATING",
    reference: "P".repeat(43),
    bookingCheckoutId: null,
    cartId: null,
    productMappingId: "782e9da0-1b27-408f-a9e8-3cb08ae75a93",
    productGid: "gid://shopify/Product/321",
    variantGid: "gid://shopify/ProductVariant/654",
    sellingPlanGid: null,
    priceCents: 29900,
    paidPriceCents: null,
    currency: "AUD",
    credits: 12,
    validityDays: 30,
    validityMonths: 1,
    timezone: "Australia/Sydney",
    termsVersion: "test",
    autoRenewTermsVersion: null,
    entitlementId: null,
    sourceOrderGid: null,
    sourceLineItemGid: null,
    billingAttemptGid: null,
    idempotencyKey: "588e0d22-ead4-4cda-8482-6595b9a76a22",
    submittedAt: null,
    lastError: null,
    createdAt: new Date("2026-10-03T00:00:00Z"),
    updatedAt: new Date("2026-10-03T00:00:00Z"),
    ...overrides,
  };
}

function previousPaidPurchase() {
  return {
    ...purchase({
      id: "00f110c1-d6c3-4aa3-b6e0-f449aa67d323",
      membershipId: "87d141be-bab9-4463-b95a-37617aa28c72",
      reference: "Q".repeat(43),
      status: "PAID",
      sellingPlanGid: "gid://shopify/SellingPlan/789",
    }),
    membership: { customerId: "671a1d79-cffb-4d43-a3b4-06d3736b695f" },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv(
    "SKYRA_MEMBERSHIPS_TEST_VALIDATION_GID",
    "gid://shopify/Validation/1",
  );
  vi.stubEnv("SHOPIFY_API_KEY", "app-key");
  mocked.capabilities.mockReturnValue({ checkoutGuardReady: true });
  mocked.read.mockResolvedValue({
    customerGid: actor.customerGid,
    authorization: null,
    compareDigest: null,
  });
  mocked.findPurchase.mockResolvedValue(null);
  mocked.findCustomer.mockResolvedValue(null);
  mocked.updateMany.mockResolvedValue({ count: 1 });
  mocked.transaction.mockImplementation(async (callback) =>
    callback({ passPurchase: { updateMany: mocked.updateMany } }),
  );
  mocked.createCart.mockResolvedValue({
    cart: {
      id: "gid://shopify/Cart/test?key=test-only",
      checkoutUrl: "https://skyra-booking-dev.myshopify.com/checkouts/test",
    },
    clean: true,
  });
  mocked.assertCart.mockReturnValue(
    "https://skyra-booking-dev.myshopify.com/checkouts/test",
  );
});

afterEach(() => vi.unstubAllEnvs());

test.each([
  {
    label: "missing guard proof",
    guardReady: false,
    customer: actor.customerGid,
    currency: "AUD",
  },
  {
    label: "missing authenticated customer",
    guardReady: true,
    customer: null,
    currency: "AUD",
  },
  {
    label: "unexpected currency",
    guardReady: true,
    customer: actor.customerGid,
    currency: "USD",
  },
])(
  "$label stops before Shopify calls or cart creation",
  async ({ guardReady, customer, currency }) => {
    mocked.capabilities.mockReturnValue({ checkoutGuardReady: guardReady });
    await expect(
      preparePassPurchaseCart(
        { ...actor, customerGid: customer },
        { purchase: purchase({ currency }), creating: true },
        domain,
        clients,
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_CHECKOUT_GUARD_UNAVAILABLE" });
    expect(mocked.read).not.toHaveBeenCalled();
    expect(mocked.protection).not.toHaveBeenCalled();
    expect(mocked.authorize).not.toHaveBeenCalled();
    expect(mocked.close).not.toHaveBeenCalled();
    expect(mocked.createCart).not.toHaveBeenCalled();
    expect(mocked.readCart).not.toHaveBeenCalled();
  },
);

test("unverified native protection blocks authorization and cart creation", async () => {
  mocked.protection.mockRejectedValue(
    new DomainError(
      "MEMBERSHIP_CHECKOUT_GUARD_UNAVAILABLE",
      "not verified",
      503,
    ),
  );
  await expect(
    preparePassPurchaseCart(
      actor,
      { purchase: purchase(), creating: true },
      domain,
      clients,
    ),
  ).rejects.toMatchObject({ code: "MEMBERSHIP_CHECKOUT_GUARD_UNAVAILABLE" });
  expect(mocked.protection).toHaveBeenCalledWith(
    admin,
    purchase().productGid,
    "gid://shopify/Validation/1",
    "app-key",
  );
  expect(mocked.read).not.toHaveBeenCalled();
  expect(mocked.authorize).not.toHaveBeenCalled();
  expect(mocked.close).not.toHaveBeenCalled();
  expect(mocked.createCart).not.toHaveBeenCalled();
});

test("the guarded cart uses the persisted purchase reference and commercial quote", async () => {
  const stored = purchase({ sellingPlanGid: "gid://shopify/SellingPlan/789" });
  await preparePassPurchaseCart(
    actor,
    { purchase: stored, creating: true },
    domain,
    clients,
    "booking-reference",
  );
  const proof = mocked.authorize.mock.calls[0][1];
  expect(proof).toEqual({
    version: 1,
    state: "OPEN",
    nonce: stored.reference,
    purchaseId: stored.id,
    membershipId: stored.membershipId,
    cycle: 1,
    customerGid: actor.customerGid,
    productGid: stored.productGid,
    variantGid: stored.variantGid,
    sellingPlanGid: stored.sellingPlanGid,
    priceCents: 29900,
    currency: "AUD",
  });
  expect(mocked.createCart).toHaveBeenCalledWith(
    clients.storefront,
    {
      reference: stored.reference,
      productGid: stored.productGid,
      variantGid: stored.variantGid,
      sellingPlanGid: stored.sellingPlanGid,
      priceCents: stored.priceCents,
      bookingReference: "booking-reference",
      authorization: proof,
    },
    domain,
  );
  expect(mocked.authorize.mock.invocationCallOrder[0]).toBeLessThan(
    mocked.createCart.mock.invocationCallOrder[0],
  );
});

test.each([
  "UNKNOWN",
  "CREATING",
  "CHECKOUT_READY",
  "BILLING_PENDING",
  "FAILED",
  "REVIEW",
])(
  "an old OPEN authorization with no verified PAID purchase (%s) cannot be replaced",
  async (unresolvedStatus) => {
    const old = previousPaidPurchase();
    const oldProof = membershipCheckoutProof(actor.customerGid, old);
    mocked.read.mockResolvedValue({ authorization: oldProof });
    // The lookup must require PAID, so an unresolved persisted row never matches.
    mocked.findPurchase.mockImplementation(async ({ where }) => {
      expect(where).toEqual({
        id: old.id,
        shopId: actor.shopId,
        status: "PAID",
      });
      return unresolvedStatus === where.status ? old : null;
    });
    await expect(
      preparePassPurchaseCart(
        actor,
        { purchase: purchase(), creating: true },
        domain,
        clients,
      ),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_AUTHORIZATION_CONFLICT" });
    expect(mocked.close).not.toHaveBeenCalled();
    expect(mocked.authorize).not.toHaveBeenCalled();
    expect(mocked.createCart).not.toHaveBeenCalled();
    expect(mocked.updateMany).toHaveBeenCalledTimes(1);
    expect(mocked.updateMany.mock.calls[0][0].where.id).toBe(purchase().id);
    expect(mocked.updateMany.mock.calls[0][0].where.id).not.toBe(old.id);
  },
);

test("only a PAID prior purchase owned by the current customer releases its exact OPEN proof", async () => {
  const old = previousPaidPurchase();
  const oldProof = membershipCheckoutProof(actor.customerGid, old);
  const next = purchase();
  mocked.read.mockResolvedValue({ authorization: oldProof });
  mocked.findPurchase.mockResolvedValue(old);
  mocked.findCustomer.mockResolvedValue({ id: old.membership.customerId });
  const proof = await prepareMembershipCheckoutAuthorization(
    actor,
    next,
    domain,
    admin,
  );
  expect(mocked.findCustomer).toHaveBeenCalledWith({
    where: {
      id: old.membership.customerId,
      shopId: actor.shopId,
      shopifyCustomerGid: actor.customerGid,
    },
  });
  expect(mocked.close).toHaveBeenCalledExactlyOnceWith(admin, oldProof);
  expect(mocked.authorize).toHaveBeenCalledExactlyOnceWith(admin, proof);
  expect(mocked.close.mock.invocationCallOrder[0]).toBeLessThan(
    mocked.authorize.mock.invocationCallOrder[0],
  );
});

test.each(["wrong customer", "wrong proof"])(
  "a PAID prior purchase with %s cannot release another authorization",
  async (mismatch) => {
    const old = previousPaidPurchase();
    const oldProof = membershipCheckoutProof(actor.customerGid, old);
    mocked.read.mockResolvedValue({
      authorization:
        mismatch === "wrong proof"
          ? { ...oldProof, nonce: "R".repeat(43) }
          : oldProof,
    });
    mocked.findPurchase.mockResolvedValue(old);
    mocked.findCustomer.mockResolvedValue(
      mismatch === "wrong customer" ? null : { id: old.membership.customerId },
    );
    await expect(
      prepareMembershipCheckoutAuthorization(actor, purchase(), domain, admin),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_AUTHORIZATION_CONFLICT" });
    expect(mocked.close).not.toHaveBeenCalled();
    expect(mocked.authorize).not.toHaveBeenCalled();
  },
);

test("replaying the same OPEN proof preserves it and never closes its checkout", async () => {
  const stored = purchase({ status: "CHECKOUT_READY" });
  const proof = membershipCheckoutProof(actor.customerGid, stored);
  mocked.read.mockResolvedValue({ authorization: proof });
  await expect(
    prepareMembershipCheckoutAuthorization(actor, stored, domain, admin),
  ).resolves.toEqual(proof);
  expect(mocked.findPurchase).not.toHaveBeenCalled();
  expect(mocked.findCustomer).not.toHaveBeenCalled();
  expect(mocked.close).not.toHaveBeenCalled();
  expect(mocked.authorize).toHaveBeenCalledExactlyOnceWith(admin, proof);
});

test("an ambiguous close response blocks authorization and creation of a replacement cart", async () => {
  const old = previousPaidPurchase();
  mocked.read.mockResolvedValue({
    authorization: membershipCheckoutProof(actor.customerGid, old),
  });
  mocked.findPurchase.mockResolvedValue(old);
  mocked.findCustomer.mockResolvedValue({ id: old.membership.customerId });
  mocked.close.mockRejectedValue(
    new DomainError("MEMBERSHIP_AUTHORIZATION_UNKNOWN", "unknown", 503),
  );
  await expect(
    preparePassPurchaseCart(
      actor,
      { purchase: purchase(), creating: true },
      domain,
      clients,
    ),
  ).rejects.toMatchObject({ code: "MEMBERSHIP_AUTHORIZATION_UNKNOWN" });
  expect(mocked.authorize).not.toHaveBeenCalled();
  expect(mocked.createCart).not.toHaveBeenCalled();
});

test("unresolved local purchases stop before any provider or cart recovery call", async () => {
  await expect(
    preparePassPurchaseCart(
      actor,
      { purchase: purchase({ status: "UNKNOWN" }), creating: false },
      domain,
      clients,
    ),
  ).rejects.toMatchObject({ code: "PASS_PAYMENT_REVIEW" });
  expect(mocked.read).not.toHaveBeenCalled();
  expect(mocked.authorize).not.toHaveBeenCalled();
  expect(mocked.createCart).not.toHaveBeenCalled();
  expect(mocked.readCart).not.toHaveBeenCalled();
  expect(mocked.updateMany).not.toHaveBeenCalled();
});

function renewalFixture() {
  const renewal = purchase({
    cycle: 4,
    status: "BILLING_PENDING",
    mode: "AUTO_RENEW",
    sellingPlanGid: "gid://shopify/SellingPlan/789",
  });
  const original = {
    ...previousPaidPurchase(),
    membershipId: renewal.membershipId,
    cycle: 2,
    cartId: "gid://shopify/Cart/original?key=test-only",
    mode: "AUTO_RENEW",
  };
  mocked.findPurchase.mockResolvedValue(original);
  mocked.findCustomer.mockResolvedValue({
    id: original.membership.customerId,
    shopifyCustomerGid: actor.customerGid,
  });
  return { renewal, original };
}

test("renewal closes the persisted prior checkout proof only after protection and public-token checks", async () => {
  const { renewal, original } = renewalFixture();
  await closeMembershipCheckoutForRenewal(renewal, admin, domain);
  expect(mocked.findPurchase).toHaveBeenCalledExactlyOnceWith({
    where: {
      shopId: renewal.shopId,
      membershipId: renewal.membershipId,
      cycle: { lt: renewal.cycle },
      status: "PAID",
      cartId: { not: null },
    },
    orderBy: { cycle: "desc" },
    include: { membership: true },
  });
  expect(mocked.findCustomer).toHaveBeenCalledExactlyOnceWith({
    where: {
      shopId: renewal.shopId,
      id: original.membership.customerId,
    },
  });
  expect(mocked.protection).toHaveBeenCalledExactlyOnceWith(
    admin,
    original.productGid,
    "gid://shopify/Validation/1",
    "app-key",
  );
  expect(mocked.publicTokens).toHaveBeenCalledExactlyOnceWith(admin);
  expect(mocked.close).toHaveBeenCalledExactlyOnceWith(admin, {
    version: 1,
    state: "OPEN",
    nonce: original.reference,
    purchaseId: original.id,
    membershipId: renewal.membershipId,
    cycle: 2,
    customerGid: actor.customerGid,
    productGid: original.productGid,
    variantGid: original.variantGid,
    sellingPlanGid: original.sellingPlanGid,
    priceCents: original.priceCents,
    currency: "AUD",
  });
  expect(mocked.protection.mock.invocationCallOrder[0]).toBeLessThan(
    mocked.publicTokens.mock.invocationCallOrder[0],
  );
  expect(mocked.publicTokens.mock.invocationCallOrder[0]).toBeLessThan(
    mocked.close.mock.invocationCallOrder[0],
  );
  expect(mocked.authorize).not.toHaveBeenCalled();
  expect(mocked.createCart).not.toHaveBeenCalled();
});

test.each([
  "no earlier PAID checkout",
  "wrong customer",
  "missing customer GID",
])(
  "renewal without %s stops before protection reads or closure",
  async (missing) => {
    const { renewal } = renewalFixture();
    if (missing === "no earlier PAID checkout")
      mocked.findPurchase.mockResolvedValue(null);
    else if (missing === "wrong customer")
      // A record belonging to another shop/customer must not match the scoped
      // query used to resolve this membership's checkout owner.
      mocked.findCustomer.mockResolvedValue(null);
    else mocked.findCustomer.mockResolvedValue({ shopifyCustomerGid: null });
    await expect(
      closeMembershipCheckoutForRenewal(renewal, admin, domain),
    ).rejects.toMatchObject({ code: "MEMBERSHIP_CHECKOUT_GUARD_UNAVAILABLE" });
    expect(mocked.protection).not.toHaveBeenCalled();
    expect(mocked.publicTokens).not.toHaveBeenCalled();
    expect(mocked.close).not.toHaveBeenCalled();
  },
);

test.each(["native protection", "public Storefront token"])(
  "failed renewal %s verification preserves the original checkout authorization",
  async (failure) => {
    const { renewal } = renewalFixture();
    const error = new DomainError(
      "RENEWAL_PROTECTION_UNAVAILABLE",
      "blocked",
      503,
    );
    if (failure === "native protection")
      mocked.protection.mockRejectedValue(error);
    else mocked.publicTokens.mockRejectedValue(error);
    await expect(
      closeMembershipCheckoutForRenewal(renewal, admin, domain),
    ).rejects.toBe(error);
    expect(mocked.close).not.toHaveBeenCalled();
    expect(mocked.authorize).not.toHaveBeenCalled();
    expect(mocked.updateMany).not.toHaveBeenCalled();
  },
);

test("an unknown renewal closure propagates rather than reporting permission to bill", async () => {
  const { renewal } = renewalFixture();
  const error = new DomainError(
    "MEMBERSHIP_AUTHORIZATION_UNKNOWN",
    "unknown",
    503,
  );
  mocked.close.mockRejectedValue(error);
  await expect(
    closeMembershipCheckoutForRenewal(renewal, admin, domain),
  ).rejects.toBe(error);
  expect(mocked.authorize).not.toHaveBeenCalled();
  expect(mocked.updateMany).not.toHaveBeenCalled();
  expect(mocked.createCart).not.toHaveBeenCalled();
});


test.each([3, 6, 12])("%s-month automatic renewal cannot bypass checkout protection", async (months) => {
  mocked.capabilities.mockReturnValue({ checkoutGuardReady: false });
  await expect(prepareMembershipCheckoutAuthorization(actor, purchase({ validityMonths: months, mode: "AUTO_RENEW" }), domain, admin)).rejects.toMatchObject({ code: "MEMBERSHIP_CHECKOUT_GUARD_UNAVAILABLE" });
  expect(mocked.authorize).not.toHaveBeenCalled();
});
