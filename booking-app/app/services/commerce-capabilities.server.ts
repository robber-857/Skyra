// Development-store release gates. Production stores remain closed even when
// environment variables are accidentally copied to another deployment.
export const DEVELOPMENT_BOOKING_SHOP = "skyra-booking-dev.myshopify.com";

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

export function commerceCapabilities(shopDomain?: string | null) {
  const developmentShop = isDevelopmentBookingShop(shopDomain);
  return {
    checkoutAvailable:
      developmentShop && enabled("SKYRA_BOOKING_CHECKOUT_ENABLED"),
    ownedPassesAvailable:
      developmentShop && enabled("SKYRA_BOOKING_OWNED_PASSES_ENABLED"),
  };
}

export function developmentReleaseReady(shopDomain?: string | null) {
  const capabilities = commerceCapabilities(shopDomain);
  return capabilities.checkoutAvailable && capabilities.ownedPassesAvailable;
}
