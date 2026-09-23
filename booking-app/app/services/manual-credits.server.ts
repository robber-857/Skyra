import { DateTime } from "luxon";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import { databaseNow } from "./booking.server";
import { audit, lockShop } from "./catalog.server";

const inputSchema = z
  .object({
    customerId: z.string().uuid(),
    target: z.string().refine((value) => {
      const [kind, id, extra] = value.split(":");
      return (
        !extra &&
        ["PASS_PLAN", "SERVICE"].includes(kind) &&
        z.string().uuid().safeParse(id).success
      );
    }, "Choose a valid class or Pass."),
    units: z.coerce.number().int().min(1).max(1000),
    validityDays: z.coerce.number().int().min(1).max(3650),
    amount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .refine((v) => Number(v) > 0 && Number(v) <= 100000),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

export async function manualCreditOptions(actor: Actor) {
  requireOperations(actor);
  const [plans, services] = await Promise.all([
    db.passPlan.findMany({
      where: { shopId: actor.shopId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
    db.service.findMany({
      where: { shopId: actor.shopId, status: "ACTIVE" },
      orderBy: { name: "asc" },
    }),
  ]);
  return [
    ...plans.map((p) => ({
      value: "PASS_PLAN:" + p.id,
      name: p.name + " (Pass)",
      units: p.credits,
      validity: p.validityMonths
        ? p.validityMonths + " calendar months from first class"
        : p.validityDays + " days from first class",
    })),
    ...services.map((s) => ({
      value: "SERVICE:" + s.id,
      name: s.name + " (Class credit)",
      units: 1,
      validity: null,
    })),
  ];
}

export async function grantCashCredits(actor: Actor, raw: unknown) {
  requireOperations(actor);
  const input = inputSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const shop = await tx.shop.findFirst({
      where: { id: actor.shopId, status: "ACTIVE" },
    });
    const customer = await tx.customerProfile.findFirst({
      where: { id: input.customerId, shopId: actor.shopId },
    });
    if (!shop || !customer)
      throw new DomainError("NOT_FOUND", "Client not found.", 404);
    const externalKey = input.idempotencyKey;
    const previous = await tx.entitlement.findUnique({
      where: {
        shopId_sourceSystem_externalKey: {
          shopId: actor.shopId,
          sourceSystem: "MANUAL_CASH",
          externalKey,
        },
      },
    });
    // Bind retries to the exact request and staff actor, including the cash record.
    const request = { ...input, actorId: actor.actorId };
    if (previous) {
      const log = await tx.auditLog.findFirst({
        where: {
          shopId: actor.shopId,
          entityId: previous.id,
          action: "CASH_CREDITS_GRANTED",
        },
      });
      const saved = log?.after as Record<string, unknown> | undefined;
      if (
        !saved ||
        Object.entries(request).some(([key, value]) => saved[key] !== value)
      )
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This grant key has already been used.",
        );
      return previous;
    }
    const [ownerType, ownerId] = input.target.split(":");
    const plan =
      ownerType === "PASS_PLAN"
        ? await tx.passPlan.findFirst({
            where: { id: ownerId, shopId: actor.shopId, status: "ACTIVE" },
          })
        : null;
    const service =
      ownerType === "SERVICE"
        ? await tx.service.findFirst({
            where: { id: ownerId, shopId: actor.shopId, status: "ACTIVE" },
          })
        : null;
    const mapping = await tx.productMapping.findUnique({
      where: {
        shopId_ownerType_ownerId: { shopId: actor.shopId, ownerType, ownerId },
      },
    });
    if ((!plan && !service) || !mapping)
      throw new DomainError(
        "INVALID_REFERENCE",
        "Choose an active class or Pass from this studio.",
      );
    const now = await databaseNow(tx);
    const entitlement = await tx.entitlement.create({
      data: {
        shopId: actor.shopId,
        customerId: customer.id,
        passPlanId: plan?.id ?? null,
        serviceId: service?.id ?? null,
        productMappingId: mapping.id,
        sourceSystem: "MANUAL_CASH",
        externalKey,
        grantedUnits: input.units,
        startsAt: plan ? null : now,
        expiresAt: plan
          ? null
          : DateTime.fromJSDate(now, { zone: shop.timezone })
              .plus({ days: input.validityDays })
              .toJSDate(),
        validityDays: plan?.validityDays ?? input.validityDays,
        validityMonths: plan?.validityMonths ?? null,
        activationTimezone: shop.timezone,
      },
    });
    await tx.entitlementLedgerEntry.create({
      data: {
        shopId: actor.shopId,
        entitlementId: entitlement.id,
        kind: "GRANT",
        availableDelta: input.units,
        reservedDelta: 0,
        consumedDelta: 0,
        idempotencyKey: "cash-grant:" + externalKey,
        reason: input.reason,
      },
    });
    await audit(
      tx,
      actor,
      "CASH_CREDITS_GRANTED",
      entitlement.id,
      null,
      request,
    );
    return entitlement;
  });
}
