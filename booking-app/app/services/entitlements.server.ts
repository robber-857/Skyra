import { Prisma, type EntitlementLedgerEntry } from "@prisma/client";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";

type Tx = Prisma.TransactionClient;
type LedgerKind =
  | "GRANT"
  | "RESERVE"
  | "CONSUME"
  | "RELEASE"
  | "ADJUST"
  | "EXPIRE"
  | "REVOKE";

export type EntitlementBalance = {
  availableUnits: number;
  reservedUnits: number;
  consumedUnits: number;
};

function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}

async function lockEntitlement(tx: Tx, shopId: string, entitlementId: string) {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(
    'SELECT id FROM "Entitlement" WHERE "shopId" = $1::uuid AND id = $2::uuid FOR UPDATE',
    shopId,
    entitlementId,
  );
  if (!rows.length)
    fail("ENTITLEMENT_NOT_FOUND", "Pass entitlement not found.", 404);
}

export async function entitlementBalance(
  tx: Tx,
  shopId: string,
  entitlementId: string,
): Promise<EntitlementBalance> {
  const sums = await tx.entitlementLedgerEntry.aggregate({
    where: { shopId, entitlementId },
    _sum: {
      availableDelta: true,
      reservedDelta: true,
      consumedDelta: true,
    },
  });
  return {
    availableUnits: sums._sum.availableDelta || 0,
    reservedUnits: sums._sum.reservedDelta || 0,
    consumedUnits: sums._sum.consumedDelta || 0,
  };
}

type LedgerInput = {
  shopId: string;
  entitlementId: string;
  kind: LedgerKind;
  availableDelta: number;
  reservedDelta: number;
  consumedDelta: number;
  idempotencyKey: string;
  reservationKey?: string | null;
  bookingId?: string | null;
  reason?: string | null;
};

function sameLedgerEntry(entry: EntitlementLedgerEntry, input: LedgerInput) {
  return (
    entry.entitlementId === input.entitlementId &&
    entry.kind === input.kind &&
    entry.availableDelta === input.availableDelta &&
    entry.reservedDelta === input.reservedDelta &&
    entry.consumedDelta === input.consumedDelta &&
    entry.reservationKey === (input.reservationKey || null) &&
    entry.bookingId === (input.bookingId || null) &&
    entry.reason === (input.reason || null)
  );
}

