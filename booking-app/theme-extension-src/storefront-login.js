export function storefrontLoginUrl({ returnPath, expectedPath, shopDomain, themeId }) {
  const safeBase = "https://booking.invalid";
  const requested = new URL(returnPath, safeBase);
  if (requested.origin !== safeBase || requested.pathname !== expectedPath)
    throw new Error("Invalid storefront return path");
  const canonicalShop = typeof shopDomain === "string" && /^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/i.test(shopDomain) ? shopDomain : "";
  const localPreview = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  if (localPreview && !canonicalShop)
    throw new Error("Shopify sign-in is not configured for this preview. Please contact Skyra Studio.");
  const loginOrigin = localPreview ? "https://" + canonicalShop : window.location.origin;
  const destination = new URL(requested.pathname + requested.search + requested.hash, loginOrigin);
  const activePreview = new URL(window.location.href).searchParams.get("preview_theme_id");
  const configuredThemeId = /^\d+$/.test(String(themeId || "")) ? String(themeId) : "";
  const runtimeThemeId = /^\d+$/.test(String(window.Shopify?.theme?.id || "")) ? String(window.Shopify.theme.id) : "";
  const previewThemeId = configuredThemeId || runtimeThemeId;
  if (previewThemeId && (localPreview || activePreview === previewThemeId))
    destination.searchParams.set("preview_theme_id", previewThemeId);
  return loginOrigin + "/customer_authentication/login?return_to=" + encodeURIComponent(destination.pathname + destination.search + destination.hash);
}
