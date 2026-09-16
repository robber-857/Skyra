import db from "../db.server";
import { databaseNow } from "./booking.server";
import { deliverBookingNotification } from "./booking-notifications.server";
import {
  sendTransactionalMail,
  transactionalMailReady,
  type TransactionalMail,
  type MailOutcome,
} from "./transactional-mail.server";

// Only operator-authorized studio/coach destinations, resolved server-side.
// Customer mail needs a separate protected Shopify recipient resolver; do not
// infer Customer email from a newsletter form or accept it from the browser.
async function destination(shopId: string, kind: string, recipientId: string) {
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
  return null;
}

export async function deliverInternalBookingMail(
  id: string,
  send: (
    mail: TransactionalMail,
  ) => Promise<MailOutcome> = sendTransactionalMail,
) {
  const notification = await db.bookingNotification.findUniqueOrThrow({
    where: { id },
  });
  if (
    !(await destination(
      notification.shopId,
      notification.recipientKind,
      notification.recipientId,
    ))
  )
    return;
  await deliverBookingNotification(id, async (input) => {
    const to = await destination(
      input.shopId,
      input.recipientKind,
      input.recipientId,
    );
    if (!to) return { status: "FAILED" };
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
      recipientKind: { in: ["COACH", "ADMIN"] },
      status: "PENDING",
      availableAt: { lte: now },
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let processed = 0;
  for (const job of jobs) {
    if (!(await destination(job.shopId, job.recipientKind, job.recipientId)))
      continue;
    await deliverInternalBookingMail(job.id);
    if (++processed >= 10) break;
  }
}
