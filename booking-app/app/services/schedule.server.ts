import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DateTime } from "luxon";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { localInstant, weekRange } from "../lib/time";
import {
  isScheduleDateInRange,
  SCHEDULE_MIN_DATE,
  SCHEDULE_MAX_DATE,
} from "../lib/schedule-range";
import { audit, lockShop } from "./catalog.server";
import { requireOperations, type Actor } from "./authorization";
import {
  releaseEntitlementReservation,
  restoreConsumedCredit,
} from "./entitlements.server";
import { enqueueBookingNotifications } from "./booking-notifications.server";
function assertScheduleStart(startsAt: Date, timezone: string) {
  const day = DateTime.fromJSDate(startsAt, { zone: timezone }).toISODate();
  if (!day || !isScheduleDateInRange(day))
    throw new DomainError(
      "SCHEDULE_DATE_OUT_OF_RANGE",
      `Session dates must be between ${SCHEDULE_MIN_DATE} and ${SCHEDULE_MAX_DATE}.`,
    );
}

function scheduleWeekRange(day: string, timezone: string) {
  const range = weekRange(day, timezone);
  const first = DateTime.fromJSDate(range.start, {
    zone: timezone,
  }).toISODate()!;
  const last = DateTime.fromJSDate(range.end, { zone: timezone })
    .minus({ days: 1 })
    .toISODate()!;
  // Boundary weeks may include December 2025 or January 2100. The selected
  // week is valid whenever at least one of its dates is inside the range.
  if (first > SCHEDULE_MAX_DATE || last < SCHEDULE_MIN_DATE)
    throw new DomainError(
      "SCHEDULE_DATE_OUT_OF_RANGE",
      `Choose a week within ${SCHEDULE_MIN_DATE} to ${SCHEDULE_MAX_DATE}.`,
    );
  return range;
}

function requireServicePrice(priceCents: number) {
  if (priceCents <= 0)
    throw new DomainError(
      "SERVICE_PRICE_REQUIRED",
      "Set the class price in Classes & Passes before publishing its sessions.",
    );
}

const slotInput = z.object({
  serviceId: z.string().uuid(),
  coachId: z.string().uuid(),
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  weeks: z.coerce.number().int().min(1).max(13).default(1),
  requestId: z.string().uuid(),
});

