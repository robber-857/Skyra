import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { lockShop } from "./catalog.server";
import { PRODUCTION_BOOKING_SHOP } from "./commerce-capabilities.server";
import { reserveEntitlementCredit } from "./entitlements.server";

const key = z.string().trim().min(1).max(240);
const uuid = z.string().uuid();
const date = z.string().datetime({ offset: true });
const units = z.number().int().min(0).max(100000);
export const mindbodyManifest = z
  .object({
    version: z.literal(1),
    sourceSystem: z.literal("MIND_BODY"),
    targetShop: z.literal(PRODUCTION_BOOKING_SHOP),
    shopId: uuid,
    batchKey: key,
    cutoff: date,
    customers: z.array(
      z
        .object({
          externalKey: key,
          customerId: uuid,
          mergeApproved: z.boolean().optional(),
        })
        .strict(),
    ),
    mappings: z.array(
      z
        .object({
          externalKey: key,
          entityType: z.enum(["SERVICE", "COACH", "LOCATION", "PASS_PLAN"]),
          targetId: uuid,
        })
        .strict(),
    ),
    passes: z.array(
      z
        .object({
          externalKey: key,
          customerKey: key,
          passKey: key,
          startsAt: date,
          expiresAt: date,
          available: units,
          reserved: units,
          consumed: units,
          legacyOnly: z.boolean().optional(),
          serviceKind: z.enum(["CLASS", "APPOINTMENT", "COURSE"]).optional(),
        })
        .strict(),
    ),
    sessions: z.array(
      z
        .object({
          externalKey: key,
          serviceKey: key,
          coachKey: key,
          locationKey: key,
          startsAt: date,
          endsAt: date,
          capacity: z.number().int().min(1).max(200),
        })
        .strict(),
    ),
    bookings: z.array(
      z
        .object({
          externalKey: key,
          customerKey: key,
          passKey: key,
          sessionKey: key,
        })
        .strict(),
    ),
  })
  .strict();
export type MindbodyManifest = z.infer<typeof mindbodyManifest>;
type Tx = Prisma.TransactionClient;
function fail(code: string): never {
  throw new DomainError(code, code);
}
function hash(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, canonical(val)]),
      );
    return v;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function validateMindbodyManifest(raw: unknown) {
  const parsed = mindbodyManifest.safeParse(raw);
  if (!parsed.success) fail("MIGRATION_INPUT_INVALID");
  const input = parsed.data;
  for (const rows of [
    input.customers,
    input.mappings.map((m) => ({
      externalKey: `${m.entityType}:${m.externalKey}`,
    })),
    input.passes,
    input.sessions,
    input.bookings,
  ]) {
    if (new Set(rows.map((r) => r.externalKey)).size !== rows.length)
      fail("MIGRATION_DUPLICATE_KEY");
  }
  for (const customer of input.customers) {
    const aliases = input.customers.filter(
      (c) => c.customerId === customer.customerId,
    );
    if (aliases.length > 1 && aliases.some((c) => c.mergeApproved !== true))
      fail("MIGRATION_CUSTOMER_MERGE_REVIEW");
  }
  const cutoff = new Date(input.cutoff);
  for (const pass of input.passes) {
    if (
      new Date(pass.expiresAt) <= cutoff ||
      new Date(pass.expiresAt) <= new Date(pass.startsAt) ||
      pass.available + pass.reserved + pass.consumed < 1
    )
      fail("MIGRATION_PASS_WINDOW_INVALID");
    const reservations = input.bookings.filter(
      (b) => b.passKey === pass.externalKey,
    );
    if (
      reservations.length !== pass.reserved ||
      reservations.some((b) => b.customerKey !== pass.customerKey)
    )
      fail("MIGRATION_RESERVED_MISMATCH");
  }
  for (const session of input.sessions) {
    if (
      new Date(session.startsAt) < cutoff ||
      new Date(session.endsAt) <= new Date(session.startsAt)
    )
      fail("MIGRATION_SESSION_WINDOW_INVALID");
  }
  for (const booking of input.bookings) {
    if (
      !input.passes.some((p) => p.externalKey === booking.passKey) ||
      !input.sessions.some((s) => s.externalKey === booking.sessionKey) ||
      !input.customers.some((c) => c.externalKey === booking.customerKey)
    )
      fail("MIGRATION_REFERENCE_MISSING");
  }
  return input;
}

