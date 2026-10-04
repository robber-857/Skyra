import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from "vitest";
import db from "../app/db.server";
import {
  deliverMembershipNotification,
  membershipManagementUrl,
  retainPaidMembershipReceipt,
  sweepMembershipNotifications,
  syncMembershipMailDeliveryStatus,
} from "../app/services/membership-notifications.server";
import { DEVELOPMENT_BOOKING_SHOP } from "../app/services/commerce-capabilities.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Tests require skyra_booking_test.");
});
beforeEach(() => {
  vi.stubEnv("SKYRA_MEMBERSHIP_MAIL_ENABLED", "true");
  vi.stubEnv("SKYRA_BOOKING_MAIL_SHOP", DEVELOPMENT_BOOKING_SHOP);
  vi.stubEnv("SKYRA_MAIL_ENABLED", "true");
  vi.stubEnv("SKYRA_MAIL_PROVIDER", "resend");
  vi.stubEnv("SKYRA_MAIL_FROM", "sender@example.test");
  vi.stubEnv("SKYRA_MAIL_TEST_RECIPIENT", "customer@example.test");
  vi.stubEnv("RESEND_API_KEY", "fake-not-used-key");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.$disconnect());

let counter = 0;
async function fixture(cycle = 1, status = "PAID", months: number | null = 1) {
  const serial = String(BigInt(Date.now()) * 1000n + BigInt(counter++));
  const shop = await db.shop.upsert({
    where: { domain: DEVELOPMENT_BOOKING_SHOP },
    create: { domain: DEVELOPMENT_BOOKING_SHOP },
    update: { status: "ACTIVE" },
  });
  const customer = await db.customerProfile.create({
    data: {
      shopId: shop.id,
      shopifyCustomerGid: `gid://shopify/Customer/${serial}`,
    },
  });
  const plan = await db.passPlan.create({
    data: {
      shopId: shop.id,
      name: "Monthly Pass",
      credits: 12,
      validityDays: 31,
      validityMonths: months,
      requestedPriceCents: 29900,
      status: "ACTIVE",
    },
  });
  const mapping = await db.productMapping.create({
    data: {
      shopId: shop.id,
      ownerType: "PASS_PLAN",
      ownerId: plan.id,
      productGid: `gid://shopify/Product/${serial}`,
      variantGid: `gid://shopify/ProductVariant/${serial}`,
    },
  });
  const membership = await db.passMembership.create({
    data: {
      shopId: shop.id,
      customerId: customer.id,
      passPlanId: plan.id,
      currentCycle: cycle,
    },
  });
  const purchase = await db.passPurchase.create({
    data: {
      shopId: shop.id,
      membershipId: membership.id,
      cycle,
      mode: months === 1 ? "AUTO_RENEW" : "ONCE",
      status,
      reference: randomUUID(),
      idempotencyKey: randomUUID(),
      productMappingId: mapping.id,
      productGid: mapping.productGid!,
      variantGid: mapping.variantGid!,
      priceCents: 29900,
      currency: "AUD",
      credits: 12,
      validityDays: 31,
      validityMonths: months,
      timezone: "Australia/Sydney",
      termsVersion: "2026-10-test",
      sourceOrderGid:
        status === "PAID" ? `gid://shopify/Order/${serial}` : null,
      sourceLineItemGid:
        status === "PAID" ? `gid://shopify/LineItem/${serial}` : null,
    },
  });
  return { shop, customer, plan, membership, purchase };
}
const retained = (purchaseId: string, paidAt?: Date) =>
  db.$transaction((tx) => retainPaidMembershipReceipt(tx, purchaseId, paidAt));
async function alreadyDueNotification(purchaseId: string) {
  const result = await retained(purchaseId);
  // These cases test send ownership/outcomes, not the scheduling boundary.
  // Use the retained database clock so host clock drift cannot delay the job.
  await db.membershipNotification.update({
    where: { id: result.notification.id },
    data: {
      availableAt: new Date(result.receipt.issuedAt.getTime() - 1000),
    },
  });
  return result;
}
const resolver = () => vi.fn(async () => "customer@example.test");
const acceptedSend = () =>
  vi.fn(async () => ({
    status: "ACCEPTED" as const,
    messageId: `message-${randomUUID()}`,
  }));

test("concurrent receipt retries retain one financial snapshot and one notification", async () => {
  const f = await fixture(2);
  const result = await Promise.all([
    retained(f.purchase.id),
    retained(f.purchase.id),
    retained(f.purchase.id),
  ]);
  expect(new Set(result.map((r) => r.receipt.id)).size).toBe(1);
  expect(new Set(result.map((r) => r.notification.id)).size).toBe(1);
  expect(
    await db.membershipReceipt.count({ where: { purchaseId: f.purchase.id } }),
  ).toBe(1);
  expect(
    await db.membershipNotification.count({
      where: { purchaseId: f.purchase.id },
    }),
  ).toBe(1);
  expect(result[0].receipt).toMatchObject({
    priceCents: 29900,
    currency: "AUD",
    credits: 12,
    cycle: 2,
    sourceOrderGid: f.purchase.sourceOrderGid,
    paidAt: null,
  });
  expect(result[0].receipt.issuedAt).toBeInstanceOf(Date);
});

test("receipt and email stay unchanged after editable Pass details change", async () => {
  const f = await fixture();
  const paidAt = new Date("2026-10-03T02:00:00Z");
  const first = await retained(f.purchase.id, paidAt);
  await db.passPlan.update({
    where: { id: f.plan.id },
    data: { name: "Different Pass", requestedPriceCents: 99900, credits: 99 },
  });
  const again = await retained(f.purchase.id, paidAt);
  expect(again).toEqual(first);
  expect(again.notification.bodyText).toContain("AUD 299.00");
  expect(again.notification.bodyText).not.toContain("Different Pass");
  expect(again.receipt.paidAt).toEqual(paidAt);
  await expect(
    db.membershipReceipt.update({
      where: { id: first.receipt.id },
      data: { priceCents: 100 },
    }),
  ).rejects.toThrow();
});

test.each(["FAILED", "UNKNOWN", "ACTION_REQUIRED", "REVIEW", "CHECKOUT_READY"])(
  "%s payment cannot create paid receipt or email",
  async (status) => {
    const f = await fixture(2, status);
    await expect(retained(f.purchase.id)).rejects.toMatchObject({
      code: "RECEIPT_PAYMENT_UNVERIFIED",
    });
    expect(
      await db.membershipReceipt.count({
        where: { purchaseId: f.purchase.id },
      }),
    ).toBe(0);
    expect(
      await db.membershipNotification.count({
        where: { purchaseId: f.purchase.id },
      }),
    ).toBe(0);
  },
);

test("receipt and mail outbox roll back with the caller payment transaction", async () => {
  const f = await fixture();
  await expect(
    db.$transaction(async (tx) => {
      await retainPaidMembershipReceipt(tx, f.purchase.id);
      throw new Error("settlement rolled back");
    }),
  ).rejects.toThrow("settlement rolled back");
  expect(
    await db.membershipReceipt.count({ where: { purchaseId: f.purchase.id } }),
  ).toBe(0);
  expect(
    await db.membershipNotification.count({
      where: { purchaseId: f.purchase.id },
    }),
  ).toBe(0);
});

test("renewal content states agreed amount, first attendance and safe management URL", async () => {
  const f = await fixture(2);
  const { notification } = await retained(f.purchase.id);
  expect(notification.subject).toContain("Pass renewal confirmed");
  expect(notification.bodyText).toContain("AUD 299.00");
  expect(notification.bodyText).toContain(
    "first attended class in this period",
  );
  expect(notification.bodyText).toContain(
    "No further renewal is charged while",
  );
  expect(notification.bodyText).toContain(
    `https://${DEVELOPMENT_BOOKING_SHOP}/pages/membership#membership-options`,
  );
  expect(notification.bodyText).toContain("not a tax invoice");
  expect(membershipManagementUrl("evil.example/redirect")).toBeNull();
});

test("other one-time Pass receipt preserves first-booking activation text", async () => {
  const f = await fixture(1, "PAID", 2);
  const { notification } = await retained(f.purchase.id);
  expect(notification.bodyText).toContain("first booked class");
  expect(notification.bodyText).not.toContain("first attended class");
  expect(notification.bodyText).not.toContain("No further renewal");
});

test("duplicate mail workers claim one send and retain recipient, content and provider ID", async () => {
  const f = await fixture(2);
  const { notification } = await alreadyDueNotification(f.purchase.id);
  const send = acceptedSend();
  const resolve = resolver();
  await Promise.all([
    deliverMembershipNotification(notification.id, send, resolve),
    deliverMembershipNotification(notification.id, send, resolve),
  ]);
  await deliverMembershipNotification(notification.id, send, resolve);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith({
    to: "customer@example.test",
    subject: notification.subject,
    text: notification.bodyText,
    idempotencyKey: notification.idempotencyKey,
  });
  expect(
    await db.membershipNotification.findUnique({
      where: { id: notification.id },
    }),
  ).toMatchObject({
    status: "ACCEPTED",
    attempts: 1,
    recipientEmail: "customer@example.test",
    providerMessageId:
      send.mock.results[0] && (await send.mock.results[0].value).messageId,
    deliveryStatus: null,
  });
});

test.each(["UNKNOWN", "FAILED"] as const)(
  "%s provider outcome never automatically sends another email or key",
  async (status) => {
    const f = await fixture();
    const { notification } = await alreadyDueNotification(f.purchase.id);
    const send = vi.fn(async () => ({ status }));
    await deliverMembershipNotification(notification.id, send, resolver());
    await deliverMembershipNotification(notification.id, send, resolver());
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await db.membershipNotification.findUnique({
        where: { id: notification.id },
      }),
    ).toMatchObject({
      status,
      attempts: 1,
      idempotencyKey: notification.idempotencyKey,
    });
  },
);

