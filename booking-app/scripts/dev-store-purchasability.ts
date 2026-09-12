import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";
import db from "../app/db.server";
import { checkCatalogPurchase } from "../app/services/shopify-purchasability.server";
import { authenticatedStorefrontClient } from "../app/services/storefront-access.server";
import type { GraphQL } from "../app/services/shopify-catalog.server";
import { unauthenticated } from "../app/shopify.server";
import { restoreCatalogOwnership } from "../app/services/catalog-ownership.server";
import { refreshOfflineScopes } from "../app/services/offline-scopes.server";

// Read-only by default. Explicit one-mapping recovery only fills absent ownership.
// Never syncs products, publishes channels, creates carts or changes booking flags.
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(false);
const domain = process.argv[2];
if (domain !== "skyra-booking-dev.myshopify.com")
  throw new Error(
    "Pass the explicit skyra-booking-dev.myshopify.com development store.",
  );
try {
  const shop = await db.shop.findUniqueOrThrow({ where: { domain } });
  // The official SDK refreshes expiring offline sessions through the existing session storage.
  const { admin, session } = await unauthenticated.admin(domain);
  if (process.argv.includes("--refresh-session-scopes")) {
    const updated = await refreshOfflineScopes(
      domain,
      process.env.SHOPIFY_API_KEY || "",
      session,
      admin.graphql,
    );
    console.log(
      JSON.stringify({ source: "offline-scope-refresh", ...updated }),
    );
  }
  if (process.argv.includes("--diagnostics")) {
    const response = await admin.graphql(
      'query BookingAppIdentity {\n currentAppInstallation { id app { id apiKey title } accessScopes { handle } }\n ownerDefinitions: metafieldDefinitions(first: 20, ownerType: PRODUCT, key: "booking_owner_id") {\n  nodes { namespace key }\n }\n kindDefinitions: metafieldDefinitions(first: 20, ownerType: PRODUCT, key: "entitlement_kind") {\n  nodes { namespace key }\n }\n}',
    );
    const identity = await response.clone().json();
    const exactResponse = await admin.graphql(
      'query BookingExactDefinitions {\n ownerDefinition: metafieldDefinition(identifier: {ownerType: PRODUCT, namespace: "$app", key: "booking_owner_id"}) { id namespace key type {name} }\n kindDefinition: metafieldDefinition(identifier: {ownerType: PRODUCT, namespace: "$app", key: "entitlement_kind"}) { id namespace key type {name} }\n}',
    );
    const exactDefinitions = await exactResponse.clone().json();
    console.log(
      JSON.stringify({
        source: "exact-definitions",
        data: exactDefinitions.data,
        errors: exactDefinitions.errors || [],
      }),
    );
    console.log(
      JSON.stringify({
        source: "app-identity",
        data: identity.data,
        errors: identity.errors || [],
      }),
    );
  }
  const mappings = await db.productMapping.findMany({
    where: { shopId: shop.id },
    orderBy: { ownerType: "asc" },
  });
  const restoreArgument = process.argv.find((argument) =>
    argument.startsWith("--restore-ownership="),
  );
  if (restoreArgument) {
    const mappingId = restoreArgument.slice("--restore-ownership=".length);
    if (!mappings.some((mapping) => mapping.id === mappingId))
      throw new Error(
        "Choose an existing mapping from this development store.",
      );
    const staff = await db.staffAccount.findFirstOrThrow({
      where: { shopId: shop.id, role: "ADMIN", status: "ACTIVE" },
    });
    const restored = await restoreCatalogOwnership(
      { shopId: shop.id, actorId: staff.id, role: "ADMIN" },
      mappingId,
      process.env.SHOPIFY_API_KEY || "",
      admin.graphql,
    );
    console.log(
      JSON.stringify({ source: "ownership-restoration", ...restored }),
    );
  }
  const results = [];
  const diagnose =
    (source: string, client: GraphQL): GraphQL =>
    async (query, options) => {
      const response = await client(query, options);
      if (process.argv.includes("--diagnostics")) {
        const payload = await response
          .clone()
          .json()
          .catch(() => ({}));
        console.log(
          JSON.stringify({
            source,
            status: response.status,
            errors: payload.errors || [],
            data: payload.data,
          }),
        );
      }
      return response;
    };
  for (const mapping of mappings) {
    if (process.argv.includes("--diagnostics") && mapping.productGid) {
      const response = await admin.graphql(
        "query BookingOwnershipDiagnostic($id: ID!) { product(id: $id) { id metafields(first: 20) { nodes { namespace key jsonValue } } } }",
        { variables: { id: mapping.productGid } },
      );
      const payload = await response.clone().json();
      const fields = payload.data?.product?.metafields?.nodes?.filter(
        (field: { key: string }) =>
          ["booking_owner_id", "entitlement_kind"].includes(field.key),
      );
      console.log(
        JSON.stringify({
          source: "ownership",
          productGid: mapping.productGid,
          fields,
          errors: payload.errors || [],
        }),
      );
    }
    results.push(
      await checkCatalogPurchase(
        { shopId: shop.id, actorId: "local-development-check", role: "ADMIN" },
        mapping.id,
        {
          admin: diagnose("admin", admin.graphql),
          storefront: diagnose(
            "storefront",
            authenticatedStorefrontClient(domain, unauthenticated.storefront),
          ),
        },
      ),
    );
  }
  console.log(
    JSON.stringify(
      {
        domain,
        readOnly:
          !restoreArgument &&
          !process.argv.includes("--refresh-session-scopes"),
        results,
      },
      null,
      2,
    ),
  );
  if (!results.length || results.some((result) => !result.ready))
    process.exitCode = 2;
} finally {
  await db.$disconnect();
}