async function source(
  tx: Tx,
  shopId: string,
  batchId: string,
  entityType: string,
  externalKey: string,
  value: unknown,
  create: () => Promise<string>,
) {
  // Store only hashes of source identifiers. No raw Client ID in application logs/audits.
  const hashedKey = hash(externalKey);
  const where = {
    shopId_sourceSystem_entityType_externalKey: {
      shopId,
      sourceSystem: "MIND_BODY",
      entityType,
      externalKey: hashedKey,
    },
  };
  const existing = await tx.migrationSource.findUnique({ where });
  const inputHash = hash(value);
  if (existing) {
    if (existing.inputHash !== inputHash) fail("IDEMPOTENCY_CONFLICT");
    return existing.targetId;
  }
  const targetId = await create();
  await tx.migrationSource.create({
    data: {
      shopId,
      batchId,
      sourceSystem: "MIND_BODY",
      entityType,
      externalKey: hashedKey,
      inputHash,
      targetId,
    },
  });
  return targetId;
}

export async function importMindbody(
  raw: unknown,
  options: {
    apply?: boolean;
    actorId: string;
    backupReference?: string;
    cutoffApproved?: boolean;
  },
) {
  const input = validateMindbodyManifest(raw);
  if (!options.actorId.trim()) fail("MIGRATION_ACTOR_REQUIRED");
  if (
    options.apply &&
    (!options.backupReference?.trim() || !options.cutoffApproved)
  )
    fail("MIGRATION_SIGNOFF_REQUIRED");
  if (
    options.apply &&
    (new Date(input.cutoff).getTime() > Date.now() ||
      Date.now() - new Date(input.cutoff).getTime() > 86400000)
  )
    fail("MIGRATION_CUTOFF_STALE");
  const shop = await db.shop.findUnique({ where: { id: input.shopId } });
  if (!shop || shop.domain !== PRODUCTION_BOOKING_SHOP)
    fail("MIGRATION_TARGET_MISMATCH");
  const inputHash = hash(input);
  const batchKey = hash(input.batchKey);
  const where = {
    shopId_sourceSystem_externalKey: {
      shopId: shop.id,
      sourceSystem: "MIND_BODY",
      externalKey: batchKey,
    },
  };
  const counts = {
    customers: new Set(input.customers.map((c) => c.customerId)).size,
    customerSourceRows: input.customers.length,
    passes: input.passes.length,
    sessions: input.sessions.length,
    bookings: input.bookings.length,
    available: input.passes.reduce((n, p) => n + p.available, 0),
    reserved: input.passes.reduce((n, p) => n + p.reserved, 0),
    consumed: input.passes.reduce((n, p) => n + p.consumed, 0),
  };
  const batchData = {
    shopId: shop.id,
    sourceSystem: "MIND_BODY",
    externalKey: batchKey,
    inputHash,
    status: "PENDING",
    actorId: options.actorId,
  };
  // Persistent failure envelope is separate from the atomic data transaction.
  const envelope = options.apply
    ? await db.migrationBatch.upsert({
        where,
        create: batchData,
        update: { attempts: { increment: 1 } },
      })
    : null;
  if (envelope && envelope.inputHash !== inputHash)
    fail("IDEMPOTENCY_CONFLICT");
  const rollback = new Error("DRY_RUN_ROLLBACK");
  let replay = false;
  try {
    await db.$transaction(
      async (tx) => {
        await lockShop(tx, shop.id);
        const currentShop = await tx.shop.findUniqueOrThrow({
          where: { id: shop.id },
        });
        if (
          currentShop.domain !== PRODUCTION_BOOKING_SHOP ||
          currentShop.status !== "ACTIVE" ||
          (currentShop.rules as Record<string, unknown>)
            .onlineBookingsEnabled === true
        )
          fail("MIGRATION_BOOKING_MUST_BE_CLOSED");
        let batch = await tx.migrationBatch.findUnique({ where });
        if (batch && batch.inputHash !== inputHash)
          fail("IDEMPOTENCY_CONFLICT");
        if (batch?.status === "COMPLETED") {
          replay = true;
          return;
        }
        if (!batch) batch = await tx.migrationBatch.create({ data: batchData });
        else if (batch.status === "FAILED")
          await tx.migrationBatch.update({
            where: { id: batch.id },
            data: { status: "PENDING", errorCode: null },
          });
        const batchId = batch.id;
        const customers = new Map<string, string>();
        for (const row of input.customers) {
          const customer = await tx.customerProfile.findFirst({
            where: { shopId: shop.id, id: row.customerId },
          });
          if (
            !customer ||
            !/^gid:\/\/shopify\/Customer\/[1-9]\d*$/.test(
              customer.shopifyCustomerGid,
            )
          )
            fail("MIGRATION_CUSTOMER_NOT_SYNCED");
          customers.set(
            row.externalKey,
            await source(
              tx,
              shop.id,
              batchId,
              "CUSTOMER",
              row.externalKey,
              row,
              async () => customer.id,
            ),
          );
        }
        const mapped = new Map<string, string>();
        for (const row of input.mappings) {
          const filter = { where: { shopId: shop.id, id: row.targetId } };
          const record =
            row.entityType === "SERVICE"
              ? await tx.service.findFirst(filter)
              : row.entityType === "COACH"
                ? await tx.coach.findFirst(filter)
                : row.entityType === "LOCATION"
                  ? await tx.location.findFirst(filter)
                  : await tx.passPlan.findFirst(filter);
          if (!record) fail("MIGRATION_CATALOG_MAPPING_MISSING");
          mapped.set(
            `${row.entityType}:${row.externalKey}`,
            await source(
              tx,
              shop.id,
              batchId,
              row.entityType,
              row.externalKey,
              row,
              async () => record.id,
            ),
          );
        }
        function ref(kind: string, key: string) {
          const id = mapped.get(`${kind}:${key}`);
          if (!id) fail("MIGRATION_CATALOG_MAPPING_MISSING");
          return id;
        }
        const passes = new Map<string, string>();
        for (const row of input.passes) {
          const customerId = customers.get(row.customerKey);
          if (!customerId) fail("MIGRATION_REFERENCE_MISSING");
          const passPlanId = ref("PASS_PLAN", row.passKey);
          const plan = await tx.passPlan.findUniqueOrThrow({
            where: { id: passPlanId },
          });
          const scope = await tx.passEligibility.findMany({
            where: { shopId: shop.id, passPlanId },
            include: { service: true },
          });
          if (row.legacyOnly && plan.saleable)
            fail("MIGRATION_LEGACY_PASS_MUST_NOT_BE_SALEABLE");
          if (
            !scope.length ||
            scope.some((s) => s.service.kind !== (row.serviceKind || "CLASS"))
          )
            fail("MIGRATION_PASS_SCOPE_MISMATCH");
          if (row.available + row.reserved + row.consumed > plan.credits)
            fail("MIGRATION_PASS_CREDITS_EXCEEDED");
          const mapping = await tx.productMapping.findUnique({
            where: {
              shopId_ownerType_ownerId: {
                shopId: shop.id,
                ownerType: "PASS_PLAN",
                ownerId: passPlanId,
              },
            },
          });
          if (!mapping) fail("MIGRATION_PRODUCT_MAPPING_MISSING");
          if (
            (mapping.productGid || mapping.variantGid) &&
            (await tx.productMapping.count({
              where: {
                shopId: { not: shop.id },
                OR: [
                  ...(mapping.productGid
                    ? [{ productGid: mapping.productGid }]
                    : []),
                  ...(mapping.variantGid
                    ? [{ variantGid: mapping.variantGid }]
                    : []),
                ],
              },
            }))
          )
            fail("MIGRATION_CROSS_SHOP_PRODUCT");
          passes.set(
            row.externalKey,
            await source(
              tx,
              shop.id,
              batchId,
              "ENTITLEMENT",
              row.externalKey,
              { ...row, customerId, passPlanId, productMappingId: mapping.id },
              async () => {
                const entitlement = await tx.entitlement.create({
                  data: {
                    shopId: shop.id,
                    customerId,
                    passPlanId,
                    productMappingId: mapping.id,
                    sourceSystem: "MIND_BODY",
                    externalKey: hash(row.externalKey),
                    startsAt: new Date(row.startsAt),
                    expiresAt: new Date(row.expiresAt),
                    grantedUnits: row.available + row.reserved + row.consumed,
                  },
                });
                await tx.entitlementLedgerEntry.create({
                  data: {
                    shopId: shop.id,
                    entitlementId: entitlement.id,
                    kind: "OPENING_BALANCE",
                    availableDelta: row.available + row.reserved,
                    reservedDelta: 0,
                    consumedDelta: row.consumed,
                    idempotencyKey: `mindbody-opening:${hash(row.externalKey)}`,
                    reason: "MIND_BODY_OPENING_BALANCE",
                  },
                });
                return entitlement.id;
              },
            ),
          );
        }
        const sessions = new Map<string, string>();
        for (const row of input.sessions) {
          const serviceId = ref("SERVICE", row.serviceKey),
            coachId = ref("COACH", row.coachKey),
            locationId = ref("LOCATION", row.locationKey);
          const service = await tx.service.findFirstOrThrow({
            where: { shopId: shop.id, id: serviceId },
          });
          const coach = await tx.coach.findFirstOrThrow({
            where: { shopId: shop.id, id: coachId },
          });
          if (
            service.locationId !== locationId ||
            (service.kind === "APPOINTMENT" && row.capacity !== 1) ||
            !(await tx.serviceCoach.findUnique({
              where: {
                shopId_serviceId_coachId: {
                  shopId: shop.id,
                  serviceId,
                  coachId,
                },
              },
            }))
          )
            fail("MIGRATION_SESSION_MAPPING_INVALID");
          const startsAt = new Date(row.startsAt),
            endsAt = new Date(row.endsAt);
          const dedupeKey = `mindbody:${hash([serviceId, coachId, locationId, startsAt.toISOString()])}`;
          sessions.set(
            row.externalKey,
            await source(
              tx,
              shop.id,
              batchId,
              "SESSION",
              row.externalKey,
              { ...row, serviceId, coachId, locationId },
              async () => {
                if (
                  await tx.classSession.count({
                    where: {
                      shopId: shop.id,
                      serviceId,
                      coachId,
                      locationId,
                      startsAt,
                    },
                  })
                )
                  fail("MIGRATION_EXISTING_SESSION_REVIEW");
                const session = await tx.classSession.create({
                  data: {
                    shopId: shop.id,
                    serviceId,
                    coachId,
                    locationId,
                    startsAt,
                    endsAt,
                    busyStartsAt: new Date(
                      startsAt.getTime() - coach.bufferBeforeMin * 60000,
                    ),
                    busyEndsAt: new Date(
                      endsAt.getTime() + coach.bufferAfterMin * 60000,
                    ),
                    timezone: "Australia/Sydney",
                    capacity: row.capacity,
                    status: "DRAFT",
                    dedupeKey,
                  },
                });
                return session.id;
              },
            ),
          );
        }
        for (const row of input.bookings) {
          const customerId = customers.get(row.customerKey),
            entitlementId = passes.get(row.passKey),
            sessionId = sessions.get(row.sessionKey);
          if (!customerId || !entitlementId || !sessionId)
            fail("MIGRATION_REFERENCE_MISSING");
          await source(
            tx,
            shop.id,
            batchId,
            "BOOKING",
            row.externalKey,
            { ...row, customerId, entitlementId, sessionId },
            async () => {
              await tx.$queryRaw`SELECT id FROM "ClassSession" WHERE id=${sessionId}::uuid AND "shopId"=${shop.id}::uuid FOR UPDATE`;
              const session = await tx.classSession.findUniqueOrThrow({
                where: { id: sessionId },
              });
              const occupied = await tx.booking.count({
                where: {
                  shopId: shop.id,
                  sessionId,
                  status: { in: ["CONFIRMED", "ATTENDED"] },
                },
              });
              if (occupied >= session.capacity)
                fail("MIGRATION_CAPACITY_EXCEEDED");
              if (
                await tx.booking.count({
                  where: {
                    shopId: shop.id,
                    sessionId,
                    customerId,
                    status: { in: ["CONFIRMED", "ATTENDED"] },
                  },
                })
              )
                fail("MIGRATION_EXISTING_BOOKING_REVIEW");
              const id = randomUUID();
              await tx.booking.create({
                data: { id, shopId: shop.id, customerId, sessionId },
              });
              await reserveEntitlementCredit(tx, {
                shopId: shop.id,
                entitlementId,
                customerId,
                serviceId: session.serviceId,
                sessionStartsAt: session.startsAt,
                now: new Date(input.cutoff),
                reservationKey: id,
                bookingId: id,
                idempotencyKey: `mindbody-reserve:${hash(row.externalKey)}`,
              });
              return id;
            },
          );
        }
        await tx.migrationBatch.update({
          where: { id: batchId },
          data: {
            status: "COMPLETED",
            counts,
            completedAt: new Date(),
            errorCode: null,
          },
        });
        await tx.auditLog.create({
          data: {
            shopId: shop.id,
            actorId: options.actorId,
            action: "MIND_BODY_IMPORTED",
            entityId: batchId,
            after: {
              ...counts,
              inputHash,
              backupReferenceHash: hash(options.backupReference || "dry-run"),
            },
          },
        });
        // No OutboxEvent or BookingNotification is created during migration.
        if (!options.apply) throw rollback;
      },
      { timeout: 60000, maxWait: 10000 },
    );
  } catch (error) {
    if (error !== rollback) {
      const code =
        error instanceof DomainError
          ? error.code
          : "MIGRATION_DATABASE_REJECTED";
      if (envelope)
        await db.migrationBatch.updateMany({
          where: { id: envelope.id, status: { not: "COMPLETED" } },
          data: { status: "FAILED", errorCode: code },
        });
      throw new DomainError(code, code);
    }
  }
  return {
    mode: options.apply ? "APPLY" : "DRY_RUN",
    replay,
    inputHash,
    counts,
  };
}