const updateInput = z.object({
  id: z.string().uuid(),
  serviceId: z.string().uuid(),
  coachId: z.string().uuid(),
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  capacity: z.coerce.number().int().min(1).max(200),
  version: z.coerce.number().int().positive(),
});
export async function addSessions(actor: Actor, raw: unknown) {
  requireOperations(actor);
  const input = slotInput.parse(raw);
  return db.$transaction(
    async (tx) => {
      await lockShop(tx, actor.shopId);
      const service = await tx.service.findFirst({
        where: {
          id: input.serviceId,
          shopId: actor.shopId,
          status: "ACTIVE",
          kind: { in: ["CLASS", "APPOINTMENT", "COURSE"] },
        },
        include: { location: true },
      });
      const assignment = await tx.serviceCoach.findFirst({
        where: {
          shopId: actor.shopId,
          serviceId: input.serviceId,
          coachId: input.coachId,
        },
        include: { coach: true },
      });
      if (!service || !assignment || assignment.coach.status !== "ACTIVE")
        throw new DomainError(
          "INVALID_ASSIGNMENT",
          "Choose an active class and an eligible coach.",
        );
      const zone = service.location.timezone;
      const first = localInstant(input.localStart, zone);
      assertScheduleStart(first, zone);
      if (first <= new Date())
        throw new DomainError(
          "PAST_SESSION",
          "Sessions must start in the future.",
        );
      const sessions = [];
      for (let i = 0; i < input.weeks; i++) {
        const value = DateTime.fromJSDate(first, { zone })
          .plus({ weeks: i })
          .toFormat("yyyy-MM-dd'T'HH:mm");
        const startsAt = localInstant(value, zone);
        assertScheduleStart(startsAt, zone);
        const endsAt = new Date(
          startsAt.getTime() + service.durationMin * 60000,
        );
        const busyStartsAt = new Date(
          startsAt.getTime() - assignment.coach.bufferBeforeMin * 60000,
        );
        const busyEndsAt = new Date(
          endsAt.getTime() + assignment.coach.bufferAfterMin * 60000,
        );
        const dedupeKey = input.requestId + "-" + i;
        const existing = await tx.classSession.findUnique({
          where: { shopId_dedupeKey: { shopId: actor.shopId, dedupeKey } },
        });
        if (existing) {
          if (
            existing.serviceId !== service.id ||
            existing.coachId !== input.coachId ||
            existing.startsAt.getTime() !== startsAt.getTime()
          )
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "Request ID already used for a different session.",
              409,
            );
          sessions.push(existing);
          continue;
        }
        const conflict = await tx.classSession.findFirst({
          where: {
            shopId: actor.shopId,
            status: { in: ["DRAFT", "PUBLISHED"] },
            OR: [
              {
                coachId: input.coachId,
                busyStartsAt: { lt: busyEndsAt },
                busyEndsAt: { gt: busyStartsAt },
              },
              {
                locationId: service.locationId,
                startsAt: { lt: endsAt },
                endsAt: { gt: startsAt },
              },
            ],
          },
        });
        if (conflict)
          throw new DomainError(
            "SCHEDULE_CONFLICT",
            "Coach or location is already occupied at " +
              value.replace("T", " ") +
              ". No sessions were added.",
            409,
          );
        const session = await tx.classSession.create({
          data: {
            shopId: actor.shopId,
            serviceId: service.id,
            coachId: input.coachId,
            locationId: service.locationId,
            startsAt,
            endsAt,
            busyStartsAt,
            busyEndsAt,
            timezone: zone,
            capacity: service.capacity,
            dedupeKey,
          },
        });
        await audit(tx, actor, "SESSION_DRAFTED", session.id, null, session);
        sessions.push(session);
      }
      return sessions;
    },
    { timeout: 15000 },
  );
}
export async function updateSession(actor: Actor, raw: unknown) {
  requireOperations(actor);
  const input = updateInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const current = await tx.classSession.findFirst({
      where: { id: input.id, shopId: actor.shopId },
      include: {
        bookings: { where: { status: "CONFIRMED" }, select: { id: true } },
        holds: {
          where: { status: "ACTIVE", expiresAt: { gt: new Date() } },
          select: { id: true },
        },
      },
    });
    if (!current) throw new DomainError("NOT_FOUND", "Session not found.", 404);
    if (!["DRAFT", "PUBLISHED"].includes(current.status))
      throw new DomainError(
        "NOT_EDITABLE",
        "Only future draft or published sessions can be edited.",
      );
    if (current.startsAt <= new Date())
      throw new DomainError("PAST_SESSION", "Past sessions cannot be edited.");
    if (current.version !== input.version)
      throw new DomainError(
        "CONFLICT",
        "This session changed in another window. Refresh and try again.",
        409,
      );
    if (current.holds.length > 0)
      throw new DomainError(
        "ACTIVE_HOLDS",
        "This session has an active checkout hold. Try again after the hold expires.",
        409,
      );
    if (current.bookings.length > 0 && current.serviceId !== input.serviceId)
      throw new DomainError(
        "SERVICE_LOCKED",
        "A session with confirmed bookings cannot change class type.",
        409,
      );
    if (input.capacity < current.bookings.length)
      throw new DomainError(
        "CAPACITY_BELOW_OCCUPANCY",
        `Capacity cannot be lower than ${current.bookings.length} confirmed booking(s).`,
        409,
      );

    const service = await tx.service.findFirst({
      where: {
        id: input.serviceId,
        shopId: actor.shopId,
        status: "ACTIVE",
        kind: { in: ["CLASS", "APPOINTMENT", "COURSE"] },
      },
      include: { location: true },
    });
    const assignment = await tx.serviceCoach.findFirst({
      where: {
        shopId: actor.shopId,
        serviceId: input.serviceId,
        coachId: input.coachId,
      },
      include: { coach: true },
    });
    if (!service || !assignment || assignment.coach.status !== "ACTIVE")
      throw new DomainError(
        "INVALID_ASSIGNMENT",
        "Choose an active class and an eligible coach.",
      );

    const zone = service.location.timezone;
    const startsAt = localInstant(input.localStart, zone);
    assertScheduleStart(startsAt, zone);
    if (current.status === "PUBLISHED")
      requireServicePrice(service.requestedPriceCents);
    if (startsAt <= new Date())
      throw new DomainError(
        "PAST_SESSION",
        "Sessions must start in the future.",
      );
    const endsAt = new Date(startsAt.getTime() + service.durationMin * 60000);
    const busyStartsAt = new Date(
      startsAt.getTime() - assignment.coach.bufferBeforeMin * 60000,
    );
    const busyEndsAt = new Date(
      endsAt.getTime() + assignment.coach.bufferAfterMin * 60000,
    );
    const conflict = await tx.classSession.findFirst({
      where: {
        id: { not: current.id },
        shopId: actor.shopId,
        status: { in: ["DRAFT", "PUBLISHED"] },
        OR: [
          {
            coachId: input.coachId,
            busyStartsAt: { lt: busyEndsAt },
            busyEndsAt: { gt: busyStartsAt },
          },
          {
            locationId: service.locationId,
            startsAt: { lt: endsAt },
            endsAt: { gt: startsAt },
          },
        ],
      },
    });
    if (conflict)
      throw new DomainError(
        "SCHEDULE_CONFLICT",
        "Coach or location is already occupied at the selected time.",
        409,
      );

    const updated = await tx.classSession.updateMany({
      where: {
        id: current.id,
        shopId: actor.shopId,
        version: input.version,
      },
      data: {
        serviceId: service.id,
        coachId: input.coachId,
        locationId: service.locationId,
        startsAt,
        endsAt,
        busyStartsAt,
        busyEndsAt,
        timezone: zone,
        capacity: input.capacity,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1)
      throw new DomainError(
        "CONFLICT",
        "This session changed in another window. Refresh and try again.",
        409,
      );
    const saved = await tx.classSession.findUniqueOrThrow({
      where: { id: current.id },
    });
    await audit(tx, actor, "SESSION_UPDATED", current.id, current, saved);
    return saved;
  });
}
export async function publishWeek(actor: Actor, day: string) {
  requireOperations(actor);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const shop = await tx.shop.findUniqueOrThrow({
      where: { id: actor.shopId },
    });
    const range = scheduleWeekRange(day, shop.timezone);
    const drafts = await tx.classSession.findMany({
      where: {
        shopId: actor.shopId,
        status: "DRAFT",
        startsAt: { gte: range.start, lt: range.end },
      },
      include: { service: true, coach: true },
    });
    const now = new Date();
    const skipped: {
      id: string;
      className: string;
      startsAt: string;
      timezone: string;
      reason: string;
    }[] = [];
    let published = 0;
    for (const session of drafts) {
      if (session.startsAt <= now) {
        skipped.push({
          id: session.id,
          className: session.service.name,
          startsAt: session.startsAt.toISOString(),
          timezone: session.timezone,
          reason: "Start time has passed. Kept as draft.",
        });
        continue;
      }
      assertScheduleStart(session.startsAt, session.timezone);
      requireServicePrice(session.service.requestedPriceCents);
      if (
        session.service.status !== "ACTIVE" ||
        session.coach.status !== "ACTIVE"
      )
        throw new DomainError(
          "NOT_PUBLISHABLE",
          `Cannot publish ${session.service.name}: the class or coach is inactive.`,
        );
      const assignment = await tx.serviceCoach.findFirst({
        where: {
          shopId: actor.shopId,
          serviceId: session.serviceId,
          coachId: session.coachId,
        },
      });
      if (!assignment)
        throw new DomainError(
          "INVALID_ASSIGNMENT",
          "A coach is no longer assigned to this class.",
        );
      await tx.classSession.update({
        where: { id: session.id },
        data: { status: "PUBLISHED", version: { increment: 1 } },
      });
      await audit(
        tx,
        actor,
        "SESSION_PUBLISHED",
        session.id,
        { status: "DRAFT" },
        { status: "PUBLISHED" },
      );
      published += 1;
    }
    return { published, skipped };
  });
}
export async function cancelDraft(actor: Actor, id: string) {
  requireOperations(actor);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const session = await tx.classSession.findFirst({
      where: { id, shopId: actor.shopId },
    });
    if (!session || session.status !== "DRAFT")
      throw new DomainError(
        "NOT_DRAFT",
        "Only draft sessions can be removed here.",
      );
    await tx.classSession.update({
      where: { id },
      data: { status: "CANCELLED", version: { increment: 1 } },
    });
    await audit(
      tx,
      actor,
      "DRAFT_CANCELLED",
      id,
      { status: "DRAFT" },
      { status: "CANCELLED" },
    );
  });
}
export async function scheduleData(shopId: string, day: string) {
  const shop = await db.shop.findUniqueOrThrow({ where: { id: shopId } });
  const range = scheduleWeekRange(day, shop.timezone);
  const rows = await db.classSession.findMany({
    where: {
      shopId,
      startsAt: { gte: range.start, lt: range.end },
      status: { not: "CANCELLED" },
    },
    include: {
      service: true,
      coach: true,
      location: true,
      bookings: {
        where: { status: { in: ["CONFIRMED", "ATTENDED", "NO_SHOW"] } },
        select: { status: true },
      },
      holds: {
        where: { status: "ACTIVE", expiresAt: { gt: new Date() } },
        select: { id: true },
      },
    },
    orderBy: { startsAt: "asc" },
  });
  const sessions = rows.map(({ bookings, holds, ...session }) => ({
    ...session,
    enrolled: bookings.length,
    occupied:
      bookings.filter((b) => b.status === "CONFIRMED").length + holds.length,
  }));
  return { sessions, week: range.label, timezone: shop.timezone };
}

