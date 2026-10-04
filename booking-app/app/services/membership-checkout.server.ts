import { z } from "zod";
import type { PassPurchase, Prisma } from "@prisma/client";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { databaseNow, type BookingActor } from "./booking.server";
import {
  bookingTerms,
  requireBookingTerms,
  recordBookingTerms,
} from "./booking-terms.server";
import { introOfferEligible } from "./entitlements.server";
import { purchaseMappingReady } from "./purchase-mapping.server";
import {
  inspectCatalogPurchase,
  type CommerceClients,
} from "./shopify-purchasability.server";
import { membershipCapabilities } from "./membership-capabilities.server";
import { claimPassPurchaseInTransaction } from "./membership-purchases.server";
import { AUTO_RENEW_TERMS_VERSION } from "./membership-catalog.server";
import {
  createMembershipCart,
  readMembershipCart,
  assertMembershipCart,
  readMembershipBilling,
} from "./shopify-membership.server";
import type { GraphQL } from "./shopify-catalog.server";
import { prepareMembershipCheckoutAuthorization } from "./membership-checkout-guard.server";
import { assertMembershipSellingPlan } from "./membership-selling-plan.server";
import { prepareInventoryPass } from "./membership-inventory-checkout.server";

function fail(code: string, message: string, status = 409): never {
  throw new DomainError(code, message, status);
}

// Consent is checked before any checkout or payment claim is created. Browser
// timestamps, variant IDs and selling plan IDs are never accepted as authority.
export function extractAutoRenewChoice(raw: unknown) {
  const parsed = z
    .object({
      autoRenew: z.boolean().optional().default(false),
      autoRenewAcceptance: z
        .object({
          accepted: z.literal(true),
          version: z.literal(AUTO_RENEW_TERMS_VERSION),
        })
        .strict()
        .optional(),
    })
    .passthrough()
    .parse(raw);
  if (parsed.autoRenew && !parsed.autoRenewAcceptance)
    fail(
      "AUTO_RENEW_TERMS_REQUIRED",
      "Please agree to the automatic renewal terms before continuing.",
      422,
    );
  const input: Record<string, unknown> = { ...parsed };
  delete input.autoRenew;
  delete input.autoRenewAcceptance;
  return { input, autoRenew: parsed.autoRenew };
}

const purchaseInput = z
  .object({
    passPlanId: z.string().uuid(),
    idempotencyKey: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    expectedPriceCents: z.number().int().positive(),
  })
  .strict();

async function readPlan(
  tx: Prisma.TransactionClient,
  actor: BookingActor,
  passPlanId: string,
  autoRenew: boolean,
) {
  const shop = await tx.shop.findFirst({
    where: { id: actor.shopId, status: "ACTIVE" },
  });
  if (!shop) fail("NOT_FOUND", "Memberships are unavailable.", 404);
  const capabilities = membershipCapabilities(shop.domain);
  if (!capabilities.checkoutAvailable)
    fail(
      "CHECKOUT_NOT_AVAILABLE",
      "Membership purchases are not available yet.",
      503,
    );
  const plan = await tx.passPlan.findFirst({
    where: {
      id: passPlanId,
      shopId: shop.id,
      status: "ACTIVE",
      saleable: true,
      standalonePurchaseEnabled: true,
    },
  });
  if (!plan)
    fail("PASS_UNAVAILABLE", "This Pass is not available for purchase.");
  if (plan.validityMonths === 1 && !capabilities.checkoutGuardReady)
    fail(
      "MEMBERSHIP_CHECKOUT_GUARD_UNAVAILABLE",
      "Monthly Pass payments are awaiting checkout verification.",
      503,
    );
  if (
    autoRenew &&
    (!capabilities.autoRenewAvailable ||
      !plan.autoRenewEnabled ||
      !plan.sellingPlanGid ||
      plan.validityMonths !== 1)
  )
    fail(
      "AUTO_RENEW_UNAVAILABLE",
      "Automatic renewal is not available for this Pass.",
    );
  const mapping = await tx.productMapping.findUnique({
    where: {
      shopId_ownerType_ownerId: {
        shopId: shop.id,
        ownerType: "PASS_PLAN",
        ownerId: plan.id,
      },
    },
  });
  if (!mapping || !purchaseMappingReady(mapping, plan))
    fail("CATALOG_CHANGED", "This Pass changed. Please review it again.");
  return { shop, plan, mapping };
}

