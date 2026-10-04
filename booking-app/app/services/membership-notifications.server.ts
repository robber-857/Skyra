import { createHash, randomUUID } from "node:crypto";
import type { Prisma, MembershipReceipt } from "@prisma/client";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { databaseNow } from "./booking.server";
import {
  DEVELOPMENT_BOOKING_SHOP,
  PRODUCTION_BOOKING_SHOP,
} from "./commerce-capabilities.server";
import { resolveShopifyCustomerEmail } from "./customer-notification-email.server";
import {
  sendTransactionalMail,
  transactionalMailReady,
  transactionalMailRecipientAllowed,
  type MailOutcome,
  type TransactionalMail,
} from "./transactional-mail.server";

export function membershipManagementUrl(domain: string) {
  if (![DEVELOPMENT_BOOKING_SHOP, PRODUCTION_BOOKING_SHOP].includes(domain))
    return null;
  return `https://${domain}/pages/membership#membership-options`;
}

function paidEmail(receipt: MembershipReceipt, domain: string) {
  const renewal = receipt.cycle > 1;
  const amount = `${receipt.currency} ${(receipt.priceCents / 100).toFixed(2)}`;
  const manage = membershipManagementUrl(domain);
  const firstClass =
    receipt.mode === "AUTO_RENEW" || receipt.validityMonths === 1
      ? "first attended class"
      : "first booked class";
  const start = receipt.validityMonths
    ? `This Pass is valid for ${receipt.validityMonths} calendar ${receipt.validityMonths === 1 ? "month" : "months"} from your ${firstClass} in this period.`
    : `This Pass is valid for ${receipt.validityDays} days from your ${firstClass} in this period.`;
  return {
    subject: `${renewal ? "Pass renewal" : "Pass purchase"} confirmed: ${receipt.passName}`,
    bodyText: [
      `Your ${renewal ? "renewal" : "purchase"} payment of ${amount} for ${receipt.passName} is confirmed.`,
      `Period ${receipt.cycle}: ${receipt.credits} class credits.`,
      start,
      ...(receipt.mode === "AUTO_RENEW"
        ? [
            "No further renewal is charged while this paid Pass is waiting for its first attended class.",
          ]
        : []),
      `Payment receipt reference: ${receipt.id}.`,
      `Shopify order reference: ${receipt.sourceOrderGid.split("/").pop()}.`,
      "The Shopify order is the authoritative payment record. This message is a payment receipt, not a tax invoice.",
      manage
        ? `View your Pass and manage renewal: ${manage}`
        : "Sign in to the Membership page to view your Pass and manage renewal.",
    ].join("\n\n"),
  };
}

