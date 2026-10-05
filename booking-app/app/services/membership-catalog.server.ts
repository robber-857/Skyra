import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { databaseNow, type BookingActor } from "./booking.server";
import { introOfferEligible } from "./entitlements.server";
import { purchaseMappingReady } from "./purchase-mapping.server";
import {
  AUTO_RENEW_TERMS_VERSION,
  membershipCapabilities,
} from "./membership-capabilities.server";
export { AUTO_RENEW_TERMS_VERSION } from "./membership-capabilities.server";

export async function membershipCatalog(actor: BookingActor, raw: unknown) {
  z.object({}).strict().parse(raw);
  const shop = await db.shop.findFirst({
    where: { id: actor.shopId, status: "ACTIVE" },
  });
  if (!shop)
    throw new DomainError("NOT_FOUND", "Memberships are unavailable.", 404);
  const capabilities = membershipCapabilities(shop.domain, actor.customerGid);
  const now = await databaseNow(db);
  const customer = actor.customerGid
    ? await db.customerProfile.findUnique({
        where: {
          shopId_shopifyCustomerGid: {
            shopId: shop.id,
            shopifyCustomerGid: actor.customerGid,
          },
        },
      })
    : null;
  const canUseIntro = customer
    ? await introOfferEligible(db, shop.id, customer.id)
    : true;
  const plans = await db.passPlan.findMany({
    where: {
      shopId: shop.id,
      status: "ACTIVE",
      saleable: true,
      standalonePurchaseEnabled: true,
      ...(process.env.SKYRA_MEMBERSHIPS_UAT_PASS_PLAN_ID ? { id: process.env.SKYRA_MEMBERSHIPS_UAT_PASS_PLAN_ID } : {}),
    },
    orderBy: [{ requestedPriceCents: "asc" }, { id: "asc" }],
  });
  const mappings = await db.productMapping.findMany({
    where: {
      shopId: shop.id,
      ownerType: "PASS_PLAN",
      ownerId: { in: plans.map((plan) => plan.id) },
    },
  });
  const memberships = customer
    ? await db.passMembership.findMany({
        where: { shopId: shop.id, customerId: customer.id },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const purchases = memberships.length
    ? await db.passPurchase.findMany({
        where: {
          shopId: shop.id,
          membershipId: { in: memberships.map((item) => item.id) },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const entitlementIds = purchases.flatMap((item) =>
    item.entitlementId ? [item.entitlementId] : [],
  );
  const entitlements = entitlementIds.length
    ? await db.entitlement.findMany({
        where: {
          shopId: shop.id,
          customerId: customer!.id,
          id: { in: entitlementIds },
        },
      })
    : [];
  const memberPlanIds = memberships.map((item) => item.passPlanId);
  const memberPlans = memberPlanIds.length
    ? await db.passPlan.findMany({
        where: {
          shopId: shop.id,
          id: { in: memberPlanIds },
        },
      })
    : [];
  return {
    authenticated: Boolean(actor.customerGid),
    checkoutAvailable: capabilities.checkoutAvailable,
    passes: plans.flatMap((plan) => {
      if (
        (plan.introOnly && !canUseIntro) ||
        !purchaseMappingReady(
          mappings.find((mapping) => mapping.ownerId === plan.id),
          plan,
        )
      )
        return [];
      const available =
        capabilities.autoRenewAvailable &&
        plan.autoRenewEnabled &&
        Boolean(plan.sellingPlanGid) &&
        plan.validityMonths === 1;
      if (!plan.oneTimePurchaseEnabled && !available) return [];
      return [
        {
          id: plan.id,
          version: plan.version,
          name: plan.name,
          credits: plan.credits,
          validityDays: plan.validityDays,
          validityMonths: plan.validityMonths,
          priceCents: plan.requestedPriceCents,
          currency: "AUD",
          kind: "NEW_PASS" as const,
          oneTimePurchaseEnabled: plan.oneTimePurchaseEnabled,
          autoRenew: { available, termsVersion: AUTO_RENEW_TERMS_VERSION },
        },
      ];
    }),
    memberships: memberships.map((item) => {
      const current = purchases.find(
        (purchase) =>
          purchase.membershipId === item.id &&
          purchase.cycle === item.currentCycle,
      );
      const entitlement = entitlements.find(
        (value) => value.id === current?.entitlementId,
      );
      return {
        id: item.id,
        passPlanId: item.passPlanId,
        name:
          memberPlans.find((plan) => plan.id === item.passPlanId)?.name ||
          "Pass",
        status: item.status,
        autoRenew: item.autoRenew,
        startsAt: entitlement?.startsAt?.toISOString() || null,
        expiresAt: entitlement?.expiresAt?.toISOString() || null,
        autoRenewRequested:
          current?.mode === "AUTO_RENEW" && item.status !== "CANCELLED",
        canCancel:
          item.status !== "CANCELLED" &&
          (item.autoRenew || current?.mode === "AUTO_RENEW"),
        paymentStatus: current?.status || null,
        purchaseId: current?.id || null,
        blocksPurchase: Boolean(
          item.autoRenew ||
          item.contractGid ||
          !entitlement?.expiresAt ||
          entitlement.expiresAt > now ||
          purchases.some(
            (purchase) =>
              purchase.membershipId === item.id &&
              purchase.cycle === item.currentCycle &&
              purchase.status !== "PAID",
          ),
        ),
        hasPendingPayment: Boolean(current && current.status !== "PAID"),
      };
    }),
  };
}