export async function prepareMembershipCheckout(
  actor: BookingActor,
  raw: unknown,
  clientsForShop: (domain: string) => Promise<CommerceClients>,
) {
  if (
    !actor.customerGid ||
    !/^gid:\/\/shopify\/Customer\/[1-9]\d*$/.test(actor.customerGid)
  )
    fail("LOGIN_REQUIRED", "Sign in with Shopify before buying a Pass.", 401);
  const choice = extractAutoRenewChoice(requireBookingTerms(raw));
  const input = purchaseInput.parse(choice.input);
  const replay = await db.passPurchase.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    include: { membership: true },
  });
  if (replay) {
    const customer = await db.customerProfile.findUnique({
      where: {
        shopId_shopifyCustomerGid: {
          shopId: actor.shopId,
          shopifyCustomerGid: actor.customerGid,
        },
      },
    });
    if (
      replay.shopId !== actor.shopId ||
      replay.membership.customerId !== customer?.id ||
      replay.membership.passPlanId !== input.passPlanId ||
      replay.mode !== (choice.autoRenew ? "AUTO_RENEW" : "ONCE") ||
      replay.bookingCheckoutId
    )
      fail(
        "IDEMPOTENCY_CONFLICT",
        "This payment request was already used for another purchase.",
      );
    if (replay.status === "PAID") {
      const plan = await db.passPlan.findFirst({
        where: { id: input.passPlanId, shopId: actor.shopId },
      });
      return {
        status: "PAID",
        purchaseId: replay.id,
        name: plan?.name || "Pass",
      };
    }
  }
  const before = await db.$transaction((tx) =>
    readPlan(tx, actor, input.passPlanId, choice.autoRenew),
  );
  if (
    before.plan.version !== input.expectedVersion ||
    before.plan.requestedPriceCents !== input.expectedPriceCents
  )
    fail(
      replay ? "CATALOG_CHANGED" : "PASS_QUOTE_CHANGED",
      "This Pass changed since you reviewed it. Refresh the membership page before paying.",
    );
  const clients = await clientsForShop(before.shop.domain);
  const report = await inspectCatalogPurchase(
    actor.shopId,
    before.mapping.id,
    clients,
  );
  if (!report.ready)
    fail(
      "CATALOG_CHANGED",
      "This Pass could not be verified. Please try again.",
    );
  const claim = await db.$transaction(
    async (tx) => {
      const current = await readPlan(
        tx,
        actor,
        input.passPlanId,
        choice.autoRenew,
      );
      if (
        current.plan.version !== before.plan.version ||
        current.mapping.variantGid !== before.mapping.variantGid ||
        current.mapping.productGid !== before.mapping.productGid ||
        current.mapping.shopifyVersion !== before.mapping.shopifyVersion ||
        current.plan.sellingPlanGid !== before.plan.sellingPlanGid
      )
        fail(
          "CATALOG_CHANGED",
          "This Pass changed while preparing checkout. Please review it again.",
        );
      const customer = await tx.customerProfile.upsert({
        where: {
          shopId_shopifyCustomerGid: {
            shopId: actor.shopId,
            shopifyCustomerGid: actor.customerGid!,
          },
        },
        create: {
          shopId: actor.shopId,
          shopifyCustomerGid: actor.customerGid!,
        },
        update: {},
      });
      if (
        current.plan.introOnly &&
        !(await introOfferEligible(tx, actor.shopId, customer.id))
      )
        fail(
          "INTRO_INELIGIBLE",
          "This introductory Pass is no longer available.",
        );
      const result = await claimPassPurchaseInTransaction(tx, {
        shopId: actor.shopId,
        customerId: customer.id,
        passPlanId: current.plan.id,
        mode: choice.autoRenew ? "AUTO_RENEW" : "ONCE",
        idempotencyKey: input.idempotencyKey,
        productMappingId: current.mapping.id,
        productGid: current.mapping.productGid!,
        variantGid: current.mapping.variantGid!,
        sellingPlanGid: choice.autoRenew ? current.plan.sellingPlanGid : null,
        priceCents: current.plan.requestedPriceCents,
        currency: "AUD",
        credits: current.plan.credits,
        validityDays: current.plan.validityDays,
        validityMonths: current.plan.validityMonths,
        timezone: "Australia/Sydney",
        termsVersion: bookingTerms.version,
        autoRenewTermsVersion: choice.autoRenew
          ? AUTO_RENEW_TERMS_VERSION
          : undefined,
      });
      await recordBookingTerms(
        tx,
        actor.shopId,
        actor.customerGid!,
        result.purchase.id,
        await databaseNow(tx),
      );
      return result;
    },
    { maxWait: 30000, timeout: 15000 },
  );
  const ready = await preparePassPurchaseCart(
    actor,
    claim,
    before.shop.domain,
    clients,
  );
  return {
    status: "CHECKOUT_READY",
    checkoutUrl: ready.checkoutUrl,
    purchaseId: claim.purchase.id,
  };
}

