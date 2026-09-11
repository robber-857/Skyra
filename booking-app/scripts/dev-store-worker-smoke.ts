import "dotenv/config";

import db from "../app/db.server";
import { saveService } from "../app/services/catalog.server";
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
const service = await db.service.findFirstOrThrow({
  where: { shopId: shop.id, name: "[DEV] Aerial Foundations" },
  include: { coaches: true },
});

const actor: Actor = {
  shopId: shop.id,
  actorId: staff.id,
  role: "ADMIN",
};

const saved = await saveService(actor, {
  id: service.id,
  version: service.version,
  name: service.name,
  status: service.status,
  kind: service.kind,
  description: service.description,
  level: service.level,
  durationMin: service.durationMin,
  capacity: service.capacity,
  requestedPriceCents: service.requestedPriceCents,
  locationId: service.locationId,
  coachIds: service.coaches.map((item) => item.coachId),
});

const deadline = Date.now() + 30_000;
let mapping;

do {
  mapping = await db.productMapping.findUniqueOrThrow({
    where: {
      shopId_ownerType_ownerId: {
        shopId: shop.id,
        ownerType: "SERVICE",
        ownerId: service.id,
      },
    },
  });
  if (
    mapping.syncStatus === "SYNCED" &&
    mapping.shopifyVersion === saved.version
  ) {
    console.log(
      JSON.stringify(
        {
          shop: shopDomain,
          serviceId: service.id,
          requestedVersion: saved.version,
          shopifyVersion: mapping.shopifyVersion,
          syncStatus: mapping.syncStatus,
          productGid: mapping.productGid,
        },
        null,
        2,
      ),
    );
    await db.$disconnect();
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
} while (Date.now() < deadline);

throw new Error(
  `Worker did not synchronize version ${saved.version}; current status ${mapping?.syncStatus}.`,
);
