export const DEVELOPMENT_BOOKING_SHOP = "skyra-booking-dev.myshopify.com";
export const PRODUCTION_BOOKING_SHOP = "mf0n6s-zg.myshopify.com";

function enabled(name: string) {
  return process.env[name]?.trim().toLowerCase() === "true";
}

export function isDevelopmentBookingShop(shopDomain?: string | null) {
  return (
    shopDomain?.trim().toLowerCase() === DEVELOPMENT_BOOKING_SHOP &&
    process.env.SKYRA_BOOKING_TEST_SHOP?.trim().toLowerCase() ===
      DEVELOPMENT_BOOKING_SHOP
  );
}

export function isProductionBookingShop(shopDomain?: string | null) {
  return (
    shopDomain?.trim().toLowerCase() === PRODUCTION_BOOKING_SHOP &&
    process.env.SKYRA_BOOKING_PRODUCTION_SHOP?.trim().toLowerCase() ===
      PRODUCTION_BOOKING_SHOP
  );
}

export function isBookingReleaseTarget(shopDomain?: string | null) {
  return (
    isDevelopmentBookingShop(shopDomain) || isProductionBookingShop(shopDomain)
  );
}

export function commerceCapabilities(shopDomain?: string | null) {
  if (enabled("SKYRA_BOOKING_EMERGENCY_STOP"))
    return { checkoutAvailable: false, ownedPassesAvailable: false };
  const developmentShop = isDevelopmentBookingShop(shopDomain);
  const productionShop =
    isProductionBookingShop(shopDomain) &&
    enabled("SKYRA_BOOKING_PRODUCTION_RELEASE_APPROVED");
  return {
    checkoutAvailable:
      (developmentShop && enabled("SKYRA_BOOKING_CHECKOUT_ENABLED")) ||
      (productionShop && enabled("SKYRA_BOOKING_PRODUCTION_CHECKOUT_ENABLED")),
    ownedPassesAvailable:
      (developmentShop && enabled("SKYRA_BOOKING_OWNED_PASSES_ENABLED")) ||
      (productionShop &&
        enabled("SKYRA_BOOKING_PRODUCTION_OWNED_PASSES_ENABLED")),
  };
}

export function developmentReleaseReady(shopDomain?: string | null) {
  const capabilities = commerceCapabilities(shopDomain);
  return capabilities.checkoutAvailable && capabilities.ownedPassesAvailable;
}

// Preparing production catalogue records must not create directly purchasable
// products before the same explicit release gate that protects Booking checkout.
export function bookingProductStatus(
  shopDomain: string,
  owner: { status: string; saleable?: boolean },
) {
  if (owner.status === "INACTIVE") return "ARCHIVED";
  if (owner.status !== "ACTIVE" || owner.saleable === false) return "DRAFT";
  if (
    shopDomain === PRODUCTION_BOOKING_SHOP &&
    !commerceCapabilities(shopDomain).checkoutAvailable
  )
    return "DRAFT";
  return "ACTIVE";
}
