import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import type { GraphQL } from "./shopify-catalog.server";
import { membershipCapabilities } from "./membership-capabilities.server";
import { closeMembershipCheckoutForRenewal } from "./membership-checkout-guard.server";
import { inventoryMembershipCheckout } from "./membership-inventory-checkout.server";
import { settlePassPurchasePayment } from "./membership-payments.server";
import {
  readSubscriptionContract,
  readMembershipBillingContext,
  submitMembershipBilling,
  readMembershipBilling,
  readMembershipOrder,
  setNextBillingDate,
  cancelSubscriptionContract,
  type MembershipContract,
} from "./shopify-membership.server";

type AdminForShop = (domain: string) => Promise<GraphQL>;
async function hasUnresolvedMembershipOrder(
  tx: Prisma.TransactionClient,
  shopId: string,
  membershipId: string,
) {
  return Boolean(
    await tx.outboxEvent.findFirst({
      where: {
        shopId,
        kind: "MEMBERSHIP_ORDER_RECONCILE",
        status: { not: "DONE" },
        payload: { path: ["membershipId"], equals: membershipId },
      },
      select: { id: true },
    }),
  );
}
// This app is the only billing scheduler. Waiting for attendance is a local
// condition, not a customer pause; do not auto-resume a Shopify PAUSED contract.
export async function bindMembershipContract(
  shopId: string,
  contractGid: string,
  admin: GraphQL,
  verifiedContract?: MembershipContract,
) {
  // A preloaded contract is accepted only from the owned billing-context read.
  const contract =
    verifiedContract ?? (await readSubscriptionContract(admin, contractGid));
  if (contract.id !== contractGid)
    throw new DomainError(
      "SUBSCRIPTION_CONTRACT_MISMATCH",
      "Subscription contract needs review.",
      409,
    );
  const purchase = await db.passPurchase.findFirst({
    where: {
      shopId,
      mode: "AUTO_RENEW",
      sourceOrderGid: contract.originOrder?.id,
    },
    include: { membership: true },
  });
  if (!contract.originOrder?.id || !purchase) return false; // order webhook may arrive later
  const customer = await db.customerProfile.findUniqueOrThrow({
    where: { id: purchase.membership.customerId },
  });
  const line = contract.lines.nodes[0];
  const cents = (amount: string) =>
    /^\d+(?:\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : NaN;
  if (
    contract.customer?.id !== customer.shopifyCustomerGid ||
    contract.currencyCode !== purchase.currency ||
    contract.lines.nodes.length !== 1 ||
    contract.lines.pageInfo.hasNextPage ||
    !line ||
    line.variantId !== purchase.variantGid ||
    line.productId !== purchase.productGid ||
    line.quantity !== 1 ||
    line.sellingPlanId !== purchase.sellingPlanGid ||
    cents(line.currentPrice.amount) !== purchase.priceCents ||
    line.currentPrice.currencyCode !== purchase.currency ||
    line.requiresShipping ||
    cents(contract.deliveryPrice.amount) !== 0 ||
    !contract.customerPaymentMethod ||
    contract.customerPaymentMethod.revokedAt
  )
    throw new DomainError(
      "SUBSCRIPTION_CONTRACT_MISMATCH",
      "Subscription contract needs review.",
      409,
    );
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PassMembership" WHERE id = ${purchase.membershipId}::uuid FOR UPDATE`;
    const member = await tx.passMembership.findUniqueOrThrow({
      where: { id: purchase.membershipId },
    });
    if (member.contractGid && member.contractGid !== contract.id)
      throw new DomainError(
        "DUPLICATE_SUBSCRIPTION",
        "A second subscription must not be billed.",
        409,
      );
    const cancelled =
      member.status === "CANCELLED" || contract.status === "CANCELLED";
    const active =
      contract.status === "ACTIVE" &&
      !cancelled &&
      member.status !== "PAYMENT_REVIEW";
    await tx.passMembership.update({
      where: { id: member.id },
      data: {
        contractGid: contract.id,
        autoRenew: active,
        ...(cancelled ? { status: "CANCELLED" } : {}),
      },
    });
  });
  return true;
}

