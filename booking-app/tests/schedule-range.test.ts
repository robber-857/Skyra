import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import db from "../app/db.server";
import { localInstant } from "../app/lib/time";
import {
  SCHEDULE_MIN_DATE,
  SCHEDULE_MAX_DATE,
} from "../app/lib/schedule-range";
import { savePass, saveService } from "../app/services/catalog.server";
import {
  addSessions,
  copyPreviousWeek,
  publishWeek,
  scheduleData,
  updateSession,
} from "../app/services/schedule.server";
import type { Actor } from "../app/services/authorization";

beforeAll(() => {
  const url = new URL(process.env.DATABASE_URL!);
  if (
    url.pathname !== "/skyra_booking_test" ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  )
    throw new Error("Dedicated local test database required");
});
afterEach(() => vi.useRealTimers());
afterAll(() => db.$disconnect());

async function fixture() {
  const shop = await db.shop.create({
    data: { domain: `schedule-range-${randomUUID()}.myshopify.com` },
  });
  const actor: Actor = {
    shopId: shop.id,
    actorId: "synthetic-schedule-admin",
    role: "ADMIN",
  };
  const location = await db.location.create({
    data: { shopId: shop.id, name: "Synthetic studio" },
  });
  const coach = await db.coach.create({
    data: { shopId: shop.id, name: "Synthetic coach" },
  });
  const serviceInput = {
    name: "Synthetic aerial class",
    status: "ACTIVE",
    kind: "CLASS",
    durationMin: 55,
    capacity: 6,
    requestedPriceCents: 4900,
    locationId: location.id,
    coachIds: [coach.id],
  };
  const service = await saveService(actor, serviceInput);
  const add = (localStart: string, weeks = 1) =>
    addSessions(actor, {
      serviceId: service.id,
      coachId: coach.id,
      localStart,
      weeks,
      requestId: randomUUID(),
    });
  // Raw fixtures exercise publish validation for data created before the new bounds.
  const rawDraft = (localStart: string) => {
    const startsAt = localInstant(localStart, location.timezone);
    const endsAt = new Date(startsAt.getTime() + 55 * 60000);
    return db.classSession.create({
      data: {
        shopId: shop.id,
        serviceId: service.id,
        coachId: coach.id,
        locationId: location.id,
        startsAt,
        endsAt,
        busyStartsAt: startsAt,
        busyEndsAt: endsAt,
        timezone: location.timezone,
        capacity: 6,
        status: "DRAFT",
        dedupeKey: randomUUID(),
      },
    });
  };
  return { shop, actor, location, coach, serviceInput, service, add, rawDraft };
}
function setDate(value: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(value));
}

test("Admin creates only requested sessions on the inclusive local date boundaries", async () => {
  setDate("2025-12-20T00:00:00Z");
  const f = await fixture();
  const [first] = await f.add(`${SCHEDULE_MIN_DATE}T00:00`);
  const [last] = await f.add(`${SCHEDULE_MAX_DATE}T10:00`);
  expect(
    DateTime.fromJSDate(first.startsAt, {
      zone: f.location.timezone,
    }).toISODate(),
  ).toBe("2026-01-01");
  expect(
    DateTime.fromJSDate(last.startsAt, {
      zone: f.location.timezone,
    }).toISODate(),
  ).toBe("2099-12-31");
  expect(await db.classSession.count({ where: { shopId: f.shop.id } })).toBe(2);
});

test.each(["2025-12-31T23:59", "2100-01-01T00:00"])(
  "rejects adding a session outside the local date range: %s",
  async (localStart) => {
    setDate("2025-12-20T00:00:00Z");
    const f = await fixture();
    await expect(f.add(localStart)).rejects.toMatchObject({
      code: "SCHEDULE_DATE_OUT_OF_RANGE",
    });
    expect(await db.classSession.count({ where: { shopId: f.shop.id } })).toBe(
      0,
    );
  },
);

