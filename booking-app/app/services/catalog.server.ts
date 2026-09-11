import { Prisma } from "@prisma/client";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
const uuid = z.string().uuid();
const common = {
  id: uuid.optional(),
  version: z.coerce.number().int().positive().optional(),
  name: z.string().trim().min(2).max(120),
  status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]),
  requestedPriceCents: z.coerce.number().int().min(0).max(10000000),
};
export const serviceInput = z.object({
  ...common,
  kind: z.enum(["CLASS", "APPOINTMENT", "COURSE"]).default("CLASS"),
  description: z.string().max(4000).default(""),
  level: z.string().max(80).default(""),
  durationMin: z.coerce.number().int().min(5).max(480),
  capacity: z.coerce.number().int().min(1).max(200),
  locationId: uuid,
  coachIds: z.array(uuid).min(1).max(100),
});
export const passInput = z.object({
  ...common,
  credits: z.coerce.number().int().min(1).max(1000),
  validityDays: z.coerce.number().int().min(1).max(3650),
  introOnly: z.boolean().default(false),
  serviceIds: z.array(uuid).min(1).max(200),
});
export async function lockShop(tx: Prisma.TransactionClient, shopId: string) {
  await tx.$queryRaw`SELECT id FROM "Shop" WHERE id = ${shopId}::uuid FOR UPDATE`;
}
export async function audit(
  tx: Prisma.TransactionClient,
  actor: Actor,
  action: string,
  entityId: string,
  before: unknown,
  after: unknown,
) {
  await tx.auditLog.create({
    data: {
      shopId: actor.shopId,
      actorId: actor.actorId,
      action,
      entityId,
      before:
        before == null ? Prisma.JsonNull : JSON.parse(JSON.stringify(before)),
      after:
        after == null ? Prisma.JsonNull : JSON.parse(JSON.stringify(after)),
    },
  });
}
export async function saveService(actor: Actor, raw: unknown) {
  requireOperations(actor);
  const { coachIds, id, version, ...input } = serviceInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const old = id
      ? await tx.service.findFirst({ where: { id, shopId: actor.shopId } })
      : null;
    if (id && !old) throw new DomainError("NOT_FOUND", "Class not found.", 404);
    if (old && version !== old.version)
      throw new DomainError(
        "CONFLICT",
        "This class changed. Refresh before saving.",
        409,
      );
    const ids = [...new Set(coachIds)];
    const [location, coaches] = await Promise.all([
      tx.location.findFirst({
        where: { id: input.locationId, shopId: actor.shopId },
      }),
      tx.coach.count({
        where: { shopId: actor.shopId, id: { in: ids }, status: "ACTIVE" },
      }),
    ]);
    if (!location || coaches !== ids.length)
      throw new DomainError(
        "INVALID_REFERENCE",
        "Choose this shop's active coaches and location.",
      );
    const saved = old
      ? await tx.service.update({
          where: { id: old.id },
          data: { ...input, version: { increment: 1 } },
        })
      : await tx.service.create({ data: { ...input, shopId: actor.shopId } });
    await tx.serviceCoach.deleteMany({
      where: { shopId: actor.shopId, serviceId: saved.id },
    });
    await tx.serviceCoach.createMany({
      data: ids.map((coachId) => ({
        shopId: actor.shopId,
        serviceId: saved.id,
        coachId,
      })),
    });
    await requestSync(tx, actor.shopId, "SERVICE", saved.id, saved.version);
    await audit(tx, actor, "SERVICE_SAVED", saved.id, old, saved);
    return saved;
  });
}
export async function savePass(actor: Actor, raw: unknown) {
  requireOperations(actor);
  const { serviceIds, id, version, ...input } = passInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const old = id
      ? await tx.passPlan.findFirst({ where: { id, shopId: actor.shopId } })
      : null;
    if (id && !old) throw new DomainError("NOT_FOUND", "Pass not found.", 404);
    if (old && old.version !== version)
      throw new DomainError(
        "CONFLICT",
        "This pass changed. Refresh before saving.",
        409,
      );
    const ids = [...new Set(serviceIds)];
    if (
      (await tx.service.count({
        where: { shopId: actor.shopId, id: { in: ids } },
      })) !== ids.length
    )
      throw new DomainError(
        "INVALID_REFERENCE",
        "Choose classes belonging to this shop.",
      );
    const saved = old
      ? await tx.passPlan.update({
          where: { id: old.id },
          data: { ...input, version: { increment: 1 } },
        })
      : await tx.passPlan.create({ data: { ...input, shopId: actor.shopId } });
    await tx.passEligibility.deleteMany({
      where: { shopId: actor.shopId, passPlanId: saved.id },
    });
    await tx.passEligibility.createMany({
      data: ids.map((serviceId) => ({
        shopId: actor.shopId,
        passPlanId: saved.id,
        serviceId,
      })),
    });
    await requestSync(tx, actor.shopId, "PASS_PLAN", saved.id, saved.version);
    await audit(tx, actor, "PASS_SAVED", saved.id, old, saved);
    return saved;
  });
}
async function requestSync(
  tx: Prisma.TransactionClient,
  shopId: string,
  ownerType: string,
  ownerId: string,
  version: number,
) {
  await tx.productMapping.upsert({
    where: { shopId_ownerType_ownerId: { shopId, ownerType, ownerId } },
    create: { shopId, ownerType, ownerId, requestedVersion: version },
    update: {
      requestedVersion: version,
      syncStatus: "PENDING",
      lastError: null,
    },
  });
  await tx.outboxEvent.create({
    data: {
      shopId,
      kind: "CATALOG_SYNC",
      aggregateId: ownerId,
      version,
      payload: { ownerType },
    },
  });
}
export async function retrySync(actor: Actor, id: string) {
  requireOperations(actor);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const mapping = await tx.productMapping.findFirst({
      where: { id, shopId: actor.shopId },
    });
    if (!mapping) throw new DomainError("NOT_FOUND", "Mapping not found.", 404);
    await tx.outboxEvent.updateMany({
      where: {
        shopId: actor.shopId,
        aggregateId: mapping.ownerId,
        kind: "CATALOG_SYNC",
        version: mapping.requestedVersion,
        status: { not: "DONE" },
      },
      data: {
        status: "PENDING",
        attempts: 0,
        availableAt: new Date(),
        lastError: null,
      },
    });
    await tx.productMapping.update({
      where: { id },
      data: { syncStatus: "PENDING", lastError: null },
    });
    await audit(tx, actor, "SYNC_RETRY", id, null, {
      version: mapping.requestedVersion,
    });
  });
}
export async function catalogData(shopId: string) {
  const [services, passes, coaches, locations, mappings] = await Promise.all([
    db.service.findMany({
      where: { shopId },
      include: { coaches: true },
      orderBy: { name: "asc" },
    }),
    db.passPlan.findMany({
      where: { shopId },
      include: { services: true },
      orderBy: { name: "asc" },
    }),
    db.coach.findMany({ where: { shopId }, orderBy: { name: "asc" } }),
    db.location.findMany({ where: { shopId }, orderBy: { name: "asc" } }),
    db.productMapping.findMany({ where: { shopId } }),
  ]);
  return { services, passes, coaches, locations, mappings };
}
