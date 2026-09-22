import db from "../db.server";
import { databaseNow } from "./booking.server";
import { deliverBookingNotification } from "./booking-notifications.server";
import { resolveShopifyCustomerEmail } from "./customer-notification-email.server";
import { log } from "../lib/log.server";
import {
  sendTransactionalMail,
  transactionalMailReady,
  transactionalMailRecipientAllowed,
  type TransactionalMail,
  type MailOutcome,
} from "./transactional-mail.server";

export type CustomerEmailResolver = (
  shopDomain: string,
  shopifyCustomerGid: string,
) => Promise<string | null>;

const shopifyCustomerEmail: CustomerEmailResolver = async (domain, gid) => {
  // Load Shopify only when a live Customer job is due. This keeps pure mail
  // tests and disabled transports independent from Shopify runtime secrets.
  const { unauthenticated } = await import("../shopify.server");
  const { admin } = await unauthenticated.admin(domain);
  return resolveShopifyCustomerEmail(admin.graphql, gid);
};

// Destinations are resolved from trusted server records at send time. Customer
// addresses come from Shopify protected customer data, never browser input.
async function destination(
  shopId: string,
  kind: string,
  recipientId: string,
  resolveCustomer: CustomerEmailResolver,
) {
  const shop = await db.shop.findFirst({
    where: {
      id: shopId,
      status: "ACTIVE",
      domain: process.env.SKYRA_BOOKING_MAIL_SHOP || "__disabled__",
    },
  });
  if (!shop) return null;
  if (kind === "ADMIN" && recipientId === shopId) return shop.operationsEmail;
  if (kind === "COACH") {
    const coach = await db.coach.findFirst({
      where: { id: recipientId, shopId, status: "ACTIVE" },
    });
    return coach?.notificationEmail || null;
  }
  if (kind === "CUSTOMER") {
    const customer = await db.customerProfile.findFirst({
      where: { id: recipientId, shopId },
      select: { shopifyCustomerGid: true },
    });
    return customer
      ? resolveCustomer(shop.domain, customer.shopifyCustomerGid)
      : null;
  }
  return null;
}

export async function deliverInternalBookingMail(
  id: string,
  send: (
    mail: TransactionalMail,
  ) => Promise<MailOutcome> = sendTransactionalMail,
  resolveCustomer: CustomerEmailResolver = shopifyCustomerEmail,
) {
  const notification = await db.bookingNotification.findUniqueOrThrow({
    where: { id },
  });
  const to = await destination(
    notification.shopId,
    notification.recipientKind,
    notification.recipientId,
    resolveCustomer,
  );
  if (!to || !transactionalMailRecipientAllowed(to)) return;
  await deliverBookingNotification(id, async (input) => {
    const result = await send({
      to,
      subject: input.subject,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
    });
    if (result.status === "UNKNOWN")
      throw new Error("Ambiguous provider acceptance");
    return result;
  });
}

export async function sweepInternalBookingMail() {
  if (!transactionalMailReady() || !process.env.SKYRA_BOOKING_MAIL_SHOP) return;
  const shop = await db.shop.findFirst({
    where: { domain: process.env.SKYRA_BOOKING_MAIL_SHOP, status: "ACTIVE" },
  });
  if (!shop) return;
  const now = await databaseNow(db);
  const jobs = await db.bookingNotification.findMany({
    where: {
      shopId: shop.id,
      recipientKind: { in: ["CUSTOMER", "COACH", "ADMIN"] },
      status: "PENDING",
      availableAt: { lte: now },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let processed = 0;
  for (const job of jobs) {
    try {
      await deliverInternalBookingMail(job.id);
      if (++processed >= 10) break;
    } catch (error) {
      log.warn(
        { err: error, notificationId: job.id },
        "Booking email recipient resolution failed",
      );
    }
  }
}
