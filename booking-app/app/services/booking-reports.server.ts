import { DateTime } from "luxon";
import { z } from "zod";
import db from "../db.server";
import { requireOperations, type Actor } from "./authorization";
import { DomainError } from "../lib/errors.server";
import { databaseNow } from "./booking.server";
const input = z
  .object({
    range: z.enum(["week", "month", "custom"]).default("month"),
    from: z.string().optional(),
    to: z.string().optional(),
  })
  .strict();
export function reportDateRange(
  raw: unknown,
  timezone: string,
  now = new Date(),
) {
  const q = input.parse(raw),
    today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  const from =
    q.range === "custom"
      ? DateTime.fromISO(q.from || "", { zone: timezone }).startOf("day")
      : today.minus({ days: q.range === "week" ? 6 : 29 });
  const to =
    q.range === "custom"
      ? DateTime.fromISO(q.to || "", { zone: timezone }).startOf("day")
      : today;
  if (
    !from.isValid ||
    !to.isValid ||
    to < from ||
    to.diff(from, "days").days > 365 ||
    (q.range === "custom" &&
      (from.toISODate() !== q.from || to.toISODate() !== q.to))
  )
    throw new DomainError(
      "INVALID_DATE_RANGE",
      "Choose a valid date range of up to 366 days.",
      400,
    );
  return {
    range: q.range,
    from: from.toISODate()!,
    to: to.toISODate()!,
    start: from.toJSDate(),
    end: to.plus({ days: 1 }).toJSDate(),
    timezone,
  };
}
export async function bookingReports(actor: Actor, raw: unknown) {
  requireOperations(actor);
  return db.$transaction(
    async (tx) => {
      const shop = await tx.shop.findFirst({
        where: { id: actor.shopId, status: "ACTIVE" },
      });
      if (!shop) throw new DomainError("NOT_FOUND", "Studio not found.", 404);
      const now = await databaseNow(tx),
        range = reportDateRange(raw, shop.timezone, now);
      const [states, sessionCount, purchases, unused, attention] =
        await Promise.all([
          tx.booking.groupBy({
            by: ["status"],
            where: {
              shopId: shop.id,
              session: {
                startsAt: { gte: range.start, lt: range.end },
                status: { not: "DRAFT" },
              },
            },
            _count: { _all: true },
          }),
          tx.classSession.count({
            where: {
              shopId: shop.id,
              startsAt: { gte: range.start, lt: range.end },
              status: { in: ["PUBLISHED", "COMPLETED"] },
            },
          }),
          tx.$queryRaw<
            { count: number; valueCents: number }[]
          >`SELECT COUNT(*)::int AS count, COALESCE(SUM(c."priceCents"),0)::float8 AS "valueCents" FROM "PaidBookingResult" r JOIN "BookingCheckout" c ON c.id=r."checkoutId" AND c."shopId"=r."shopId" WHERE r."shopId"=${shop.id}::uuid AND r."createdAt">=${range.start} AND r."createdAt"<${range.end}`,
          tx.$queryRaw<
            {
              passes: number;
              customers: number;
              available: number;
              reserved: number;
            }[]
          >`SELECT COUNT(*)::int AS passes, COUNT(DISTINCT b."customerId")::int AS customers, COALESCE(SUM(b.available),0)::float8 AS available, COALESCE(SUM(b.reserved),0)::float8 AS reserved FROM (SELECT e.id,e."customerId",SUM(l."availableDelta") AS available,SUM(l."reservedDelta") AS reserved FROM "Entitlement" e JOIN "EntitlementLedgerEntry" l ON l."entitlementId"=e.id AND l."shopId"=e."shopId" WHERE e."shopId"=${shop.id}::uuid AND e.status='ACTIVE' AND e."startsAt"<=${now} AND e."expiresAt">${now} GROUP BY e.id,e."customerId" HAVING SUM(l."availableDelta")>0 OR SUM(l."reservedDelta")>0) b`,
          tx.webhookReceipt.count({
            where: {
              shopId: shop.id,
              status: { in: ["NEEDS_ATTENTION", "FAILED"] },
            },
          }),
        ]);
      const counts = Object.fromEntries(
        states.map((s) => [s.status, s._count._all]),
      );
      return {
        range,
        asOf: now.toISOString(),
        sessionCount,
        counts,
        purchases: purchases[0],
        unused: unused[0],
        attention,
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
