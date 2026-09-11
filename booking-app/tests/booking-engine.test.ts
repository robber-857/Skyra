import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, expect, test } from "vitest";
import { DateTime } from "luxon";
import db from "../app/db.server";
import {
  startAttempt,
  bookingPassOptions,
  resumeAttempt,
  createSeatHold,
  releaseSeatHold,
  classAvailability,
  expireBookingWork,
  bookingWindow,
  attemptReturnPath,
  type BookingActor,
} from "../app/services/booking.server";

beforeAll(() => {
  if (new URL(process.env.DATABASE_URL!).pathname !== "/skyra_booking_test")
    throw new Error("Tests require skyra_booking_test.");
});
afterAll(async () => {
  await db.$disconnect();
});
const rules = {
  bookingWindowDays: 14,
  bookingClosesBeforeMinutes: 120,
  seatHoldMinutes: 15,
  onlineBookingsEnabled: true,
};
async function fixture(capacity = 4) {
  const shop = await db.shop.create({
    data: {
      domain: randomUUID() + "-booking-test.myshopify.com",
      rules,
      rulesApprovedAt: new Date(),
    },
  });
  const shopId = shop.id;
  const location = await db.location.create({
    data: { shopId, name: "Studio" },
  });
  const coach = await db.coach.create({ data: { shopId, name: "Coach" } });
  const service = await db.service.create({
    data: {
      shopId,
      locationId: location.id,
      name: "Class",
      durationMin: 55,
      capacity,
      requestedPriceCents: 4900,
      status: "ACTIVE",
    },
  });
  const startsAt = new Date(Date.now() + 2 * 86400000),
    endsAt = new Date(startsAt.getTime() + 55 * 60000);
  const session = await db.classSession.create({
    data: {
      shopId,
      serviceId: service.id,
      coachId: coach.id,
      locationId: location.id,
      startsAt,
      endsAt,
      busyStartsAt: startsAt,
      busyEndsAt: endsAt,
      timezone: "Australia/Sydney",
      capacity,
      status: "PUBLISHED",
      dedupeKey: randomUUID(),
    },
  });
  const pass = await db.passPlan.create({
    data: {
      shopId,
      name: "5 Class Pass",
      credits: 5,
      validityDays: 90,
      requestedPriceCents: 22000,
      status: "ACTIVE",
    },
  });
  await db.passEligibility.create({
    data: { shopId, passPlanId: pass.id, serviceId: service.id },
  });
  await db.productMapping.create({
    data: {
      shopId,
      ownerType: "PASS_PLAN",
      ownerId: pass.id,
      variantGid: "gid://shopify/ProductVariant/123",
      syncStatus: "SYNCED",
      productStatus: "ACTIVE",
    },
  });
  const actor = (id: number | null = 1): BookingActor => ({
    shopId,
    customerGid: id ? "gid://shopify/Customer/" + id : null,
  });
  const start = (id: number | null = 1) =>
    startAttempt(actor(id), { sessionId: session.id, surface: "PROGRAMS" });
  const hold = (token: string, id = 1, key = randomUUID()) =>
    createSeatHold(actor(id), {
      token,
      passPlanId: pass.id,
      idempotencyKey: key,
    });
  return { shop, shopId, session, pass, actor, start, hold };
}

test("attempts are hashed, anonymous browsing has no occupancy, and return paths are allowlisted", async () => {
  const f = await fixture();
  const a = await f.start(null);
  expect(a.requiresLogin).toBe(true);
  const record = await db.bookingAttempt.findFirstOrThrow({
    where: { shopId: f.shopId },
  });
  expect(record.tokenHash).toHaveLength(64);
  expect(record.tokenHash).not.toContain(a.token);
  expect(a.returnPath).toBe(
    "/pages/programs?skyra_attempt=" + a.token + "#skyra-booking-programs",
  );
  expect(() => attemptReturnPath("https://evil.example", a.token)).toThrow();
  await expect(
    startAttempt(f.actor(), {
      sessionId: f.session.id,
      surface: "HOME",
      returnTo: "https://evil.example",
    }),
  ).rejects.toThrow();
  expect(
    (await classAvailability(f.shopId, [f.session.id])).get(f.session.id),
  ).toBe(4);
  expect(await db.bookingHold.count({ where: { shopId: f.shopId } })).toBe(0);
});

