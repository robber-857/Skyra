import { afterAll, beforeAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { coachListData, saveCoachPhone } from "../app/services/people.server";
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
  // The fixture coach can itself sort last; explicitly deactivate the last ID.
  await db.coach.update({
    where: { id: ids[16] },
    data: { status: "INACTIVE" },
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

test("coach phone updates are scoped, audited and do not grant login access", async () => {
  const f = await paidFixture();
  const actor = {
    shopId: f.shop.id,
    actorId: randomUUID(),
    role: "ADMIN" as const,
  };
  const phone = "+61 400 000 001";
  const saved = await saveCoachPhone(actor, f.coach.id, phone);
  expect(saved.phone).toBe(phone);
  expect(saved.loginEmail).toBeNull();
  expect(saved.notificationEmail).toBe(f.coach.notificationEmail);
  await saveCoachPhone(actor, f.coach.id, phone);
  expect(
    await db.auditLog.count({
      where: { entityId: f.coach.id, action: "COACH_PHONE_UPDATED" },
    }),
  ).toBe(1);
  const foreign = await paidFixture();
  await expect(
    saveCoachPhone(actor, foreign.coach.id, phone),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    saveCoachPhone({ ...actor, role: "COACH" }, f.coach.id, phone),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    saveCoachPhone(actor, f.coach.id, "not a phone"),
  ).rejects.toThrow();
  expect((await saveCoachPhone(actor, f.coach.id, "")).phone).toBeNull();
});
