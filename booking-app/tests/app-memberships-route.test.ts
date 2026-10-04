import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

const fixture = vi.hoisted(() => ({
  actor: { shopId: "shop-one", actorId: "staff-one", role: "ADMIN" },
  shop: { domain: "skyra-booking-dev.myshopify.com" },
  transaction: vi.fn(),
  findPass: vi.fn(),
  updatePass: vi.fn(),
  findMembership: vi.fn(),
  audit: vi.fn(),
  plans: vi.fn(),
  mappings: vi.fn(),
  purchases: vi.fn(),
  purchaseCount: vi.fn(),
  receipts: vi.fn(),
  receiptCount: vi.fn(),
  profiles: vi.fn(),
  capabilities: vi.fn(),
  setup: vi.fn(),
}));
vi.mock("../app/services/membership-plan-setup.server", () => ({
  configureMonthlyPlan: fixture.setup,
}));
vi.mock("../app/services/context.server", () => ({
  adminContext: async () => ({
    actor: fixture.actor,
    shop: fixture.shop,
    admin: { graphql: vi.fn() },
  }),
}));
vi.mock("../app/db.server", () => ({
  default: {
    $transaction: fixture.transaction,
    passPlan: { findMany: fixture.plans },
    productMapping: { findMany: fixture.mappings },
    passPurchase: { findMany: fixture.purchases, count: fixture.purchaseCount },
    membershipReceipt: {
      findMany: fixture.receipts,
      count: fixture.receiptCount,
    },
    customerProfile: { findMany: fixture.profiles },
  },
}));
vi.mock("../app/services/catalog.server", () => ({
  lockShop: vi.fn(),
  audit: fixture.audit,
}));
vi.mock("../app/services/membership-capabilities.server", () => ({
  membershipCapabilities: fixture.capabilities,
}));

import { action, loader } from "../app/routes/app.memberships";

const updatedAt = new Date("2026-10-02T01:00:00Z");
const pass = {
  id: "11111111-1111-4111-8111-111111111111",
  shopId: "shop-one",
  version: 3,
  updatedAt,
  status: "ACTIVE",
  saleable: true,
  requestedPriceCents: 29900,
  validityMonths: 1,
  introOnly: false,
  sellingPlanGid: "gid://shopify/SellingPlan/3",
  sellingPlanGroupGid: "gid://shopify/SellingPlanGroup/2",
  renewalSetupState: "READY",
  standalonePurchaseEnabled: false,
  autoRenewEnabled: false,
};
function save(override: Record<string, string> = {}) {
  const body = new URLSearchParams({
    intent: "save-config",
    id: pass.id,
    version: "3",
    updatedAt: updatedAt.toISOString(),
    standalonePurchaseEnabled: "on",
    autoRenewEnabled: "on",
    sellingPlanGid: "gid://shopify/SellingPlan/3",
    ...override,
  });
  return action({
    request: new Request("https://app.example/app/memberships", {
      method: "POST",
      body,
    }),
    params: {},
    context: {},
  } as ActionFunctionArgs);
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of [
    "SKYRA_MAIL_PROVIDER",
    "RESEND_API_KEY",
    "SKYRA_MAIL_FROM",
    "SKYRA_MAIL_ENABLED",
    "SKYRA_MEMBERSHIP_MAIL_ENABLED",
    "SKYRA_BOOKING_MAIL_SHOP",
    "SKYRA_MAIL_TEST_RECIPIENT",
  ])
    vi.stubEnv(key, "");
  fixture.actor.role = "ADMIN";
  fixture.shop.domain = "skyra-booking-dev.myshopify.com";
  fixture.plans.mockResolvedValue([]);
  fixture.mappings.mockResolvedValue([]);
  fixture.purchases.mockResolvedValue([]);
  fixture.purchaseCount.mockResolvedValue(0);
  fixture.receipts.mockResolvedValue([]);
  fixture.receiptCount.mockResolvedValue(0);
  fixture.profiles.mockResolvedValue([]);
  fixture.capabilities.mockReturnValue({
    checkoutAvailable: true,
    autoRenewAvailable: true,
    checkoutGuardReady: true,
  });
  fixture.findPass.mockResolvedValue(pass);
  fixture.findMembership.mockResolvedValue(null);
  fixture.updatePass.mockResolvedValue({ count: 1 });
  fixture.transaction.mockImplementation((fn) =>
    fn({
      passPlan: { findFirst: fixture.findPass, updateMany: fixture.updatePass },
      passMembership: { findFirst: fixture.findMembership },
    }),
  );
});
afterEach(() => vi.unstubAllEnvs());

function open() {
  return loader({
    request: new Request("https://app.example/app/memberships"),
    params: {},
    context: {},
  } as LoaderFunctionArgs);
}

