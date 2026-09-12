import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily } from "node:net";
import db from "../app/db.server";
import {
  checkCatalogPurchase,
  storefrontReadClient,
} from "../app/services/shopify-purchasability.server";
import type { GraphQL } from "../app/services/shopify-catalog.server";
import { unauthenticated } from "../app/shopify.server";

// Read-only diagnostic. No syncing, publishing, carts or capability flag changes.
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
  const { admin } = await unauthenticated.admin(domain);
  const mappings = await db.productMapping.findMany({
    where: { shopId: shop.id },
    orderBy: { ownerType: "asc" },
  });
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
          storefront: diagnose("storefront", storefrontReadClient(domain)),
        },
      ),
    );
  }
  console.log(JSON.stringify({ domain, readOnly: true, results }, null, 2));
  if (!results.length || results.some((result) => !result.ready))
    process.exitCode = 2;
} finally {
  await db.$disconnect();
}
