import { z } from "zod";
import { DateTime } from "luxon";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { localInstant, weekRange } from "../lib/time";
import { audit, lockShop } from "./catalog.server";
import { requireOperations, type Actor } from "./authorization";
const slotInput = z.object({
  serviceId: z.string().uuid(),
  coachId: z.string().uuid(),
  localStart: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  weeks: z.coerce.number().int().min(1).max(13).default(1),
  requestId: z.string().uuid(),
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
          kind: "CLASS",
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
export async function publishWeek(actor: Actor, day: string) {
  requireOperations(actor);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const shop = await tx.shop.findUniqueOrThrow({
      where: { id: actor.shopId },
    });
    const range = weekRange(day, shop.timezone);
    const drafts = await tx.classSession.findMany({
      where: {
        shopId: actor.shopId,
        status: "DRAFT",
        startsAt: { gte: range.start, lt: range.end },
      },
      include: { service: true, coach: true },
    });
    for (const session of drafts) {
      if (
        session.startsAt <= new Date() ||
        session.service.status !== "ACTIVE" ||
        session.coach.status !== "ACTIVE"
      )
        throw new DomainError(
          "NOT_PUBLISHABLE",
          "This week includes a past session or inactive class/coach.",
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
    }
    return drafts.length;
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
  const range = weekRange(day, shop.timezone);
  const sessions = await db.classSession.findMany({
    where: {
      shopId,
      startsAt: { gte: range.start, lt: range.end },
      status: { not: "CANCELLED" },
    },
    include: { service: true, coach: true, location: true },
    orderBy: { startsAt: "asc" },
  });
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
      const target = weekRange(day, shop.timezone);
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
      for (const source of sources) {
        const dedupeKey = "copy-" + source.id + "-" + target.label;
        if (
          await tx.classSession.findUnique({
            where: { shopId_dedupeKey: { shopId: actor.shopId, dedupeKey } },
          })
        )
          continue;
        const local = DateTime.fromJSDate(source.startsAt, {
          zone: source.timezone,
        })
          .plus({ weeks: 1 })
          .toFormat("yyyy-MM-dd'T'HH:mm");
        const startsAt = localInstant(local, source.timezone);
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
        const conflict = await tx.classSession.findFirst({
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
        if (conflict)
          throw new DomainError(
            "SCHEDULE_CONFLICT",
            "The copied timetable conflicts with an existing coach or location booking. No sessions were copied.",
            409,
          );
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
        count++;
      }
      return count;
    },
    { timeout: 15000 },
  );
}