test("login claims an attempt once; cross-customer and cross-shop access are rejected", async () => {
  const f = await fixture(),
    other = await fixture();
  const a = await f.start(null);
  const claimed = await resumeAttempt(f.actor(1), a.token);
  expect(claimed.requiresLogin).toBe(false);
  expect(claimed.status).toBe("STARTED");
  await expect(resumeAttempt(f.actor(2), a.token)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(resumeAttempt(other.actor(1), a.token)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  expect((await resumeAttempt(f.actor(null), a.token)).requiresLogin).toBe(
    true,
  );
  const record = await db.bookingAttempt.findFirstOrThrow({
    where: { shopId: f.shopId },
  });
  await expect(
    db.bookingAttempt.update({
      where: { id: record.id },
      data: { customerId: null },
    }),
  ).rejects.toThrow();
});

test("two customers racing to claim one anonymous attempt bind only one identity", async () => {
  const f = await fixture();
  const a = await f.start(null);
  const results = await Promise.allSettled([
    resumeAttempt(f.actor(1), a.token),
    resumeAttempt(f.actor(2), a.token),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});

test("20 customers racing for the last seat produce exactly one hold", async () => {
  const f = await fixture(1);
  const attempts = await Promise.all(
    Array.from({ length: 20 }, (_, i) => f.start(i + 1)),
  );
  const results = await Promise.allSettled(
    attempts.map((a, i) => f.hold(a.token, i + 1)),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    results
      .filter((r) => r.status === "rejected")
      .every((r) => r.reason.code === "SOLD_OUT"),
  ).toBe(true);
  expect(
    await db.bookingHold.count({
      where: { shopId: f.shopId, status: "ACTIVE" },
    }),
  ).toBe(1);
  expect(
    (await classAvailability(f.shopId, [f.session.id])).get(f.session.id),
  ).toBe(0);
});

test("duplicate requests reuse one hold without extending its 15-minute expiry", async () => {
  const f = await fixture();
  const a = await f.start();
  const key = randomUUID();
  const holds = await Promise.all(
    Array.from({ length: 20 }, () => f.hold(a.token, 1, key)),
  );
  expect(new Set(holds.map((h) => h.id)).size).toBe(1);
  expect(new Set(holds.map((h) => h.expiresAt.getTime())).size).toBe(1);
  expect(holds[0].expiresAt.getTime() - holds[0].createdAt.getTime()).toBe(
    15 * 60000,
  );
  expect((await f.hold(a.token)).id).toBe(holds[0].id);
  expect(
    await db.auditLog.count({
      where: { shopId: f.shopId, action: "HOLD_CREATED" },
    }),
  ).toBe(1);
});

test("different attempts for the same customer cannot multiply active holds", async () => {
  const f = await fixture();
  const a = await f.start(),
    b = await f.start();
  const results = await Promise.allSettled([f.hold(a.token), f.hold(b.token)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    await db.bookingHold.count({
      where: { shopId: f.shopId, status: "ACTIVE" },
    }),
  ).toBe(1);
});

test("idempotency keys cannot be repurposed for a different attempt", async () => {
  const f = await fixture();
  const a = await f.start(),
    b = await f.start(),
    key = randomUUID();
  await f.hold(a.token, 1, key);
  await expect(f.hold(b.token, 1, key)).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
});

test("expired holds stop counting immediately, before the worker runs", async () => {
  const f = await fixture(1),
    a = await f.start();
  const hold = await f.hold(a.token);
  await db.bookingHold.update({
    where: { id: hold.id },
    data: {
      createdAt: new Date(Date.now() - 16 * 60000),
      expiresAt: new Date(Date.now() - 60000),
    },
  });
  expect(
    (await classAvailability(f.shopId, [f.session.id])).get(f.session.id),
  ).toBe(1);
  const b = await f.start(2);
  await f.hold(b.token, 2);
  expect(
    (await db.bookingHold.findUniqueOrThrow({ where: { id: hold.id } })).status,
  ).toBe("EXPIRED");
  expect((await resumeAttempt(f.actor(), a.token)).status).toBe("RECOVERY");
  await expect(f.hold(a.token)).rejects.toMatchObject({
    code: "ATTEMPT_EXPIRED",
  });
});

test("expiry worker is repeatable, updates attempts and appends one audit event", async () => {
  const f = await fixture(),
    a = await f.start(),
    h = await f.hold(a.token);
  await db.bookingHold.update({
    where: { id: h.id },
    data: {
      createdAt: new Date(Date.now() - 16 * 60000),
      expiresAt: new Date(Date.now() - 60000),
    },
  });
  await db.bookingAttempt.updateMany({
    where: { shopId: f.shopId },
    data: {
      createdAt: new Date(Date.now() - 31 * 60000),
      expiresAt: new Date(Date.now() - 60000),
    },
  });
  await expireBookingWork();
  await expireBookingWork();
  expect((await resumeAttempt(f.actor(), a.token)).status).toBe("EXPIRED");
  expect(
    await db.auditLog.count({
      where: { shopId: f.shopId, action: "HOLD_EXPIRED" },
    }),
  ).toBe(1);
});

test("release is owner-only, idempotent and restores capacity", async () => {
  const f = await fixture(1),
    a = await f.start();
  await f.hold(a.token);
  await expect(releaseSeatHold(f.actor(2), a.token)).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(releaseSeatHold(f.actor(null), a.token)).rejects.toMatchObject({
    code: "LOGIN_REQUIRED",
  });
  await releaseSeatHold(f.actor(), a.token);
  await releaseSeatHold(f.actor(), a.token);
  expect(
    (await classAvailability(f.shopId, [f.session.id])).get(f.session.id),
  ).toBe(1);
  expect(
    await db.auditLog.count({
      where: { shopId: f.shopId, action: "HOLD_RELEASED" },
    }),
  ).toBe(1);
});

test("disabled booking, unavailable Pass and anonymous requests cannot create holds", async () => {
  const f = await fixture();
  const anonymous = await f.start(null),
    a = await f.start();
  await expect(f.hold(anonymous.token)).rejects.toMatchObject({
    code: "LOGIN_REQUIRED",
  });
  await db.shop.update({
    where: { id: f.shopId },
    data: { rules: { ...rules, onlineBookingsEnabled: false } },
  });
  await expect(f.hold(a.token)).rejects.toMatchObject({
    code: "BOOKING_NOT_ENABLED",
  });
  await db.shop.update({ where: { id: f.shopId }, data: { rules } });
  await db.passPlan.update({
    where: { id: f.pass.id },
    data: { status: "INACTIVE" },
  });
  await expect(f.hold(a.token)).rejects.toMatchObject({
    code: "PASS_UNAVAILABLE",
  });
  expect(await db.bookingHold.count({ where: { shopId: f.shopId } })).toBe(0);
});

test("server rules enforce 14 days and the two-hour closing boundary including DST", async () => {
  const f = await fixture();
  const startsAt = DateTime.fromISO("2026-10-10T18:30", {
    zone: "Australia/Sydney",
  }).toJSDate();
  const s = { ...f.session, startsAt };
  const opens = DateTime.fromJSDate(startsAt, { zone: s.timezone })
    .minus({ days: 14 })
    .toJSDate();
  expect(bookingWindow(f.shop, s, new Date(opens.getTime() - 1))).toBe(
    "NOT_YET_OPEN",
  );
  expect(bookingWindow(f.shop, s, opens)).toBe("OPEN");
  expect(
    bookingWindow(f.shop, s, new Date(startsAt.getTime() - 120 * 60000)),
  ).toBe("BOOKING_CLOSED");
  await db.classSession.update({
    where: { id: f.session.id },
    data: { status: "CANCELLED" },
  });
  await expect(f.start()).rejects.toMatchObject({ code: "UNAVAILABLE" });
});

test("confirmed bookings consume capacity and the database itself rejects oversell and capacity reduction", async () => {
  const f = await fixture(2),
    a = await f.start(),
    b = await f.start(2);
  await f.hold(a.token);
  const profile = await db.customerProfile.findUniqueOrThrow({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: f.shopId,
        shopifyCustomerGid: f.actor(2).customerGid!,
      },
    },
  });
  await db.booking.create({
    data: { shopId: f.shopId, sessionId: f.session.id, customerId: profile.id },
  });
  expect(
    (await classAvailability(f.shopId, [f.session.id])).get(f.session.id),
  ).toBe(0);
  await expect(f.hold(b.token, 2)).rejects.toMatchObject({
    code: "ALREADY_RESERVED",
  });
  await expect(
    db.classSession.update({
      where: { id: f.session.id },
      data: { capacity: 1 },
    }),
  ).rejects.toThrow();
  await expect(
    db.booking.create({
      data: {
        shopId: f.shopId,
        sessionId: f.session.id,
        customerId: profile.id,
      },
    }),
  ).rejects.toThrow();
});

test("20 direct database booking inserts cannot bypass the final-seat lock", async () => {
  const f = await fixture(1);
  const customers = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      db.customerProfile.create({
        data: {
          shopId: f.shopId,
          shopifyCustomerGid: f.actor(i + 1).customerGid!,
        },
      }),
    ),
  );
  const writes = await Promise.allSettled(
    customers.map((c) =>
      db.booking.create({
        data: { shopId: f.shopId, sessionId: f.session.id, customerId: c.id },
      }),
    ),
  );
  expect(writes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
});

test("database foreign keys prohibit a hold with a different attempt customer or tenant", async () => {
  const f = await fixture(),
    other = await fixture(),
    a = await f.start(),
    b = await f.start(2);
  await resumeAttempt(f.actor(2), b.token);
  const attempt = await db.bookingAttempt.findFirstOrThrow({
    where: {
      shopId: f.shopId,
      customer: { shopifyCustomerGid: f.actor(1).customerGid! },
    },
  });
  const second = await db.customerProfile.findFirstOrThrow({
    where: { shopId: f.shopId, shopifyCustomerGid: f.actor(2).customerGid! },
  });
  await expect(
    db.bookingHold.create({
      data: {
        shopId: f.shopId,
        attemptId: attempt.id,
        sessionId: f.session.id,
        customerId: second.id,
        passPlanId: f.pass.id,
        idempotencyKey: randomUUID(),
        expiresAt: new Date(Date.now() + 60000),
      },
    }),
  ).rejects.toThrow();
  await expect(
    startAttempt(f.actor(), { sessionId: other.session.id, surface: "HOME" }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(a.token).toHaveLength(43);
});

test("a Pass that expires before class and an unchecked intro Pass cannot hold seats", async () => {
  const f = await fixture(),
    a = await f.start();
  await db.passPlan.update({
    where: { id: f.pass.id },
    data: { validityDays: 1 },
  });
  await expect(f.hold(a.token)).rejects.toMatchObject({
    code: "PASS_EXPIRES_BEFORE_CLASS",
  });
  await db.passPlan.update({
    where: { id: f.pass.id },
    data: { validityDays: 90, introOnly: true },
  });
  await expect(f.hold(a.token)).rejects.toMatchObject({
    code: "INTRO_NOT_READY",
  });
});

test("an expired anonymous attempt cannot bind a customer or extend its lifetime", async () => {
  const f = await fixture(),
    a = await f.start(null);
  const expiresAt = new Date(Date.now() - 60000);
  await db.bookingAttempt.updateMany({
    where: { shopId: f.shopId },
    data: { createdAt: new Date(Date.now() - 31 * 60000), expiresAt },
  });
  const restored = await resumeAttempt(f.actor(), a.token);
  expect(restored.status).toBe("EXPIRED");
  const record = await db.bookingAttempt.findFirstOrThrow({
    where: { shopId: f.shopId },
  });
  expect(record.customerId).toBeNull();
  expect(record.expiresAt).toEqual(expiresAt);
});

async function selectablePass(f: Awaited<ReturnType<typeof fixture>>) {
  await db.productMapping.updateMany({
    where: { shopId: f.shopId, ownerType: "PASS_PLAN" },
    data: {
      productGid: "gid://shopify/Product/123",
      publishedPrice: "220.00",
      shopifyVersion: 1,
      requestedVersion: 1,
    },
  });
}
test("Pass options require the bound Shopify customer and isolate shops", async () => {
  const f = await fixture(),
    other = await fixture();
  await selectablePass(f);
  const { token } = await f.start();
  await expect(
    bookingPassOptions(f.actor(null), { token }),
  ).rejects.toMatchObject({ code: "LOGIN_REQUIRED" });
  await expect(bookingPassOptions(f.actor(2), { token })).rejects.toMatchObject(
    { code: "FORBIDDEN" },
  );
  await expect(
    bookingPassOptions(other.actor(), { token }),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  const result = await bookingPassOptions(f.actor(), { token });
  expect(result.passes).toHaveLength(1);
  expect(result.checkoutAvailable).toBe(false);
  expect(await db.bookingHold.count({ where: { shopId: f.shopId } })).toBe(0);
});
test("Review rejects expired attempts and closed or full classes", async () => {
  const f = await fixture(1);
  await selectablePass(f);
  const a = await f.start(),
    b = await f.start(2);
  await f.hold(b.token, 2);
  await expect(
    bookingPassOptions(f.actor(), { token: a.token, passPlanId: f.pass.id }),
  ).rejects.toMatchObject({ code: "SOLD_OUT" });
  await db.bookingAttempt.updateMany({
    where: { shopId: f.shopId },
    data: {
      createdAt: new Date(Date.now() - 31 * 60000),
      expiresAt: new Date(Date.now() - 60000),
    },
  });
  await expect(
    bookingPassOptions(f.actor(), { token: a.token }),
  ).rejects.toMatchObject({ code: "ATTEMPT_EXPIRED" });
});
test("Only eligible active synchronized non-intro Passes are shown", async () => {
  const f = await fixture();
  await selectablePass(f);
  const { token } = await f.start();
  for (const change of [
    { introOnly: true },
    { status: "DRAFT" },
    { validityDays: 1 },
  ]) {
    await db.passPlan.update({ where: { id: f.pass.id }, data: change });
    expect((await bookingPassOptions(f.actor(), { token })).passes).toEqual([]);
    await db.passPlan.update({
      where: { id: f.pass.id },
      data: { introOnly: false, status: "ACTIVE", validityDays: 90 },
    });
  }
  await db.passEligibility.deleteMany({ where: { passPlanId: f.pass.id } });
  expect((await bookingPassOptions(f.actor(), { token })).passes).toEqual([]);
});
test("Review revalidates price and mapping version without trusting a browser amount", async () => {
  const f = await fixture();
  await selectablePass(f);
  const { token } = await f.start();
  expect(
    (await bookingPassOptions(f.actor(), { token, passPlanId: f.pass.id }))
      .selected?.priceCents,
  ).toBe(22000);
  await db.passPlan.update({
    where: { id: f.pass.id },
    data: { requestedPriceCents: 22500, version: 2 },
  });
  await expect(
    bookingPassOptions(f.actor(), { token, passPlanId: f.pass.id }),
  ).rejects.toMatchObject({ code: "PASS_UNAVAILABLE" });
  await db.productMapping.updateMany({
    where: { shopId: f.shopId },
    data: { publishedPrice: "225.00", shopifyVersion: 2, requestedVersion: 2 },
  });
  expect(
    (await bookingPassOptions(f.actor(), { token, passPlanId: f.pass.id }))
      .selected?.priceCents,
  ).toBe(22500);
  await expect(
    bookingPassOptions(f.actor(), {
      token,
      passPlanId: f.pass.id,
      priceCents: 1,
    }),
  ).rejects.toThrow();
  const foreign = await fixture();
  await expect(
    bookingPassOptions(f.actor(), { token, passPlanId: foreign.pass.id }),
  ).rejects.toMatchObject({ code: "PASS_UNAVAILABLE" });
});
