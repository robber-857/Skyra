import { DateTime } from "luxon";
import db from "../db.server";
import { databaseNow } from "./booking.server";
import { requireOperations, type Actor } from "./authorization";

export async function adminOverview(actor: Actor) {
  requireOperations(actor);
  return db.$transaction(
    async (tx) => {
      const shop = await tx.shop.findFirstOrThrow({
        where: { id: actor.shopId, status: "ACTIVE" },
      });
      const now = await databaseNow(tx);
      const today = DateTime.fromJSDate(now, { zone: shop.timezone }).startOf(
        "day",
      );
      const tomorrow = today.plus({ days: 1 });
      const expiryEnd = DateTime.fromJSDate(now, {
        zone: shop.timezone,
      }).plus({ days: 30 });
      const [sessions, attention, expiringPasses] = await Promise.all([
        tx.classSession.findMany({
          where: {
            shopId: shop.id,
            startsAt: { gte: today.toJSDate(), lt: tomorrow.toJSDate() },
            status: { in: ["PUBLISHED", "COMPLETED"] },
          },
          orderBy: [{ startsAt: "asc" }, { id: "asc" }],
          select: {
            id: true,
            startsAt: true,
            timezone: true,
            capacity: true,
            status: true,
            service: { select: { name: true } },
            coach: { select: { name: true } },
            bookings: {
              where: { status: { in: ["CONFIRMED", "ATTENDED", "NO_SHOW"] } },
              select: { id: true },
            },
          },
        }),
        tx.webhookReceipt.count({
          where: {
            shopId: shop.id,
            status: { in: ["NEEDS_ATTENTION", "FAILED"] },
          },
        }),
        tx.$queryRaw<
          {
            entitlementId: string;
            customerId: string;
            customerName: string;
            passName: string;
            expiresAt: Date;
            granted: number;
            remaining: number;
          }[]
        >`SELECT e.id AS "entitlementId", e."customerId", COALESCE(NULLIF(TRIM(c."preferredName"), ''), NULLIF(TRIM(c."shopifyName"), ''), NULLIF(c.email, ''), 'Unnamed client') AS "customerName", COALESCE(p.name, s.name, 'Class credit') AS "passName", e."expiresAt", e."grantedUnits"::int AS granted, SUM(l."availableDelta" + l."reservedDelta")::int AS remaining FROM "Entitlement" e JOIN "CustomerProfile" c ON c.id=e."customerId" AND c."shopId"=e."shopId" LEFT JOIN "PassPlan" p ON p.id=e."passPlanId" AND p."shopId"=e."shopId" LEFT JOIN "Service" s ON s.id=e."serviceId" AND s."shopId"=e."shopId" JOIN "EntitlementLedgerEntry" l ON l."entitlementId"=e.id AND l."shopId"=e."shopId" WHERE e."shopId"=${shop.id}::uuid AND e.status='ACTIVE' AND e."expiresAt">${now} AND e."expiresAt"<=${expiryEnd.toJSDate()} GROUP BY e.id,e."customerId",c.id,p.name,s.name,e."expiresAt",e."grantedUnits" HAVING SUM(l."availableDelta" + l."reservedDelta")>0 ORDER BY e."expiresAt" ASC, e.id ASC`,
      ]);
      return {
        timezone: shop.timezone,
        date: today.toISODate()!,
        operationsEmailConfigured: Boolean(shop.operationsEmail),
        sessions: sessions.map((session) => ({
          ...session,
          startsAt: session.startsAt.toISOString(),
          booked: session.bookings.length,
        })),
        metrics: {
          classesToday: sessions.length,
          bookedToday: sessions.reduce(
            (sum, session) => sum + session.bookings.length,
            0,
          ),
          capacityToday: sessions.reduce(
            (sum, session) => sum + session.capacity,
            0,
          ),
          attention,
          expiringPasses: expiringPasses.length,
          expiringCredits: expiringPasses.reduce(
            (sum, entitlement) => sum + entitlement.remaining,
            0,
          ),
        },
        expiringPasses: expiringPasses.slice(0, 50).map((entitlement) => ({
          ...entitlement,
          expiresAt: entitlement.expiresAt.toISOString(),
          daysRemaining: Math.max(
            0,
            Math.ceil(
              DateTime.fromJSDate(entitlement.expiresAt, {
                zone: shop.timezone,
              })
                .startOf("day")
                .diff(today, "days").days,
            ),
          ),
        })),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