// Both purchase surfaces use the same durable claim. An unknown cart creation
// result must never be replaced with another potentially payable checkout.
export async function preparePassPurchaseCart(
  actor: BookingActor,
  claim: { purchase: PassPurchase; creating: boolean },
  domain: string,
  clients: CommerceClients,
  bookingReference?: string,
) {
  if (!claim.creating && claim.purchase.status !== "CHECKOUT_READY")
    fail(
      "PASS_PAYMENT_REVIEW",
      "Your payment is being checked. Do not start another payment.",
    );
  const purchase = await prepareInventoryPass(claim.purchase, clients.admin);
  const target = {
    reference: purchase.reference,
    productGid: purchase.productGid,
    variantGid: purchase.variantGid,
    priceCents: purchase.priceCents,
    sellingPlanGid: purchase.sellingPlanGid,
    bookingReference,
  };
  if (!claim.creating && purchase.status !== "CHECKOUT_READY")
    fail(
      purchase.status === "CREATING" ? "CART_PENDING" : "PASS_PAYMENT_REVIEW",
      "Your payment is being checked. Do not start another payment.",
    );
  try {
    let cart;
    if (purchase.mode === "AUTO_RENEW") {
      const membership = await db.passMembership.findFirst({
        where: { id: purchase.membershipId, shopId: actor.shopId },
      });
      const configuredPlan = membership
        ? await db.passPlan.findFirst({
            where: {
              id: membership.passPlanId,
              shopId: actor.shopId,
              sellingPlanGid: purchase.sellingPlanGid,
            },
            select: { sellingPlanGroupGid: true },
          })
        : null;
      await assertMembershipSellingPlan(clients.admin, {
        productGid: purchase.productGid,
        variantGid: purchase.variantGid,
        priceCents: purchase.priceCents,
        sellingPlanGid: purchase.sellingPlanGid || "",
        currency: "AUD",
        trustedGroupGid:
          configuredPlan?.sellingPlanGroupGid ||
          (domain === "skyra-booking-dev.myshopify.com"
            ? process.env.SKYRA_MEMBERSHIPS_TEST_SELLING_PLAN_GROUP_GID || ""
            : process.env.SKYRA_MEMBERSHIPS_SELLING_PLAN_GROUP_GID || ""),
      });
    }
    const authorization = await prepareMembershipCheckoutAuthorization(
      actor,
      purchase,
      domain,
      clients.admin,
    );
    const authorizedTarget = {
      ...target,
      ...(authorization ? { authorization } : {}),
    };
    if (claim.creating) {
      const result = await createMembershipCart(
        clients.storefront,
        authorizedTarget,
        domain,
      );
      cart = result.cart;
      await db.passPurchase.update({
        where: { id: purchase.id },
        data: { cartId: cart.id },
      });
      if (!result.clean)
        fail(
          "CART_CHANGED",
          "This checkout needs a payment review before you continue.",
        );
    } else {
      if (!purchase.cartId)
        fail(
          "PASS_PAYMENT_REVIEW",
          "This checkout needs a payment review before you continue.",
        );
      cart = await readMembershipCart(
        clients.storefront,
        purchase.cartId,
        authorizedTarget,
        domain,
      );
      if (cart.id !== purchase.cartId)
        fail("CART_CHANGED", "This checkout has changed.");
    }
    const checkoutUrl = assertMembershipCart(cart, authorizedTarget, domain);
    await db.$transaction(async (tx) => {
      const updated = await tx.passPurchase.updateMany({
        where: {
          id: purchase.id,
          shopId: actor.shopId,
          status: claim.creating ? "CREATING" : "CHECKOUT_READY",
        },
        data: { status: "CHECKOUT_READY" },
      });
      if (!updated.count)
        fail(
          "PASS_PAYMENT_REVIEW",
          "Your payment state changed. Please check your Passes before paying.",
        );
    });
    return { checkoutUrl, cartId: cart.id };
  } catch (error) {
    const code =
      error instanceof DomainError ? error.code : "CART_REQUEST_UNKNOWN";
    if (claim.creating || ["CART_CHANGED", "CATALOG_CHANGED"].includes(code)) {
      await db.passPurchase.updateMany({
        where: {
          id: purchase.id,
          shopId: actor.shopId,
          status: { in: ["CREATING", "CHECKOUT_READY"] },
        },
        data: {
          status:
            code === "CART_REJECTED"
              ? "FAILED"
              : code === "CART_REQUEST_UNKNOWN"
                ? "UNKNOWN"
                : "REVIEW",
        },
      });
    }
    if (error instanceof DomainError) throw error;
    fail(
      "UNAVAILABLE",
      "Your payment is being checked. Please do not start another checkout.",
      503,
    );
  }
}

