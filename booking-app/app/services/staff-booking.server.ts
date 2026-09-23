import { randomUUID } from "node:crypto";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import { audit } from "./catalog.server";
import {
  bookingWindow,
  classForBooking,
  classAvailability,
  databaseNow,
} from "./booking.server";
import {
  eligibleEntitlements,
  reserveEntitlementCredit,
} from "./entitlements.server";
import { enqueueBookingNotifications } from "./booking-notifications.server";

export async function staffBookingOptions(actor: Actor, customerId: string) {
  requireOperations(actor);
  const customer = await db.customerProfile.findFirst({
    where: { shopId: actor.shopId, id: customerId },
  });
  const shop = await db.shop.findFirst({
    where: { id: actor.shopId, status: "ACTIVE" },
  });
  if (!shop || !customer)
    throw new DomainError("NOT_FOUND", "Client not found.", 404);
  const now = await databaseNow(db);
  const sessions = await db.classSession.findMany({
    where: {
      shopId: actor.shopId,
      status: "PUBLISHED",
      startsAt: { gt: now, lte: new Date(now.getTime() + 15 * 86400000) },
      service: {
        status: "ACTIVE",
        kind: { in: ["CLASS", "APPOINTMENT", "COURSE"] },
      },
      coach: { status: "ACTIVE" },
    },
    include: { service: true, coach: true, location: true },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  const capacity = await classAvailability(
    actor.shopId,
    sessions.map((s) => s.id),
  );
  const booked = await db.booking.findMany({
    where: {
      shopId: actor.shopId,
      customerId,
      status: { in: ["CONFIRMED", "ATTENDED"] },
      sessionId: { in: sessions.map((s) => s.id) },
    },
    select: { sessionId: true },
  });
  const options = [];
  for (const s of sessions) {
    if (
      bookingWindow(shop, s, now) !== "OPEN" ||
      !capacity.get(s.id) ||
      booked.some((b) => b.sessionId === s.id)
    )
      continue;
    const passes = await eligibleEntitlements(db, {
      shopId: actor.shopId,
      customerId,
      serviceId: s.serviceId,
      sessionStartsAt: s.startsAt,
      now,
    });
    options.push({
      id: s.id,
      name: s.service.name,
      coach: s.coach.name,
      location: s.location.name,
      startsAt: s.startsAt.toISOString(),
      timezone: s.timezone,
      remaining: capacity.get(s.id)!,
      passes: passes.map((p) => ({
        id: p.id,
        name: p.name,
        available: p.availableUnits,
      })),
    });
  }
  return options;
}

const schema = z
  .object({
    customerId: z.string().uuid(),
    sessionId: z.string().uuid(),
    entitlementId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export async function bookClientIntoSession(actor: Actor, raw: unknown) {
  requireOperations(actor);
  const input = schema.parse(raw);
  return db.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM "ClassSession" WHERE id = ${input.sessionId}::uuid AND "shopId" = ${actor.shopId}::uuid FOR UPDATE`;
      const shop = await tx.shop.findFirst({
        where: { id: actor.shopId, status: "ACTIVE" },
      });
      const customer = await tx.customerProfile.findFirst({
        where: { id: input.customerId, shopId: actor.shopId },
      });
      if (!locked.length || !shop || !customer)
        throw new DomainError("NOT_FOUND", "Client or class not found.", 404);
      const key = `staff-booking:${input.idempotencyKey}`;
      const request = { ...input, actorId: actor.actorId };
      const previous = await tx.entitlementLedgerEntry.findUnique({
        where: {
          shopId_idempotencyKey: { shopId: actor.shopId, idempotencyKey: key },
        },
      });
      if (previous) {
        const log = await tx.auditLog.findFirst({
          where: {
            shopId: actor.shopId,
            entityId: previous.bookingId!,
            action: "STAFF_BOOKING_CONFIRMED",
          },
        });
        const saved = log?.after as Record<string, unknown> | undefined;
        if (!saved || Object.entries(request).some(([k, v]) => saved[k] !== v))
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "This booking request has already been used.",
          );
        return previous.bookingId!;
      }
      const now = await databaseNow(tx);
      const session = await classForBooking(tx, shop, input.sessionId, now);
      if (
        await tx.booking.findFirst({
          where: {
            shopId: actor.shopId,
            customerId: customer.id,
            sessionId: session.id,
            status: { in: ["CONFIRMED", "ATTENDED"] },
          },
        })
      )
        throw new DomainError(
          "ALREADY_BOOKED",
          "This client is already booked into this class.",
        );
      if (
        !(await classAvailability(actor.shopId, [session.id], tx)).get(
          session.id,
        )
      )
        throw new DomainError(
          "SOLD_OUT",
          "This class is full, including seats currently held for checkout.",
        );
      const passes = await eligibleEntitlements(tx, {
        shopId: actor.shopId,
        customerId: customer.id,
        serviceId: session.serviceId,
        sessionStartsAt: session.startsAt,
        now,
      });
      if (!passes.some((p) => p.id === input.entitlementId))
        throw new DomainError(
          "PASS_UNAVAILABLE",
          "Choose an eligible Pass with available credits for this client.",
        );
      const booking = await tx.booking.create({
        data: {
          shopId: actor.shopId,
          customerId: customer.id,
          sessionId: session.id,
        },
      });
      await reserveEntitlementCredit(tx, {
        shopId: actor.shopId,
        entitlementId: input.entitlementId,
        customerId: customer.id,
        serviceId: session.serviceId,
        sessionStartsAt: session.startsAt,
        now,
        reservationKey: randomUUID(),
        idempotencyKey: key,
        bookingId: booking.id,
      });
      await enqueueBookingNotifications(tx, actor.shopId, booking.id);
      await audit(
        tx,
        actor,
        "STAFF_BOOKING_CONFIRMED",
        booking.id,
        null,
        request,
      );
      return booking.id;
    },
    { maxWait: 30000, timeout: 15000 },
  );
}
