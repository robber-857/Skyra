import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import type { BookingActor } from "./booking.server";
import { passActivationWindow } from "./pass-activation.server";

type Tx = Prisma.TransactionClient;
export async function queueContractReconciliation(
  tx: Tx,
  shopId: string,
  membershipId: string,
) {
  // Multiple state changes may coalesce: worker always reads current authoritative state.
  await tx.outboxEvent.upsert({
    where: {
      shopId_kind_aggregateId_version: {
        shopId,
        kind: "MEMBERSHIP_CONTRACT_SYNC",
        aggregateId: membershipId,
        version: 1,
      },
    },
    create: {
      shopId,
      kind: "MEMBERSHIP_CONTRACT_SYNC",
      aggregateId: membershipId,
      version: 1,
      payload: { revision: randomUUID() },
    },
    update: {
      status: "PENDING",
      availableAt: new Date(),
      lastError: null,
      payload: { revision: randomUUID() },
    },
  });
}

// Call only with a trusted staff CHECK_IN/COMPLETE event, never AUTO_COMPLETE.
export async function activateMembershipForAttendance(
  tx: Tx,
  input: {
    shopId: string;
    bookingId: string;
    sessionStartsAt: Date;
    actorId: string;
  },
) {
  const reserve = await tx.entitlementLedgerEntry.findFirst({
    where: {
      shopId: input.shopId,
      bookingId: input.bookingId,
      kind: "RESERVE",
    },
  });
  if (!reserve) return;
  await tx.$queryRaw`SELECT id FROM "Entitlement" WHERE id = ${reserve.entitlementId}::uuid FOR UPDATE`;
  const entitlement = await tx.entitlement.findUniqueOrThrow({
    where: { id: reserve.entitlementId },
  });
  if (
    entitlement.activationMode !== "FIRST_ATTENDANCE" ||
    entitlement.startsAt ||
    entitlement.status !== "ACTIVE"
  )
    return;
  const window = passActivationWindow(input.sessionStartsAt, entitlement);
  // Future reservations made before activation must fit the now-authoritative window.
  // Otherwise staff must resolve those reservations first; never silently strand bookings.
  const outside = await tx.entitlementLedgerEntry.findFirst({
    where: {
      entitlementId: entitlement.id,
      kind: "RESERVE",
      booking: {
        status: "CONFIRMED",
        session: {
          OR: [
            { startsAt: { lt: window.startsAt } },
            { startsAt: { gte: window.expiresAt } },
          ],
        },
      },
    },
  });
  if (outside)
    throw new DomainError(
      "PASS_BOOKINGS_OUTSIDE_WINDOW",
      "Review this Pass's other bookings before confirming its first attendance.",
      409,
    );
  await tx.entitlement.update({
    where: { id: entitlement.id },
    data: { ...window, activationBookingId: input.bookingId },
  });
  const purchase = await tx.passPurchase.findUnique({
    where: { entitlementId: entitlement.id },
  });
  if (purchase) {
    await tx.$queryRaw`SELECT id FROM "PassMembership" WHERE id = ${purchase.membershipId}::uuid FOR UPDATE`;
    const membership = await tx.passMembership.findUniqueOrThrow({
      where: { id: purchase.membershipId },
    });
    if (
      membership.currentCycle === purchase.cycle &&
      !["CANCELLED", "PAYMENT_REVIEW"].includes(membership.status)
    ) {
      await tx.passMembership.update({
        where: { id: membership.id },
        data: { status: "ACTIVE" },
      });
      await queueContractReconciliation(tx, input.shopId, membership.id);
    }
  }
  await tx.auditLog.create({
    data: {
      shopId: input.shopId,
      actorId: input.actorId,
      action: "PASS_FIRST_ATTENDANCE",
      entityId: entitlement.id,
      after: {
        bookingId: input.bookingId,
        startsAt: window.startsAt.toISOString(),
        expiresAt: window.expiresAt.toISOString(),
      },
    },
  });
}

export async function cancelPassMembership(
  actor: BookingActor,
  membershipId: string,
) {
  if (!actor.customerGid)
    throw new DomainError(
      "LOGIN_REQUIRED",
      "Sign in to manage your Pass.",
      401,
    );
  return db.$transaction(async (tx) => {
    const customer = await tx.customerProfile.findUnique({
      where: {
        shopId_shopifyCustomerGid: {
          shopId: actor.shopId,
          shopifyCustomerGid: actor.customerGid!,
        },
      },
    });
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "PassMembership" WHERE id = ${membershipId}::uuid AND "shopId" = ${actor.shopId}::uuid AND "customerId" = ${customer?.id || "00000000-0000-0000-0000-000000000000"}::uuid FOR UPDATE`;
    if (!rows.length)
      throw new DomainError("NOT_FOUND", "Membership not found.", 404);
    const current = await tx.passMembership.findUniqueOrThrow({
      where: { id: membershipId },
    });
    const purchase = await tx.passPurchase.findUnique({
      where: {
        membershipId_cycle: { membershipId, cycle: current.currentCycle },
      },
    });
    await tx.passMembership.update({
      where: { id: membershipId },
      data: { autoRenew: false, status: "CANCELLED" },
    });
    await queueContractReconciliation(tx, actor.shopId, membershipId);
    await tx.auditLog.create({
      data: {
        shopId: actor.shopId,
        actorId: customer!.id,
        action: "MEMBERSHIP_CANCELLED",
        entityId: membershipId,
        after: { currentCycle: current.currentCycle },
      },
    });
    const pending =
      purchase &&
      purchase.status !== "PAID" &&
      Boolean(purchase.submittedAt || purchase.cartId);
    return {
      status: "CANCELLED",
      message: pending
        ? "Future renewals stopped. A payment already in progress still needs to be checked. Your paid Pass remains available."
        : "Automatic renewal stopped. Your paid Pass remains available.",
    };
  });
}
