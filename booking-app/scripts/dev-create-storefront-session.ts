import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import db from "../app/db.server";
import { addSessions, publishWeek } from "../app/services/schedule.server";

async function main() {
  const shop = await db.shop.findUniqueOrThrow({
    where: { domain: "skyra-booking-dev.myshopify.com" },
  });
  const service = await db.service.findFirstOrThrow({
    where: {
      shopId: shop.id,
      status: "ACTIVE",
      kind: "CLASS",
      coaches: { some: { coach: { status: "ACTIVE" } } },
    },
    include: { coaches: { include: { coach: true } } },
  });
  const staff = await db.staffAccount.findFirstOrThrow({
    where: {
      shopId: shop.id,
      status: "ACTIVE",
      role: { in: ["ADMIN", "OPERATIONS"] },
    },
  });
  const actor = {
    shopId: shop.id,
    actorId: staff.id,
    role: staff.role as "ADMIN" | "OPERATIONS",
  };
  const localStart = DateTime.now()
    .setZone(shop.timezone)
    .plus({ days: 1 })
    .set({ hour: 18, minute: 30, second: 0, millisecond: 0 })
    .toFormat("yyyy-MM-dd'T'HH:mm");
  const created = await addSessions(actor, {
    serviceId: service.id,
    coachId: service.coaches[0].coachId,
    localStart,
    weeks: 1,
    requestId: randomUUID(),
  });
  const published = await publishWeek(actor, localStart.slice(0, 10));
  console.log(JSON.stringify({
    created: created.length,
    published,
    sessionId: created[0].id,
    className: service.name,
    coach: service.coaches[0].coach.name,
    localStart,
  }));
}

main().finally(() => db.$disconnect());