function retainNotification(
  status = "PENDING",
  deliveryStatus: string | null = null,
) {
  fixture.receiptCount.mockResolvedValue(1);
  fixture.receipts.mockResolvedValue([
    {
      id: "receipt-one",
      purchaseId: "purchase-one",
      customerId: "customer-one",
      passName: "Original monthly pass",
      cycle: 2,
      priceCents: 29900,
      currency: "AUD",
      issuedAt: updatedAt,
      sourceOrderGid: "gid://shopify/Order/55",
      notification: {
        id: "notification-one",
        status,
        subject: "Pass renewal confirmed: Original monthly pass",
        bodyText: "Your payment of AUD 299.00 is confirmed. Period 2.",
        recipientEmail: status === "PENDING" ? null : "customer@example.test",
        providerMessageId: status === "ACCEPTED" ? "provider-one" : null,
        acceptedAt: status === "ACCEPTED" ? updatedAt : null,
        deliveryStatus,
        deliveryError: null,
        lastError: null,
      },
    },
  ]);
}

function configureMail() {
  vi.stubEnv("SKYRA_MAIL_PROVIDER", "resend");
  vi.stubEnv("RESEND_API_KEY", "unit-test-provider-key");
  vi.stubEnv("SKYRA_MAIL_FROM", "studio@example.test");
  vi.stubEnv("SKYRA_MAIL_ENABLED", "true");
  vi.stubEnv("SKYRA_MEMBERSHIP_MAIL_ENABLED", "true");
  vi.stubEnv("SKYRA_BOOKING_MAIL_SHOP", fixture.shop.domain);
  vi.stubEnv("SKYRA_MAIL_TEST_RECIPIENT", "customer@example.test");
}

test("without a mail provider the admin retains payment history and exposes no sending or delivery claim", async () => {
  retainNotification();
  const data = await open();
  expect(data.mail).toEqual({
    state: "NOT_CONFIGURED",
    label: "App payment emails not configured",
  });
  expect(data.capabilities).toMatchObject({
    checkoutAvailable: true,
    autoRenewAvailable: true,
  });
  expect(data.receipts[0]).toMatchObject({
    priceCents: 29900,
    currency: "AUD",
    cycle: 2,
    orderUrl: "https://skyra-booking-dev.myshopify.com/admin/orders/55",
    notification: {
      status: "PENDING",
      statusLabel: "Not sent (email service not configured)",
      providerMessageId: null,
      acceptedAt: null,
      deliveryStatus: null,
      bodyText: "Your payment of AUD 299.00 is confirmed. Period 2.",
    },
  });
  expect(fixture.receipts).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { shopId: fixture.actor.shopId },
    }),
  );
  expect(fixture.transaction).not.toHaveBeenCalled();
});

test.each([
  ["SKYRA_MAIL_PROVIDER", "other-provider"],
  ["RESEND_API_KEY", ""],
  ["SKYRA_MAIL_FROM", "invalid-email"],
])(
  "incomplete provider configuration (%s) does not show mail as ready",
  async (key, value) => {
    configureMail();
    vi.stubEnv(key, value);
    expect((await open()).mail.state).toBe("NOT_CONFIGURED");
  },
);

test.each(["SKYRA_MAIL_ENABLED", "SKYRA_MEMBERSHIP_MAIL_ENABLED"])(
  "configured provider with %s disabled remains unsent",
  async (key) => {
    configureMail();
    vi.stubEnv(key, "false");
    retainNotification();
    const data = await open();
    expect(data.mail.state).toBe("DISABLED");
    expect(data.receipts[0].notification?.statusLabel).toBe(
      "Not sent (app email sending disabled)",
    );
  },
);

test("mail configuration for another shop does not enable this shop", async () => {
  configureMail();
  vi.stubEnv("SKYRA_BOOKING_MAIL_SHOP", "mf0n6s-zg.myshopify.com");
  expect((await open()).mail.state).toBe("SHOP_DISABLED");
});

test.each(["", "invalid-email"])(
  "development mail requires a valid test recipient",
  async (recipient) => {
    configureMail();
    vi.stubEnv("SKYRA_MAIL_TEST_RECIPIENT", recipient);
    expect((await open()).mail.state).toBe("TEST_RECIPIENT_REQUIRED");
  },
);

test("ready configuration exposes no API key, sender or recipient in mail availability", async () => {
  configureMail();
  retainNotification();
  const data = await open();
  expect(data.mail).toEqual({
    state: "READY",
    label: "App payment emails configured for sending",
  });
  expect(data.receipts[0].notification?.statusLabel).toBe(
    "Queued for app email",
  );
  expect(JSON.stringify(data)).not.toContain("unit-test-provider-key");
  expect(JSON.stringify(data.mail)).not.toContain("studio@example.test");
  expect(JSON.stringify(data.mail)).not.toContain("customer@example.test");
});