test("provider exception is ambiguous and does not reset the durable send claim", async () => {
  const f = await fixture();
  const { notification } = await alreadyDueNotification(f.purchase.id);
  const send = vi.fn(async () => {
    throw new Error("timeout");
  });
  await deliverMembershipNotification(notification.id, send, resolver());
  await deliverMembershipNotification(notification.id, send, resolver());
  expect(send).toHaveBeenCalledTimes(1);
  expect(
    await db.membershipNotification.findUnique({
      where: { id: notification.id },
    }),
  ).toMatchObject({
    status: "UNKNOWN",
    lastError: "DELIVERY_OUTCOME_UNKNOWN",
    attempts: 1,
  });
});

test("mail default-off gate and dev allowlist prevent provider calls", async () => {
  const f = await fixture();
  const { notification } = await retained(f.purchase.id);
  const send = acceptedSend();
  const resolve = resolver();
  vi.stubEnv("SKYRA_MEMBERSHIP_MAIL_ENABLED", "");
  await deliverMembershipNotification(notification.id, send, resolve);
  vi.stubEnv("SKYRA_MEMBERSHIP_MAIL_ENABLED", "true");
  vi.stubEnv("SKYRA_MAIL_TEST_RECIPIENT", "");
  await deliverMembershipNotification(notification.id, send, resolve);
  expect(send).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
  expect(
    await db.membershipNotification.findUnique({
      where: { id: notification.id },
    }),
  ).toMatchObject({ status: "PENDING", attempts: 0 });
});

