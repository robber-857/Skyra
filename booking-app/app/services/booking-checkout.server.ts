import { supportsRenewalPeriod } from "./renewal-period";
import {
  bookingTerms,
  requireBookingTerms,
  recordBookingTerms,
} from "./booking-terms.server";
import { createHash, randomBytes } from "node:crypto";
import type { BookingAttempt, Prisma, Shop } from "@prisma/client";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import {
  attemptReturnPath,
  classAvailability,
  classForBooking,
  createSeatHold,
  holdInput,
  withAttempt,
  type BookingActor,
} from "./booking.server";
import { introOfferEligible } from "./entitlements.server";
import { isDevelopmentBookingShop } from "./commerce-capabilities.server";
import { purchaseMappingReady } from "./purchase-mapping.server";
import {
  inspectCatalogPurchase,
  type CommerceClients,
} from "./shopify-purchasability.server";
import {
  assertBookingCart,
  createBookingCart,
  readBookingCart,
} from "./shopify-cart.server";
import {
  AUTO_RENEW_TERMS_VERSION,
  membershipCapabilities,
} from "./membership-capabilities.server";
import { claimPassPurchaseInTransaction } from "./membership-purchases.server";
import {
  extractAutoRenewChoice,
  preparePassPurchaseCart,
} from "./membership-checkout.server";

type Input = z.infer<typeof holdInput>;
function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}

async function readContext(
  tx: Prisma.TransactionClient,
  attempt: BookingAttempt,
  shop: Shop,
  now: Date,
  input: Input,
) {
  if (!attempt.customerId)
    fail("LOGIN_REQUIRED", "Sign in with Shopify before checkout.", 401);
  if ((shop.rules as Record<string, unknown>).onlineBookingsEnabled !== true)
    fail("BOOKING_NOT_ENABLED", "Online booking is not enabled.", 503);
  if (
    attempt.expiresAt <= now ||
    !["STARTED", "HOLD_ACTIVE"].includes(attempt.status)
  )
    fail("ATTEMPT_EXPIRED", "Start a new booking to continue.");
  const session = await classForBooking(tx, shop, attempt.sessionId, now);
  const hold = await tx.bookingHold.findUnique({
    where: { attemptId: attempt.id },
  });
  if (
    hold &&
    (hold.purchaseKind !== input.purchaseKind ||
      hold.passPlanId !== (input.passPlanId || null))
  )
    fail(
      "IDEMPOTENCY_CONFLICT",
      "This booking already selected another purchase option.",
    );
  if (hold && (hold.status !== "ACTIVE" || hold.expiresAt <= now))
    fail("HOLD_EXPIRED", "Your seat hold expired. Start a new booking.");
  if (
    !hold &&
    (await classAvailability(shop.id, [session.id], tx)).get(session.id) === 0
  )
    fail("SOLD_OUT", "This class is full.");
  const plan =
    input.purchaseKind === "NEW_PASS"
      ? await tx.passPlan.findFirst({
          where: {
            id: input.passPlanId!,
            shopId: shop.id,
            services: {
              some: { shopId: shop.id, serviceId: session.serviceId },
            },
          },
        })
      : null;
  if (input.purchaseKind === "NEW_PASS" && (!plan || !plan.saleable))
    fail("PASS_UNAVAILABLE", "This Pass is no longer eligible.");
  if (plan) {
    if (
      plan.introOnly &&
      !(await introOfferEligible(tx, shop.id, attempt.customerId!))
    )
      fail(
        "INTRO_INELIGIBLE",
        "This introductory Pass is no longer available.",
      );
  }
  const owner = plan || session.service;
  const mapping = await tx.productMapping.findUnique({
    where: {
      shopId_ownerType_ownerId: {
        shopId: shop.id,
        ownerType: plan ? "PASS_PLAN" : "SERVICE",
        ownerId: owner.id,
      },
    },
  });
  if (
    owner.status !== "ACTIVE" ||
    !purchaseMappingReady(mapping, owner) ||
    !/^gid:\/\/shopify\/Product\/[1-9]\d*$/.test(mapping?.productGid || "") ||
    !/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/.test(
      mapping?.variantGid || "",
    )
  )
    fail("CATALOG_CHANGED", "This purchase option changed. Review it again.");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        shop.domain,
        mapping!.id,
        mapping!.productGid,
        mapping!.variantGid,
        mapping!.requestedVersion,
        mapping!.shopifyVersion,
        mapping!.publishedPrice,
        owner.id,
        owner.version,
        owner.requestedPriceCents,
        owner.name,
        plan?.credits,
        plan?.validityDays,
        plan?.validityMonths,
        plan?.introOnly,
        plan?.autoRenewEnabled,
        plan?.oneTimePurchaseEnabled,
        plan?.sellingPlanGid,
        session.service.id,
        session.service.version,
        session.id,
        session.version,
        session.startsAt,
        session.endsAt,
        session.timezone,
        session.coachId,
        session.locationId,
      ]),
    )
    .digest("hex");
  const checkout = hold
    ? await tx.bookingCheckout.findUnique({ where: { holdId: hold.id } })
    : null;
  if (checkout && checkout.catalogFingerprint !== fingerprint)
    fail("CATALOG_CHANGED", "The booking changed. Start a new booking.");
  return {
    domain: shop.domain,
    customerId: attempt.customerId,
    plan,
    surface: attempt.surface,
    hold,
    checkout,
    fingerprint,
    mappingId: mapping!.id,
    productGid: mapping!.productGid!,
    variantGid: mapping!.variantGid!,
    priceCents: owner.requestedPriceCents,
    purchaseTerms: {
      version: 1,
      credits: plan?.credits ?? 1,
      validityDays: plan?.validityDays ?? 1,
      validityMonths: plan?.validityMonths ?? null,
      timezone: session.timezone,
      sessionStartsAt: session.startsAt.toISOString(),
      sessionEndsAt: session.endsAt.toISOString(),
      coachId: session.coachId,
      locationId: session.locationId,
      serviceId: session.serviceId,
      introOnly: plan?.introOnly ?? false,
    },
  };
}
type Context = Awaited<ReturnType<typeof readContext>>;

