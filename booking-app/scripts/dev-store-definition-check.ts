import "dotenv/config";

import db from "../app/db.server";

const shopDomain = process.argv[2];

if (!shopDomain || !shopDomain.endsWith("-dev.myshopify.com")) {
  throw new Error(
    "This diagnostic only accepts an explicit *-dev.myshopify.com store.",
  );
}

const session = await db.session.findFirstOrThrow({
  where: { shop: shopDomain, isOnline: false },
  orderBy: { expires: "desc" },
});

const response = await fetch(
  `https://${shopDomain}/admin/api/2026-07/graphql.json`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({
      query: `#graphql
        query BookingMetaobjectDefinitions {
          metaobjectDefinitions(first: 50) {
            nodes { id type name }
          }
        }
      `,
    }),
  },
);

const result = await response.json();
if (!response.ok || result.errors?.length) {
  throw new Error(
    `Metaobject definition query failed: ${JSON.stringify(result.errors ?? response.status)}`,
  );
}

const definitions = result.data.metaobjectDefinitions.nodes.filter(
  (definition: { name: string; type: string }) =>
    definition.name.toLowerCase().includes("booking") ||
    definition.type.toLowerCase().includes("service"),
);

console.log(JSON.stringify({ shop: shopDomain, definitions }, null, 2));
await db.$disconnect();