import { afterEach, expect, test, vi } from "vitest";
import { exactProductionUatDiscount } from "../app/services/production-uat-discount.server";
import {
  sendTransactionalMail,
  transactionalMailRecipientAllowed,
} from "../app/services/transactional-mail.server";
const shop = "mf0n6s-zg.myshopify.com";
const config = {
  code: "TESTONCE99",
  customerGid: "gid://shopify/Customer/123",
  variantGid: "gid://shopify/ProductVariant/654",
  priceCents: 22000,
  startsAt: "2026-09-22T00:00:00Z",
  endsAt: "2026-09-23T00:00:00Z",
};
const order = {
  purchasedAt: "2026-09-22T12:00:00Z",
  customerGid: config.customerGid,
  subtotalCents: 220,
  finalCents: 220,
  totalDiscountsCents: 21780,
  discountCodes: [
    { code: config.code, amountCents: 21780, type: "percentage" },
  ],
};
const line = { variantGid: config.variantGid, priceCents: 22000 };
const checkout = { priceCents: 22000, hold: { purchaseKind: "NEW_PASS" } };
function enable() {
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_SHOP", shop);
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED", "true");
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED", "true");
  vi.stubEnv("SKYRA_BOOKING_EMERGENCY_STOP", "false");
  vi.stubEnv("SKYRA_BOOKING_UAT_DISCOUNT", JSON.stringify(config));
}
afterEach(() => vi.unstubAllEnvs());
test("exact nonzero UAT payment matches; delayed webhook uses purchase date", () => {
  enable();
  expect(exactProductionUatDiscount(shop, order, line, checkout)).toBe(true);
});
test.each([
  { customerGid: "gid://shopify/Customer/124" },
  { subtotalCents: 0, finalCents: 0 },
  { finalCents: 221 },
  { totalDiscountsCents: 21779 },
  { purchasedAt: null },
  { purchasedAt: "invalid" },
  { purchasedAt: config.endsAt },
  { purchasedAt: "2026-09-21T23:59:59Z" },
  { discountCodes: [] },
  {
    discountCodes: [{ code: "OTHER", amountCents: 21780, type: "percentage" }],
  },
  { discountCodes: [...order.discountCodes, ...order.discountCodes] },
])("rejects changed order %j", (patch) => {
  enable();
  expect(
    exactProductionUatDiscount(shop, { ...order, ...patch }, line, checkout),
  ).toBe(false);
});
test("rejects different shop, variant, checkout price, and drop-in", () => {
  enable();
  expect(
    exactProductionUatDiscount("other.myshopify.com", order, line, checkout),
  ).toBe(false);
  expect(
    exactProductionUatDiscount(
      shop,
      order,
      { ...line, variantGid: "gid://shopify/ProductVariant/655" },
      checkout,
    ),
  ).toBe(false);
  expect(
    exactProductionUatDiscount(shop, order, line, {
      ...checkout,
      priceCents: 22100,
    }),
  ).toBe(false);
  expect(
    exactProductionUatDiscount(shop, order, line, {
      ...checkout,
      hold: { purchaseKind: "DROP_IN" },
    }),
  ).toBe(false);
});
test.each([
  "",
  "{}",
  "broken",
  JSON.stringify({ ...config, endsAt: "2026-09-26T00:00:00Z" }),
])("fails closed for config %s", (raw) => {
  enable();
  vi.stubEnv("SKYRA_BOOKING_UAT_DISCOUNT", raw);
  expect(exactProductionUatDiscount(shop, order, line, checkout)).toBe(false);
});
test("release and emergency gates remain required", () => {
  enable();
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED", "false");
  expect(exactProductionUatDiscount(shop, order, line, checkout)).toBe(false);
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED", "true");
  vi.stubEnv("SKYRA_BOOKING_EMERGENCY_STOP", "true");
  expect(exactProductionUatDiscount(shop, order, line, checkout)).toBe(false);
});
test("sandbox recipient cannot be redirected and blocked sends never reach provider", async () => {
  vi.stubEnv("SKYRA_MAIL_TEST_RECIPIENT", "tester@example.com");
  expect(transactionalMailRecipientAllowed("TESTER@example.com")).toBe(true);
  expect(transactionalMailRecipientAllowed("other@example.com")).toBe(false);
  vi.stubEnv("SKYRA_MAIL_ENABLED", "true");
  vi.stubEnv("SKYRA_MAIL_PROVIDER", "resend");
  vi.stubEnv("SKYRA_MAIL_FROM", "onboarding@resend.dev");
  vi.stubEnv("RESEND_API_KEY", "synthetic-test-key");
  const send = vi.fn();
  expect(
    await sendTransactionalMail(
      {
        to: "other@example.com",
        subject: "test",
        text: "test",
        idempotencyKey: "test",
      },
      send,
    ),
  ).toEqual({ status: "FAILED" });
  expect(send).not.toHaveBeenCalled();
  vi.stubEnv("SKYRA_MAIL_TEST_RECIPIENT", "invalid");
  expect(transactionalMailRecipientAllowed("tester@example.com")).toBe(false);
});

test("owner-adjusted fixed discount requires the exact configured payable amount", () => {
  enable();
  vi.stubEnv(
    "SKYRA_BOOKING_UAT_DISCOUNT",
    JSON.stringify({
      ...config,
      payableCents: 50,
      discountType: "fixed_amount",
    }),
  );
  const adjusted = {
    ...order,
    subtotalCents: 50,
    finalCents: 50,
    totalDiscountsCents: 21950,
    discountCodes: [
      { code: config.code, amountCents: 21950, type: "fixed_amount" },
    ],
  };
  expect(exactProductionUatDiscount(shop, adjusted, line, checkout)).toBe(true);
  expect(exactProductionUatDiscount(shop, order, line, checkout)).toBe(false);
  for (const patch of [
    { finalCents: 49 },
    { subtotalCents: 51 },
    { totalDiscountsCents: 21949 },
    { customerGid: "gid://shopify/Customer/124" },
    { discountCodes: [{ ...adjusted.discountCodes[0], type: "percentage" }] },
  ]) {
    expect(
      exactProductionUatDiscount(
        shop,
        { ...adjusted, ...patch },
        line,
        checkout,
      ),
    ).toBe(false);
  }
});

test.each([0, -1, 0.5, 22000, 22001])(
  "invalid configured payable %s fails closed",
  (payableCents) => {
    enable();
    vi.stubEnv(
      "SKYRA_BOOKING_UAT_DISCOUNT",
      JSON.stringify({ ...config, payableCents }),
    );
    expect(exactProductionUatDiscount(shop, order, line, checkout)).toBe(false);
  },
);