async function guardManagedPassCheckout(
  tx: Prisma.TransactionClient,
  shopId: string,
  context: Context,
  autoRenew: boolean,
) {
  if (!context.plan) return;
  // Membership and Booking serialize on the same customer before claiming a
  // payable cart. A seat-hold deadline never proves that its checkout is unpaid.
  await tx.$queryRaw`SELECT id FROM "CustomerProfile" WHERE id = ${context.customerId}::uuid AND "shopId" = ${shopId}::uuid FOR UPDATE`;
  const membership = await tx.passMembership.findUnique({
    where: {
      shopId_customerId_passPlanId: {
        shopId,
        customerId: context.customerId!,
        passPlanId: context.plan.id,
      },
    },
  });
  if (!membership) return;
  const purchase = await tx.passPurchase.findUnique({
    where: {
      membershipId_cycle: {
        membershipId: membership.id,
        cycle: membership.currentCycle,
      },
    },
  });
  if (!purchase) return;
  if (purchase.bookingCheckoutId === context.checkout?.id) {
    if ((purchase.mode === "AUTO_RENEW") !== autoRenew)
      fail(
        "IDEMPOTENCY_CONFLICT",
        "This checkout already uses a different renewal option.",
      );
    return;
  }
  if (purchase.status !== "PAID")
    fail(
      "PASS_PAYMENT_IN_PROGRESS",
      "A payment for this Pass already exists. Return to that purchase before starting another.",
    );
  const entitlement = purchase.entitlementId
    ? await tx.entitlement.findUnique({ where: { id: purchase.entitlementId } })
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
      "Use your existing Pass or manage its renewal before buying another.",
    );
}

function managedMonthlyPass(context: Context) {
  // Owner-only standalone UAT leaves the existing Booking purchase path intact.
  if (process.env.SKYRA_MEMBERSHIPS_UAT_CUSTOMER_GID && process.env.SKYRA_MEMBERSHIPS_ENABLED !== "true") return false;
  return (
    context.plan && supportsRenewalPeriod(context.plan.validityMonths) &&
    (Boolean(context.plan.sellingPlanGid) ||
      context.plan.autoRenewEnabled ||
      (context.plan.validityMonths === 1 && membershipCapabilities(context.domain).checkoutAvailable))
  );
}