// Called inside verified payment settlement, after setting PAID and source IDs.
// The receipt and notification commit with that payment; this function never sends.
export async function retainPaidMembershipReceipt(
  tx: Prisma.TransactionClient,
  purchaseId: string,
  verifiedPaidAt?: Date,
) {
  await tx.$queryRaw`SELECT id FROM "PassPurchase" WHERE id = ${purchaseId}::uuid FOR UPDATE`;
  const purchase = await tx.passPurchase.findUniqueOrThrow({
    where: { id: purchaseId },
    include: { membership: true },
  });
  if (
    purchase.status !== "PAID" ||
    !/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(purchase.sourceOrderGid || "") ||
    !/^gid:\/\/shopify\/LineItem\/[1-9]\d*$/.test(
      purchase.sourceLineItemGid || "",
    ) ||
    (verifiedPaidAt && !Number.isFinite(verifiedPaidAt.getTime()))
  )
    throw new DomainError(
      "RECEIPT_PAYMENT_UNVERIFIED",
      "Only a verified paid purchase can have a payment receipt.",
      409,
    );
  let receipt = await tx.membershipReceipt.findUnique({
    where: { purchaseId },
  });
  if (!receipt) {
    const plan = await tx.passPlan.findFirstOrThrow({
      where: { id: purchase.membership.passPlanId, shopId: purchase.shopId },
    });
    const snapshot = {
      shopId: purchase.shopId,
      purchaseId,
      customerId: purchase.membership.customerId,
      passPlanId: plan.id,
      passName: plan.name,
      cycle: purchase.cycle,
      mode: purchase.mode,
      sourceOrderGid: purchase.sourceOrderGid!,
      sourceLineItemGid: purchase.sourceLineItemGid!,
      priceCents: purchase.paidPriceCents ?? purchase.priceCents,
      currency: purchase.currency,
      credits: purchase.credits,
      validityDays: purchase.validityDays,
      validityMonths: purchase.validityMonths,
      timezone: purchase.timezone,
      termsVersion: purchase.termsVersion,
      paidAt: verifiedPaidAt ?? null,
    };
    receipt = await tx.membershipReceipt.create({
      data: {
        ...snapshot,
        issuedAt: await databaseNow(tx),
        snapshotHash: createHash("sha256")
          .update(JSON.stringify(snapshot))
          .digest("hex"),
      },
    });
  } else if (
    receipt.sourceOrderGid !== purchase.sourceOrderGid ||
    receipt.sourceLineItemGid !== purchase.sourceLineItemGid ||
    receipt.priceCents !== purchase.priceCents ||
    receipt.currency !== purchase.currency ||
    receipt.customerId !== purchase.membership.customerId
  )
    throw new DomainError(
      "RECEIPT_PAYMENT_CONFLICT",
      "The original payment receipt requires review.",
      409,
    );
  const shop = await tx.shop.findUniqueOrThrow({
    where: { id: purchase.shopId },
  });
  const email = paidEmail(receipt, shop.domain);
  const id = randomUUID();
  const notification = await tx.membershipNotification.upsert({
    where: { purchaseId_event: { purchaseId, event: "PAID" } },
    create: {
      id,
      shopId: purchase.shopId,
      purchaseId,
      receiptId: receipt.id,
      event: "PAID",
      template: "MEMBERSHIP_PAID_V1",
      ...email,
      idempotencyKey: `skyra-membership-email:${id}`,
    },
    update: {},
  });
  return { receipt, notification };
}

function deliveryAllowed(domain: string) {
  return (
    process.env.SKYRA_MEMBERSHIP_MAIL_ENABLED === "true" &&
    process.env.SKYRA_BOOKING_MAIL_SHOP === domain &&
    Boolean(membershipManagementUrl(domain)) &&
    transactionalMailReady() &&
    (domain !== DEVELOPMENT_BOOKING_SHOP ||
      z.email().safeParse(process.env.SKYRA_MAIL_TEST_RECIPIENT).success)
  );
}

export type MembershipCustomerEmailResolver = (
  domain: string,
  customerGid: string,
) => Promise<string | null>;
const shopifyEmail: MembershipCustomerEmailResolver = async (
  domain,
  customerGid,
) => {
  const { unauthenticated } = await import("../shopify.server");
  const { admin } = await unauthenticated.admin(domain);
  return resolveShopifyCustomerEmail(admin.graphql, customerGid);
};

export async function deliverMembershipNotification(
  id: string,
  send: (
    mail: TransactionalMail,
  ) => Promise<MailOutcome> = sendTransactionalMail,
  resolveCustomer: MembershipCustomerEmailResolver = shopifyEmail,
) {
  const notification = await db.membershipNotification.findUniqueOrThrow({
    where: { id },
    include: { receipt: true },
  });
  if (notification.status !== "PENDING") return;
  const shop = await db.shop.findFirst({
    where: { id: notification.shopId, status: "ACTIVE" },
  });
  if (!shop || !deliveryAllowed(shop.domain)) return;
  const customer = await db.customerProfile.findFirstOrThrow({
    where: { id: notification.receipt.customerId, shopId: shop.id },
    select: { shopifyCustomerGid: true },
  });
  const to =
    notification.recipientEmail ??
    (await resolveCustomer(shop.domain, customer.shopifyCustomerGid));
  if (
    !z.email().safeParse(to).success ||
    !transactionalMailRecipientAllowed(to!)
  ) {
    await db.membershipNotification.updateMany({
      where: { id, status: "PENDING" },
      data: {
        lastError: !to ? "RECIPIENT_UNAVAILABLE" : "RECIPIENT_NOT_ALLOWED",
        availableAt: new Date(Date.now() + 15 * 60000),
      },
    });
    return;
  }
  const now = await databaseNow(db);
  const claim = await db.membershipNotification.updateMany({
    where: { id, status: "PENDING", availableAt: { lte: now } },
    data: {
      status: "SENDING",
      claimedAt: now,
      recipientEmail: to!,
      attempts: { increment: 1 },
    },
  });
  if (!claim.count) return;
  let result: MailOutcome;
  try {
    result = await send({
      to: to!,
      subject: notification.subject,
      text: notification.bodyText,
      idempotencyKey: notification.idempotencyKey,
    });
  } catch {
    result = { status: "UNKNOWN" };
  }
  await db.membershipNotification.updateMany({
    where: { id, status: "SENDING" },
    data:
      result.status === "ACCEPTED"
        ? {
            status: "ACCEPTED",
            acceptedAt: await databaseNow(db),
            providerMessageId: result.messageId,
            lastError: null,
          }
        : {
            status: result.status,
            lastError:
              result.status === "UNKNOWN"
                ? "DELIVERY_OUTCOME_UNKNOWN"
                : "DELIVERY_REJECTED",
          },
  });
}

