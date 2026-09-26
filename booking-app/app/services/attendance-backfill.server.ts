import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import { databaseNow } from "./booking.server";
import { audit } from "./catalog.server";
import {
  consumeEntitlementReservation,
  eligibleEntitlements,
  reserveEntitlementCredit,
} from "./entitlements.server";

export async function attendanceBackfillOptions(
  actor: Actor,
  customerId: string,
  requestedDate?: string | null,
) {
  requireOperations(actor);
  const shop = await db.shop.findFirst({
    where: { id: actor.shopId, status: "ACTIVE" },
  });
  const customer = await db.customerProfile.findFirst({
    where: { id: customerId, shopId: actor.shopId },
  });
  if (!shop || !customer)
    throw new DomainError("NOT_FOUND", "Client not found.", 404);
  const now = await databaseNow(db);
  const today = DateTime.fromJSDate(now, { zone: shop.timezone });
  const date = requestedDate ?? today.toISODate()!;
  const day = DateTime.fromISO(date, { zone: shop.timezone }).startOf("day");
  if (!day.isValid || day.toISODate() !== date)
    throw new DomainError("INVALID_DATE", "Choose a valid class date.", 400);
  const sessions = await db.classSession.findMany({
    where: {
      shopId: actor.shopId,
      status: { in: ["PUBLISHED", "COMPLETED"] },
      startsAt: { gte: day.toJSDate(), lt: day.plus({ days: 1 }).toJSDate() },
      endsAt: { lte: now },
      service: { kind: { in: ["CLASS", "APPOINTMENT", "COURSE"] } },
      bookings: {
        none: { customerId, status: { not: "CANCELLED" } },
      },
    },
    include: {
      service: true,
      coach: true,
      location: true,
      _count: {
        select: {
          bookings: {
            where: { status: { in: ["CONFIRMED", "ATTENDED", "NO_SHOW"] } },
          },
        },
      },
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
  });
  const options = await Promise.all(
    sessions.map(async (session) => ({
      id: session.id,
      name: session.service.name,
      startsAt: session.startsAt.toISOString(),
      timezone: session.timezone,
      coach: session.coach.name,
      location: session.location.name,
      capacity: session.capacity,
      enrolled: session._count.bookings,
      passes: (
        await eligibleEntitlements(db, {
          shopId: actor.shopId,
          customerId,
          serviceId: session.serviceId,
          sessionStartsAt: session.startsAt,
          now,
        })
      ).map((pass) => ({
        id: pass.id,
        name: pass.name,
        available: pass.availableUnits,
      })),
    })),
  );
  return { date, today: today.toISODate()!, timezone: shop.timezone, options };
}

const inputSchema = z
  .object({
    customerId: z.string().uuid(),
    sessionId: z.string().uuid(),
    entitlementId: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export async function backfillAttendance(actor: Actor, raw: unknown) {
  requireOperations(actor);
  const input = inputSchema.parse(raw);
  return db.$transaction(
    async (tx) => {
      // Serialize retries even when a reused request key names a different class.
      const key = `attendance-backfill:${actor.shopId}:${input.idempotencyKey}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
      const request = { ...input, actorId: actor.actorId };
      const previous = await tx.bookingChange.findUnique({
        where: {
          shopId_idempotencyKey: {
            shopId: actor.shopId,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (previous) {
        const log = await tx.auditLog.findFirst({
          where: {
            shopId: actor.shopId,
            entityId: previous.bookingId,
            action: "ATTENDANCE_BACKFILLED",
          },
        });
        const saved = log?.after as Record<string, unknown> | undefined;
        if (
          previous.action !== "BACKFILL_ATTENDANCE" ||
          !saved ||
          Object.entries(request).some(([k, v]) => saved[k] !== v)
        )
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "This attendance request has already been used.",
          );
        return previous.bookingId;
      }
      await tx.$queryRaw`SELECT id FROM "ClassSession" WHERE id = ${input.sessionId}::uuid AND "shopId" = ${actor.shopId}::uuid FOR UPDATE`;
      const shop = await tx.shop.findFirst({
        where: { id: actor.shopId, status: "ACTIVE" },
      });
      const customer = await tx.customerProfile.findFirst({
        where: { id: input.customerId, shopId: actor.shopId },
      });
      const session = await tx.classSession.findFirst({
        where: { id: input.sessionId, shopId: actor.shopId },
        include: { service: true },
      });
      if (!shop || !customer || !session)
        throw new DomainError("NOT_FOUND", "Client or class not found.", 404);
      const now = await databaseNow(tx);
      if (
        !["PUBLISHED", "COMPLETED"].includes(session.status) ||
        !["CLASS", "APPOINTMENT", "COURSE"].includes(session.service.kind) ||
        session.endsAt > now
      )
        throw new DomainError(
          "CLASS_NOT_ENDED",
          "Choose a published or completed class that has already ended.",
        );
      if (
        await tx.booking.findFirst({
          where: {
            shopId: actor.shopId,
            sessionId: session.id,
            customerId: customer.id,
            status: { not: "CANCELLED" },
          },
        })
      )
        throw new DomainError(
          "ALREADY_BOOKED",
          "This client already has a record for this class. Review the existing booking instead of charging another credit.",
        );
      const passes = await eligibleEntitlements(tx, {
        shopId: actor.shopId,
        customerId: customer.id,
        serviceId: session.serviceId,
        sessionStartsAt: session.startsAt,
        now,
      });
      if (!passes.some((pass) => pass.id === input.entitlementId))
        throw new DomainError(
          "PASS_UNAVAILABLE",
          "Choose a Pass valid for this class date with an available credit.",
        );
      // This records actual past attendance, including walk-ins to a full class.
      // Keep recorded-at time truthful; do not fabricate a historical check-in time.
      const booking = await tx.booking.create({
        data: {
          shopId: actor.shopId,
          sessionId: session.id,
          customerId: customer.id,
          status: "ATTENDED",
        },
      });
      const reservationKey = randomUUID();
      await reserveEntitlementCredit(tx, {
        shopId: actor.shopId,
        customerId: customer.id,
        serviceId: session.serviceId,
        entitlementId: input.entitlementId,
        sessionStartsAt: session.startsAt,
        now,
        reservationKey,
        bookingId: booking.id,
        idempotencyKey: `${key}:reserve`,
      });
      await consumeEntitlementReservation(tx, {
        shopId: actor.shopId,
        entitlementId: input.entitlementId,
        reservationKey,
        bookingId: booking.id,
        idempotencyKey: `${key}:consume`,
      });
      await tx.bookingChange.create({
        data: {
          shopId: actor.shopId,
          bookingId: booking.id,
          idempotencyKey: input.idempotencyKey,
          actorKind: "STAFF",
          actorId: actor.actorId,
          action: "BACKFILL_ATTENDANCE",
          reason: input.reason,
          fromStatus: "NOT_RECORDED",
          toStatus: "ATTENDED",
        },
      });
      await audit(tx, actor, "ATTENDANCE_BACKFILLED", booking.id, null, {
        ...request,
        sessionStartsAt: session.startsAt.toISOString(),
        status: "ATTENDED",
      });
      // Past attendance must not queue booking confirmations or upcoming reminders.
      return booking.id;
    },
    { maxWait: 30000, timeout: 15000 },
  );
}
