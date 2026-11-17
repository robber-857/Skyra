import { Prisma } from "@prisma/client";

type Range = { start: Date; end: Date; customerId?: string; search: string };
type Row = {
  purchaseId: string;
  customerId: string;
  customerName: string;
  passName: string;
  source: string;
  reference: string;
  purchasedAt: Date;
  dateBasis: string;
  amountCents: number | null;
  purchased: number | null;
  used: number | null;
  remaining: number | null;
  reserved: number | null;
};

export async function purchaseUsageReport(
  tx: Prisma.TransactionClient,
  shopId: string,
  range: Range,
  now: Date,
) {
  // A historical ledger snapshot, including exhausted, expired and revoked entitlements.
  // Never substitute the editable catalogue price or present-day entitlement grant count.
  const cutoff = new Date(Math.min(range.end.getTime(), now.getTime()));
  const customer = range.customerId || null;
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`
    WITH purchases AS (
      SELECT m.id::text AS "purchaseId", m."customerId", p."entitlementId", m."passName",
        'Membership'::text AS source, m."sourceOrderGid" AS reference,
        COALESCE(m."paidAt",m."issuedAt") AS "purchasedAt",
        CASE WHEN m."paidAt" IS NULL THEN 'Receipt recorded' ELSE 'Payment' END AS "dateBasis",
        m."priceCents"::float8 AS "amountCents", m.credits::int AS purchased
      FROM "MembershipReceipt" m
      JOIN "PassPurchase" p ON p.id=m."purchaseId" AND p."shopId"=m."shopId"
      WHERE m."shopId"=${shopId}::uuid AND m.currency='AUD'
      UNION ALL
      SELECT r.id::text,h."customerId",r."entitlementId",COALESCE(pp.name,s.name,'Class credit'),
        'Booking online',r."sourceOrderGid",r."createdAt",'Purchase recorded',
        ch."priceCents"::float8,
        CASE WHEN ch."purchaseTerms"->>'credits' ~ '^[0-9]{1,8}$'
          THEN (ch."purchaseTerms"->>'credits')::int ELSE NULL END
      FROM "PaidBookingResult" r
      JOIN "BookingCheckout" ch ON ch.id=r."checkoutId" AND ch."shopId"=r."shopId"
      JOIN "BookingHold" h ON h.id=ch."holdId" AND h."shopId"=ch."shopId"
      JOIN "ClassSession" cs ON cs.id=h."sessionId" AND cs."shopId"=h."shopId"
      JOIN "Service" s ON s.id=cs."serviceId" AND s."shopId"=cs."shopId"
      LEFT JOIN "PassPlan" pp ON pp.id=h."passPlanId" AND pp."shopId"=h."shopId"
      WHERE r."shopId"=${shopId}::uuid AND NOT EXISTS (
        SELECT 1 FROM "MembershipReceipt" m WHERE m."shopId"=r."shopId"
          AND m."sourceOrderGid"=r."sourceOrderGid" AND m."sourceLineItemGid"=r."sourceLineItemGid"
      )
      UNION ALL
      SELECT e.id::text,e."customerId",e.id,COALESCE(p.name,s.name,'Class credit'),
        'Cash',e.id::text,a."createdAt",'Cash recorded',
        CASE WHEN a.after->>'amount' ~ '^[0-9]+([.][0-9]{1,2})?$'
          THEN ((a.after->>'amount')::numeric*100)::float8 ELSE NULL END,
        CASE WHEN a.after->>'units' ~ '^[0-9]{1,8}$' THEN (a.after->>'units')::int ELSE NULL END
      FROM "Entitlement" e
      JOIN LATERAL (SELECT a.after,a."createdAt" FROM "AuditLog" a
        WHERE a."shopId"=e."shopId" AND a."entityId"=e.id::text AND a.action='CASH_CREDITS_GRANTED'
        ORDER BY a."createdAt",a.id LIMIT 1) a ON true
      LEFT JOIN "PassPlan" p ON p.id=e."passPlanId" AND p."shopId"=e."shopId"
      LEFT JOIN "Service" s ON s.id=e."serviceId" AND s."shopId"=e."shopId"
      WHERE e."shopId"=${shopId}::uuid AND e."sourceSystem"='MANUAL_CASH'
    )
    SELECT p."purchaseId",p."customerId",
      COALESCE(NULLIF(TRIM(c."preferredName"),''),NULLIF(TRIM(c."shopifyName"),''),NULLIF(c.email,''),'Unnamed client') AS "customerName",
      p."passName",p.source,p.reference,p."purchasedAt",p."dateBasis",p."amountCents",p.purchased,
      CASE WHEN p."entitlementId" IS NULL THEN NULL ELSE COALESCE(l.used,0)::int END AS used,
      CASE WHEN p."entitlementId" IS NULL THEN NULL ELSE COALESCE(l.remaining,0)::int END AS remaining,
      CASE WHEN p."entitlementId" IS NULL THEN NULL ELSE COALESCE(l.reserved,0)::int END AS reserved
    FROM purchases p
    JOIN "CustomerProfile" c ON c.id=p."customerId" AND c."shopId"=${shopId}::uuid
    LEFT JOIN LATERAL (SELECT SUM(l."consumedDelta") AS used,
      SUM(l."availableDelta"+l."reservedDelta") AS remaining,SUM(l."reservedDelta") AS reserved
      FROM "EntitlementLedgerEntry" l WHERE l."shopId"=${shopId}::uuid
        AND l."entitlementId"=p."entitlementId" AND l."createdAt"<${cutoff}) l ON true
    WHERE p."purchasedAt">=${range.start} AND p."purchasedAt"<${range.end}
      AND (${customer}::uuid IS NULL OR c.id=${customer}::uuid)
      AND (${range.search}='' OR strpos(lower(COALESCE(c."preferredName",'')),lower(${range.search}))>0
        OR strpos(lower(COALESCE(c."shopifyName",'')),lower(${range.search}))>0
        OR strpos(lower(COALESCE(c.email,'')),lower(${range.search}))>0)
    ORDER BY p."purchasedAt",p."purchaseId"
  `);
  return {
    cutoff: cutoff.toISOString(),
    customers: new Set(rows.map((row) => row.customerId)).size,
    amountCents: rows.reduce((sum, row) => sum + (row.amountCents || 0), 0),
    rows: rows.map((row) => ({
      ...row,
      purchasedAt: row.purchasedAt.toISOString(),
      unitPriceCents:
        row.amountCents != null && row.purchased != null && row.purchased > 0
          ? row.amountCents / row.purchased
          : null,
    })),
  };
}
