import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { DomainError } from "../lib/errors.server";

type Tx = Prisma.TransactionClient;
export type PassPurchaseClaim = {
  shopId: string;
  customerId: string;
  passPlanId: string;
  mode: "ONCE" | "AUTO_RENEW";
  bookingCheckoutId?: string;
  idempotencyKey: string;
  reference?: string;
  productMappingId: string;
  productGid: string;
  variantGid: string;
  sellingPlanGid?: string | null;
  priceCents: number;
  currency: "AUD";
  credits: number;
  validityDays: number;
  validityMonths?: number | null;
  timezone: string;
  termsVersion: string;
  autoRenewTermsVersion?: string;
};
function fail(code: string, message: string): never {
  throw new DomainError(code, message, 409);
}

export async function claimPassPurchaseInTransaction(
  tx: Tx,
  input: PassPurchaseClaim,
) {
  const owner = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "CustomerProfile" WHERE id = ${input.customerId}::uuid AND "shopId" = ${input.shopId}::uuid FOR UPDATE`;
  if (!owner.length) fail("NOT_FOUND", "Customer not found.");
  const plan = await tx.passPlan.findFirst({
    where: {
      id: input.passPlanId,
      shopId: input.shopId,
      status: "ACTIVE",
      saleable: true,
    },
  });
  const mapping = await tx.productMapping.findFirst({
    where: {
      id: input.productMappingId,
      shopId: input.shopId,
      ownerId: input.passPlanId,
      ownerType: "PASS_PLAN",
      productGid: input.productGid,
      variantGid: input.variantGid,
    },
  });
  if (
    !plan ||
    !mapping ||
    input.priceCents !== plan.requestedPriceCents ||
    input.credits !== plan.credits ||
    input.validityMonths !== plan.validityMonths ||
    input.validityDays !== plan.validityDays
  )
    fail("CATALOG_CHANGED", "This Pass changed. Refresh before purchasing.");
  const membership = await tx.passMembership.upsert({
    where: {
      shopId_customerId_passPlanId: {
        shopId: input.shopId,
        customerId: input.customerId,
        passPlanId: input.passPlanId,
      },
    },
    create: {
      shopId: input.shopId,
      customerId: input.customerId,
      passPlanId: input.passPlanId,
    },
    update: {},
  });
  await tx.$queryRaw`SELECT id FROM "PassMembership" WHERE id = ${membership.id}::uuid FOR UPDATE`;
  const prior = await tx.passPurchase.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });
  if (
    prior &&
    (prior.membershipId !== membership.id ||
      prior.mode !== input.mode ||
      prior.bookingCheckoutId !== (input.bookingCheckoutId ?? null))
  )
    fail(
      "IDEMPOTENCY_CONFLICT",
      "This payment request was already used for another purchase.",
    );
  const current = await tx.passPurchase.findUnique({
    where: {
      membershipId_cycle: {
        membershipId: membership.id,
        cycle: membership.currentCycle,
      },
    },
  });
  if (prior || current) {
    const existing = prior || current!;
    if (existing.status !== "PAID") {
      if (
        existing.mode !== input.mode ||
        existing.bookingCheckoutId !== (input.bookingCheckoutId ?? null)
      )
        fail(
          "PASS_PAYMENT_IN_PROGRESS",
          "A payment for this Pass already exists. Return to that purchase before starting another.",
        );
      return { purchase: existing, creating: false };
    }
    if (prior) return { purchase: prior, creating: false };
    const entitlement = existing.entitlementId
      ? await tx.entitlement.findUnique({
          where: { id: existing.entitlementId },
        })
      : null;
    const [{ now }] = await tx.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    if (
      membership.autoRenew ||
      membership.contractGid ||
      !entitlement?.expiresAt ||
      entitlement.expiresAt > now
    )
      fail(
        "PASS_ALREADY_OWNED",
        "You already have this Pass. Use your existing Pass or manage its renewal.",
      );
  }
  // Existing legacy entitlements must also prevent a new pending/active duplicate.
  const [{ now }] = await tx.$queryRaw<
    { now: Date }[]
  >`SELECT clock_timestamp() AS now`;
  if (
    await tx.entitlement.findFirst({
      where: {
        shopId: input.shopId,
        customerId: input.customerId,
        passPlanId: input.passPlanId,
        status: "ACTIVE",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    })
  )
    fail(
      "PASS_ALREADY_OWNED",
      "You already have an active or unused Pass of this type.",
    );
  // An older ordinary Booking checkout remains payable after its local hold expires.
  const legacyCheckouts = await tx.bookingCheckout.findMany({
    where: {
      shopId: input.shopId,
      id: input.bookingCheckoutId
        ? { not: input.bookingCheckoutId }
        : undefined,
      hold: { customerId: input.customerId, passPlanId: input.passPlanId },
      status: { not: "REJECTED" },
    },
    select: { id: true },
  });
  const settled = await tx.paidBookingResult.count({
    where: {
      shopId: input.shopId,
      checkoutId: { in: legacyCheckouts.map((c) => c.id) },
    },
  });
  if (legacyCheckouts.length > settled)
    fail(
      "PASS_PAYMENT_IN_PROGRESS",
      "An earlier payment for this Pass needs to be checked before another purchase.",
    );
  const cycle = current ? membership.currentCycle + 1 : membership.currentCycle;
  const {
    customerId: _customerId,
    passPlanId: _passPlanId,
    reference,
    ...data
  } = input;
  void _customerId;
  void _passPlanId;
  const purchase = await tx.passPurchase.create({
    data: {
      ...data,
      membershipId: membership.id,
      cycle,
      reference: reference || randomBytes(32).toString("base64url"),
    },
  });
  await tx.passMembership.update({
    where: { id: membership.id },
    data: { currentCycle: cycle, status: "WAITING_PAYMENT", autoRenew: false },
  });
  await tx.auditLog.create({
    data: {
      shopId: input.shopId,
      actorId: input.customerId,
      action: "PASS_PURCHASE_CLAIMED",
      entityId: purchase.id,
      after: {
        membershipId: membership.id,
        cycle,
        mode: input.mode,
        termsVersion: input.termsVersion,
        autoRenewTermsVersion: input.autoRenewTermsVersion ?? null,
      },
    },
  });
  return { purchase, creating: true };
}