test("accepted mail remains historical provider acceptance when the provider is later unconfigured", async () => {
  retainNotification("ACCEPTED");
  const data = await open();
  expect(data.mail.state).toBe("NOT_CONFIGURED");
  expect(data.receipts[0].notification).toMatchObject({
    status: "ACCEPTED",
    statusLabel: "Accepted by provider (delivery unverified)",
    acceptedAt: updatedAt.toISOString(),
    deliveryStatus: null,
  });
});

test("unknown mail outcomes are not relabeled as safely unsent or reset for sending", async () => {
  retainNotification("UNKNOWN");
  const data = await open();
  expect(data.receipts[0].notification).toMatchObject({
    status: "UNKNOWN",
    statusLabel: "Send outcome unknown (do not resend)",
    deliveryStatus: null,
  });
  expect(fixture.transaction).not.toHaveBeenCalled();
});

test("mail history is unavailable to coaches before customer data lookup", async () => {
  fixture.actor.role = "COACH";
  await expect(open()).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(fixture.receipts).not.toHaveBeenCalled();
});

test("operations staff cannot change membership billing configuration", async () => {
  fixture.actor.role = "OPERATIONS";
  await expect(save()).rejects.toMatchObject({ status: 403 });
  expect(fixture.transaction).not.toHaveBeenCalled();
});

test("configuration lookup is scoped to the authenticated shop", async () => {
  fixture.findPass.mockResolvedValue(null);
  await expect(save()).resolves.toMatchObject({ code: "NOT_FOUND" });
  expect(fixture.findPass).toHaveBeenCalledWith({
    where: { id: pass.id, shopId: fixture.actor.shopId },
  });
  expect(fixture.updatePass).not.toHaveBeenCalled();
});

test.each([
  { version: 4, updatedAt },
  { version: 3, updatedAt: new Date("2026-10-02T02:00:00Z") },
])(
  "concurrent catalogue or configuration edit requires refresh",
  async (change) => {
    fixture.findPass.mockResolvedValue({ ...pass, ...change });
    await expect(save()).resolves.toMatchObject({ code: "CONFLICT" });
    expect(fixture.updatePass).not.toHaveBeenCalled();
  },
);

test.each([
  { introOnly: true },
  { validityMonths: 3 },
  { status: "DRAFT" },
  { saleable: false },
])("cannot enable renewal on an ineligible Pass (%j)", async (change) => {
  fixture.findPass.mockResolvedValue({ ...pass, ...change });
  await expect(save()).resolves.toHaveProperty("error");
  expect(fixture.updatePass).not.toHaveBeenCalled();
});

test("browser cannot replace a server assigned selling plan", async () => {
  fixture.findMembership.mockResolvedValue({ id: "existing-membership" });
  await expect(
    save({ sellingPlanGid: "gid://shopify/SellingPlan/99" }),
  ).resolves.toMatchObject({ code: "SELLING_PLAN_READ_ONLY" });
  expect(fixture.updatePass).not.toHaveBeenCalled();
});

test("valid save records only per-plan settings and an audit, preserving catalogue version", async () => {
  await expect(save()).resolves.toHaveProperty("message");
  expect(fixture.updatePass).toHaveBeenCalledWith({
    where: { id: pass.id, shopId: fixture.actor.shopId, version: 3, updatedAt },
    data: {
      standalonePurchaseEnabled: true,
      autoRenewEnabled: true,
    },
  });
  expect(fixture.audit).toHaveBeenCalledTimes(1);
});

test("unverified plan cannot be enabled even with a pasted ID", async () => {
  fixture.findPass.mockResolvedValue({
    ...pass,
    renewalSetupState: "VERIFYING",
  });
  await expect(save()).resolves.toMatchObject({ code: "INVALID_RENEWAL_PLAN" });
  expect(fixture.updatePass).not.toHaveBeenCalled();
});

test("admin setup uses the authenticated actor and Shopify client", async () => {
  await expect(save({ intent: "configure-renewal" })).resolves.toHaveProperty(
    "message",
  );
  expect(fixture.setup).toHaveBeenCalledWith(
    fixture.actor,
    expect.objectContaining({ id: pass.id }),
    expect.any(Function),
    fixture.shop.domain,
  );
});

test("operations cannot create renewal plans", async () => {
  fixture.actor.role = "OPERATIONS";
  await expect(save({ intent: "configure-renewal" })).rejects.toMatchObject({
    status: 403,
  });
  expect(fixture.setup).not.toHaveBeenCalled();
});

test("raced update cannot falsely report a saved configuration", async () => {
  fixture.updatePass.mockResolvedValue({ count: 0 });
  await expect(save()).resolves.toMatchObject({ code: "CONFLICT" });
  expect(fixture.audit).not.toHaveBeenCalled();
});
