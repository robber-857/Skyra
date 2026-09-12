import { DomainError } from "../lib/errors.server";
import type { GraphQL } from "./shopify-catalog.server";

export const STOREFRONT_PRODUCT_SCOPE = "unauthenticated_read_product_listings";
type StorefrontContext = {
  session: { shop: string; isOnline: boolean; scope?: string };
  storefront: { graphql: GraphQL };
};

// Only after Admin/App Proxy authentication, with the database-owned shop domain.
// The official SDK owns token refresh and private transport. Never fall back to
// tokenless access or accept credentials or a shop domain from the browser.
export function authenticatedStorefrontClient(
  domain: string,
  contextForShop: (domain: string) => Promise<StorefrontContext>,
): GraphQL {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain))
    throw new DomainError("INVALID_SHOP", "Invalid Shopify store.", 400);
  return async (query, options) => {
    let context: StorefrontContext;
    try {
      context = await contextForShop(domain);
    } catch {
      throw new DomainError(
        "STOREFRONT_ACCESS_REQUIRED",
        "Reconnect Shopify Storefront access.",
        503,
      );
    }
    if (
      context.session.shop !== domain ||
      context.session.isOnline ||
      !context.session.scope
        ?.split(",")
        .map((scope) => scope.trim())
        .includes(STOREFRONT_PRODUCT_SCOPE)
    )
      throw new DomainError(
        "STOREFRONT_ACCESS_REQUIRED",
        "Approve Shopify Storefront product access.",
        503,
      );
    return context.storefront.graphql(query, options);
  };
}
