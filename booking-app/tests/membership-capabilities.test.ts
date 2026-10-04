import { afterEach, expect, test, vi } from "vitest";
import { membershipCapabilities } from "../app/services/membership-capabilities.server";

afterEach(() => vi.unstubAllEnvs());

test("owner-only Basic checkout UAT never releases other customers or worker billing", () => {
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_SHOP", "mf0n6s-zg.myshopify.com");
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED", "true");
  vi.stubEnv("SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED", "true");
  vi.stubEnv("SKYRA_MEMBERSHIPS_ENABLED", "false");
  vi.stubEnv("SKYRA_MEMBERSHIPS_CHECKOUT_PROTECTION", "INVENTORY");
  vi.stubEnv("SKYRA_MEMBERSHIPS_BILLING_ENABLED", "false");
  vi.stubEnv("SKYRA_MEMBERSHIPS_UAT_CUSTOMER_GID", "gid://shopify/Customer/1");
  vi.stubEnv("SKYRA_MEMBERSHIPS_UAT_PASS_PLAN_ID", "test-pass");
  vi.stubEnv("SKYRA_MEMBERSHIPS_SUBSCRIPTIONS_READY", "true");
  vi.stubEnv("SKYRA_MEMBERSHIPS_CHECKOUT_GUARD_READY", "false");
  vi.stubEnv("SKYRA_MEMBERSHIPS_CHECKOUT_EXCLUSION_VERIFIED", "false");
  vi.stubEnv("SKYRA_BOOKING_EMERGENCY_STOP", "false");
  expect(membershipCapabilities("mf0n6s-zg.myshopify.com", "gid://shopify/Customer/1").autoRenewAvailable).toBe(true);
  expect(membershipCapabilities("mf0n6s-zg.myshopify.com", "gid://shopify/Customer/2").autoRenewAvailable).toBe(false);
  expect(membershipCapabilities("mf0n6s-zg.myshopify.com").autoRenewAvailable).toBe(false);
  vi.stubEnv("SKYRA_MEMBERSHIPS_BILLING_ENABLED", "true");
  expect(membershipCapabilities("mf0n6s-zg.myshopify.com", "gid://shopify/Customer/1").autoRenewAvailable).toBe(false);
});

function testStore() {
  vi.stubEnv("SKYRA_BOOKING_TEST_SHOP", "skyra-booking-dev.myshopify.com");
  vi.stubEnv("SKYRA_BOOKING_CHECKOUT_ENABLED", "true");
  vi.stubEnv("SKYRA_MEMBERSHIPS_TEST_ENABLED", "true");
  vi.stubEnv("SKYRA_MEMBERSHIPS_SUBSCRIPTIONS_READY", "true");
  vi.stubEnv("SKYRA_BOOKING_EMERGENCY_STOP", "false");
}

test.each([
  ["false", "false"],
  ["true", "false"],
  ["false", "true"],
])(
  "the test store also requires both checkout guard and exclusion acceptance (%s/%s)",
  (guard, accepted) => {
    testStore();
    vi.stubEnv("SKYRA_MEMBERSHIPS_CHECKOUT_GUARD_READY", guard);
    vi.stubEnv("SKYRA_MEMBERSHIPS_CHECKOUT_EXCLUSION_VERIFIED", accepted);
    expect(
      membershipCapabilities("skyra-booking-dev.myshopify.com"),
    ).toMatchObject({
      checkoutAvailable: true,
      autoRenewAvailable: false,
      checkoutGuardReady: false,
    });
  },
);

test("emergency stop still prevents charges after checkout acceptance", () => {
  testStore();
  vi.stubEnv("SKYRA_MEMBERSHIPS_CHECKOUT_GUARD_READY", "true");
  vi.stubEnv("SKYRA_MEMBERSHIPS_CHECKOUT_EXCLUSION_VERIFIED", "true");
  expect(
    membershipCapabilities("skyra-booking-dev.myshopify.com")
      .autoRenewAvailable,
  ).toBe(true);
  vi.stubEnv("SKYRA_BOOKING_EMERGENCY_STOP", "true");
  expect(
    membershipCapabilities("skyra-booking-dev.myshopify.com")
      .autoRenewAvailable,
  ).toBe(false);
});