test("recipient restriction retains queued content but does not claim or send", async () => {
  const f = await fixture();
  const { notification } = await retained(f.purchase.id);
  const send = acceptedSend();
  await deliverMembershipNotification(
    notification.id,
    send,
    vi.fn(async () => "other@example.test"),
  );
  expect(send).not.toHaveBeenCalled();
  expect(
    await db.membershipNotification.findUnique({
      where: { id: notification.id },
    }),
  ).toMatchObject({
    status: "PENDING",
    attempts: 0,
    lastError: "RECIPIENT_NOT_ALLOWED",
    recipientEmail: null,
  });
});

test("crashed stale send is parked UNKNOWN by sweep and never resubmitted", async () => {
  const f = await fixture();
  const { notification } = await retained(f.purchase.id);
  await db.membershipNotification.update({
    where: { id: notification.id },
    data: {
      status: "SENDING",
      claimedAt: new Date(Date.now() - 11 * 60000),
      recipientEmail: "customer@example.test",
      attempts: 1,
    },
  });
  const send = acceptedSend();
  // Hide other test jobs: this sweep should only inspect this shop's stale send.
  const originalPending = await db.membershipNotification.findMany({
    where: { shopId: f.shop.id, status: "PENDING" },
    select: { id: true, availableAt: true },
  });
  const future = new Date(Date.now() + 86400000);
  await db.membershipNotification.updateMany({
    where: { id: { in: originalPending.map((j) => j.id) } },
    data: { availableAt: future },
  });
  try {
    await sweepMembershipNotifications(send, resolver());
    expect(send).not.toHaveBeenCalled();
    expect(
      await db.membershipNotification.findUnique({
        where: { id: notification.id },
      }),
    ).toMatchObject({ status: "UNKNOWN", attempts: 1 });
  } finally {
    for (const job of originalPending)
      await db.membershipNotification.update({
        where: { id: job.id },
        data: { availableAt: job.availableAt },
      });
  }
});

test("provider delivery check retains delivered separately from accepted and is shop-scoped", async () => {
  const f = await fixture();
  const { notification } = await retained(f.purchase.id);
  await db.membershipNotification.update({
    where: { id: notification.id },
    data: { status: "ACCEPTED", providerMessageId: "provider-test-id" },
  });
  const read = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ id: "provider-test-id", last_event: "delivered" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  await expect(
    syncMembershipMailDeliveryStatus(randomUUID(), notification.id, read),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(read).not.toHaveBeenCalled();
  await syncMembershipMailDeliveryStatus(f.shop.id, notification.id, read);
  await syncMembershipMailDeliveryStatus(f.shop.id, notification.id, read);
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    await db.membershipNotification.findUnique({
      where: { id: notification.id },
    }),
  ).toMatchObject({
    status: "ACCEPTED",
    deliveryStatus: "delivered",
    deliveryError: null,
  });
});
