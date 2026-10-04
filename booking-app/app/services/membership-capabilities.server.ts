import {
  commerceCapabilities,
  isDevelopmentBookingShop,
  isProductionBookingShop,
} from "./commerce-capabilities.server";

export const AUTO_RENEW_TERMS_VERSION = "2026-10-02.v1";
export function membershipCapabilities(domain: string) {
  const enabled = (name: string) => process.env[name] === "true";
  const development = isDevelopmentBookingShop(domain);
  const target = development || isProductionBookingShop(domain);
  const checkoutAvailable =
    target &&
    commerceCapabilities(domain).checkoutAvailable &&
    enabled(
      development
        ? "SKYRA_MEMBERSHIPS_TEST_ENABLED"
        : "SKYRA_MEMBERSHIPS_ENABLED",
    );
  // A database lock cannot invalidate an already-open Shopify Checkout.
  // Real billing must remain off until all storefront payment paths are verified.
  const checkoutGuardReady =
    enabled("SKYRA_MEMBERSHIPS_CHECKOUT_GUARD_READY") &&
    enabled("SKYRA_MEMBERSHIPS_CHECKOUT_EXCLUSION_VERIFIED");
  const autoRenewAvailable =
    checkoutAvailable &&
    enabled("SKYRA_MEMBERSHIPS_SUBSCRIPTIONS_READY") &&
    checkoutGuardReady;
  return {
    checkoutAvailable,
    checkoutGuardReady,
    autoRenewAvailable,
    reason: autoRenewAvailable
      ? undefined
      : "Automatic renewal is not available yet.",
  };
}
