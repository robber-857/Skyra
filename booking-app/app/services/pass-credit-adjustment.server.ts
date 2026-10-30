import { z } from "zod";
import { DateTime } from "luxon";
import { PASS_EXPIRY_TIMEZONE } from "../lib/pass-time";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { requireOperations, type Actor } from "./authorization";
import { audit, lockShop } from "./catalog.server";
import { databaseNow } from "./booking.server";
import { adjustEntitlement, entitlementBalance } from "./entitlements.server";

const schema = z
  .object({
    customerId: z.string().uuid(),
    entitlementId: z.string().uuid(),
    available: z.preprocess(
      (v) => (v === null || v === "" ? undefined : v),
      z.coerce.number().int().min(0).max(10000),
    ),
    expectedAvailable: z.preprocess(
      (v) => (v === null || v === "" ? undefined : v),
      z.coerce.number().int().min(0),
    ),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

const editSchema = schema.extend({
  expectedRevision: z.coerce.number().int().min(0),
  expectedExpiresAt: z.string().datetime().nullable(),
  // Empty means keep the exact existing instant, avoiding date-only round trips.
  expiryDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
});

export async function updateClientPass(actor: Actor, raw: unknown) {
  requireOperations(actor);
  const input = editSchema.parse(raw);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const shop = await tx.shop.findFirst({
      where: { id: actor.shopId, status: "ACTIVE" },
    });
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Entitlement" WHERE "shopId" = ${actor.shopId}::uuid AND "customerId" = ${input.customerId}::uuid AND id = ${input.entitlementId}::uuid FOR UPDATE`;
    if (!shop || !rows.length)
      throw new DomainError("NOT_FOUND", "Client Pass not found.", 404);
    const request = { ...input, actorId: actor.actorId };
    const receipt = await tx.auditLog.findFirst({
      where: {
        shopId: actor.shopId,
        action: "PASS_UPDATED",
        entityId: input.idempotencyKey,
      },
    });
    if (receipt) {
      const saved = receipt.after as Record<string, unknown>;
      if (Object.entries(request).some(([key, value]) => saved[key] !== value))
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This request was already used for a different Pass change.",
        );
      return;
    }
    const pass = await tx.entitlement.findUniqueOrThrow({
      where: { id: input.entitlementId },
    });
    if (!["ACTIVE", "EXPIRED"].includes(pass.status))
      throw new DomainError(
        "PASS_NOT_USABLE",
        "Pending or revoked Passes cannot be edited.",
      );
    const before = await entitlementBalance(tx, actor.shopId, pass.id);
    if (
      before.availableUnits !== input.expectedAvailable ||
      pass.revision !== input.expectedRevision ||
      (pass.expiresAt?.toISOString() ?? null) !== input.expectedExpiresAt
    )
      throw new DomainError(
        "PASS_CHANGED",
        "This Pass changed. Refresh the profile and review its current balance and expiry before saving.",
      );
    const now = await databaseNow(tx);
    let expiresAt = pass.expiresAt;
    if (input.expiryDate) {
      const day = DateTime.fromISO(input.expiryDate, {
        zone: PASS_EXPIRY_TIMEZONE,
      });
      if (!day.isValid || day.toISODate() !== input.expiryDate)
        throw new DomainError(
          "INVALID_EXPIRY",
          "Enter a valid expiry date.",
          400,
        );
      expiresAt = day.plus({ days: 1 }).startOf("day").toJSDate();
      if (expiresAt <= now || (pass.startsAt && expiresAt <= pass.startsAt))
        throw new DomainError(
          "INVALID_EXPIRY",
          "Expiry must be in the future and after the Pass start.",
          400,
        );
      if (
        before.reservedUnits > 0 &&
        pass.expiresAt &&
        expiresAt < pass.expiresAt
      )
        throw new DomainError(
          "PASS_RESERVED",
          "This Pass has reserved credits. Resolve its reservations before shortening expiry.",
        );
    }
    if (pass.status === "EXPIRED" && (!expiresAt || expiresAt <= now))
      throw new DomainError(
        "INVALID_EXPIRY",
        "Choose a future expiry date to reopen this expired Pass.",
      );
    const units = input.available - before.availableUnits;
    const expiryChanged = expiresAt?.getTime() !== pass.expiresAt?.getTime();
    if (!units && !expiryChanged)
      throw new DomainError(
        "NO_CHANGE",
        "Change the available credits or expiry date before saving.",
      );
    // Updating the row also advances its database-managed revision for credit-only edits.
    await tx.entitlement.update({
      where: { id: pass.id },
      data: {
        expiresAt,
        startsAt: pass.startsAt ?? (expiryChanged ? now : null),
        status: "ACTIVE",
      },
    });
    if (units)
      await adjustEntitlement(tx, {
        shopId: actor.shopId,
        entitlementId: pass.id,
        units,
        reason: input.reason,
        idempotencyKey: `staff-pass-edit:${input.idempotencyKey}`,
      });
    await audit(
      tx,
      actor,
      "PASS_UPDATED",
      input.idempotencyKey,
      {
        ...before,
        expiresAt: pass.expiresAt,
        startsAt: pass.startsAt,
        status: pass.status,
        revision: pass.revision,
      },
      {
        ...request,
        expiresAt,
        startsAt: pass.startsAt ?? (expiryChanged ? now : null),
        status: "ACTIVE",
        balance: await entitlementBalance(tx, actor.shopId, pass.id),
      },
    );
  });
}

