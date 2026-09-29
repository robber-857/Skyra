import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";

// Resend's last_event is provider evidence, not proof a human read the email.
// Sending-only API keys cannot read this endpoint; expose that limitation.
export async function syncMailDeliveryStatus(
  shopId: string,
  id: string,
  send: typeof fetch = fetch,
) {
  const notification = await db.bookingNotification.findFirst({
    where: { id, shopId, status: "ACCEPTED", providerMessageId: { not: null } },
  });
  if (!notification)
    throw new DomainError("NOT_FOUND", "No accepted email to check.", 404);
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
  await db.bookingNotification.update({
    where: { id },
    data: { deliveryStatus, deliveryError, deliveryCheckedAt: new Date() },
  });
}

export async function refreshMailDeliveryStatus(actor: Actor, id: string) {
  requireOperations(actor);
  z.uuid().parse(id);
  await syncMailDeliveryStatus(actor.shopId, id);
}

export async function sweepMailDeliveryStatus() {
  if (
    !process.env.RESEND_API_KEY ||
    process.env.SKYRA_MAIL_PROVIDER !== "resend" ||
    !process.env.SKYRA_BOOKING_MAIL_SHOP
  )
    return;
  const shop = await db.shop.findFirst({
    where: { domain: process.env.SKYRA_BOOKING_MAIL_SHOP, status: "ACTIVE" },
  });
  if (!shop) return;
  const notification = await db.bookingNotification.findFirst({
    where: {
      shopId: shop.id,
      status: "ACCEPTED",
      providerMessageId: { not: null },
      acceptedAt: { gt: new Date(Date.now() - 7 * 86400000) },
      OR: [
        { deliveryCheckedAt: null },
        { deliveryCheckedAt: { lt: new Date(Date.now() - 15 * 60000) } },
      ],
    },
    orderBy: [
      { deliveryCheckedAt: { sort: "asc", nulls: "first" } },
      { acceptedAt: "desc" },
    ],
  });
  if (notification) await syncMailDeliveryStatus(shop.id, notification.id);
}
