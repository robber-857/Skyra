import { DateTime } from "luxon";
import db from "../db.server";
import { databaseNow } from "./booking.server";
import { requireOperations, type Actor } from "./authorization";
import { coachIdentity } from "./coach-auth.server";
async function today(shopId: string, coachId?: string) {
  const shop = await db.shop.findFirstOrThrow({
      where: { id: shopId, status: "ACTIVE" },
    }),
    now = await databaseNow(db);
  const start = DateTime.fromJSDate(now, { zone: shop.timezone }).startOf(
    "day",
  );
  const sessions = await db.classSession.findMany({
    where: {
      shopId,
      ...(coachId ? { coachId } : {}),
      startsAt: {
        gte: start.toJSDate(),
        lt: start.plus({ days: 1 }).toJSDate(),
      },
      status: { in: ["PUBLISHED", "COMPLETED"] },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: 101,
    select: {
      id: true,
      startsAt: true,
      timezone: true,
      capacity: true,
      service: { select: { name: true, kind: true } },
      coach: { select: { name: true } },
      bookings: {
        where: { status: { in: ["CONFIRMED", "ATTENDED", "NO_SHOW"] } },
        select: { id: true, customerId: true, status: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  return {
    date: start.toISODate()!,
    timezone: shop.timezone,
    sessions: sessions.slice(0, 100),
    truncated: sessions.length > 100,
  };
}
export async function adminToday(actor: Actor) {
  requireOperations(actor);
  return today(actor.shopId);
}
export async function coachToday(token: string) {
  const identity = await coachIdentity(token);
  const result = await today(identity.shopId, identity.coachId);
  await db.auditLog.create({
    data: {
      shopId: identity.shopId,
      actorId: identity.coachId,
      action: "COACH_TODAY_VIEWED",
      entityId: identity.coachId,
    },
  });
  return result;
}
