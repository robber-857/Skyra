import { createHash, randomBytes } from "node:crypto";
import {
  Prisma,
  type BookingAttempt,
  type Shop,
  type ProductMapping,
} from "@prisma/client";
import { DateTime } from "luxon";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";

type Tx = Prisma.TransactionClient;
export type BookingActor = { shopId: string; customerGid: string | null };
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const hash = (token: string) =>
  createHash("sha256").update(tokenSchema.parse(token)).digest("hex");
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}
const txOptions = { maxWait: 30000, timeout: 15000 };
export const startInput = z
  .object({
    sessionId: z.string().uuid(),
    surface: z.enum(["HOME", "PROGRAMS"]),
  })
  .strict();

export async function databaseNow(tx: Tx) {
  const [row] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  return row.now;
}
async function lockSession(tx: Tx, shopId: string, sessionId: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "ClassSession" WHERE "shopId" = ${shopId}::uuid AND id = ${sessionId}::uuid FOR UPDATE`;
  if (!rows.length) fail("NOT_FOUND", "Class not found.", 404);
}
async function activeShop(tx: Tx, shopId: string) {
  const shop = await tx.shop.findUnique({ where: { id: shopId } });
  if (!shop || shop.status !== "ACTIVE")
    return fail("NOT_FOUND", "Booking is unavailable for this store.", 404);
  return shop;
}
export function bookingWindow(
  shop: Shop,
  session: { startsAt: Date; timezone: string; status: string },
  now: Date,
) {
  const rules = shop.rules as Record<string, unknown>;
  if (
    !shop.rulesApprovedAt ||
    rules.bookingWindowDays !== 14 ||
    rules.bookingClosesBeforeMinutes !== 120 ||
    rules.seatHoldMinutes !== 15
  )
    return "RULES_NOT_READY";
  if (session.status !== "PUBLISHED") return "UNAVAILABLE";
  if (now.getTime() >= session.startsAt.getTime() - 120 * 60000)
    return "BOOKING_CLOSED";
  // Calendar days in the location timezone preserve the studio's DST behavior.
  const opensAt = DateTime.fromJSDate(session.startsAt, {
    zone: session.timezone,
  })
    .minus({ days: 14 })
    .toMillis();
  return now.getTime() < opensAt ? "NOT_YET_OPEN" : "OPEN";
}
async function classForBooking(
  tx: Tx,
  shop: Shop,
  sessionId: string,
  now: Date,
) {
  const session = await tx.classSession.findFirst({
    where: { shopId: shop.id, id: sessionId },
    include: { service: true, coach: true, location: true },
  });
  if (
    !session ||
    session.service.status !== "ACTIVE" ||
    session.service.kind !== "CLASS" ||
    session.coach.status !== "ACTIVE"
  )
    return fail("UNAVAILABLE", "This class is no longer available.");
  const window = bookingWindow(shop, session, now);
  if (window !== "OPEN")
    fail(window, "This class is outside its booking window.");
  return session;
}
async function customer(tx: Tx, actor: BookingActor) {
  if (
    !actor.customerGid ||
    !/^gid:\/\/shopify\/Customer\/[1-9]\d*$/.test(actor.customerGid)
  )
    return fail("LOGIN_REQUIRED", "Sign in with Shopify to continue.", 401);
  return tx.customerProfile.upsert({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: actor.shopId,
        shopifyCustomerGid: actor.customerGid,
      },
    },
    create: { shopId: actor.shopId, shopifyCustomerGid: actor.customerGid },
    update: {},
  });
}
async function audit(
  tx: Tx,
  actor: BookingActor,
  action: string,
  entityId: string,
  after: Prisma.InputJsonValue,
) {
  await tx.auditLog.create({
    data: {
      shopId: actor.shopId,
      actorId: actor.customerGid || "ANONYMOUS",
      action,
      entityId,
      after,
    },
  });
}
export async function classAvailability(
  shopId: string,
  ids: string[],
  tx: Tx = db,
) {
  if (!ids.length) return new Map<string, number>();
  const rows = await tx.$queryRaw<
    { id: string; remaining: number }[]
  >(Prisma.sql`
    SELECT s.id, GREATEST(0, s.capacity
      - (SELECT count(*)::int FROM "Booking" b WHERE b."shopId" = s."shopId" AND b."sessionId" = s.id AND b.status = 'CONFIRMED')
      - (SELECT count(*)::int FROM "BookingHold" h WHERE h."shopId" = s."shopId" AND h."sessionId" = s.id AND h.status = 'ACTIVE' AND h."expiresAt" > clock_timestamp()))::int AS remaining
    FROM "ClassSession" s WHERE s."shopId" = ${shopId}::uuid AND s.id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`);
  return new Map(rows.map((row) => [row.id, row.remaining]));
}
export function attemptReturnPath(surface: string, token: string) {
  tokenSchema.parse(token);
  const path =
    surface === "HOME"
      ? "/"
      : surface === "PROGRAMS"
        ? "/pages/programs"
        : fail("INVALID_SURFACE", "Invalid booking surface.", 400);
  return (
    path +
    "?skyra_attempt=" +
    encodeURIComponent(token) +
    "#skyra-booking-" +
    surface.toLowerCase()
  );
}
async function snapshot(
  tx: Tx,
  attempt: BookingAttempt,
  token: string,
  requiresLogin: boolean,
) {
  const session = await tx.classSession.findUniqueOrThrow({
    where: { id: attempt.sessionId },
    include: { service: true, coach: true, location: true },
  });
  const hold = await tx.bookingHold.findUnique({
    where: { attemptId: attempt.id },
  });
  const availability = await classAvailability(
    attempt.shopId,
    [session.id],
    tx,
  );
  return {
    token,
    surface: attempt.surface,
    status: attempt.status,
    requiresLogin,
    expiresAt: attempt.expiresAt.toISOString(),
    returnPath: attemptReturnPath(attempt.surface, token),
    session: {
      id: session.id,
      startsAt: session.startsAt.toISOString(),
      endsAt: session.endsAt.toISOString(),
      timezone: session.timezone,
      spotsRemaining: availability.get(session.id) || 0,
      bookingStatus: bookingWindow(
        await activeShop(tx, attempt.shopId),
        session,
        await databaseNow(tx),
      ),
      service: {
        id: session.service.id,
        name: session.service.name,
        description: session.service.description,
        durationMin: session.service.durationMin,
        level: session.service.level,
      },
      coach: { id: session.coach.id, name: session.coach.name },
      location: { id: session.location.id, name: session.location.name },
    },
    hold:
      !requiresLogin && hold
        ? {
            id: hold.id,
            status: hold.status,
            expiresAt: hold.expiresAt.toISOString(),
          }
        : null,
  };
}
export async function startAttempt(actor: BookingActor, raw: unknown) {
  const input = startInput.parse(raw);
  const token = randomBytes(32).toString("base64url");
  return db.$transaction(async (tx) => {
    await lockSession(tx, actor.shopId, input.sessionId);
    const shop = await activeShop(tx, actor.shopId);
    const now = await databaseNow(tx);
    await classForBooking(tx, shop, input.sessionId, now);
    if (
      (await classAvailability(shop.id, [input.sessionId], tx)).get(
        input.sessionId,
      ) === 0
    )
      fail("SOLD_OUT", "This class is full. Please choose another class.");
    const profile = actor.customerGid ? await customer(tx, actor) : null;
    const attempt = await tx.bookingAttempt.create({
      data: {
        shopId: shop.id,
        sessionId: input.sessionId,
        surface: input.surface,
        tokenHash: hash(token),
        customerId: profile?.id,
        status: profile ? "STARTED" : "LOGIN_REQUIRED",
        createdAt: now,
        expiresAt: new Date(now.getTime() + 30 * 60000),
      },
    });
    await audit(tx, actor, "ATTEMPT_STARTED", attempt.id, {
      surface: input.surface,
      sessionId: input.sessionId,
    });
    return snapshot(tx, attempt, token, !profile);
  }, txOptions);
}
async function withAttempt<T>(
  actor: BookingActor,
  token: string,
  fn: (tx: Tx, attempt: BookingAttempt, shop: Shop, now: Date) => Promise<T>,
) {
  const tokenHash = hash(token);
  return db.$transaction(async (tx) => {
    const first = await tx.bookingAttempt.findFirst({
      where: { shopId: actor.shopId, tokenHash },
    });
    if (!first) return fail("NOT_FOUND", "Booking attempt not found.", 404);
    await lockSession(tx, actor.shopId, first.sessionId);
    await tx.$queryRaw`SELECT id FROM "BookingAttempt" WHERE id = ${first.id}::uuid FOR UPDATE`;
    const attempt = await tx.bookingAttempt.findUniqueOrThrow({
      where: { id: first.id },
    });
    const shop = await activeShop(tx, actor.shopId);
    if (attempt.customerId && actor.customerGid) {
      const owner = await tx.customerProfile.findUniqueOrThrow({
        where: { id: attempt.customerId },
      });
      if (owner.shopifyCustomerGid !== actor.customerGid)
        fail("FORBIDDEN", "This booking belongs to another account.", 403);
    }
    return fn(tx, attempt, shop, await databaseNow(tx));
  }, txOptions);
}
async function expireSessionHolds(
  tx: Tx,
  shopId: string,
  sessionId: string,
  now: Date,
) {
  const holds = await tx.bookingHold.findMany({
    where: { shopId, sessionId, status: "ACTIVE", expiresAt: { lte: now } },
  });
  for (const hold of holds) {
    await tx.bookingHold.update({
      where: { id: hold.id },
      data: { status: "EXPIRED" },
    });
    await tx.bookingAttempt.updateMany({
      where: { id: hold.attemptId, status: "HOLD_ACTIVE" },
      data: { status: "RECOVERY" },
    });
    await audit(tx, { shopId, customerGid: null }, "HOLD_EXPIRED", hold.id, {
      status: "EXPIRED",
    });
  }
  return holds.length;
}
export async function resumeAttempt(actor: BookingActor, token: string) {
  return withAttempt(actor, token, async (tx, attempt, shop, now) => {
    await expireSessionHolds(tx, shop.id, attempt.sessionId, now);
    attempt = await tx.bookingAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    if (attempt.expiresAt <= now) {
      attempt = await tx.bookingAttempt.update({
        where: { id: attempt.id },
        data: { status: "EXPIRED" },
      });
    } else if (actor.customerGid && !attempt.customerId) {
      const profile = await customer(tx, actor);
      attempt = await tx.bookingAttempt.update({
        where: { id: attempt.id },
        data: { customerId: profile.id, status: "STARTED" },
      });
      await audit(tx, actor, "ATTEMPT_CUSTOMER_BOUND", attempt.id, {
        customerId: profile.id,
      });
    }
    if (!["EXPIRED", "RECOVERY"].includes(attempt.status)) {
      try {
        await classForBooking(tx, shop, attempt.sessionId, now);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        attempt = await tx.bookingAttempt.update({
          where: { id: attempt.id },
          data: { status: "RECOVERY" },
        });
      }
    }
    return snapshot(tx, attempt, token, !actor.customerGid);
  });
}
export const holdInput = z
  .object({
    token: tokenSchema,
    passPlanId: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
// Internal commerce primitive. No public hold/checkout endpoint until M4 can create a cart safely.
export async function createSeatHold(actor: BookingActor, raw: unknown) {
  const input = holdInput.parse(raw);
  return withAttempt(actor, input.token, async (tx, attempt, shop, now) => {
    if (!actor.customerGid || !attempt.customerId)
      return fail("LOGIN_REQUIRED", "Sign in before reserving a seat.", 401);
    if ((shop.rules as Record<string, unknown>).onlineBookingsEnabled !== true)
      fail(
        "BOOKING_NOT_ENABLED",
        "Online booking is not enabled for this store.",
        503,
      );
    if (
      attempt.expiresAt <= now ||
      ["EXPIRED", "RECOVERY"].includes(attempt.status)
    )
      fail("ATTEMPT_EXPIRED", "Start a new booking to continue.");
    const session = await classForBooking(tx, shop, attempt.sessionId, now);
    const replay = await tx.bookingHold.findUnique({
      where: {
        shopId_customerId_idempotencyKey: {
          shopId: shop.id,
          customerId: attempt.customerId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (
      replay &&
      (replay.attemptId !== attempt.id ||
        replay.passPlanId !== input.passPlanId)
    )
      fail(
        "IDEMPOTENCY_CONFLICT",
        "This request was already used for another booking.",
      );
    const existing =
      replay ||
      (await tx.bookingHold.findUnique({ where: { attemptId: attempt.id } }));
    if (existing) {
      if (existing.passPlanId !== input.passPlanId)
        fail(
          "IDEMPOTENCY_CONFLICT",
          "The selected Pass has changed. Start a new booking.",
        );
      if (existing.status !== "ACTIVE" || existing.expiresAt <= now)
        fail(
          "HOLD_EXPIRED",
          "Your seat hold has expired. Start a new booking.",
        );
      return existing;
    }
    const eligible = await tx.passEligibility.findFirst({
      where: {
        shopId: shop.id,
        serviceId: session.serviceId,
        passPlanId: input.passPlanId,
      },
      include: { passPlan: true },
    });
    const mapping = await tx.productMapping.findUnique({
      where: {
        shopId_ownerType_ownerId: {
          shopId: shop.id,
          ownerType: "PASS_PLAN",
          ownerId: input.passPlanId,
        },
      },
    });
    if (
      !eligible ||
      eligible.passPlan.status !== "ACTIVE" ||
      !mapping?.variantGid ||
      mapping.syncStatus !== "SYNCED" ||
      mapping.productStatus !== "ACTIVE"
    )
      fail("PASS_UNAVAILABLE", "This Pass is not available for this class.");
    const validUntil = DateTime.fromJSDate(now, { zone: session.timezone })
      .plus({ days: eligible.passPlan.validityDays })
      .toMillis();
    if (session.startsAt.getTime() >= validUntil)
      fail(
        "PASS_EXPIRES_BEFORE_CLASS",
        "This Pass would expire before the class.",
      );
    // Intro-history eligibility will be enabled with the entitlement ledger, never guessed.
    if (eligible.passPlan.introOnly)
      fail("INTRO_NOT_READY", "Intro Pass eligibility is not available yet.");
    await expireSessionHolds(tx, shop.id, session.id, now);
    const occupied = await tx.bookingHold.findFirst({
      where: {
        shopId: shop.id,
        sessionId: session.id,
        customerId: attempt.customerId,
        status: "ACTIVE",
      },
    });
    const booked = await tx.booking.findFirst({
      where: {
        shopId: shop.id,
        sessionId: session.id,
        customerId: attempt.customerId,
        status: "CONFIRMED",
      },
    });
    if (occupied || booked)
      fail(
        "ALREADY_RESERVED",
        "You already have a booking or seat hold for this class.",
      );
    if (
      (await classAvailability(shop.id, [session.id], tx)).get(session.id) === 0
    )
      fail("SOLD_OUT", "This class is full. Please choose another class.");
    const hold = await tx.bookingHold.create({
      data: {
        shopId: shop.id,
        attemptId: attempt.id,
        customerId: attempt.customerId,
        sessionId: session.id,
        passPlanId: input.passPlanId,
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60000),
      },
    });
    await tx.bookingAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "HOLD_ACTIVE",
        expiresAt: new Date(
          Math.max(attempt.expiresAt.getTime(), hold.expiresAt.getTime()),
        ),
      },
    });
    await audit(tx, actor, "HOLD_CREATED", hold.id, {
      attemptId: attempt.id,
      sessionId: session.id,
      expiresAt: hold.expiresAt.toISOString(),
    });
    return hold;
  });
}
export async function releaseSeatHold(actor: BookingActor, token: string) {
  return withAttempt(actor, token, async (tx, attempt, shop, now) => {
    if (!actor.customerGid || !attempt.customerId)
      fail("LOGIN_REQUIRED", "Sign in to release this hold.", 401);
    await expireSessionHolds(tx, shop.id, attempt.sessionId, now);
    const hold = await tx.bookingHold.findUnique({
      where: { attemptId: attempt.id },
    });
    if (!hold || hold.status !== "ACTIVE") return hold;
    const released = await tx.bookingHold.update({
      where: { id: hold.id },
      data: { status: "RELEASED" },
    });
    await tx.bookingAttempt.update({
      where: { id: attempt.id },
      data: { status: "RECOVERY" },
    });
    await audit(tx, actor, "HOLD_RELEASED", hold.id, { status: "RELEASED" });
    return released;
  });
}
export async function expireBookingWork(batchSize = 100) {
  // Bound each sweep; use the same session -> attempt lock order as the request path.
  const now = await databaseNow(db);
  const holds = await db.bookingHold.findMany({
    where: { status: "ACTIVE", expiresAt: { lte: now } },
    take: batchSize,
    orderBy: { expiresAt: "asc" },
  });
  const attempts = await db.bookingAttempt.findMany({
    where: { status: { not: "EXPIRED" }, expiresAt: { lte: now } },
    take: batchSize,
    orderBy: { expiresAt: "asc" },
  });
  const keys = new Map(
    [...holds, ...attempts].map((row) => [
      row.sessionId,
      { shopId: row.shopId, sessionId: row.sessionId },
    ]),
  );
  let released = 0,
    expired = 0;
  for (const { shopId, sessionId } of keys.values()) {
    await db.$transaction(async (tx) => {
      await lockSession(tx, shopId, sessionId);
      const clock = await databaseNow(tx);
      released += await expireSessionHolds(tx, shopId, sessionId, clock);
      expired += (
        await tx.bookingAttempt.updateMany({
          where: {
            shopId,
            sessionId,
            expiresAt: { lte: clock },
            status: { not: "EXPIRED" },
          },
          data: { status: "EXPIRED" },
        })
      ).count;
    }, txOptions);
  }
  return { released, expired };
}

// Read-only selection/review. No Hold or Shopify Cart is created by this endpoint.
export const passOptionsInput = z
  .object({
    token: tokenSchema,
    passPlanId: z.string().uuid().optional(),
    purchaseKind: z.enum(["NEW_PASS", "DROP_IN"]).optional(),
  })
  .strict()
  .refine(
    (input) => input.purchaseKind !== "DROP_IN" || !input.passPlanId,
    "A drop-in cannot select a Pass",
  )
  .refine(
    (input) => input.purchaseKind !== "NEW_PASS" || Boolean(input.passPlanId),
    "Select a Pass for review",
  );

function purchaseMappingReady(
  mapping: ProductMapping | null | undefined,
  owner: { version: number; requestedPriceCents: number },
) {
  return Boolean(
    mapping?.variantGid &&
    mapping.productGid &&
    mapping.syncStatus === "SYNCED" &&
    mapping.productStatus === "ACTIVE" &&
    mapping.shopifyVersion === owner.version &&
    mapping.requestedVersion === owner.version &&
    /^\d+(\.\d{1,2})?$/.test(mapping.publishedPrice || "") &&
    Math.round(Number(mapping.publishedPrice) * 100) ===
      owner.requestedPriceCents,
  );
}
export async function bookingPassOptions(actor: BookingActor, raw: unknown) {
  const input = passOptionsInput.parse(raw);
  return withAttempt(actor, input.token, async (tx, attempt, shop, now) => {
    if (!actor.customerGid || !attempt.customerId)
      fail("LOGIN_REQUIRED", "Sign in with Shopify to choose a Pass.", 401);
    if (attempt.expiresAt <= now || attempt.status !== "STARTED")
      fail(
        "ATTEMPT_EXPIRED",
        "This booking needs to be restarted. Choose the class again.",
      );
    const session = await classForBooking(tx, shop, attempt.sessionId, now);
    const spots =
      (await classAvailability(shop.id, [session.id], tx)).get(session.id) || 0;
    if (!spots) fail("SOLD_OUT", "This class is full. Choose another class.");
    const plans = await tx.passPlan.findMany({
      where: {
        shopId: shop.id,
        status: "ACTIVE",
        introOnly: false,
        services: { some: { shopId: shop.id, serviceId: session.serviceId } },
      },
      orderBy: [{ requestedPriceCents: "asc" }, { id: "asc" }],
    });
    const mappings = await tx.productMapping.findMany({
      where: {
        shopId: shop.id,
        ownerType: "PASS_PLAN",
        ownerId: { in: plans.map((p) => p.id) },
        syncStatus: "SYNCED",
        productStatus: "ACTIVE",
      },
    });
    const passes = plans.flatMap((plan) => {
      const mapping = mappings.find((m) => m.ownerId === plan.id);
      if (
        !purchaseMappingReady(mapping, plan) ||
        DateTime.fromJSDate(now, { zone: session.timezone })
          .plus({ days: plan.validityDays })
          .toJSDate() < session.startsAt
      )
        return [];
      return [
        {
          id: plan.id,
          name: plan.name,
          credits: plan.credits,
          validityDays: plan.validityDays,
          priceCents: plan.requestedPriceCents,
          currency: "AUD",
          kind: "NEW_PASS" as const,
        },
      ];
    });
    // The dated Session supplies the Service. Never accept a client Service or Variant ID.
    const serviceMapping = await tx.productMapping.findUnique({
      where: {
        shopId_ownerType_ownerId: {
          shopId: shop.id,
          ownerType: "SERVICE",
          ownerId: session.serviceId,
        },
      },
    });
    const dropIn = purchaseMappingReady(serviceMapping, session.service)
      ? {
          id: session.serviceId,
          kind: "DROP_IN" as const,
          name: "Single class (Drop-in)",
          priceCents: session.service.requestedPriceCents,
          currency: "AUD",
        }
      : null;
    const selected =
      input.purchaseKind === "DROP_IN"
        ? dropIn
        : input.passPlanId
          ? passes.find((p) => p.id === input.passPlanId)
          : null;
    if (input.purchaseKind === "DROP_IN" && !dropIn)
      fail(
        "DROP_IN_UNAVAILABLE",
        "Single-class booking is not available right now. Choose another option.",
      );
    if (input.passPlanId && !selected)
      fail(
        "PASS_UNAVAILABLE",
        "This Pass has changed or is no longer available. Choose another Pass.",
      );
    return {
      attemptExpiresAt: attempt.expiresAt.toISOString(),
      spotsRemaining: spots,
      passes,
      dropIn,
      selected,
      checkoutAvailable: false,
      ownedPassesAvailable: false,
    };
  });
}
