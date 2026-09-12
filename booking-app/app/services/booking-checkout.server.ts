import { createHash, randomBytes } from "node:crypto";
import type { BookingAttempt, Prisma, Shop } from "@prisma/client";
import { DateTime } from "luxon";
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
  if (input.purchaseKind === "NEW_PASS" && !plan)
    fail("PASS_UNAVAILABLE", "This Pass is no longer eligible.");
  if (plan) {
    if (
      DateTime.fromJSDate(now, { zone: session.timezone })
        .plus({ days: plan.validityDays })
        .toMillis() <= session.startsAt.getTime()
    )
      fail("PASS_EXPIRES_BEFORE_CLASS", "This Pass expires before your class.");
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
        plan?.introOnly,
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
    surface: attempt.surface,
    hold,
    checkout,
    fingerprint,
    mappingId: mapping!.id,
    productGid: mapping!.productGid!,
    variantGid: mapping!.variantGid!,
    priceCents: owner.requestedPriceCents,
  };
}
type Context = Awaited<ReturnType<typeof readContext>>;

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
  const input = holdInput.parse(raw);
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
  assertReplayable(before);
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
    assertReplayable(context);
    if (context.checkout) return { intent: context.checkout, creating: false };
    const intent = await tx.bookingCheckout.create({
      data: {
        shopId: actor.shopId,
        holdId: context.hold!.id,
        productMappingId: context.mappingId,
        reference: randomBytes(32).toString("base64url"),
        productGid: context.productGid,
        variantGid: context.variantGid,
        priceCents: context.priceCents,
        catalogFingerprint: context.fingerprint,
      },
    });
    await tx.auditLog.create({
      data: {
        shopId: actor.shopId,
        actorId: actor.customerGid!,
        action: "CHECKOUT_CREATING",
        entityId: intent.id,
        after: { holdId: intent.holdId },
      },
    });
    return { intent, creating: true };
  });
  const { intent, creating } = claim;
  try {
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