export async function adjustClientPassCredits(actor: Actor, raw: unknown) {
  requireOperations(actor);
  const input = schema.parse(raw);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const shop = await tx.shop.findFirst({
      where: { id: actor.shopId, status: "ACTIVE" },
    });
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "Entitlement" WHERE "shopId" = ${actor.shopId}::uuid AND "customerId" = ${input.customerId}::uuid AND id = ${input.entitlementId}::uuid FOR UPDATE`;
    if (!shop || !rows.length)
      throw new DomainError("NOT_FOUND", "Client Pass not found.", 404);
    const request = { ...input, actorId: actor.actorId };
    const key = `staff-pass-adjust:${input.idempotencyKey}`;
    const previous = await tx.entitlementLedgerEntry.findUnique({
      where: {
        shopId_idempotencyKey: { shopId: actor.shopId, idempotencyKey: key },
      },
    });
    if (previous) {
      const log = await tx.auditLog.findFirst({
        where: {
          shopId: actor.shopId,
          entityId: previous.id,
          action: "PASS_CREDITS_ADJUSTED",
        },
      });
      const saved = log?.after as Record<string, unknown> | undefined;
      if (!saved || Object.entries(request).some(([k, v]) => saved[k] !== v))
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This adjustment request has already been used.",
        );
      return;
    }
    const pass = await tx.entitlement.findUniqueOrThrow({
      where: { id: input.entitlementId },
    });
    const now = await databaseNow(tx);
    if (pass.status !== "ACTIVE" || (pass.expiresAt && pass.expiresAt <= now))
      throw new DomainError(
        "PASS_NOT_USABLE",
        "Expired or closed Passes cannot be adjusted.",
      );
    const before = await entitlementBalance(tx, actor.shopId, pass.id);
    if (before.availableUnits !== input.expectedAvailable)
      throw new DomainError(
        "BALANCE_CHANGED",
        "The balance changed. Refresh this profile and review the new balance before saving.",
      );
    const units = input.available - before.availableUnits;
    if (!units)
      throw new DomainError(
        "NO_CHANGE",
        "Enter a different available credit balance.",
      );
    const result = await adjustEntitlement(tx, {
      shopId: actor.shopId,
      entitlementId: pass.id,
      units,
      reason: input.reason,
      idempotencyKey: key,
    });
    await audit(tx, actor, "PASS_CREDITS_ADJUSTED", result.entry.id, before, {
      ...request,
      balance: result.balance,
    });
  });
}
