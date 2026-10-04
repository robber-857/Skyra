import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { grantEntitlementInTransaction } from "./entitlements.server";
import { PASS_PURCHASE_REFERENCE_KEY } from "./shopify-membership.server";
import { queueContractReconciliation } from "./membership-lifecycle.server";
import { retainPaidMembershipReceipt } from "./membership-notifications.server";

const id = z.union([
  z.string().regex(/^[1-9]\d*$/),
  z.number().int().positive().safe(),
]);
const money = z
  .string()
  .regex(/^\d+\.\d{2}$/)
  .transform((s) => Number(s.replace(".", "")));
const orderSchema = z.object({
  admin_graphql_api_id: z.string().regex(/^gid:\/\/shopify\/Order\/[1-9]\d*$/),
  customer: z.object({ admin_graphql_api_id: z.string() }).nullable(),
  financial_status: z.string(),
  cancelled_at: z.string().nullable().optional(),
  currency: z.string(),
  current_total_price: money,
  total_discounts: money,
  line_items: z.array(
    z.object({
      admin_graphql_api_id: z.string(),
      product_id: id,
      variant_id: id,
      quantity: z.number().int(),
      price: money,
      properties: z
        .array(z.object({ name: z.string(), value: z.string().nullable() }))
        .default([]),
    }),
  ),
});
export type VerifiedPassPayment = {
  paidPriceCents?: number;
  orderGid: string;
  lineItemGid: string;
  customerGid: string;
  productGid: string;
  variantGid: string;
  priceCents: number;
  currency: string;
  quantity: number;
};

async function review(
  tx: Prisma.TransactionClient,
  purchaseId: string,
  shopId: string,
  code: string,
) {
  const p = await tx.passPurchase.findUniqueOrThrow({
    where: { id: purchaseId },
  });
  // Never downgrade a successful payment or undo the already-granted Pass.
  await tx.passPurchase.update({
    where: { id: p.id },
    data: {
      ...(p.status !== "PAID" ? { status: "REVIEW" } : {}),
      lastError: code,
    },
  });
  await tx.passMembership.update({
    where: { id: p.membershipId },
    data: { autoRenew: false, status: "PAYMENT_REVIEW" },
  });
  await tx.outboxEvent.upsert({
    where: {
      shopId_kind_aggregateId_version: {
        shopId,
        kind: "MEMBERSHIP_PAYMENT_REVIEW",
        aggregateId: p.id,
        version: 1,
      },
    },
    create: {
      shopId,
      kind: "MEMBERSHIP_PAYMENT_REVIEW",
      aggregateId: p.id,
      version: 1,
      payload: { code },
    },
    update: { payload: { code }, status: "PENDING" },
  });
  return { status: "NEEDS_ATTENTION" };
}

