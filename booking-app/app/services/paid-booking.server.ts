import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import {
  bookingWindow,
  classAvailability,
  databaseNow,
} from "./booking.server";
import {
  grantEntitlementInTransaction,
  reserveEntitlementCredit,
} from "./entitlements.server";
import { enqueueBookingNotifications } from "./booking-notifications.server";

const payment = z.object({
  receiptId: z.string().uuid(),
  checkoutId: z.string().uuid(),
  orderGid: z.string().regex(/^gid:\/\/shopify\/Order\/[1-9]\d*$/),
  lineItemGid: z.string().regex(/^gid:\/\/shopify\/LineItem\/[1-9]\d*$/),
  purchasedAt: z.string().datetime({ offset: true }),
  codes: z.array(z.string()).length(0),
});
export const purchaseTerms = z.object({
  version: z.literal(1),
  credits: z.number().int().positive(),
  validityDays: z.number().int().positive(),
  timezone: z.string(),
  sessionStartsAt: z.string().datetime(),
  sessionEndsAt: z.string().datetime(),
  coachId: z.string().uuid(),
  locationId: z.string().uuid(),
  serviceId: z.string().uuid(),
  introOnly: z.boolean(),
});

// No Shopify network call runs inside this transaction. Input comes exclusively
// from the authenticated, validated inbox. Public checkout remains disabled.
export async function processPaidBookingEvent(eventId: string): Promise<{ status: string; reason?: string }> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "OutboxEvent" WHERE id = ${eventId}::uuid FOR UPDATE`;
      const event = await tx.outboxEvent.findUniqueOrThrow({
        where: { id: eventId },
      });
      if (event.kind !== "ORDER_PAID_RECEIVED")
        throw new DomainError("WRONG_EVENT", "Not a paid booking event.");
      if (event.status !== "PENDING") return { status: event.status };
      let now = await databaseNow(tx);
      if (event.attempts > 0 && event.availableAt > now)
        return { status: "DEFERRED" };
      const receipt = await tx.webhookReceipt.findFirst({
        where: {
          id: event.aggregateId,
          shopId: event.shopId,
          topic: "orders/paid",
        },
      });
      if (!receipt)
        throw new DomainError("RECEIPT_NOT_FOUND", "Payment receipt missing.");
      async function finish(reason?: string) {
        await tx.webhookReceipt.update({
          where: { id: receipt!.id },
          data: { status: reason ? "NEEDS_ATTENTION" : "PROCESSED" },
        });
        await tx.outboxEvent.update({
          where: { id: event.id },
          data: { status: "DONE", lastError: reason || null },
        });
        if (reason)
          await tx.outboxEvent.upsert({
            where: {
              shopId_kind_aggregateId_version: {
                shopId: event.shopId,
                kind: "ORDER_PAID_REVIEW",
                aggregateId: receipt!.id,
                version: 1,
              },
            },
            create: {
              shopId: event.shopId,
              kind: "ORDER_PAID_REVIEW",
              aggregateId: receipt!.id,
              version: 1,
              payload: { receiptId: receipt!.id, codes: [reason] },
            },
            update: {},
          });
        return { status: reason ? "NEEDS_ATTENTION" : "CONFIRMED", reason };
      }
      const parsed = payment.safeParse(event.payload);
      if (
        !parsed.success ||
        parsed.data.receiptId !== receipt.id ||
        receipt.status !== "QUEUED"
      )
        return finish("PAYMENT_CONTEXT_INVALID");
      const input = parsed.data;
      const checkout = await tx.bookingCheckout.findFirst({
        where: { id: input.checkoutId, shopId: event.shopId },
        include: { hold: true },
      });
      if (!checkout) return finish("CHECKOUT_NOT_FOUND");
      // Session -> Attempt is the same lock order used by holds and expiry sweeps.
      await tx.$queryRaw`SELECT id FROM "ClassSession" WHERE id = ${checkout.hold.sessionId}::uuid AND "shopId" = ${event.shopId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "BookingAttempt" WHERE id = ${checkout.hold.attemptId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "BookingCheckout" WHERE id = ${checkout.id}::uuid FOR UPDATE`;
      const prior = await tx.paidBookingResult.findFirst({
        where: {
          shopId: event.shopId,
          OR: [
            { checkoutId: checkout.id },
            {
              sourceOrderGid: input.orderGid,
              sourceLineItemGid: input.lineItemGid,
            },
          ],
        },
      });
      if (prior) {
        if (
          prior.checkoutId !== checkout.id ||
          prior.sourceOrderGid !== input.orderGid ||
          prior.sourceLineItemGid !== input.lineItemGid
        )
          return finish("PAYMENT_SOURCE_ALREADY_USED");
        return finish(
          prior.status === "CONFIRMED"
            ? undefined
            : prior.reason || "PAYMENT_REVIEW_REQUIRED",
        );
      }
      now = await databaseNow(tx);
      const current = await tx.bookingCheckout.findUniqueOrThrow({
        where: { id: checkout.id },
      });
      if (current.status !== "READY") return finish("CHECKOUT_NOT_READY");
      const termsResult = purchaseTerms.safeParse(current.purchaseTerms);
      if (!termsResult.success) return finish("CHECKOUT_TERMS_MISSING");
      const terms = termsResult.data;
      const hold = await tx.bookingHold.findUniqueOrThrow({
        where: { id: checkout.holdId },
      });
      const attempt = await tx.bookingAttempt.findUniqueOrThrow({
        where: { id: hold.attemptId },
      });
      const session = await tx.classSession.findUniqueOrThrow({
        where: { id: hold.sessionId },
        include: { service: true, coach: true },
      });
      const shop = await tx.shop.findUniqueOrThrow({
        where: { id: event.shopId },
      });
      const purchasedAt = new Date(input.purchasedAt);
      if (
        purchasedAt < current.createdAt ||
        purchasedAt.getTime() > receipt.receivedAt.getTime() + 60000
      )
        return finish("PURCHASE_TIME_INVALID");
      const expires =
        hold.purchaseKind === "DROP_IN"
          ? DateTime.fromISO(terms.sessionEndsAt)
          : DateTime.fromJSDate(purchasedAt, { zone: terms.timezone }).plus({
              days: terms.validityDays,
            });
      if (
        !expires.isValid ||
        expires.toMillis() <= purchasedAt.getTime() ||
        (hold.purchaseKind === "DROP_IN" && terms.credits !== 1)
      )
        return finish("PURCHASE_TERMS_INVALID");
      // Prevent granting a mutated mapping's terms to a different product/service.
      const mapping = await tx.productMapping.findFirst({
        where: { shopId: event.shopId, id: current.productMappingId },
      });
      if (
        !mapping ||
        mapping.productGid !== current.productGid ||
        mapping.variantGid !== current.variantGid ||
        (hold.passPlanId
          ? mapping.ownerType !== "PASS_PLAN" ||
            mapping.ownerId !== hold.passPlanId
          : mapping.ownerType !== "SERVICE" ||
            mapping.ownerId !== terms.serviceId)
      )
        return finish("PURCHASE_MAPPING_CHANGED");
      await tx.$queryRaw`SELECT id FROM "CustomerProfile" WHERE id = ${hold.customerId}::uuid AND "shopId" = ${event.shopId}::uuid FOR UPDATE`;
      const { entitlement } = await grantEntitlementInTransaction(tx, {
        shopId: event.shopId,
        customerId: hold.customerId,
        passPlanId: hold.passPlanId,
        serviceId: hold.purchaseKind === "DROP_IN" ? terms.serviceId : null,
        productMappingId: current.productMappingId,
        sourceOrderGid: input.orderGid,
        sourceLineItemGid: input.lineItemGid,
        startsAt: purchasedAt,
        expiresAt: expires.toJSDate(),
        grantedUnits: terms.credits,
        idempotencyKey: `paid-grant:${input.orderGid}:${input.lineItemGid}`,
      });
      let reason: string | undefined;
      if (shop.status !== "ACTIVE") reason = "SHOP_INACTIVE";
      else if (
        session.serviceId !== terms.serviceId ||
        session.startsAt.toISOString() !== terms.sessionStartsAt ||
        session.endsAt.toISOString() !== terms.sessionEndsAt ||
        session.coachId !== terms.coachId ||
        session.locationId !== terms.locationId ||
        session.timezone !== terms.timezone
      )
        reason = "SESSION_CHANGED";
      else if (
        session.service.status !== "ACTIVE" ||
        session.coach.status !== "ACTIVE"
      )
        reason = "SESSION_UNAVAILABLE";
      else if (
        attempt.expiresAt <= now ||
        (!["HOLD_ACTIVE", "STARTED"].includes(attempt.status) &&
          !(
            attempt.status === "RECOVERY" &&
            (hold.status === "EXPIRED" ||
              (hold.status === "ACTIVE" && hold.expiresAt <= now))
          ))
      )
        reason = "ATTEMPT_RECOVERY_REQUIRED";
      else if (!["ACTIVE", "EXPIRED"].includes(hold.status))
        reason = "HOLD_RELEASED";
      else if (bookingWindow(shop, session, now) !== "OPEN")
        reason = "BOOKING_WINDOW_CLOSED";
      else if (
        entitlement.expiresAt <= session.startsAt ||
        entitlement.expiresAt <= now
      )
        reason = "PASS_EXPIRED";
      if (!reason && hold.passPlanId) {
        const eligible = await tx.passEligibility.findUnique({
          where: {
            shopId_passPlanId_serviceId: {
              shopId: event.shopId,
              passPlanId: hold.passPlanId,
              serviceId: session.serviceId,
            },
          },
        });
        if (!eligible) reason = "PASS_ELIGIBILITY_CHANGED";
      }
      if (!reason && terms.introOnly) {
        const other = await tx.entitlement.count({
          where: {
            shopId: event.shopId,
            customerId: hold.customerId,
            id: { not: entitlement.id },
            status: { not: "PENDING" },
          },
        });
        if (
          other ||
          (await tx.booking.count({
            where: {
              shopId: event.shopId,
              customerId: hold.customerId,
              status: { not: "CANCELLED" },
            },
          }))
        )
          reason = "INTRO_REVIEW_REQUIRED";
      }
      // Remove this hold before computing availability and creating the Booking.
      // Both operations commit together; no other writer can enter this session.
      if (hold.status === "ACTIVE")
        await tx.bookingHold.update({
          where: { id: hold.id },
          data: { status: reason ? "RELEASED" : "CONSUMED" },
        });
      if (
        !reason &&
        (await tx.booking.count({
          where: {
            shopId: event.shopId,
            sessionId: session.id,
            customerId: hold.customerId,
            status: "CONFIRMED",
          },
        }))
      )
        reason = "ALREADY_BOOKED";
      if (
        !reason &&
        (await classAvailability(event.shopId, [session.id], tx)).get(
          session.id,
        ) === 0
      )
        reason = "SOLD_OUT";
      if (
        !reason &&
        (await tx.bookingHold.count({
          where: {
            shopId: event.shopId,
            sessionId: session.id,
            customerId: hold.customerId,
            id: { not: hold.id },
            status: "ACTIVE",
            expiresAt: { gt: now },
          },
        }))
      )
        reason = "ANOTHER_HOLD_ACTIVE";
      let bookingId: string | null = null;
      if (reason) {
        if (hold.status === "ACTIVE")
          await tx.bookingHold.update({
            where: { id: hold.id },
            data: { status: "RELEASED" },
          });
        await tx.bookingAttempt.update({
          where: { id: attempt.id },
          data: { status: "RECOVERY" },
        });
      } else {
        bookingId = randomUUID();
        await tx.booking.create({
          data: {
            id: bookingId,
            shopId: event.shopId,
            sessionId: session.id,
            customerId: hold.customerId,
            checkoutId: current.id,
            sourceOrderGid: input.orderGid,
            sourceLineItemGid: input.lineItemGid,
          },
        });
        await reserveEntitlementCredit(tx, {
          shopId: event.shopId,
          entitlementId: entitlement.id,
          customerId: hold.customerId,
          serviceId: session.serviceId,
          sessionStartsAt: session.startsAt,
          now,
          reservationKey: bookingId,
          bookingId,
          idempotencyKey: `booking-reserve:${bookingId}`,
        });
        if (hold.status === "EXPIRED")
          await tx.bookingHold.update({
            where: { id: hold.id },
            data: { status: "CONSUMED" },
          });
        await tx.bookingAttempt.update({
          where: { id: attempt.id },
          data: { status: "CONFIRMED" },
        });
        await enqueueBookingNotifications(tx, event.shopId, bookingId);
      }
      await tx.paidBookingResult.create({
        data: {
          shopId: event.shopId,
          checkoutId: current.id,
          sourceOrderGid: input.orderGid,
          sourceLineItemGid: input.lineItemGid,
          entitlementId: entitlement.id,
          bookingId,
          status: reason ? "NEEDS_ATTENTION" : "CONFIRMED",
          reason,
        },
      });
      await tx.auditLog.create({
        data: {
          shopId: event.shopId,
          actorId: "SYSTEM",
          action: reason ? "PAID_BOOKING_REVIEW" : "BOOKING_CONFIRMED",
          entityId: bookingId || current.id,
          after: {
            receiptId: receipt.id,
            entitlementId: entitlement.id,
            reason: reason || null,
          },
        },
      });
      return finish(reason);
    },
    { timeout: 20000, maxWait: 30000 },
  );
}

export async function recordPaidBookingFailure(eventId: string) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "OutboxEvent" WHERE id = ${eventId}::uuid FOR UPDATE`;
    const event = await tx.outboxEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    if (event.kind !== "ORDER_PAID_RECEIVED" || event.status !== "PENDING")
      return;
    const attempts = event.attempts + 1;
    await tx.outboxEvent.update({
      where: { id: eventId },
      data: {
        attempts,
        status: attempts >= 5 ? "FAILED" : "PENDING",
        availableAt: new Date(
          Date.now() + Math.min(3600000, 30000 * 2 ** attempts),
        ),
        lastError: "PAID_BOOKING_PROCESSING_FAILED",
      },
    });
    if (attempts >= 5)
      await tx.webhookReceipt.updateMany({
        where: {
          id: event.aggregateId,
          shopId: event.shopId,
          status: "QUEUED",
        },
        data: { status: "FAILED" },
      });
  });
}
