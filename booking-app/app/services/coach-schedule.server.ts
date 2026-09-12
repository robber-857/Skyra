import { DateTime } from "luxon";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { coachIdentity } from "./coach-auth.server";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const query = z
  .object({
    range: z.enum(["week", "month", "custom"]).default("week"),
    from: date.optional(),
    to: date.optional(),
  })
  .strict();
export function coachDateRange(
  raw: unknown,
  timezone: string,
  now = new Date(),
) {
  const input = query.parse(raw);
  const today = DateTime.fromJSDate(now, { zone: timezone }).startOf("day");
  if (!today.isValid)
    throw new DomainError("INVALID_TIMEZONE", "Invalid studio timezone.", 400);
  const start =
    input.range === "custom"
      ? DateTime.fromISO(input.from || "", { zone: timezone }).startOf("day")
      : today;
  const lastDay =
    input.range === "custom"
      ? DateTime.fromISO(input.to || "", { zone: timezone }).startOf("day")
      : start.plus({ days: input.range === "week" ? 6 : 29 });
  if (
    !start.isValid ||
    !lastDay.isValid ||
    (input.range === "custom" &&
      (start.toISODate() !== input.from || lastDay.toISODate() !== input.to)) ||
    lastDay < start ||
    lastDay.diff(start, "days").days > 365
  )
    throw new DomainError(
      "INVALID_DATE_RANGE",
      "Choose a date range of up to 366 days.",
      400,
    );
  return {
    range: input.range,
    from: start.toISODate()!,
    to: lastDay.toISODate()!,
    start: start.toJSDate(),
    end: lastDay.plus({ days: 1 }).toJSDate(),
    timezone,
  };
}

export async function coachSchedule(token: string, raw: unknown) {
  const identity = await coachIdentity(token);
  const shop = await db.shop.findUniqueOrThrow({
    where: { id: identity.shopId },
  });
  const range = coachDateRange(raw, shop.timezone);
  return db.$transaction(
    async (tx) => {
      const sessions = await tx.classSession.findMany({
        where: {
          shopId: identity.shopId,
          coachId: identity.coachId,
          startsAt: { gte: range.start, lt: range.end },
          status: { in: ["PUBLISHED", "CANCELLED", "COMPLETED"] },
        },
        include: {
          service: { select: { name: true } },
          location: { select: { name: true } },
          bookings: { select: { status: true } },
          _count: {
            select: {
              holds: {
                where: { status: "ACTIVE", expiresAt: { gt: new Date() } },
              },
            },
          },
        },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      });
      const rows = sessions.map((s) => {
        const count = (states: string[]) =>
          s.bookings.filter((b) => states.includes(b.status)).length;
        const confirmed = count(["CONFIRMED"]);
        const enrolled = count(["CONFIRMED", "ATTENDED", "NO_SHOW"]);
        return {
          id: s.id,
          className: s.service.name,
          location: s.location.name,
          startsAt: s.startsAt.toISOString(),
          endsAt: s.endsAt.toISOString(),
          timezone: s.timezone,
          status: s.status,
          capacity: s.capacity,
          confirmed,
          enrolled,
          attended: count(["ATTENDED"]),
          cancelled: count(["CANCELLED"]),
          noShow: count(["NO_SHOW"]),
          lateCancel: count(["LATE_CANCEL"]),
          remaining: Math.max(0, s.capacity - confirmed - s._count.holds),
        };
      });
      const activeRows = rows.filter((s) => s.status !== "CANCELLED");
      const capacity = activeRows.reduce((sum, s) => sum + s.capacity, 0);
      const enrolled = activeRows.reduce((sum, s) => sum + s.enrolled, 0);
      await tx.auditLog.create({
        data: {
          shopId: identity.shopId,
          actorId: identity.coachId,
          action: "COACH_SCHEDULE_READ",
          entityId: identity.coachId,
          after: { from: range.from, to: range.to, sessions: rows.length },
        },
      });
      return {
        coachName: identity.name,
        range: {
          range: range.range,
          from: range.from,
          to: range.to,
          timezone: range.timezone,
        },
        rows,
        summary: {
          sessions: activeRows.length,
          enrolled,
          capacity,
          occupancyPercent: capacity
            ? Math.round((enrolled / capacity) * 100)
            : 0,
          confirmed: activeRows.reduce((sum, s) => sum + s.confirmed, 0),
        },
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}
