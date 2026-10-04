import { isDeepStrictEqual } from "node:util";
import type { PassPurchase } from "@prisma/client";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import type { BookingActor } from "./booking.server";
import type { GraphQL } from "./shopify-catalog.server";
import { membershipCapabilities } from "./membership-capabilities.server";
import {
  inventoryMembershipCheckout,
  assertInventoryPassClosedOrOpen,
} from "./membership-inventory-checkout.server";
import {
  authorizeMembershipCheckout,
  assertMembershipCheckoutProtection,
  assertNoPublicMembershipStorefrontTokens,
  closeMembershipCheckout,
  readMembershipCheckoutAuthorization,
  type MembershipCheckoutAuthorization,
} from "./membership-checkout-authorization.server";

export function membershipCheckoutProof(
  customerGid: string,
  purchase: PassPurchase,
): MembershipCheckoutAuthorization {
  return {
    version: 1,
    state: "OPEN",
    nonce: purchase.reference,
    purchaseId: purchase.id,
    membershipId: purchase.membershipId,
    cycle: purchase.cycle,
    customerGid,
    productGid: purchase.productGid,
    variantGid: purchase.variantGid,
    sellingPlanGid: purchase.sellingPlanGid,
    priceCents: purchase.priceCents,
    currency: "AUD",
  };
}

export async function closeMembershipCheckoutForRenewal(
  purchase: PassPurchase,
  admin: GraphQL,
  domain: string,
) {
  const original = await db.passPurchase.findFirst({
    where: {
      shopId: purchase.shopId,
      membershipId: purchase.membershipId,
      cycle: { lt: purchase.cycle },
      status: "PAID",
      cartId: { not: null },
    },
    orderBy: { cycle: "desc" },
    include: { membership: true },
  });
  const customer = original
    ? await db.customerProfile.findFirst({
        where: { shopId: purchase.shopId, id: original.membership.customerId },
      })
    : null;
  if (!original || !customer?.shopifyCustomerGid)
    throw new DomainError(
      "MEMBERSHIP_CHECKOUT_GUARD_UNAVAILABLE",
      "The original monthly Pass checkout must be verified before renewal.",
      409,
    );
  if (inventoryMembershipCheckout()) {
    await assertInventoryPassClosedOrOpen(original.id, admin, "CLOSED");
    return;
  }
  await assertMembershipCheckoutProtection(
    admin,
    original.productGid,
    domain === "skyra-booking-dev.myshopify.com"
      ? process.env.SKYRA_MEMBERSHIPS_TEST_VALIDATION_GID || ""
      : process.env.SKYRA_MEMBERSHIPS_VALIDATION_GID || "",
    process.env.SHOPIFY_API_KEY || "",
  );
  await assertNoPublicMembershipStorefrontTokens(admin);
  // Close the original payable checkout before submitting a renewal. A lost
  // closure response stops billing; an idempotent reread can confirm CLOSED.
  await closeMembershipCheckout(
    admin,
    membershipCheckoutProof(customer.shopifyCustomerGid, original),
  );
}

export async function prepareMembershipCheckoutAuthorization(
  actor: BookingActor,
  purchase: PassPurchase,
  domain: string,
  admin: GraphQL,
) {
  if (purchase.validityMonths !== 1) return undefined;
  if (
    !actor.customerGid ||
    purchase.currency !== "AUD" ||
    !membershipCapabilities(domain).checkoutGuardReady
  )
    throw new DomainError(
      "MEMBERSHIP_CHECKOUT_GUARD_UNAVAILABLE",
      "Monthly Pass payments are awaiting checkout verification. Please contact the studio.",
      503,
    );
  const proof = membershipCheckoutProof(actor.customerGid, purchase);
  if (inventoryMembershipCheckout()) {
    await assertInventoryPassClosedOrOpen(purchase.id, admin, "OPEN");
    return undefined;
  }
  await assertMembershipCheckoutProtection(
    admin,
    purchase.productGid,
    domain === "skyra-booking-dev.myshopify.com"
      ? process.env.SKYRA_MEMBERSHIPS_TEST_VALIDATION_GID || ""
      : process.env.SKYRA_MEMBERSHIPS_VALIDATION_GID || "",
    process.env.SHOPIFY_API_KEY || "",
  );
  const current = await readMembershipCheckoutAuthorization(
    admin,
    actor.customerGid,
  );
  if (
    current.authorization?.state === "OPEN" &&
    !isDeepStrictEqual(current.authorization, proof)
  ) {
    const old = await db.passPurchase.findFirst({
      where: {
        id: current.authorization.purchaseId,
        shopId: actor.shopId,
        status: "PAID",
      },
      include: { membership: true },
    });
    const owner = old
      ? await db.customerProfile.findFirst({
          where: {
            id: old.membership.customerId,
            shopId: actor.shopId,
            shopifyCustomerGid: actor.customerGid,
          },
        })
      : null;
    if (
      !old ||
      !owner ||
      !isDeepStrictEqual(
        membershipCheckoutProof(actor.customerGid, old),
        current.authorization,
      )
    )
      throw new DomainError(
        "MEMBERSHIP_AUTHORIZATION_CONFLICT",
        "An earlier monthly Pass payment needs review before another checkout.",
        409,
      );
    // Only a verified PAID purchase may release an old authorization. Timeouts,
    // failed local holds and unknown payments never authorize a replacement.
    await closeMembershipCheckout(admin, current.authorization);
  }
  await authorizeMembershipCheckout(admin, proof);
  return proof;
}
