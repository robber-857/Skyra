import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, test } from "vitest";
import { DateTime } from "luxon";
import db from "../app/db.server";
import { paidFixture } from "./paid-fixture";
import { removeSession, scheduleData } from "../app/services/schedule.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test database required");
});
afterAll(() => db.$disconnect());
const actorFor = (shopId: string) => ({
  shopId,
  actorId: "test-admin",
  role: "ADMIN" as const,
});

test.each(["DRAFT", "PUBLISHED"] as const)(
  "deleting %s hides only this session and retains an audit record",
  async (status) => {
    const f = await paidFixture("NEW_PASS", true);
    await db.classSession.update({
      where: { id: f.session.id },
      data: { status },
    });
    await removeSession(actorFor(f.shop.id), {
      id: f.session.id,
      version: f.session.version,
    });
    expect(
      await db.classSession.findUnique({ where: { id: f.session.id } }),
    ).toMatchObject({ status: "CANCELLED", version: f.session.version + 1 });
    const day = DateTime.fromJSDate(f.session.startsAt, {
      zone: f.shop.timezone,
    }).toISODate()!;
    expect((await scheduleData(f.shop.id, day)).sessions).toHaveLength(0);
    expect(
      await db.auditLog.count({
        where: {
          entityId: f.session.id,
          action: status === "DRAFT" ? "DRAFT_CANCELLED" : "SESSION_CANCELLED",
        },
      }),
    ).toBe(1);
  },
);

test("rejects cross-shop, unauthorized, stale and active-checkout deletion", async () => {
  const f = await paidFixture();
  const input = { id: f.session.id, version: f.session.version };
  const actor = actorFor(f.shop.id);
  await expect(
    removeSession(actorFor(randomUUID()), input),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(
    removeSession({ ...actor, role: "COACH" }, input),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(
    removeSession(actor, { ...input, version: input.version + 1 }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
  await expect(removeSession(actor, input)).rejects.toMatchObject({
    code: "ACTIVE_HOLDS",
  });
  expect(
    await db.classSession.findUnique({ where: { id: f.session.id } }),
  ).toMatchObject({ status: "PUBLISHED", version: input.version });
});

test("retains past published sessions", async () => {
  const f = await paidFixture("NEW_PASS", true);
  await db.classSession.update({
    where: { id: f.session.id },
    data: {
      startsAt: new Date(Date.now() - 7200000),
      endsAt: new Date(Date.now() - 3600000),
      busyStartsAt: new Date(Date.now() - 7200000),
      busyEndsAt: new Date(Date.now() - 3600000),
    },
  });
  await expect(
    removeSession(actorFor(f.shop.id), {
      id: f.session.id,
      version: f.session.version,
    }),
  ).rejects.toMatchObject({ code: "PAST_SESSION" });
});

test.each(["CONFIRMED", "ATTENDED", "NO_SHOW", "LATE_CANCEL"] as const)(
  "preserves sessions with %s booking records",
  async (status) => {
    const f = await paidFixture("NEW_PASS", true);
    await db.booking.create({
      data: {
        shopId: f.shop.id,
        sessionId: f.session.id,
        customerId: f.customer.id,
        status,
      },
    });
    await expect(
      removeSession(actorFor(f.shop.id), {
        id: f.session.id,
        version: f.session.version,
      }),
    ).rejects.toMatchObject({ code: "HAS_BOOKINGS" });
    expect(
      await db.classSession.findUnique({ where: { id: f.session.id } }),
    ).toMatchObject({ status: "PUBLISHED" });
  },
);
