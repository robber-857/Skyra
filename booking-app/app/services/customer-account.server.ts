import { randomUUID } from "node:crypto";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { databaseNow, type BookingActor } from "./booking.server";
import { cancellationOutcome } from "./booking-lifecycle.server";
const query = z
  .object({
    view: z.enum(["upcoming", "history", "passes"]).default("upcoming"),
    cursor: z.string().uuid().optional(),
    page: z.coerce.number().int().min(1).max(100000).optional(),
  })
  .strict();
export async function customerAccountData(actor: BookingActor, raw: unknown) {
  const input = query.parse(raw);
  if (input.page !== undefined && (input.view !== "passes" || input.cursor))
    throw new DomainError(
      "INVALID_PAGE",
      "Choose a Pass page without a cursor.",
      400,
    );
  if (!actor.customerGid)
    throw new DomainError(
      "LOGIN_REQUIRED",
      "Sign in to view your bookings.",
      401,
    );
  const shop = await db.shop.findFirstOrThrow({
    where: { id: actor.shopId, status: "ACTIVE" },
  });
  const customer = await db.customerProfile.findUnique({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: actor.shopId,
        shopifyCustomerGid: actor.customerGid,
      },
    },
  });
  const now = await databaseNow(db);
  const empty = {
    view: input.view,
    timezone: shop.timezone,
    now: now.toISOString(),
    bookings: [],
    passes: [],
    nextCursor: null,
    page: 1,
    totalPages: 1,
    totalPasses: 0,
  };
  if (!customer) return empty;
  if (input.view === "passes") {
    return db.$transaction(
      async (tx) => {
        const where = { shopId: shop.id, customerId: customer.id };
        const totalPasses = await tx.entitlement.count({ where });
        const numbered = input.page !== undefined;
        const pageSize = numbered ? 5 : 25;
        const totalPages = Math.max(1, Math.ceil(totalPasses / pageSize));
        const page = Math.min(input.page || 1, totalPages);
        if (
          input.cursor &&
          !(await tx.entitlement.findFirst({
            where: {
              id: input.cursor,
              shopId: shop.id,
              customerId: customer.id,
            },
          }))
        )
          throw new DomainError("INVALID_CURSOR", "Choose a valid page.", 400);
        const rows = await tx.entitlement.findMany({
          where: { shopId: shop.id, customerId: customer.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: numbered ? 5 : 26,
          ...(numbered ? { skip: (page - 1) * 5 } : {}),
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          include: {
            passPlan: {
              select: {
                name: true,
                services: { select: { service: { select: { name: true } } } },
              },
            },
            service: { select: { name: true, kind: true } },
            ledgerEntries: {
              orderBy: { createdAt: "desc" },
              select: {
                id: true,
                kind: true,
                availableDelta: true,
                reservedDelta: true,
                consumedDelta: true,
                createdAt: true,
              },
            },
          },
        });
        return {
          ...empty,
          passes: rows.slice(0, pageSize).map((e) => {
            const balance = e.ledgerEntries.reduce(
              (b, x) => ({
                available: b.available + x.availableDelta,
                reserved: b.reserved + x.reservedDelta,
                used: b.used + x.consumedDelta,
              }),
              { available: 0, reserved: 0, used: 0 },
            );
            return {
              id: e.id,
              name: e.passPlan?.name || e.service?.name || "Class credit",
              status:
                e.status === "ACTIVE" &&
                e.expiresAt != null &&
                e.expiresAt <= now
                  ? "EXPIRED"
                  : e.status,
              startsAt: e.startsAt?.toISOString() ?? null,
              expiresAt: e.expiresAt?.toISOString() ?? null,
              ...balance,
              eligibleClasses: e.passPlan?.services.map(
                (s) => s.service.name,
              ) || [e.service?.name || ""],
              history: e.ledgerEntries.slice(0, 20).map((x) => ({
                id: x.id,
                kind: x.kind,
                availableDelta: x.availableDelta,
                reservedDelta: x.reservedDelta,
                consumedDelta: x.consumedDelta,
                createdAt: x.createdAt.toISOString(),
              })),
              historyTruncated: e.ledgerEntries.length > 20,
            };
          }),
          nextCursor: !numbered && rows.length > 25 ? rows[24].id : null,
          page,
          totalPages,
          totalPasses,
        };
      },
      { isolationLevel: "RepeatableRead" },
    );
  }
  if (
    input.cursor &&
    !(await db.booking.findFirst({
      where: { id: input.cursor, shopId: shop.id, customerId: customer.id },
    }))
  )
    throw new DomainError("INVALID_CURSOR", "Choose a valid page.", 400);
  const rows = await db.booking.findMany({
    where: {
      shopId: shop.id,
      customerId: customer.id,
      ...(input.view === "upcoming"
        ? { status: "CONFIRMED", session: { endsAt: { gt: now } } }
        : {
            OR: [
              { status: { not: "CONFIRMED" } },
              { session: { endsAt: { lte: now } } },
            ],
          }),
    },
    orderBy: [
      { session: { startsAt: input.view === "upcoming" ? "asc" : "desc" } },
      { id: "asc" },
    ],
    take: 26,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    include: {
      session: {
        include: {
          service: { select: { name: true, kind: true } },
          coach: { select: { name: true } },
          location: { select: { name: true } },
        },
      },
    },
  });
  const moves = await db.bookingReschedule.findMany({
    where: { shopId: shop.id, oldBookingId: { in: rows.map((b) => b.id) } },
    select: { oldBookingId: true, newBookingId: true },
  });
  return {
    ...empty,
    bookings: rows.slice(0, 25).map((b) => ({
      id: b.id,
      customerComment: b.customerComment,
      serviceKind: b.session.service.kind,
      rescheduledTo:
        moves.find((m) => m.oldBookingId === b.id)?.newBookingId || null,
      cancellationKey: randomUUID(),
      canReschedule:
        b.status === "CONFIRMED" &&
        !b.checkedInAt &&
        cancellationOutcome(b.session.startsAt, now) === "CANCELLED",
      status: b.status,
      version: b.version,
      checkedIn: !!b.checkedInAt,
      className: b.session.service.name,
      coachName: b.session.coach.name,
      locationName: b.session.location.name,
      startsAt: b.session.startsAt.toISOString(),
      endsAt: b.session.endsAt.toISOString(),
      timezone: b.session.timezone,
      canCancel:
        b.status === "CONFIRMED" && !b.checkedInAt && b.session.startsAt > now,
      cancellationOutcome: cancellationOutcome(b.session.startsAt, now),
    })),
    nextCursor: rows.length > 25 ? rows[24].id : null,
  };
}
