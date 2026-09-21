import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import { clientName } from "./client-identity";

export async function adminSessionDetail(actor: Actor, id: unknown) {
  requireOperations(actor);
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success)
    throw new DomainError("NOT_FOUND", "Session not found.", 404);
  const now = new Date();
  const session = await db.classSession.findFirst({
    where: { id: parsed.data, shopId: actor.shopId },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      capacity: true,
      status: true,
      service: { select: { name: true } },
      coach: { select: { name: true } },
      location: { select: { name: true } },
      bookings: {
        where: { shopId: actor.shopId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          status: true,
          checkedInAt: true,
          customerComment: true,
          customer: {
            select: {
              id: true,
              preferredName: true,
              shopifyName: true,
              email: true,
              avatarBytes: true,
              avatarMimeType: true,
            },
          },
        },
      },
      _count: {
        select: {
          holds: {
            where: {
              shopId: actor.shopId,
              status: "ACTIVE",
              expiresAt: { gt: now },
            },
          },
        },
      },
    },
  });
  if (!session) throw new DomainError("NOT_FOUND", "Session not found.", 404);
  const { bookings, _count, ...details } = session;
  const enrolledStatuses = ["CONFIRMED", "ATTENDED", "NO_SHOW"];
  const enrolled = bookings.filter((b) =>
    enrolledStatuses.includes(b.status),
  ).length;
  return {
    ...details,
    canEdit:
      ["DRAFT", "PUBLISHED"].includes(session.status) && session.startsAt > now,
    enrolled,
    attended: bookings.filter((b) => b.status === "ATTENDED").length,
    noShows: bookings.filter((b) => b.status === "NO_SHOW").length,
    holds: _count.holds,
    bookings: bookings.map(({ customer, ...booking }) => ({
      ...booking,
      enrolled: enrolledStatuses.includes(booking.status),
      customer: {
        id: customer.id,
        name: clientName(customer),
        avatarDataUrl:
          customer.avatarBytes && customer.avatarMimeType
            ? `data:${customer.avatarMimeType};base64,${Buffer.from(customer.avatarBytes).toString("base64")}`
            : null,
      },
    })),
  };
}
