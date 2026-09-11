import "dotenv/config";

import db from "../app/db.server";
import { savePass, saveService } from "../app/services/catalog.server";
import {
  syncCatalogEvent,
  type GraphQL,
} from "../app/services/shopify-catalog.server";
import type { Actor } from "../app/services/authorization";

const shopDomain = process.argv[2];

if (!shopDomain || !shopDomain.endsWith("-dev.myshopify.com")) {
  throw new Error(
    "This smoke script only accepts an explicit *-dev.myshopify.com store.",
  );
}

const shop = await db.shop.findUniqueOrThrow({ where: { domain: shopDomain } });
const staff = await db.staffAccount.findFirstOrThrow({
  where: { shopId: shop.id, role: "ADMIN", status: "ACTIVE" },
});
const session = await db.session.findFirstOrThrow({
  where: { shop: shopDomain, isOnline: false },
  orderBy: { expires: "desc" },
});

const actor: Actor = {
  shopId: shop.id,
  actorId: staff.id,
  role: "ADMIN",
};

const location = await db.location.upsert({
  where: {
    shopId_name: { shopId: shop.id, name: "Skyra Booking Dev Studio" },
  },
  create: {
    shopId: shop.id,
    name: "Skyra Booking Dev Studio",
    timezone: "Australia/Sydney",
  },
  update: {},
});

const coach =
  (await db.coach.findFirst({
    where: { shopId: shop.id, name: "Development Coach" },
  })) ??
  (await db.coach.create({
    data: {
      shopId: shop.id,
      name: "Development Coach",
      bufferBeforeMin: 10,
      bufferAfterMin: 10,
    },
  }));

const existingService = await db.service.findFirst({
  where: { shopId: shop.id, name: "[DEV] Aerial Foundations" },
});
const service = await saveService(actor, {
  id: existingService?.id,
  version: existingService?.version,
  name: "[DEV] Aerial Foundations",
  status: "ACTIVE",
  kind: "CLASS",
  description: "Development-store catalogue synchronization test.",
  level: "Beginner",
  durationMin: 60,
  capacity: 8,
  requestedPriceCents: 4900,
  locationId: location.id,
  coachIds: [coach.id],
});

const existingPass = await db.passPlan.findFirst({
  where: { shopId: shop.id, name: "[DEV] Five Class Pass" },
});
const pass = await savePass(actor, {
  id: existingPass?.id,
  version: existingPass?.version,
  name: "[DEV] Five Class Pass",
  status: "ACTIVE",
  credits: 5,
  validityDays: 90,
  introOnly: false,
  requestedPriceCents: 22000,
  serviceIds: [service.id],
});

const graphql: GraphQL = async (query, options) =>
  fetch(`https://${shopDomain}/admin/api/2026-07/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": session.accessToken,
    },
    body: JSON.stringify({ query, variables: options.variables }),
  });

const events = await db.outboxEvent.findMany({
  where: {
    shopId: shop.id,
    kind: "CATALOG_SYNC",
    aggregateId: { in: [service.id, pass.id] },
    status: "PENDING",
  },
  orderBy: { version: "asc" },
});

for (const event of events) {
  await syncCatalogEvent(event.id, graphql);
}

const mappings = await db.productMapping.findMany({
  where: {
    shopId: shop.id,
    ownerId: { in: [service.id, pass.id] },
  },
  select: {
    ownerType: true,
    ownerId: true,
    productGid: true,
    variantGid: true,
    syncStatus: true,
    publishedTitle: true,
    publishedPrice: true,
    productStatus: true,
  },
  orderBy: { ownerType: "asc" },
});

if (
  mappings.length !== 2 ||
  mappings.some((item) => item.syncStatus !== "SYNCED")
) {
  throw new Error(
    "Development-store catalogue synchronization did not complete.",
  );
}

console.log(JSON.stringify({ shop: shopDomain, mappings }, null, 2));
await db.$disconnect();