export async function claimDueMembershipCycle(membershipId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "PassMembership" WHERE id = ${membershipId}::uuid FOR UPDATE`;
    const m = await tx.passMembership.findUniqueOrThrow({
      where: { id: membershipId },
    });
    if (!m.autoRenew || !m.contractGid || m.status !== "ACTIVE") return null;
    if (await hasUnresolvedMembershipOrder(tx, m.shopId, m.id)) return null;
    const old = await tx.passPurchase.findUniqueOrThrow({
      where: { membershipId_cycle: { membershipId, cycle: m.currentCycle } },
    });
    if (old.status !== "PAID" || !old.entitlementId) return null;
    const entitlement = await tx.entitlement.findUniqueOrThrow({
      where: { id: old.entitlementId },
    });
    const [{ now }] = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    if (entitlement.status !== "ACTIVE" && entitlement.status !== "EXPIRED")
      return null;
    if (
      !entitlement.startsAt ||
      !entitlement.expiresAt ||
      entitlement.expiresAt > now
    )
      return null;
    const purchase = await tx.passPurchase.create({
      data: {
        shopId: old.shopId,
        membershipId,
        cycle: m.currentCycle + 1,
        mode: "AUTO_RENEW",
        status: "BILLING_PENDING",
        reference: randomBytes(32).toString("base64url"),
        idempotencyKey: randomUUID(),
        productMappingId: old.productMappingId,
        productGid: old.productGid,
        variantGid: old.variantGid,
        sellingPlanGid: old.sellingPlanGid,
        priceCents: old.priceCents,
        currency: old.currency,
        credits: old.credits,
        validityDays: old.validityDays,
        validityMonths: old.validityMonths,
        timezone: old.timezone,
        termsVersion: old.termsVersion,
        autoRenewTermsVersion: old.autoRenewTermsVersion,
      },
    });
    await tx.passMembership.update({
      where: { id: m.id },
      data: { currentCycle: purchase.cycle, status: "WAITING_PAYMENT" },
    });
    return purchase;
  });
}

export async function processMembershipBilling(
  purchaseId: string,
  admin: GraphQL,
) {
  const first = await db.passPurchase.findUniqueOrThrow({
    where: { id: purchaseId },
    include: { membership: true },
  });
  const shop = await db.shop.findUniqueOrThrow({ where: { id: first.shopId } });
  if (
    !membershipCapabilities(shop.domain).autoRenewAvailable ||
    first.status === "PAID" ||
    first.cycle < 2 ||
    first.mode !== "AUTO_RENEW"
  )
    return;
  if (!first.membership.contractGid) return;
  let billing;
  if (first.billingAttemptGid) {
    billing = await readMembershipBilling(admin, first.billingAttemptGid);
  } else {
    if (inventoryMembershipCheckout() &&
      process.env.SKYRA_MEMBERSHIPS_BILLING_ENABLED !== "true") return;
    // After a lost response, do not re-charge with a new key, or assume that a
    // provider deduplication window lasts forever. Stop for reconciliation.
    if (first.submittedAt || first.status !== "BILLING_PENDING") return;
    const [{ now: billingNow }] = await db.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    const context = await readMembershipBillingContext(
      admin,
      first.membership.contractGid,
      billingNow,
    );
    const bound = await bindMembershipContract(
      first.shopId,
      first.membership.contractGid,
      admin,
      context.contract,
    );
    if (!bound)
      throw new DomainError(
        "BILLING_CONTRACT_UNBOUND",
        "The original paid order must be verified before renewal billing.",
        409,
      );
    await closeMembershipCheckoutForRenewal(first, admin, shop.domain);
    const claimed = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PassMembership" WHERE id = ${first.membershipId}::uuid FOR UPDATE`;
      const member = await tx.passMembership.findUniqueOrThrow({
        where: { id: first.membershipId },
      });
      if (
        !member.autoRenew ||
        member.status !== "WAITING_PAYMENT" ||
        member.currentCycle !== first.cycle ||
        member.contractGid !== first.membership.contractGid
      )
        return false;
      // An unmatched paid order may arrive after the renewal was claimed.
      // Keep that payment unresolved before submitting any additional charge.
      if (await hasUnresolvedMembershipOrder(tx, member.shopId, member.id))
        return false;
      const [{ now }] = await tx.$queryRaw<
        { now: Date }[]
      >`SELECT clock_timestamp() AS now`;
      // Claiming the next period and submitting it can happen in separate
      // worker runs. Recheck the prior Pass at the actual submit boundary: a
      // revoked, corrected or still-unactivated Pass must not be charged early.
      const previous = await tx.passPurchase.findUniqueOrThrow({
        where: {
          membershipId_cycle: {
            membershipId: first.membershipId,
            cycle: first.cycle - 1,
          },
        },
      });
      if (previous.status !== "PAID" || !previous.entitlementId) return false;
      const previousPass = await tx.entitlement.findUniqueOrThrow({
        where: { id: previous.entitlementId },
      });
      if (
        previousPass.shopId !== member.shopId ||
        previousPass.customerId !== member.customerId ||
        previousPass.passPlanId !== member.passPlanId ||
        previousPass.activationMode !== "FIRST_ATTENDANCE" ||
        !["ACTIVE", "EXPIRED"].includes(previousPass.status) ||
        !previousPass.startsAt ||
        !previousPass.expiresAt ||
        previousPass.startsAt >= previousPass.expiresAt ||
        previousPass.expiresAt > now
      )
        return false;
      if (
        !context.contract.nextBillingDate ||
        Date.parse(context.contract.nextBillingDate) !==
          previousPass.expiresAt.getTime()
      )
        throw new DomainError(
          "BILLING_DATE_MISMATCH",
          "The Shopify billing date must match this Pass expiry before charging.",
          409,
        );
      const current = await tx.passPurchase.findUniqueOrThrow({
        where: { id: first.id },
      });
      const agreedFields = [
        "productMappingId",
        "productGid",
        "variantGid",
        "sellingPlanGid",
        "priceCents",
        "currency",
        "credits",
        "validityDays",
        "validityMonths",
        "timezone",
        "termsVersion",
        "autoRenewTermsVersion",
      ] as const;
      if (
        previous.mode !== "AUTO_RENEW" ||
        current.mode !== "AUTO_RENEW" ||
        current.idempotencyKey !== first.idempotencyKey ||
        agreedFields.some(
          (field) =>
            current[field] !== previous[field] ||
            current[field] !== first[field],
        )
      )
        throw new DomainError(
          "BILLING_TERMS_MISMATCH",
          "This renewal differs from its agreed terms and needs review.",
          409,
        );
      const update = await tx.passPurchase.updateMany({
        where: { id: first.id, status: "BILLING_PENDING", submittedAt: null },
        data: { status: "SUBMITTING", submittedAt: now },
      });
      return update.count === 1
        ? {
            contractGid: member.contractGid!,
            idempotencyKey: current.idempotencyKey,
            originTime: previousPass.expiresAt,
            billingCycleSelector: context.billingCycleSelector,
            ...(inventoryMembershipCheckout()
              ? { inventoryProtected: true }
              : {}),
          }
        : false;
    });
    if (!claimed) return;
    try {
      billing = await submitMembershipBilling(admin, claimed);
    } catch {
      await db.passPurchase.updateMany({
        where: { id: first.id, status: "SUBMITTING" },
        data: { status: "UNKNOWN", lastError: "BILLING_RESULT_UNKNOWN" },
      });
      return;
    }
    await db.passPurchase.updateMany({
      where: { id: first.id, status: { not: "PAID" } },
      data: { billingAttemptGid: billing.id, status: "BILLING_PENDING" },
    });
  }
  if (
    billing.contractGid !== first.membership.contractGid ||
    billing.idempotencyKey !== first.idempotencyKey
  )
    throw new DomainError(
      "BILLING_CONTEXT_MISMATCH",
      "Billing attempt needs review.",
      409,
    );
  if (
    billing.orderGid &&
    billing.ready &&
    !billing.errorCode &&
    !billing.nextActionUrl
  ) {
    const payment = await readMembershipOrder(admin, billing.orderGid);
    if (
      !payment ||
      payment.contractGid !== first.membership.contractGid ||
      payment.sellingPlanGid !== first.sellingPlanGid
    )
      throw new DomainError(
        "BILLING_ORDER_MISMATCH",
        "Renewal order needs review.",
        409,
      );
    await settlePassPurchasePayment(first.id, payment);
  } else if (billing.errorCode || billing.nextActionUrl) {
    await db.passPurchase.updateMany({
      where: { id: first.id, status: { not: "PAID" } },
      data: {
        status: billing.nextActionUrl ? "ACTION_REQUIRED" : "FAILED",
        lastError: billing.nextActionUrl
          ? "PAYMENT_AUTHENTICATION_REQUIRED"
          : "PAYMENT_FAILED",
      },
    });
    // Store no authentication URL in logs or public purchase status.
  }
}