test("weekly repetitions can end on the last allowed date but cannot cross it", async () => {
  const valid = await fixture();
  const sessions = await valid.add("2099-12-24T10:00", 2);
  expect(
    sessions.map((row) =>
      DateTime.fromJSDate(row.startsAt, {
        zone: valid.location.timezone,
      }).toISODate(),
    ),
  ).toEqual(["2099-12-24", "2099-12-31"]);
  const invalid = await fixture();
  await expect(invalid.add("2099-12-25T10:00", 2)).rejects.toMatchObject({
    code: "SCHEDULE_DATE_OUT_OF_RANGE",
  });
  expect(
    await db.classSession.count({ where: { shopId: invalid.shop.id } }),
  ).toBe(0);
  expect(
    await db.auditLog.count({
      where: { shopId: invalid.shop.id, action: "SESSION_DRAFTED" },
    }),
  ).toBe(0);
});

test("edits reject both outside dates and past dates without changing a session", async () => {
  setDate("2026-09-22T00:00:00Z");
  const f = await fixture();
  const [session] = await f.add("2030-07-01T10:00");
  const update = (localStart: string) =>
    updateSession(f.actor, {
      id: session.id,
      serviceId: f.service.id,
      coachId: f.coach.id,
      localStart,
      capacity: 6,
      version: session.version,
    });
  for (const localStart of ["2025-12-31T10:00", "2100-01-01T10:00"])
    await expect(update(localStart)).rejects.toMatchObject({
      code: "SCHEDULE_DATE_OUT_OF_RANGE",
    });
  await expect(update("2026-09-21T10:00")).rejects.toMatchObject({
    code: "PAST_SESSION",
  });
  expect(
    await db.classSession.findUniqueOrThrow({ where: { id: session.id } }),
  ).toMatchObject({ startsAt: session.startsAt, version: session.version });
  const saved = await update("2099-12-31T10:00");
  expect(
    DateTime.fromJSDate(saved.startsAt, {
      zone: f.location.timezone,
    }).toISODate(),
  ).toBe("2099-12-31");
  await expect(f.add("2026-01-01T10:00")).rejects.toMatchObject({
    code: "PAST_SESSION",
  });
});

test("boundary week views stay accessible while wholly outside weeks are rejected", async () => {
  const f = await fixture();
  expect((await scheduleData(f.shop.id, "2026-01-01")).week).toBe("2025-12-29");
  expect((await scheduleData(f.shop.id, "2025-12-29")).week).toBe("2025-12-29");
  expect((await scheduleData(f.shop.id, "2099-12-31")).week).toBe("2099-12-28");
  expect((await scheduleData(f.shop.id, "2100-01-01")).week).toBe("2099-12-28");
  for (const day of ["2025-12-22", "2100-01-04"]) {
    await expect(scheduleData(f.shop.id, day)).rejects.toMatchObject({
      code: "SCHEDULE_DATE_OUT_OF_RANGE",
    });
    await expect(publishWeek(f.actor, day)).rejects.toMatchObject({
      code: "SCHEDULE_DATE_OUT_OF_RANGE",
    });
    await expect(copyPreviousWeek(f.actor, day)).rejects.toMatchObject({
      code: "SCHEDULE_DATE_OUT_OF_RANGE",
    });
  }
});

test("copy accepts the final valid date and rolls back a week containing an outside occurrence", async () => {
  const valid = await fixture();
  await valid.add("2099-12-24T10:00");
  expect(await copyPreviousWeek(valid.actor, "2099-12-28")).toBe(1);
  expect(await copyPreviousWeek(valid.actor, "2099-12-28")).toBe(0);
  const copied = await db.classSession.findFirstOrThrow({
    where: { shopId: valid.shop.id, dedupeKey: { startsWith: "copy-" } },
  });
  expect(
    DateTime.fromJSDate(copied.startsAt, {
      zone: valid.location.timezone,
    }).toISODate(),
  ).toBe("2099-12-31");
  const invalid = await fixture();
  await invalid.add("2099-12-23T10:00");
  await invalid.add("2099-12-26T10:00");
  await expect(
    copyPreviousWeek(invalid.actor, "2099-12-28"),
  ).rejects.toMatchObject({ code: "SCHEDULE_DATE_OUT_OF_RANGE" });
  expect(
    await db.classSession.count({ where: { shopId: invalid.shop.id } }),
  ).toBe(2);
  expect(
    await db.auditLog.count({
      where: { shopId: invalid.shop.id, action: "SESSION_COPIED" },
    }),
  ).toBe(0);
});