export async function membershipPurchaseResult(
  actor: BookingActor,
  raw: unknown,
  adminForShop?: (domain: string) => Promise<GraphQL>,
) {
  const input = z.object({ purchaseId: z.string().uuid() }).strict().parse(raw);
  if (!actor.customerGid)
    fail("LOGIN_REQUIRED", "Sign in to view your Pass purchase.", 401);
  const customer = await db.customerProfile.findUnique({
    where: {
      shopId_shopifyCustomerGid: {
        shopId: actor.shopId,
        shopifyCustomerGid: actor.customerGid,
      },
    },
  });
  if (!customer) fail("NOT_FOUND", "Purchase not found.", 404);
  const purchase = await db.passPurchase.findFirst({
    where: { id: input.purchaseId, shopId: actor.shopId },
  });
  const membership = purchase
    ? await db.passMembership.findFirst({
        where: {
          id: purchase.membershipId,
          shopId: actor.shopId,
          customerId: customer.id,
        },
      })
    : null;
  if (!purchase || !membership) fail("NOT_FOUND", "Purchase not found.", 404);
  const plan = await db.passPlan.findFirst({
    where: { id: membership.passPlanId, shopId: actor.shopId },
  });
  if (purchase.status === "ACTION_REQUIRED") {
    if (!purchase.billingAttemptGid || !membership.contractGid || !adminForShop)
      return { status: "NEEDS_ATTENTION", name: plan?.name || "Pass" };
    const shop = await db.shop.findUniqueOrThrow({
      where: { id: actor.shopId },
    });
    const billing = await readMembershipBilling(
      await adminForShop(shop.domain),
      purchase.billingAttemptGid,
    );
    if (
      billing.contractGid !== membership.contractGid ||
      billing.idempotencyKey !== purchase.idempotencyKey
    )
      fail(
        "BILLING_CONTEXT_MISMATCH",
        "This payment needs a studio review before continuing.",
      );
    if (billing.nextActionUrl) {
      let actionUrl: URL;
      try {
        actionUrl = new URL(billing.nextActionUrl);
      } catch {
        return fail(
          "BILLING_ACTION_UNAVAILABLE",
          "Payment verification is temporarily unavailable.",
          503,
        );
      }
      if (
        actionUrl.protocol !== "https:" ||
        actionUrl.username ||
        actionUrl.password
      )
        fail(
          "BILLING_ACTION_UNAVAILABLE",
          "Payment verification is temporarily unavailable.",
          503,
        );
      return {
        status: "ACTION_REQUIRED",
        name: plan?.name || "Pass",
        actionUrl: actionUrl.toString(),
      };
    }
    return {
      status: billing.errorCode ? "NEEDS_ATTENTION" : "PENDING",
      name: plan?.name || "Pass",
    };
  }
  return {
    status:
      purchase.status === "PAID"
        ? "PAID"
        : ["UNKNOWN", "REVIEW", "FAILED"].includes(purchase.status)
          ? "NEEDS_ATTENTION"
          : "PENDING",
    name: plan?.name || "Pass",
  };
}