function requireRenewalAvailable(context: Context, autoRenew: boolean) {
  if (context.plan && !autoRenew && !context.plan.oneTimePurchaseEnabled)
    fail("ONE_TIME_PURCHASE_DISABLED", "This Pass is available only with automatic renewal. Please review and accept the renewal terms.");
  if (
    managedMonthlyPass(context) &&
    !membershipCapabilities(context.domain).checkoutGuardReady
  )
    fail(
      "MEMBERSHIP_CHECKOUT_GUARD_UNAVAILABLE",
      "Pass payments are awaiting checkout verification.",
      503,
    );
  if (
    autoRenew &&
    (!context.plan ||
      !context.plan.autoRenewEnabled ||
      !context.plan.sellingPlanGid ||
      !supportsRenewalPeriod(context.plan.validityMonths) ||
      !membershipCapabilities(context.domain).autoRenewAvailable)
  )
    fail(
      "AUTO_RENEW_UNAVAILABLE",
      "Automatic renewal is not available for this Pass.",
    );
}

function withContext<T>(
  actor: BookingActor,
  input: Input,
  run: (tx: Prisma.TransactionClient, context: Context) => Promise<T>,
) {
  return withAttempt(actor, input.token, async (tx, attempt, shop, now) =>
    run(tx, await readContext(tx, attempt, shop, now, input)),
  );
}

function assertReplayable(context: Context) {
  if (!context.checkout || context.checkout.status === "READY") return;
  if (
    context.checkout.status === "CREATING" &&
    Date.now() - context.checkout.createdAt.getTime() < 30000
  )
    fail(
      "CART_PENDING",
      "Your cart is being prepared. Please retry shortly.",
      503,
    );
  fail(
    "CART_RECOVERY_REQUIRED",
    "This cart request needs recovery. Do not start another payment.",
    409,
  );
}
function sameCatalog(before: Context, after: Context) {
  if (before.fingerprint !== after.fingerprint)
    fail(
      "CATALOG_CHANGED",
      "The booking changed while preparing checkout. Review it again.",
    );
}

async function markFailure(
  id: string,
  actor: BookingActor,
  creating: boolean,
  error: unknown,
) {
  const code =
    error instanceof DomainError ? error.code : "CART_REQUEST_UNKNOWN";
  // Read failures may be retried against a known Cart ID. Never create a replacement.
  if (!creating && !["CART_CHANGED", "CATALOG_CHANGED"].includes(code)) return;
  const status =
    code === "CART_REQUEST_UNKNOWN"
      ? "UNKNOWN"
      : code === "CART_REJECTED"
        ? "REJECTED"
        : "INVALIDATED";
  await db.$transaction(async (tx) => {
    const updated = await tx.bookingCheckout.updateMany({
      where: {
        id,
        shopId: actor.shopId,
        status: creating ? "CREATING" : "READY",
      },
      data: { status },
    });
    if (updated.count)
      await tx.auditLog.create({
        data: {
          shopId: actor.shopId,
          actorId: actor.customerGid!,
          action: "CHECKOUT_" + status,
          entityId: id,
          after: { code },
        },
      });
  });
}