test("publishing a boundary week validates each session instead of rejecting its week label", async () => {
  setDate("2025-12-20T00:00:00Z");
  const lower = await fixture();
  await lower.add("2026-01-01T10:00");
  expect(await publishWeek(lower.actor, "2025-12-29")).toBe(1);
  const upper = await fixture();
  await upper.add("2099-12-31T10:00");
  expect(await publishWeek(upper.actor, "2099-12-28")).toBe(1);
  const invalid = await fixture();
  await invalid.add("2099-12-30T10:00");
  await invalid.rawDraft("2100-01-01T10:00");
  await expect(publishWeek(invalid.actor, "2099-12-28")).rejects.toMatchObject({
    code: "SCHEDULE_DATE_OUT_OF_RANGE",
  });
  expect(
    await db.classSession.count({
      where: { shopId: invalid.shop.id, status: "PUBLISHED" },
    }),
  ).toBe(0);
});

test("unknown Service price stays draft until a price and coach are supplied; zero-price Pass remains valid", async () => {
  const f = await fixture();
  const draft = await saveService(f.actor, {
    ...f.serviceInput,
    name: "Synthetic price pending",
    status: "DRAFT",
    requestedPriceCents: 0,
    coachIds: [],
  });
  await expect(
    saveService(f.actor, {
      ...f.serviceInput,
      id: draft.id,
      version: draft.version,
      requestedPriceCents: 0,
    }),
  ).rejects.toMatchObject({
    issues: expect.arrayContaining([
      expect.objectContaining({ path: ["requestedPriceCents"] }),
    ]),
  });
  expect(
    await db.service.findUniqueOrThrow({ where: { id: draft.id } }),
  ).toMatchObject({
    status: "DRAFT",
    requestedPriceCents: 0,
    version: draft.version,
  });
  await expect(
    addSessions(f.actor, {
      serviceId: draft.id,
      coachId: f.coach.id,
      localStart: "2030-07-01T10:00",
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "INVALID_ASSIGNMENT" });
  const active = await saveService(f.actor, {
    ...f.serviceInput,
    id: draft.id,
    version: draft.version,
  });
  const [session] = await addSessions(f.actor, {
    serviceId: active.id,
    coachId: f.coach.id,
    localStart: "2030-07-01T10:00",
    requestId: randomUUID(),
  });
  expect(await publishWeek(f.actor, "2030-07-01")).toBe(1);
  expect(
    (await db.classSession.findUniqueOrThrow({ where: { id: session.id } }))
      .status,
  ).toBe("PUBLISHED");
  const pass = await savePass(f.actor, {
    name: "Synthetic legacy zero-price Pass",
    status: "ACTIVE",
    credits: 5,
    validityDays: 30,
    requestedPriceCents: 0,
    saleable: false,
    serviceIds: [active.id],
  });
  expect(pass).toMatchObject({
    status: "ACTIVE",
    requestedPriceCents: 0,
    saleable: false,
  });
});

test("an existing active zero-price Service cannot publish sessions or replace a published session", async () => {
  const f = await fixture();
  const [session] = await f.add("2030-07-01T10:00");
  await db.service.update({
    where: { id: f.service.id },
    data: { requestedPriceCents: 0 },
  });
  await expect(publishWeek(f.actor, "2030-07-01")).rejects.toMatchObject({
    code: "SERVICE_PRICE_REQUIRED",
  });
  expect(
    (await db.classSession.findUniqueOrThrow({ where: { id: session.id } }))
      .status,
  ).toBe("DRAFT");
  // Simulate a preexisting published row without exposing this state publicly.
  await db.classSession.update({
    where: { id: session.id },
    data: { status: "PUBLISHED" },
  });
  await expect(
    updateSession(f.actor, {
      id: session.id,
      serviceId: f.service.id,
      coachId: f.coach.id,
      localStart: "2030-07-02T10:00",
      capacity: 6,
      version: session.version,
    }),
  ).rejects.toMatchObject({ code: "SERVICE_PRICE_REQUIRED" });
  expect(
    (await db.classSession.findUniqueOrThrow({ where: { id: session.id } }))
      .startsAt,
  ).toEqual(session.startsAt);
});