async function ledgerReplay(tx: Tx, input: LedgerInput) {
  const entry = await tx.entitlementLedgerEntry.findUnique({
    where: {
      shopId_idempotencyKey: {
        shopId: input.shopId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (entry && !sameLedgerEntry(entry, input))
    fail(
      "IDEMPOTENCY_CONFLICT",
      "This entitlement operation key was already used.",
    );
  return entry;
}

async function appendLedgerEntry(tx: Tx, input: LedgerInput) {
  const replay = await ledgerReplay(tx, input);
  if (replay) return replay;
  return tx.entitlementLedgerEntry.create({
    data: {
      shopId: input.shopId,
      entitlementId: input.entitlementId,
      kind: input.kind,
      availableDelta: input.availableDelta,
      reservedDelta: input.reservedDelta,
      consumedDelta: input.consumedDelta,
      idempotencyKey: input.idempotencyKey,
      reservationKey: input.reservationKey || null,
      bookingId: input.bookingId || null,
      reason: input.reason || null,
    },
  });
}

export type GrantEntitlementInput = {
  shopId: string;
  customerId: string;
  passPlanId: string;
  productMappingId: string;
  sourceOrderGid: string;
  sourceLineItemGid: string;
  startsAt: Date;
  expiresAt: Date;
  grantedUnits: number;
  idempotencyKey: string;
};

export async function grantEntitlement(input: GrantEntitlementInput) {
  if (
    !Number.isInteger(input.grantedUnits) ||
    input.grantedUnits <= 0 ||
    input.expiresAt <= input.startsAt
  )
    fail("INVALID_ENTITLEMENT", "Invalid Pass entitlement grant.", 400);
  return db.$transaction(async (tx) => {
    const mapping = await tx.productMapping.findUnique({
      where: {
        shopId_id: {
          shopId: input.shopId,
          id: input.productMappingId,
        },
      },
    });
    if (
      !mapping ||
      mapping.ownerType !== "PASS_PLAN" ||
      mapping.ownerId !== input.passPlanId
    )
      fail("INVALID_ENTITLEMENT", "Pass product mapping does not match.", 400);
    const entitlement = await tx.entitlement.upsert({
      where: {
        shopId_sourceOrderGid_sourceLineItemGid: {
          shopId: input.shopId,
          sourceOrderGid: input.sourceOrderGid,
          sourceLineItemGid: input.sourceLineItemGid,
        },
      },
      create: {
        shopId: input.shopId,
        customerId: input.customerId,
        passPlanId: input.passPlanId,
        productMappingId: input.productMappingId,
        sourceOrderGid: input.sourceOrderGid,
        sourceLineItemGid: input.sourceLineItemGid,
        startsAt: input.startsAt,
        expiresAt: input.expiresAt,
        grantedUnits: input.grantedUnits,
      },
      update: {},
    });
    if (
      entitlement.customerId !== input.customerId ||
      entitlement.passPlanId !== input.passPlanId ||
      entitlement.productMappingId !== input.productMappingId ||
      entitlement.startsAt.getTime() !== input.startsAt.getTime() ||
      entitlement.expiresAt.getTime() !== input.expiresAt.getTime() ||
      entitlement.grantedUnits !== input.grantedUnits
    )
      fail(
        "IDEMPOTENCY_CONFLICT",
        "This Shopify order line was already used for a different entitlement.",
      );
    await lockEntitlement(tx, input.shopId, entitlement.id);
    await appendLedgerEntry(tx, {
      shopId: input.shopId,
      entitlementId: entitlement.id,
      kind: "GRANT",
      availableDelta: input.grantedUnits,
      reservedDelta: 0,
      consumedDelta: 0,
      idempotencyKey: input.idempotencyKey,
      reason: "SHOPIFY_ORDER_PAID",
    });
    return {
      entitlement,
      balance: await entitlementBalance(tx, input.shopId, entitlement.id),
    };
  });
}

export async function eligibleEntitlements(
  tx: Tx,
  input: {
    shopId: string;
    customerId: string;
    serviceId: string;
    sessionStartsAt: Date;
    now: Date;
  },
) {
  const entitlements = await tx.entitlement.findMany({
    where: {
      shopId: input.shopId,
      customerId: input.customerId,
      status: "ACTIVE",
      startsAt: { lte: input.now },
      expiresAt: { gt: input.sessionStartsAt },
      passPlan: {
        status: "ACTIVE",
        services: {
          some: {
            shopId: input.shopId,
            serviceId: input.serviceId,
          },
        },
      },
    },
    include: { passPlan: true, ledgerEntries: true },
    orderBy: [{ expiresAt: "asc" }, { createdAt: "asc" }],
  });
  return entitlements.flatMap((entitlement) => {
    const balance = entitlement.ledgerEntries.reduce<EntitlementBalance>(
      (result, entry) => ({
        availableUnits: result.availableUnits + entry.availableDelta,
        reservedUnits: result.reservedUnits + entry.reservedDelta,
        consumedUnits: result.consumedUnits + entry.consumedDelta,
      }),
      { availableUnits: 0, reservedUnits: 0, consumedUnits: 0 },
    );
    return balance.availableUnits > 0
      ? [
          {
            id: entitlement.id,
            passPlanId: entitlement.passPlanId,
            name: entitlement.passPlan.name,
            grantedUnits: entitlement.grantedUnits,
            expiresAt: entitlement.expiresAt,
            ...balance,
          },
        ]
      : [];
  });
}

export async function introOfferEligible(
  tx: Tx,
  shopId: string,
  customerId: string,
) {
  const [entitlements, bookings] = await Promise.all([
    tx.entitlement.count({
      where: {
        shopId,
        customerId,
        status: { in: ["ACTIVE", "EXPIRED", "REVOKED"] },
      },
    }),
    tx.booking.count({
      where: { shopId, customerId, status: { not: "CANCELLED" } },
    }),
  ]);
  return entitlements === 0 && bookings === 0;
}

export async function reserveEntitlementCredit(
  tx: Tx,
  input: {
    shopId: string;
    entitlementId: string;
    customerId: string;
    serviceId: string;
    sessionStartsAt: Date;
    now: Date;
    reservationKey: string;
    idempotencyKey: string;
    bookingId?: string;
  },
) {
  await lockEntitlement(tx, input.shopId, input.entitlementId);
  const entitlement = await tx.entitlement.findUniqueOrThrow({
    where: { id: input.entitlementId },
  });
  const ledgerInput: LedgerInput = {
    shopId: input.shopId,
    entitlementId: input.entitlementId,
    kind: "RESERVE",
    availableDelta: -1,
    reservedDelta: 1,
    consumedDelta: 0,
    idempotencyKey: input.idempotencyKey,
    reservationKey: input.reservationKey,
    bookingId: input.bookingId || null,
    reason: "BOOKING_CONFIRMED",
  };
  const replay = await ledgerReplay(tx, ledgerInput);
  if (replay)
    return {
      entry: replay,
      balance: await entitlementBalance(tx, input.shopId, input.entitlementId),
    };
  if (
    entitlement.shopId !== input.shopId ||
    entitlement.customerId !== input.customerId
  )
    fail("ENTITLEMENT_NOT_FOUND", "Pass entitlement not found.", 404);
  if (
    entitlement.status !== "ACTIVE" ||
    entitlement.startsAt > input.now ||
    entitlement.expiresAt <= input.sessionStartsAt
  )
    fail("ENTITLEMENT_UNAVAILABLE", "This Pass is not valid for the class.");
  const eligible = await tx.passEligibility.findUnique({
    where: {
      shopId_passPlanId_serviceId: {
        shopId: input.shopId,
        passPlanId: entitlement.passPlanId,
        serviceId: input.serviceId,
      },
    },
  });
  if (!eligible)
    fail("ENTITLEMENT_UNAVAILABLE", "This Pass cannot be used for the class.");
  const balance = await entitlementBalance(
    tx,
    input.shopId,
    input.entitlementId,
  );
  if (balance.availableUnits < 1)
    fail("ENTITLEMENT_EMPTY", "This Pass has no available class credits.");
  const entry = await appendLedgerEntry(tx, ledgerInput);
  return {
    entry,
    balance: await entitlementBalance(tx, input.shopId, input.entitlementId),
  };
}

async function settleReservation(
  tx: Tx,
  input: {
    shopId: string;
    entitlementId: string;
    reservationKey: string;
    idempotencyKey: string;
    bookingId?: string;
  },
  kind: "CONSUME" | "RELEASE",
) {
  await lockEntitlement(tx, input.shopId, input.entitlementId);
  const ledgerInput: LedgerInput = {
    shopId: input.shopId,
    entitlementId: input.entitlementId,
    kind,
    availableDelta: kind === "RELEASE" ? 1 : 0,
    reservedDelta: -1,
    consumedDelta: kind === "CONSUME" ? 1 : 0,
    idempotencyKey: input.idempotencyKey,
    reservationKey: input.reservationKey,
    bookingId: input.bookingId || null,
    reason: kind === "CONSUME" ? "CLASS_USED" : "BOOKING_CANCELLED_IN_POLICY",
  };
  const replay = await ledgerReplay(tx, ledgerInput);
  if (replay)
    return {
      entry: replay,
      balance: await entitlementBalance(tx, input.shopId, input.entitlementId),
    };
  const reserved = await tx.entitlementLedgerEntry.findFirst({
    where: {
      shopId: input.shopId,
      entitlementId: input.entitlementId,
      reservationKey: input.reservationKey,
      kind: "RESERVE",
    },
  });
  if (!reserved)
    fail("RESERVATION_NOT_FOUND", "Reserved credit not found.", 404);
  const terminal = await tx.entitlementLedgerEntry.findFirst({
    where: {
      shopId: input.shopId,
      entitlementId: input.entitlementId,
      reservationKey: input.reservationKey,
      kind: { in: ["CONSUME", "RELEASE"] },
    },
  });
  if (terminal)
    fail(
      "RESERVATION_ALREADY_SETTLED",
      "This reserved credit was already settled.",
    );
  const entry = await appendLedgerEntry(tx, ledgerInput);
  return {
    entry,
    balance: await entitlementBalance(tx, input.shopId, input.entitlementId),
  };
}

export const consumeEntitlementReservation = (
  tx: Tx,
  input: Parameters<typeof settleReservation>[1],
) => settleReservation(tx, input, "CONSUME");

export const releaseEntitlementReservation = (
  tx: Tx,
  input: Parameters<typeof settleReservation>[1],
) => settleReservation(tx, input, "RELEASE");

export async function adjustEntitlement(
  tx: Tx,
  input: {
    shopId: string;
    entitlementId: string;
    units: number;
    reason: string;
    idempotencyKey: string;
  },
) {
  if (
    !Number.isInteger(input.units) ||
    input.units === 0 ||
    !input.reason.trim()
  )
    fail(
      "INVALID_ADJUSTMENT",
      "A non-zero adjustment and reason are required.",
      400,
    );
  await lockEntitlement(tx, input.shopId, input.entitlementId);
  const entry = await appendLedgerEntry(tx, {
    shopId: input.shopId,
    entitlementId: input.entitlementId,
    kind: "ADJUST",
    availableDelta: input.units,
    reservedDelta: 0,
    consumedDelta: 0,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason.trim(),
  });
  return {
    entry,
    balance: await entitlementBalance(tx, input.shopId, input.entitlementId),
  };
}

async function closeEntitlement(
  tx: Tx,
  input: {
    shopId: string;
    entitlementId: string;
    idempotencyKey: string;
    reason: string;
  },
  kind: "EXPIRE" | "REVOKE",
) {
  await lockEntitlement(tx, input.shopId, input.entitlementId);
  const replay = await tx.entitlementLedgerEntry.findUnique({
    where: {
      shopId_idempotencyKey: {
        shopId: input.shopId,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (replay) {
    if (
      replay.entitlementId !== input.entitlementId ||
      replay.kind !== kind ||
      replay.reason !== input.reason
    )
      fail(
        "IDEMPOTENCY_CONFLICT",
        "This entitlement operation key was already used.",
      );
    return {
      entry: replay,
      balance: await entitlementBalance(tx, input.shopId, input.entitlementId),
    };
  }
  const balance = await entitlementBalance(
    tx,
    input.shopId,
    input.entitlementId,
  );
  if (balance.reservedUnits !== 0)
    fail(
      "ENTITLEMENT_RESERVED",
      "Release or consume reserved credits before closing this Pass.",
    );
  const entry = await appendLedgerEntry(tx, {
    shopId: input.shopId,
    entitlementId: input.entitlementId,
    kind,
    availableDelta: -balance.availableUnits,
    reservedDelta: 0,
    consumedDelta: 0,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
  });
  await tx.entitlement.update({
    where: { id: input.entitlementId },
    data: { status: kind === "EXPIRE" ? "EXPIRED" : "REVOKED" },
  });
  return {
    entry,
    balance: await entitlementBalance(tx, input.shopId, input.entitlementId),
  };
}

export const expireEntitlement = (
  tx: Tx,
  input: Parameters<typeof closeEntitlement>[1],
) => closeEntitlement(tx, input, "EXPIRE");

export const revokeEntitlement = (
  tx: Tx,
  input: Parameters<typeof closeEntitlement>[1],
) => closeEntitlement(tx, input, "REVOKE");
