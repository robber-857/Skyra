import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import type { GraphQL } from "./shopify-catalog.server";
export const GRANTED_SCOPES_QUERY = `query BookingGrantedScopes {
 shop { myshopifyDomain }
 currentAppInstallation { app { apiKey } accessScopes { handle } }
}`;
const granted = z.object({
  shop: z.object({ myshopifyDomain: z.string() }),
  currentAppInstallation: z.object({
    app: z.object({ apiKey: z.string() }),
    accessScopes: z.array(z.object({ handle: z.string().regex(/^[a-z_]+$/) })),
  }),
});
type OfflineSession = {
  id: string;
  shop: string;
  isOnline: boolean;
  accessToken?: string;
  scope?: string | null;
};

// Explicit maintenance: reconcile only a verified snapshot of this app's own
// offline scope cache. Does not grant Shopify permissions or alter tokens.
export async function refreshOfflineScopes(
  domain: string,
  expectedAppApiKey: string,
  session: OfflineSession,
  graphql: GraphQL,
) {
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain) ||
    !/^[a-f0-9]{32}$/i.test(expectedAppApiKey) ||
    session.shop !== domain ||
    session.isOnline ||
    session.id !== "offline_" + domain ||
    !session.accessToken
  )
    throw new DomainError(
      "INVALID_SESSION",
      "Choose this app's valid offline session.",
      409,
    );
  let body;
  try {
    const response = await graphql(GRANTED_SCOPES_QUERY, { variables: {} });
    const payload = await response.json();
    if (!response.ok || payload.errors?.length) throw new Error();
    body = granted.parse(payload.data);
  } catch {
    throw new DomainError(
      "SHOPIFY_UNAVAILABLE",
      "Could not verify granted Shopify permissions.",
      503,
    );
  }
  if (
    body.shop.myshopifyDomain !== domain ||
    body.currentAppInstallation.app.apiKey !== expectedAppApiKey
  )
    throw new DomainError(
      "APP_IDENTITY_MISMATCH",
      "App or shop identity differs. No session was updated.",
      409,
    );
  const scopes = [
    ...new Set(
      body.currentAppInstallation.accessScopes.map((scope) => scope.handle),
    ),
  ].sort();
  const result = await db.session.updateMany({
    where: {
      id: session.id,
      shop: domain,
      isOnline: false,
      accessToken: session.accessToken,
    },
    data: { scope: scopes.join(",") },
  });
  if (result.count !== 1)
    throw new DomainError(
      "SESSION_CHANGED",
      "The offline session changed. Reconnect and retry.",
      409,
    );
  return { shop: domain, scopes };
}
