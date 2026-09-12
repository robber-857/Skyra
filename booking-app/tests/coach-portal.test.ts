import { beforeAll, afterAll, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import db from "../app/db.server";
import { paidFixture, queuePaid } from "./paid-fixture";
import { processPaidBookingEvent } from "../app/services/paid-booking.server";
import {
  issueCoachLogin,
  exchangeCoachLogin,
  coachIdentity,
  revokeCoachSession,
  coachCookie,
} from "../app/services/coach-auth.server";
import {
  coachDateRange,
  coachSchedule,
} from "../app/services/coach-schedule.server";
import { bookingOperationsData } from "../app/services/booking-operations.server";
beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Dedicated test DB required");
});
afterAll(() => db.$disconnect());
async function login(f: Awaited<ReturnType<typeof paidFixture>>) {
  return exchangeCoachLogin(
    await issueCoachLogin(
      { shopId: f.shop.id, actorId: "TEST_ADMIN", role: "ADMIN" },
      f.coach.id,
    ),
  );
}

test("coach sees only assigned classes and confirmed registration counts", async () => {
  const f = await paidFixture();
  await processPaidBookingEvent((await queuePaid(f)).id);
  const token = await login(f);
  const other = await paidFixture();
  await processPaidBookingEvent((await queuePaid(other)).id);
  const result = await coachSchedule(token, { range: "week" });
  expect(result.rows.map((r) => r.id)).toEqual([f.session.id]);
  expect(result.summary).toMatchObject({
    sessions: 1,
    enrolled: 1,
    confirmed: 1,
    capacity: 8,
    occupancyPercent: 13,
  });
  expect(JSON.stringify(result)).not.toContain("gid://shopify/Customer");
  expect(JSON.stringify(result)).not.toContain("sourceOrderGid");
});

test("date scope cannot be changed into another coach or shop", async () => {
  const f = await paidFixture();
  const token = await login(f);
  await expect(
    coachSchedule(token, { range: "week", coachId: randomUUID() }),
  ).rejects.toThrow();
  await expect(
    coachSchedule(token, { range: "week", shopId: randomUUID() }),
  ).rejects.toThrow();
  await expect(coachSchedule("invalid", {})).rejects.toMatchObject({
    status: 401,
  });
});

test("temporary holds and cancellations are not enrolment", async () => {
  const f = await paidFixture();
  const token = await login(f);
  let result = await coachSchedule(token, { range: "month" });
  expect(result.summary.enrolled).toBe(0);
  expect(result.rows[0].remaining).toBe(7);
  await processPaidBookingEvent((await queuePaid(f)).id);
  const b = await db.booking.findFirstOrThrow({ where: { shopId: f.shop.id } });
  await db.booking.update({
    where: { id: b.id },
    data: { status: "CANCELLED" },
  });
  result = await coachSchedule(token, { range: "month" });
  expect(result.summary.enrolled).toBe(0);
  expect(result.rows[0].cancelled).toBe(1);
});

test("same-shop unassigned sessions are hidden", async () => {
  const f = await paidFixture();
  const token = await login(f);
  const coach = await db.coach.create({
    data: { shopId: f.shop.id, name: "Another coach" },
  });
  const other = await db.classSession.create({
    data: {
      shopId: f.shop.id,
      serviceId: f.service.id,
      coachId: coach.id,
      locationId: f.location.id,
      startsAt: new Date(f.session.startsAt.getTime() + 86400000),
      endsAt: new Date(f.session.endsAt.getTime() + 86400000),
      busyStartsAt: new Date(f.session.startsAt.getTime() + 86400000),
      busyEndsAt: new Date(f.session.endsAt.getTime() + 86400000),
      timezone: f.session.timezone,
      capacity: 8,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  expect(
    (await coachSchedule(token, { range: "month" })).rows.map((r) => r.id),
  ).not.toContain(other.id);
});

test("one-use login link accepts only one concurrent exchange", async () => {
  const f = await paidFixture();
  const token = await issueCoachLogin(
    { shopId: f.shop.id, actorId: "TEST_ADMIN", role: "ADMIN" },
    f.coach.id,
  );
  await expect(coachIdentity(token)).rejects.toMatchObject({ status: 401 });
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () => exchangeCoachLogin(token)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const records = await db.coachAccessToken.findMany({
    where: { shopId: f.shop.id },
  });
  expect(records.every((r) => !JSON.stringify(r).includes(token))).toBe(true);
});

test("revocation and inactive coach remove portal access immediately", async () => {
  const f = await paidFixture();
  const token = await login(f);
  await revokeCoachSession(token);
  await expect(coachSchedule(token, {})).rejects.toMatchObject({ status: 401 });
  const second = await login(f);
  await db.coach.update({
    where: { id: f.coach.id },
    data: { status: "INACTIVE" },
  });
  await expect(coachSchedule(second, {})).rejects.toMatchObject({
    status: 401,
  });
});

test("Coach role cannot issue login links or read Admin payment data", async () => {
  const f = await paidFixture();
  const actor = {
    shopId: f.shop.id,
    actorId: f.coach.id,
    role: "COACH" as const,
  };
  await expect(issueCoachLogin(actor, f.coach.id)).rejects.toMatchObject({
    status: 403,
  });
  await expect(bookingOperationsData(actor)).rejects.toMatchObject({
    status: 403,
  });
  expect(coachCookie("a".repeat(43))).toContain("HttpOnly; SameSite=Lax");
});

test("week and month are 7/30 local calendar days, including Sydney DST", () => {
  const r = coachDateRange(
    { range: "week" },
    "Australia/Sydney",
    new Date("2026-10-03T12:00:00Z"),
  );
  expect(r.from).toBe("2026-10-03");
  expect(r.to).toBe("2026-10-09");
  expect((r.end.getTime() - r.start.getTime()) / 3600000).toBe(167);
  const m = coachDateRange(
    { range: "month" },
    "Australia/Sydney",
    new Date("2026-09-12T00:00:00Z"),
  );
  expect(m.from).toBe("2026-09-12");
  expect(m.to).toBe("2026-10-11");
});

test("custom date last day is inclusive and invalid/reversed/excessive ranges fail", () => {
  const r = coachDateRange(
    { range: "custom", from: "2026-09-12", to: "2026-09-12" },
    "Australia/Sydney",
  );
  expect(r.end.getTime() - r.start.getTime()).toBe(86400000);
  for (const [from, to] of [
    ["2026-02-30", "2026-03-01"],
    ["2026-10-02", "2026-10-01"],
    ["2025-01-01", "2026-12-31"],
  ])
    expect(() =>
      coachDateRange({ range: "custom", from, to }, "Australia/Sydney"),
    ).toThrow();
});
