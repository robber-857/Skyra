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
    customer: z.string().uuid().optional(),
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
    customerId: q.customer,
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
      const customerId = range.customerId || null;
      const [
        states,
        sessionCount,
        purchases,
        unused,
        attention,
        customers,
        spendingRows,
        unusedRows,
      ] =
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
          tx.customerProfile.findMany({
            where: { shopId: shop.id },
            orderBy: [{ preferredName: "asc" }, { id: "asc" }],
            select: { id: true, preferredName: true },
          }),
          tx.$queryRaw<
            {
              customerId: string;
              customerName: string;
              purchaseCount: number;
              totalSpendCents: number;
              passPurchases: number;
              passRevenueCents: number;
              lastPurchase: Date;
            }[]
          >`SELECT c.id AS "customerId", COALESCE(NULLIF(c."preferredName", ''), 'Customer ' || RIGHT(c.id::text, 8)) AS "customerName", COUNT(*)::int AS "purchaseCount", COALESCE(SUM(ch."priceCents"),0)::float8 AS "totalSpendCents", COUNT(*) FILTER (WHERE h."purchaseKind"='NEW_PASS')::int AS "passPurchases", COALESCE(SUM(ch."priceCents") FILTER (WHERE h."purchaseKind"='NEW_PASS'),0)::float8 AS "passRevenueCents", MAX(r."createdAt") AS "lastPurchase" FROM "PaidBookingResult" r JOIN "BookingCheckout" ch ON ch.id=r."checkoutId" AND ch."shopId"=r."shopId" JOIN "BookingHold" h ON h.id=ch."holdId" AND h."shopId"=ch."shopId" JOIN "CustomerProfile" c ON c.id=h."customerId" AND c."shopId"=h."shopId" WHERE r."shopId"=${shop.id}::uuid AND r."createdAt">=${range.start} AND r."createdAt"<${range.end} AND (${customerId}::uuid IS NULL OR c.id=${customerId}::uuid) GROUP BY c.id,c."preferredName" ORDER BY "totalSpendCents" DESC,c.id ASC`,
          tx.$queryRaw<
            {
              entitlementId: string;
              customerId: string;
              customerName: string;
              passName: string;
              purchased: number;
              used: number;
              available: number;
              reserved: number;
              remaining: number;
              expiresAt: Date;
            }[]
          >`SELECT e.id AS "entitlementId", c.id AS "customerId", COALESCE(NULLIF(c."preferredName", ''), 'Customer ' || RIGHT(c.id::text, 8)) AS "customerName", COALESCE(p.name,s.name,'Class credit') AS "passName", e."grantedUnits"::int AS purchased, COALESCE(SUM(l."consumedDelta"),0)::int AS used, COALESCE(SUM(l."availableDelta"),0)::int AS available, COALESCE(SUM(l."reservedDelta"),0)::int AS reserved, COALESCE(SUM(l."availableDelta" + l."reservedDelta"),0)::int AS remaining, e."expiresAt" FROM "Entitlement" e JOIN "CustomerProfile" c ON c.id=e."customerId" AND c."shopId"=e."shopId" LEFT JOIN "PassPlan" p ON p.id=e."passPlanId" AND p."shopId"=e."shopId" LEFT JOIN "Service" s ON s.id=e."serviceId" AND s."shopId"=e."shopId" JOIN "EntitlementLedgerEntry" l ON l."entitlementId"=e.id AND l."shopId"=e."shopId" WHERE e."shopId"=${shop.id}::uuid AND e.status='ACTIVE' AND e."startsAt"<=${now} AND e."expiresAt">${now} AND (${customerId}::uuid IS NULL OR c.id=${customerId}::uuid) GROUP BY e.id,c.id,c."preferredName",p.name,s.name,e."grantedUnits",e."expiresAt" HAVING SUM(l."availableDelta" + l."reservedDelta")>0 ORDER BY e."expiresAt" ASC,e.id ASC`,
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
        customers: customers.map((customer) => ({
          id: customer.id,
          name:
            customer.preferredName || `Customer ${customer.id.slice(-8)}`,
        })),
        spending: {
          totalSpendCents: spendingRows.reduce(
            (sum, row) => sum + row.totalSpendCents,
            0,
          ),
          passRevenueCents: spendingRows.reduce(
            (sum, row) => sum + row.passRevenueCents,
            0,
          ),
          refundsTracked: false,
          rows: spendingRows.map((row) => ({
            ...row,
            lastPurchase: row.lastPurchase.toISOString(),
          })),
        },
        unusedPasses: {
          customers: new Set(unusedRows.map((row) => row.customerId)).size,
          credits: unusedRows.reduce((sum, row) => sum + row.remaining, 0),
          expiringIn30Days: unusedRows.reduce(
            (sum, row) =>
              row.expiresAt <= new Date(now.getTime() + 30 * 86400000)
                ? sum + row.remaining
                : sum,
            0,
          ),
          rows: unusedRows.map((row) => ({
            ...row,
            expiresAt: row.expiresAt.toISOString(),
          })),
        },
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