export async function sweepMembershipNotifications(
  send: (
    mail: TransactionalMail,
  ) => Promise<MailOutcome> = sendTransactionalMail,
  resolveCustomer: MembershipCustomerEmailResolver = shopifyEmail,
) {
  const domain = process.env.SKYRA_BOOKING_MAIL_SHOP;
  if (!domain || !deliveryAllowed(domain)) return;
  const shop = await db.shop.findFirst({ where: { domain, status: "ACTIVE" } });
  if (!shop) return;
  const now = await databaseNow(db);
  // A crash after provider acceptance must not reset the job to PENDING.
  await db.membershipNotification.updateMany({
    where: {
      shopId: shop.id,
      status: "SENDING",
      claimedAt: { lt: new Date(now.getTime() - 10 * 60000) },
    },
    data: { status: "UNKNOWN", lastError: "DELIVERY_OUTCOME_UNKNOWN" },
  });
  const jobs = await db.membershipNotification.findMany({
    where: { shopId: shop.id, status: "PENDING", availableAt: { lte: now } },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const job of jobs) {
    try {
      await deliverMembershipNotification(job.id, send, resolveCustomer);
    } catch {
      // Recipient lookup has not submitted mail. Keep the durable job queued.
      await db.membershipNotification.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: {
          lastError: "RECIPIENT_LOOKUP_UNAVAILABLE",
          availableAt: new Date(Date.now() + 15 * 60000),
        },
      });
    }
  }
}

// Provider evidence is delivery to a mail server, not a customer's reading.
// This performs only a read, and cannot send or resend a receipt.
export async function syncMembershipMailDeliveryStatus(
  shopId: string,
  id: string,
  send: typeof fetch = fetch,
) {
  const notification = await db.membershipNotification.findFirst({
    where: { id, shopId, status: "ACCEPTED", providerMessageId: { not: null } },
  });
  if (!notification)
    throw new DomainError(
      "NOT_FOUND",
      "No accepted membership email to check.",
      404,
    );
  if (
    notification.deliveryCheckedAt &&
    notification.deliveryCheckedAt > new Date(Date.now() - 30000)
  )
    return;
  let deliveryStatus: string | undefined;
  let deliveryError: string | null = null;
  if (
    process.env.SKYRA_MAIL_PROVIDER !== "resend" ||
    !process.env.RESEND_API_KEY
  )
    deliveryError = "PROVIDER_NOT_CONFIGURED";
  else {
    try {
      const response = await send(
        `https://api.resend.com/emails/${encodeURIComponent(notification.providerMessageId!)}`,
        {
          headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok)
        deliveryError =
          response.status === 401 || response.status === 403
            ? "PROVIDER_READ_PERMISSION_REQUIRED"
            : "PROVIDER_STATUS_UNAVAILABLE";
      else {
        const result = z
          .object({
            id: z.string(),
            last_event: z.enum([
              "sent",
              "delivered",
              "delivery_delayed",
              "bounced",
              "complained",
              "opened",
              "clicked",
              "failed",
              "suppressed",
              "queued",
              "scheduled",
              "canceled",
            ]),
          })
          .safeParse(await response.json());
        if (result.success && result.data.id === notification.providerMessageId)
          deliveryStatus = result.data.last_event;
        else deliveryError = "PROVIDER_STATUS_UNAVAILABLE";
      }
    } catch {
      deliveryError = "PROVIDER_STATUS_UNAVAILABLE";
    }
  }
  await db.membershipNotification.update({
    where: { id },
    data: { deliveryStatus, deliveryError, deliveryCheckedAt: new Date() },
  });
}
