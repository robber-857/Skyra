import type { PassPurchase } from "@prisma/client";
import db from "../db.server";
import { supportsRenewalPeriod } from "./renewal-period";

// Keep unconfigured one-time Passes on their existing checkout path. A Pass
// configured for renewal needs protection even when bought as a one-time Pass.
export async function requiresMembershipProtection(
  purchase: Pick<PassPurchase, "mode" | "validityMonths" | "membershipId">,
) {
  if (purchase.mode === "AUTO_RENEW" || purchase.validityMonths === 1)
    return true;
  if (!supportsRenewalPeriod(purchase.validityMonths)) return false;
  const member = await db.passMembership.findUnique({
    where: { id: purchase.membershipId },
    select: { passPlanId: true, shopId: true },
  });
  if (!member) return false;
  const plan = await db.passPlan.findFirst({
    where: { id: member.passPlanId, shopId: member.shopId },
    select: { sellingPlanGid: true },
  });
  return Boolean(plan?.sellingPlanGid);
}