export async function copyPreviousWeek(actor: Actor, day: string) {
  requireOperations(actor);
  return db.$transaction(
    async (tx) => {
      await lockShop(tx, actor.shopId);
      const shop = await tx.shop.findUniqueOrThrow({
        where: { id: actor.shopId },
      });
      const target = scheduleWeekRange(day, shop.timezone);
      const previous = DateTime.fromJSDate(target.start, {
        zone: shop.timezone,
      })
        .minus({ weeks: 1 })
        .toJSDate();
      const sources = await tx.classSession.findMany({
        where: {
          shopId: actor.shopId,
          status: { in: ["DRAFT", "PUBLISHED"] },
          startsAt: { gte: previous, lt: target.start },
        },
        include: { service: true, coach: true },
      });
      let count = 0;
      let replaced = 0;
      let preserved = 0;
      let cancelledBookings = 0;
      const createdIds = new Set<string>();
      for (const source of sources) {
        let dedupeKey = "copy-" + source.id + "-" + target.label;
        if (
          await tx.classSession.findUnique({
            where: { shopId_dedupeKey: { shopId: actor.shopId, dedupeKey } },
          })
        )
          dedupeKey += "-" + randomUUID();
        const local = DateTime.fromJSDate(source.startsAt, {
          zone: source.timezone,
        })
          .plus({ weeks: 1 })
          .toFormat("yyyy-MM-dd'T'HH:mm");
        const startsAt = localInstant(local, source.timezone);
        assertScheduleStart(startsAt, source.timezone);
        const endsAt = new Date(
          startsAt.getTime() + source.service.durationMin * 60000,
        );
        const busyStartsAt = new Date(
          startsAt.getTime() - source.coach.bufferBeforeMin * 60000,
        );
        const busyEndsAt = new Date(
          endsAt.getTime() + source.coach.bufferAfterMin * 60000,
        );
        const assignment = await tx.serviceCoach.findFirst({
          where: {
            shopId: actor.shopId,
            serviceId: source.serviceId,
            coachId: source.coachId,
          },
        });
        if (
          startsAt <= new Date() ||
          source.service.status !== "ACTIVE" ||
          source.coach.status !== "ACTIVE" ||
          !assignment
        )
          throw new DomainError(
            "INVALID_ASSIGNMENT",
            "A previous-week class or coach is no longer available.",
          );
        const conflicts = await tx.classSession.findMany({
          where: {
            shopId: actor.shopId,
            status: { in: ["DRAFT", "PUBLISHED"] },
            OR: [
              {
                coachId: source.coachId,
                busyStartsAt: { lt: busyEndsAt },
                busyEndsAt: { gt: busyStartsAt },
              },
              {
                locationId: source.locationId,
                startsAt: { lt: endsAt },
                endsAt: { gt: startsAt },
              },
            ],
          },
        });
        // Lock before inspecting bookings: checkout and booking creation use this lock too.
        for (const conflict of [...conflicts].sort((a, b) =>
          a.id.localeCompare(b.id),
        )) {
          await tx.$queryRaw`SELECT id FROM "ClassSession" WHERE id=${conflict.id}::uuid AND "shopId"=${actor.shopId}::uuid FOR UPDATE`;
        }
        if (conflicts.some((conflict) => createdIds.has(conflict.id)))
          throw new DomainError(
            "SCHEDULE_CONFLICT",
            "The previous week's classes overlap after copying. Check their times and coach buffers.",
            409,
          );
        // An identical target session already represents this occurrence, including its roster.
        if (
          conflicts.length === 1 &&
          conflicts[0].serviceId === source.serviceId &&
          conflicts[0].coachId === source.coachId &&
          conflicts[0].locationId === source.locationId &&
          conflicts[0].startsAt.getTime() === startsAt.getTime() &&
          conflicts[0].endsAt.getTime() === endsAt.getTime()
        ) {
          createdIds.add(conflicts[0].id);
          preserved++;
          continue;
        }
        const conflictIds = conflicts.map((conflict) => conflict.id);
        if (
          conflicts.some(
            (conflict) =>
              conflict.startsAt < target.start ||
              conflict.startsAt >= target.end ||
              conflict.startsAt <= new Date(),
          )
        )
          throw new DomainError(
            "SCHEDULE_CONFLICT",
            "A conflict is outside the target week or has already started. Choose a future week.",
            409,
          );
        const bookings = await tx.booking.findMany({
          where: {
            shopId: actor.shopId,
            sessionId: { in: conflictIds },
            status: { in: ["CONFIRMED", "ATTENDED", "NO_SHOW", "LATE_CANCEL"] },
          },
          include: { entitlementLedgerEntries: true },
          orderBy: { id: "asc" },
        });
        const reason =
          "Previous-week timetable copied over this session; booking cancelled and credit returned.";
        for (const booking of bookings) {
          const reservations = booking.entitlementLedgerEntries.filter(
            (entry) => entry.kind === "RESERVE",
          );
          if (reservations.length !== 1 || !reservations[0].reservationKey)
            throw new DomainError(
              "BOOKING_LEDGER_REVIEW",
              "A conflicting booking needs a credit ledger review. No sessions were copied.",
              409,
            );
          const reserve = reservations[0];
          const restore = booking.status !== "CONFIRMED";
          await (
            restore ? restoreConsumedCredit : releaseEntitlementReservation
          )(tx, {
            shopId: actor.shopId,
            entitlementId: reserve.entitlementId,
            reservationKey: reserve.reservationKey!,
            bookingId: booking.id,
            idempotencyKey:
              (restore ? "booking-restore:" : "booking-settle:") + booking.id,
            reason,
          });
          await tx.booking.update({
            where: { id: booking.id },
            data: {
              status: "CANCELLED",
              checkedInAt: null,
              version: { increment: 1 },
            },
          });
          await tx.bookingChange.create({
            data: {
              shopId: actor.shopId,
              bookingId: booking.id,
              idempotencyKey: randomUUID(),
              actorKind: "STAFF",
              actorId: actor.actorId,
              action: "CANCEL_WAIVE",
              reason,
              fromStatus: booking.status,
              toStatus: "CANCELLED",
            },
          });
          await tx.bookingNotification.updateMany({
            where: {
              shopId: actor.shopId,
              bookingId: booking.id,
              status: "PENDING",
            },
            data: { status: "SUPPRESSED", lastError: "NOTIFICATION_OBSOLETE" },
          });
          await enqueueBookingNotifications(
            tx,
            actor.shopId,
            booking.id,
            "BOOKING_CANCELLED_V1",
          );
          await audit(
            tx,
            actor,
            "BOOKING_CANCEL_WAIVE",
            booking.id,
            { status: booking.status },
            { status: "CANCELLED", reason },
          );
          cancelledBookings++;
        }
        const holds = await tx.bookingHold.findMany({
          where: {
            shopId: actor.shopId,
            sessionId: { in: conflictIds },
            status: "ACTIVE",
          },
        });
        for (const hold of holds) {
          await tx.bookingHold.update({
            where: { id: hold.id },
            data: { status: "RELEASED" },
          });
          await tx.bookingAttempt.update({
            where: { id: hold.attemptId },
            data: { status: "EXPIRED" },
          });
          await audit(
            tx,
            actor,
            "HOLD_RELEASED",
            hold.id,
            { status: hold.status },
            { status: "RELEASED", reason },
          );
        }
        for (const conflict of conflicts) {
          const cancelled = await tx.classSession.update({
            where: { id: conflict.id },
            data: { status: "CANCELLED", version: { increment: 1 } },
          });
          await audit(
            tx,
            actor,
            "SESSION_COPY_REPLACED",
            conflict.id,
            conflict,
            cancelled,
          );
          replaced++;
        }
        const session = await tx.classSession.create({
          data: {
            shopId: actor.shopId,
            serviceId: source.serviceId,
            coachId: source.coachId,
            locationId: source.locationId,
            startsAt,
            endsAt,
            busyStartsAt,
            busyEndsAt,
            timezone: source.timezone,
            capacity: source.service.capacity,
            dedupeKey,
          },
        });
        await audit(
          tx,
          actor,
          "SESSION_COPIED",
          session.id,
          { sourceId: source.id },
          session,
        );
        createdIds.add(session.id);
        count++;
      }
      return { copied: count, replaced, preserved, cancelledBookings };
    },
    { timeout: 15000 },
  );
}
