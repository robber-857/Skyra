import { z } from "zod";
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