export async function settlePassPurchasePayment(
  purchaseId: string,
  payment: VerifiedPassPayment,
) {
  return db.$transaction(
    async (tx) => {
      const first = await tx.passPurchase.findUniqueOrThrow({
        where: { id: purchaseId },
        include: { membership: true },
      });
      await tx.$queryRaw`SELECT id FROM "CustomerProfile" WHERE id = ${first.membership.customerId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "PassMembership" WHERE id = ${first.membershipId}::uuid FOR UPDATE`;
      const purchase = await tx.passPurchase.findUniqueOrThrow({
        where: { id: purchaseId },
        include: { membership: true },
      });
      const customer = await tx.customerProfile.findUniqueOrThrow({
        where: { id: purchase.membership.customerId },
      });
      const paidPriceCents = payment.paidPriceCents ?? payment.priceCents;
      if (purchase.status === "PAID") {
        if (
          purchase.sourceOrderGid === payment.orderGid &&
          purchase.sourceLineItemGid === payment.lineItemGid
        ) {
          await retainPaidMembershipReceipt(tx, purchase.id);
          return { status: "PAID" };
        }
        return review(tx, purchase.id, purchase.shopId, "DUPLICATE_PAID_ORDER");
      }
      if (
        payment.customerGid !== customer.shopifyCustomerGid ||
        payment.productGid !== purchase.productGid ||
        payment.variantGid !== purchase.variantGid ||
        payment.currency !== purchase.currency ||
        payment.priceCents !== purchase.priceCents ||
        !Number.isSafeInteger(paidPriceCents) ||
        paidPriceCents < 0 ||
        paidPriceCents > purchase.priceCents ||
        (purchase.cycle > 1 && paidPriceCents !== purchase.priceCents) ||
        payment.quantity !== 1
      )
        return review(
          tx,
          purchase.id,
          purchase.shopId,
          "PAYMENT_DETAILS_MISMATCH",
        );
      const reused = await tx.passPurchase.findFirst({
        where: {
          shopId: purchase.shopId,
          sourceOrderGid: payment.orderGid,
          sourceLineItemGid: payment.lineItemGid,
          id: { not: purchase.id },
        },
      });
      if (reused)
        return review(
          tx,
          purchase.id,
          purchase.shopId,
          "PAYMENT_SOURCE_ALREADY_USED",
        );
      const { entitlement } = await grantEntitlementInTransaction(tx, {
        shopId: purchase.shopId,
        customerId: customer.id,
        passPlanId: purchase.membership.passPlanId,
        productMappingId: purchase.productMappingId,
        sourceOrderGid: payment.orderGid,
        sourceLineItemGid: payment.lineItemGid,
        startsAt: null,
        expiresAt: null,
        validityDays: purchase.validityDays,
        validityMonths: purchase.validityMonths,
        activationTimezone: purchase.timezone,
        grantedUnits: purchase.credits,
        idempotencyKey: `paid-grant:${payment.orderGid}:${payment.lineItemGid}`,
      });
      await tx.entitlement.update({
        where: { id: entitlement.id },
        data: {
          activationMode:
            purchase.mode === "AUTO_RENEW" || purchase.validityMonths === 1
              ? "FIRST_ATTENDANCE"
              : "FIRST_BOOKING",
        },
      });
      await tx.passPurchase.update({
        where: { id: purchase.id },
        data: {
          status: "PAID",
          paidPriceCents,
          sourceOrderGid: payment.orderGid,
          sourceLineItemGid: payment.lineItemGid,
          entitlementId: entitlement.id,
          lastError: null,
        },
      });
      await retainPaidMembershipReceipt(tx, purchase.id);
      if (purchase.membership.status !== "CANCELLED")
        await tx.passMembership.update({
          where: { id: purchase.membershipId },
          data: { status: "WAITING_ACTIVATION" },
        });
      await queueContractReconciliation(
        tx,
        purchase.shopId,
        purchase.membershipId,
      );
      await tx.auditLog.create({
        data: {
          shopId: purchase.shopId,
          actorId: "SYSTEM",
          action: "MEMBERSHIP_PAID",
          entityId: purchase.id,
          after: {
            orderGid: payment.orderGid,
            entitlementId: entitlement.id,
            cycle: purchase.cycle,
          },
        },
      });
      return { status: "PAID" };
    },
    { timeout: 20000 },
  );
}