export async function sweepMembershipWork(adminForShop: AdminForShop) {
  const shops = await db.shop.findMany({ where: { status: "ACTIVE" } });
  for (const shop of shops) {
    const ready = membershipCapabilities(shop.domain).autoRenewAvailable;
    const pending = await db.outboxEvent.findMany({
      where: {
        shopId: shop.id,
        status: "PENDING",
        availableAt: { lte: new Date() },
        kind: {
          in: [
            "MEMBERSHIP_CONTRACT_RECEIVED",
            "MEMBERSHIP_CONTRACT_SYNC",
            "MEMBERSHIP_BILLING_RECEIVED",
          ],
        },
      },
      take: 30,
      orderBy: { availableAt: "asc" },
    });
    const cancelled = await db.passMembership.findFirst({
      where: {
        shopId: shop.id,
        status: "CANCELLED",
        contractGid: { not: null },
      },
    });
    // Disabling new purchases/billing must not strand provider receipts or
    // prevent an already-created contract from being bound and cancelled.
    if (!ready && !cancelled && !pending.length) continue;
    const admin = await adminForShop(shop.domain);
    for (const event of pending) {
      try {
        if (event.kind === "MEMBERSHIP_BILLING_RECEIVED") {
          const attempt = await readMembershipBilling(
            admin,
            (event.payload as { attemptGid: string }).attemptGid,
          );
          const purchase = await db.passPurchase.findFirst({
            where: { shopId: shop.id, idempotencyKey: attempt.idempotencyKey },
            include: { membership: true },
          });
          if (
            !purchase ||
            !purchase.submittedAt ||
            purchase.cycle < 2 ||
            purchase.membership.contractGid !== attempt.contractGid ||
            (purchase.billingAttemptGid &&
              purchase.billingAttemptGid !== attempt.id)
          )
            throw new DomainError(
              "BILLING_CONTEXT_MISMATCH",
              "Unmatched billing event.",
              409,
            );
          await db.passPurchase.updateMany({
            where: { id: purchase.id, status: { not: "PAID" } },
            data: {
              billingAttemptGid: attempt.id,
              status: "BILLING_PENDING",
              lastError: null,
            },
          });
        } else if (event.kind === "MEMBERSHIP_CONTRACT_RECEIVED") {
          const contractGid = (event.payload as { contractGid: string })
            .contractGid;
          if (!(await bindMembershipContract(shop.id, contractGid, admin))) {
            await db.outboxEvent.update({
              where: { id: event.id },
              data: { availableAt: new Date(Date.now() + 60000) },
            });
            continue;
          }
        } else {
          const member = await db.passMembership.findUniqueOrThrow({
            where: { id: event.aggregateId },
          });
          if (!member.contractGid) {
            await db.outboxEvent.update({
              where: { id: event.id },
              data: { availableAt: new Date(Date.now() + 60000) },
            });
            continue;
          }
          const contract = await readSubscriptionContract(
            admin,
            member.contractGid,
          );
          if (member.status === "CANCELLED") {
            if (contract.status !== "CANCELLED")
              await cancelSubscriptionContract(admin, member.contractGid);
          } else if (ready && member.autoRenew) {
            const current = await db.passPurchase.findUnique({
              where: {
                membershipId_cycle: {
                  membershipId: member.id,
                  cycle: member.currentCycle,
                },
              },
            });
            const pass = current?.entitlementId
              ? await db.entitlement.findUnique({
                  where: { id: current.entitlementId },
                })
              : null;
            if (pass?.expiresAt && contract.status === "ACTIVE")
              await setNextBillingDate(
                admin,
                member.contractGid,
                pass.expiresAt,
              );
          }
        }
        await db.$transaction(async (tx) => {
          const completed = await tx.outboxEvent.updateMany({
            where: {
              id: event.id,
              payload: { equals: event.payload as Prisma.InputJsonValue },
            },
            data: { status: "DONE", lastError: null },
          });
          if (
            completed.count &&
            [
              "MEMBERSHIP_CONTRACT_RECEIVED",
              "MEMBERSHIP_BILLING_RECEIVED",
            ].includes(event.kind)
          )
            await tx.webhookReceipt.updateMany({
              where: { id: event.aggregateId, shopId: shop.id },
              data: { status: "PROCESSED" },
            });
        });
      } catch {
        await db.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts: { increment: 1 },
            lastError: "MEMBERSHIP_SYNC_REQUIRES_REVIEW",
            availableAt: new Date(Date.now() + 300000),
          },
        });
      }
    }
    if (!ready) continue;
    await db.passPurchase.updateMany({
      where: {
        shopId: shop.id,
        status: "SUBMITTING",
        billingAttemptGid: null,
        submittedAt: { lt: new Date(Date.now() - 300000) },
      },
      data: { status: "UNKNOWN", lastError: "BILLING_RESULT_UNKNOWN" },
    });
    const due = await db.$queryRaw<
      { id: string }[]
    >`SELECT m.id FROM "PassMembership" m
      JOIN "PassPurchase" p ON p."membershipId" = m.id AND p.cycle = m."currentCycle"
      JOIN "Entitlement" e ON e.id = p."entitlementId"
      WHERE m."shopId" = ${shop.id}::uuid AND m.status = 'ACTIVE' AND m."autoRenew" = true
        AND p.status = 'PAID' AND e."startsAt" IS NOT NULL AND e."expiresAt" <= clock_timestamp()
        AND e.status IN ('ACTIVE', 'EXPIRED')
      ORDER BY e."expiresAt" ASC LIMIT 50`;
    for (const member of due) await claimDueMembershipCycle(member.id);
    const payments = await db.passPurchase.findMany({
      where: {
        shopId: shop.id,
        cycle: { gt: 1 },
        status: {
          in: ["BILLING_PENDING", "SUBMITTING", "UNKNOWN", "ACTION_REQUIRED"],
        },
        OR: [
          { status: "BILLING_PENDING", submittedAt: null },
          { billingAttemptGid: { not: null } },
        ],
      },
      take: 50,
      orderBy: { updatedAt: "asc" },
    });
    for (const payment of payments) {
      try {
        await processMembershipBilling(payment.id, admin);
        // Rotate not-yet-ready provider attempts so the first batch cannot starve later work.
        await db.passPurchase.updateMany({
          where: {
            id: payment.id,
            status: { in: ["BILLING_PENDING", "ACTION_REQUIRED"] },
            billingAttemptGid: { not: null },
          },
          data: { updatedAt: new Date() },
        });
      } catch {
        await db.passPurchase.updateMany({
          where: { id: payment.id, status: { not: "PAID" } },
          data: { status: "REVIEW", lastError: "BILLING_REQUIRES_REVIEW" },
        });
      }
    }
    const orders = await db.outboxEvent.findMany({
      where: {
        shopId: shop.id,
        kind: "MEMBERSHIP_ORDER_RECONCILE",
        status: "PENDING",
        availableAt: { lte: new Date() },
      },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
      take: 50,
    });
    for (const event of orders) {
      const data = event.payload as { orderGid: string; membershipId: string };
      const paid = await db.passPurchase.findFirst({
        where: {
          shopId: shop.id,
          membershipId: data.membershipId,
          sourceOrderGid: data.orderGid,
          status: "PAID",
        },
      });
      if (paid) {
        await db.$transaction(async (tx) => {
          await tx.outboxEvent.update({
            where: { id: event.id },
            data: { status: "DONE", lastError: null },
          });
          await tx.webhookReceipt.updateMany({
            where: { id: event.aggregateId, shopId: shop.id },
            data: { status: "PROCESSED" },
          });
        });
      } else {
        const pendingPayment = await db.passPurchase.findFirst({
          where: {
            shopId: shop.id,
            membershipId: data.membershipId,
            submittedAt: { not: null },
            status: { not: "PAID" },
          },
        });
        if (!pendingPayment)
          await db.passMembership.update({
            where: { id: data.membershipId },
            data: { autoRenew: false, status: "PAYMENT_REVIEW" },
          });
        // Keep the unresolved order blocking billing, but rotate it out of this
        // batch so later verified orders can finish their reconciliation.
        await db.outboxEvent.update({
          where: { id: event.id },
          data: {
            attempts: { increment: 1 },
            lastError: "UNMATCHED_PAID_ORDER",
            availableAt: new Date(Date.now() + 300000),
          },
        });
      }
    }
  }
}
