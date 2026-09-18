import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { coachListData } from "../app/services/people.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
test("coach pages isolate shops, retain every active approval option and use stable name/id ordering", async () => {
  const f = await paidFixture();
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  await db.coach.update({
    where: { id: f.coach.id },
    data: { name: "Same name" },
  });
  const ids = [
    f.coach.id,
    ...Array.from({ length: 16 }, () => randomUUID()),
  ].sort();
  await db.coach.createMany({
    data: ids
      .filter((id) => id !== f.coach.id)
      .map((id) => ({
        id,
        shopId: f.shop.id,
        name: "Same name",
        status: id === ids[16] ? "INACTIVE" : "ACTIVE",
      })),
  });
  const foreign = await paidFixture();
  const pages = await Promise.all(
    [1, 2, 3].map((p) => coachListData(actor, p)),
  );
  expect(pages.map((p) => p.coaches.length)).toEqual([8, 8, 1]);
  expect(pages.flatMap((p) => p.coaches.map((c) => c.id))).toEqual(ids);
  expect(pages[2].pagination).toEqual({
    page: 3,
    pageSize: 8,
    totalCount: 17,
    totalPages: 3,
  });
  expect(pages.every((p) => p.coachOptions.length === 16)).toBe(true);
  expect(pages[0].coachOptions.map((c) => c.id)).toEqual(ids.slice(0, 16));
  expect(pages[0].coachOptions.some((c) => c.id === foreign.coach.id)).toBe(
    false,
  );
  expect((await coachListData(actor, 999)).pagination.page).toBe(3);
  for (const p of [0, -1, 1.5, NaN, Infinity])
    expect((await coachListData(actor, p)).pagination.page).toBe(1);
  expect(
    (await coachListData({ ...actor, role: "OPERATIONS" })).coachOptions,
  ).toEqual([]);
  await expect(
    coachListData({ ...actor, role: "COACH" }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  const empty = await db.shop.create({
    data: { domain: "empty-" + randomUUID() + ".myshopify.com" },
  });
  const result = await coachListData({ ...actor, shopId: empty.id }, 999);
  expect(result.coaches).toEqual([]);
  expect(result.coachOptions).toEqual([]);
  expect(result.pagination).toEqual({
    page: 1,
    pageSize: 8,
    totalCount: 0,
    totalPages: 1,
  });
});