// Internal orchestration; the public route stays behind the shared release gate.
// Customer GIDs come only from signed App Proxy context. No network request holds
// a Session/Attempt lock. No function here confirms a booking or charges a buyer.
export async function prepareBookingCheckout(
  actor: BookingActor,
  raw: unknown,
  clientsForShop: (domain: string) => Promise<CommerceClients>,
) {
  const choice = extractAutoRenewChoice(requireBookingTerms(raw));
  const input = holdInput.parse(choice.input);
  if (
    !actor.customerGid ||
    !/^gid:\/\/shopify\/Customer\/[1-9]\d*$/.test(actor.customerGid)
  )
    fail("LOGIN_REQUIRED", "Sign in with Shopify before checkout.", 401);
  const before = await withContext(
    actor,
    input,
    async (_tx, context) => context,
  );
  requireRenewalAvailable(before, choice.autoRenew);
  assertReplayable(before);
  const managedPassPurchase = choice.autoRenew || managedMonthlyPass(before);
  const handoffMode =
    !managedPassPurchase && isDevelopmentBookingShop(before.domain)
      ? "ONLINE_STORE_NATIVE"
      : "STOREFRONT_API";
  let clients: CommerceClients;
  try {
    clients = await clientsForShop(before.domain);
  } catch {
    return fail("UNAVAILABLE", "Could not connect to Shopify. Try again.", 503);
  }
  const report = await inspectCatalogPurchase(
    actor.shopId,
    before.mappingId,
    clients,
  );
  if (!report.ready) {
    if (
      report.issues.some((i) =>
        [
          "SHOPIFY_UNAVAILABLE",
          "STOREFRONT_LOCKED",
          "STOREFRONT_ACCESS_REQUIRED",
        ].includes(i.code),
      )
    )
      fail(
        "UNAVAILABLE",
        "Could not verify Shopify availability. Try again.",
        503,
      );
    fail("CATALOG_CHANGED", "This purchase option is no longer available.");
  }
  await withContext(actor, input, async (_tx, context) => {
    sameCatalog(before, context);
  });
  // Existing Hold retries keep their original 15-minute deadline.
  await createSeatHold(actor, input);
  const claim = await withContext(actor, input, async (tx, context) => {
    sameCatalog(before, context);
    requireRenewalAvailable(context, choice.autoRenew);
    assertReplayable(context);
    await guardManagedPassCheckout(tx, actor.shopId, context, choice.autoRenew);
    if (
      managedPassPurchase &&
      context.checkout &&
      !(await tx.passPurchase.findUnique({
        where: { bookingCheckoutId: context.checkout.id },
      }))
    )
      fail(
        "IDEMPOTENCY_CONFLICT",
        "This checkout already uses a different renewal option.",
      );
    const intent =
      context.checkout ||
      (await tx.bookingCheckout.create({
        data: {
          shopId: actor.shopId,
          holdId: context.hold!.id,
          productMappingId: context.mappingId,
          reference: randomBytes(32).toString("base64url"),
          productGid: context.productGid,
          variantGid: context.variantGid,
          priceCents: context.priceCents,
          catalogFingerprint: context.fingerprint,
          purchaseTerms: context.purchaseTerms,
          handoffMode,
        },
      }));
    if (!context.checkout)
      await tx.auditLog.create({
        data: {
          shopId: actor.shopId,
          actorId: actor.customerGid!,
          action: "CHECKOUT_CREATING",
          entityId: intent.id,
          after: { holdId: intent.holdId },
        },
      });
    await recordBookingTerms(
      tx,
      actor.shopId,
      actor.customerGid!,
      intent.id,
      new Date(),
    );
    // Every new one-calendar-month Pass shares the durable claim, receipt and
    // attendance activation, including a one-time purchase during Booking.
    const membershipClaim = managedPassPurchase
      ? await claimPassPurchaseInTransaction(tx, {
          shopId: actor.shopId,
          customerId: context.customerId!,
          passPlanId: context.plan!.id,
          mode: choice.autoRenew ? "AUTO_RENEW" : "ONCE",
          bookingCheckoutId: intent.id,
          idempotencyKey: `booking-membership:${intent.id}`,
          productMappingId: context.mappingId,
          productGid: context.productGid,
          variantGid: context.variantGid,
          sellingPlanGid: choice.autoRenew
            ? context.plan!.sellingPlanGid
            : null,
          priceCents: context.priceCents,
          currency: "AUD",
          credits: context.purchaseTerms.credits,
          validityDays: context.purchaseTerms.validityDays,
          validityMonths: context.purchaseTerms.validityMonths,
          timezone: context.purchaseTerms.timezone,
          termsVersion: bookingTerms.version,
          autoRenewTermsVersion: choice.autoRenew
            ? AUTO_RENEW_TERMS_VERSION
            : undefined,
        })
      : null;
    return { intent, creating: !context.checkout, membershipClaim };
  });
  const { intent, creating } = claim;
  try {
    if (claim.membershipClaim) {
      const ready = await preparePassPurchaseCart(
        actor,
        claim.membershipClaim,
        before.domain,
        clients,
        intent.reference,
      );
      return await withContext(actor, input, async (tx, context) => {
        sameCatalog(before, context);
        if (
          context.checkout?.id !== intent.id ||
          context.checkout.status !== (creating ? "CREATING" : "READY")
        )
          fail(
            "CART_RECOVERY_REQUIRED",
            "This checkout needs a payment review before you continue.",
          );
        await tx.bookingCheckout.update({
          where: { id: intent.id },
          data: { status: "READY", cartId: ready.cartId },
        });
        return {
          status: "CHECKOUT_READY",
          checkoutUrl: ready.checkoutUrl,
          holdExpiresAt: context.hold!.expiresAt.toISOString(),
          returnPath: attemptReturnPath(context.surface, input.token),
        };
      });
    }
    if (intent.handoffMode === "ONLINE_STORE_NATIVE") {
      const variantId = Number(intent.variantGid.split("/").at(-1));
      if (!Number.isSafeInteger(variantId) || variantId <= 0)
        fail("CATALOG_CHANGED", "This purchase option is no longer available.");
      return await withContext(actor, input, async (tx, context) => {
        sameCatalog(before, context);
        if (
          context.checkout?.id !== intent.id ||
          context.checkout.handoffMode !== "ONLINE_STORE_NATIVE" ||
          context.checkout.status !== (creating ? "CREATING" : "READY")
        )
          fail("CART_RECOVERY_REQUIRED", "This cart needs recovery.");
        if (creating) {
          await tx.bookingCheckout.update({
            where: { id: intent.id },
            data: { status: "READY" },
          });
          await tx.auditLog.create({
            data: {
              shopId: actor.shopId,
              actorId: actor.customerGid!,
              action: "CHECKOUT_READY",
              entityId: intent.id,
              after: {
                holdId: intent.holdId,
                handoffMode: "ONLINE_STORE_NATIVE",
              },
            },
          });
        }
        return {
          status: "NATIVE_CART_READY",
          variantId,
          bookingReference: intent.reference,
          priceCents: intent.priceCents,
          currency: "AUD",
          holdExpiresAt: context.hold!.expiresAt.toISOString(),
          returnPath: attemptReturnPath(context.surface, input.token),
        };
      });
    }
    let cart;
    if (creating) {
      const created = await createBookingCart(clients.storefront, intent);
      cart = created.cart;
      // Persist the known ID even if the returned contents cannot be handed off.
      await db.bookingCheckout.update({
        where: { id: intent.id },
        data: { cartId: cart.id },
      });
      if (!created.clean)
        fail(
          "CART_CHANGED",
          "Shopify adjusted this cart. Start a new booking.",
        );
    } else {
      if (!intent.cartId)
        fail("CART_RECOVERY_REQUIRED", "This cart needs recovery.");
      cart = await readBookingCart(clients.storefront, intent.cartId);
      if (cart.id !== intent.cartId)
        fail("CART_CHANGED", "This cart no longer matches the booking.");
    }
    const checkoutUrl = assertBookingCart(cart, intent, before.domain);
    return await withContext(actor, input, async (tx, context) => {
      sameCatalog(before, context);
      if (
        context.checkout?.id !== intent.id ||
        context.checkout.status !== (creating ? "CREATING" : "READY")
      )
        fail("CART_RECOVERY_REQUIRED", "This cart needs recovery.");
      if (creating) {
        await tx.bookingCheckout.update({
          where: { id: intent.id },
          data: { status: "READY" },
        });
        await tx.auditLog.create({
          data: {
            shopId: actor.shopId,
            actorId: actor.customerGid!,
            action: "CHECKOUT_READY",
            entityId: intent.id,
            after: { holdId: intent.holdId },
          },
        });
      }
      // Deliberately omit full Cart ID, reconciliation reference and upstream errors.
      return {
        status: "CHECKOUT_READY",
        checkoutUrl,
        holdExpiresAt: context.hold!.expiresAt.toISOString(),
        returnPath: attemptReturnPath(context.surface, input.token),
      };
    });
  } catch (error) {
    await markFailure(intent.id, actor, creating, error);
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "UNAVAILABLE",
      "Checkout could not be verified. Please try again.",
      503,
    );
  }
}
