import { z } from "zod";
import { DomainError } from "../lib/errors.server";
import { audit, lockShop } from "./catalog.server";
import db from "../db.server";
import { requireOperations, type Actor } from "./authorization";
export async function coachListData(actor: Actor, requestedPage = 1) {
  requireOperations(actor);
  const pageSize = 8;
  const where = { shopId: actor.shopId };
  const totalCount = await db.coach.count({ where });
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1,
    totalPages,
  );
  const [coaches, coachOptions] = await Promise.all([
    db.coach.findMany({
      where,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    actor.role === "ADMIN"
      ? db.coach.findMany({
          where: { ...where, status: "ACTIVE" },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  return {
    coaches,
    coachOptions,
    pagination: { page, pageSize, totalCount, totalPages },
  };
}

export const coachPhoneInput = z
  .string()
  .trim()
  .max(40)
  .regex(
    /^[+\d\s().-]*$/,
    "Enter a phone number using digits and phone punctuation.",
  );
export async function saveCoachPhone(
  actor: Actor,
  coachId: string,
  raw: unknown,
) {
  requireOperations(actor);
  const phone = coachPhoneInput.parse(raw) || null;
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const before = await tx.coach.findFirst({
      where: { id: coachId, shopId: actor.shopId },
    });
    if (!before) throw new DomainError("NOT_FOUND", "Coach not found.", 404);
    if (before.phone === phone) return before;
    const after = await tx.coach.update({
      where: { id: before.id },
      data: { phone },
    });
    await audit(
      tx,
      actor,
      "COACH_PHONE_UPDATED",
      before.id,
      { phone: before.phone },
      { phone },
    );
    return after;
  });
}