// Invoked only after authenticate.webhook; the public client cannot assert payment.
export async function receiveMembershipOrderPaid(input: {
  shopDomain: string;
  payload: unknown;
  webhookId: string;
  rawBody: string;
}) {
  const parsed = orderSchema.safeParse(input.payload);
  if (!parsed.success) {
    // A malformed managed event must be retried, not silently acknowledged as unrelated.
    if (JSON.stringify(input.payload).includes(PASS_PURCHASE_REFERENCE_KEY))
      throw new DomainError(
        "MEMBERSHIP_PAYMENT_INVALID",
        "Membership payment requires review.",
        503,
      );
    return;
  }
  const order = parsed.data;
  const shop = await db.shop.findUnique({
    where: { domain: input.shopDomain },
  });
  if (!shop) return;
  const references = order.line_items.flatMap((line) =>
    line.properties
      .filter((p) => p.name === PASS_PURCHASE_REFERENCE_KEY)
      .map((p) => ({ reference: p.value, line })),
  );
  if (!references.length) return;
  if (references.length !== 1 || order.line_items.length !== 1)
    throw new DomainError(
      "MEMBERSHIP_PAYMENT_INVALID",
      "Membership payment requires review.",
      503,
    );
  const { reference, line } = references[0];
  const purchase = await db.passPurchase.findFirst({
    where: { shopId: shop.id, reference: reference || "" },
  });
  if (!purchase)
    throw new DomainError(
      "MEMBERSHIP_PAYMENT_INVALID",
      "Unknown membership purchase.",
      503,
    );
  const hash = createHash("sha256").update(input.rawBody).digest("hex");
  const receiptKey = `membership:${input.webhookId}`;
  const receipt = await db.webhookReceipt.upsert({
    where: { shopId_webhookId: { shopId: shop.id, webhookId: receiptKey } },
    create: {
      shopId: shop.id,
      webhookId: receiptKey,
      topic: "memberships/orders/paid",
      payloadHash: hash,
    },
    update: {},
  });
  if (receipt.payloadHash !== hash)
    throw new DomainError("WEBHOOK_CONFLICT", "Webhook requires review.", 409);
  if (receipt.status === "PROCESSED")
    return {
      skipBooking:
        !purchase.bookingCheckoutId ||
        purchase.sourceOrderGid !== order.admin_graphql_api_id,
    };
  // Recurring orders may copy the first order's booking and purchase references.
  // Preserve the event until the billing worker proves its order/cycle binding.
  if (
    purchase.status === "PAID" &&
    purchase.sourceOrderGid !== order.admin_graphql_api_id
  ) {
    await db.outboxEvent.upsert({
      where: {
        shopId_kind_aggregateId_version: {
          shopId: shop.id,
          kind: "MEMBERSHIP_ORDER_RECONCILE",
          aggregateId: receipt.id,
          version: 1,
        },
      },
      create: {
        shopId: shop.id,
        kind: "MEMBERSHIP_ORDER_RECONCILE",
        aggregateId: receipt.id,
        version: 1,
        payload: {
          orderGid: order.admin_graphql_api_id,
          membershipId: purchase.membershipId,
        },
      },
      update: {},
    });
    await db.webhookReceipt.update({
      where: { id: receipt.id },
      data: { status: "QUEUED" },
    });
    return { skipBooking: true };
  }
  let result;
  if (
    order.financial_status !== "paid" ||
    order.cancelled_at ||
    !order.customer ||
    order.total_discounts > purchase.priceCents ||
    order.current_total_price + order.total_discounts !== purchase.priceCents ||
    (purchase.cycle > 1 && order.total_discounts !== 0)
  ) {
    result = await db.$transaction((tx) =>
      review(tx, purchase.id, shop.id, "PAYMENT_TOTAL_MISMATCH"),
    );
  } else
    result = await settlePassPurchasePayment(purchase.id, {
      orderGid: order.admin_graphql_api_id,
      lineItemGid: line.admin_graphql_api_id,
      customerGid: order.customer.admin_graphql_api_id,
      productGid: `gid://shopify/Product/${line.product_id}`,
      variantGid: `gid://shopify/ProductVariant/${line.variant_id}`,
      quantity: line.quantity,
      currency: order.currency,
      priceCents: line.price,
      paidPriceCents: order.current_total_price,
    });
  await db.webhookReceipt.update({
    where: { id: receipt.id },
    data: {
      status: result.status === "PAID" ? "PROCESSED" : "NEEDS_ATTENTION",
    },
  });
  return {
    skipBooking: !purchase.bookingCheckoutId || result.status !== "PAID",
  };
}
