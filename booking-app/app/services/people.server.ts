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
