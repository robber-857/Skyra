import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { z } from "zod";
import { membershipCapabilities } from "./membership-capabilities.server";
import {
  bookingPassOptions,
  passOptionsInput,
  type BookingActor,
} from "./booking.server";
import {
  inspectCatalogPurchase,
  type CommerceClients,
} from "./shopify-purchasability.server";

export async function bookingPurchaseReview(
  actor: BookingActor,
  raw: unknown,
  clientsForShop: (domain: string) => Promise<CommerceClients>,
) {
  const { autoRenew, ...rest } = z
    .object({ autoRenew: z.boolean().optional().default(false) })
    .passthrough()
    .parse(raw);
  const input = passOptionsInput.parse(rest);
  const options = await bookingPassOptions(actor, input);
  if (autoRenew && options.selected?.kind !== "NEW_PASS")
    throw new DomainError(
      "AUTO_RENEW_UNAVAILABLE",
      "Automatic renewal is available only when purchasing an eligible Pass.",
      409,
    );
  if (!options.selected || options.selected.kind === "OWNED_PASS")
    return options;
  const selected = options.selected;
  if (selected.kind === "NEW_PASS" && !autoRenew && !selected.oneTimePurchaseEnabled)
    throw new DomainError("ONE_TIME_PURCHASE_DISABLED", "This Pass is available only with automatic renewal. Please review and accept the renewal terms.", 409);
  const ownerType = selected.kind === "DROP_IN" ? "SERVICE" : "PASS_PLAN";
  // selected.id comes from the server's Session/eligibility resolution, never a client Variant or Service ID.
  const [shop, mapping] = await Promise.all([
    db.shop.findUniqueOrThrow({ where: { id: actor.shopId } }),
    db.productMapping.findUnique({
      where: {
        shopId_ownerType_ownerId: {
          shopId: actor.shopId,
          ownerType,
          ownerId: selected.id,
        },
      },
    }),
  ]);
  const unavailable = () =>
    new DomainError(
      selected.kind === "DROP_IN" ? "DROP_IN_UNAVAILABLE" : "PASS_UNAVAILABLE",
      "This booking option has changed or is unavailable. Please choose another option.",
      409,
    );
  if (!mapping) throw unavailable();
  if (autoRenew) {
    const plan = await db.passPlan.findFirst({
      where: { id: selected.id, shopId: shop.id },
    });
    if (
      !membershipCapabilities(shop.domain).autoRenewAvailable ||
      !plan?.autoRenewEnabled ||
      !plan.sellingPlanGid ||
      plan.validityMonths !== 1
    )
      throw new DomainError(
        "AUTO_RENEW_UNAVAILABLE",
        "Automatic renewal is not available for this Pass.",
        409,
      );
  }
  let clients: CommerceClients;
  try {
    clients = await clientsForShop(shop.domain);
  } catch {
    throw new DomainError(
      "UNAVAILABLE",
      "We could not check availability. Please try again.",
      503,
    );
  }
  const checked = await inspectCatalogPurchase(shop.id, mapping.id, clients);
  if (!checked.ready) {
    if (
      checked.issues.some((issue) =>
        [
          "SHOPIFY_UNAVAILABLE",
          "STOREFRONT_LOCKED",
          "STOREFRONT_ACCESS_REQUIRED",
        ].includes(issue.code),
      )
    )
      throw new DomainError(
        "UNAVAILABLE",
        "We could not check availability. Please try again.",
        503,
      );
    throw unavailable();
  }
  // Recheck attempt ownership, expiry, Session capacity and eligibility after the network call.
  const current = await bookingPassOptions(actor, input);
  if (current.selected?.kind === "NEW_PASS" && !autoRenew && !current.selected.oneTimePurchaseEnabled)
    throw new DomainError("ONE_TIME_PURCHASE_DISABLED", "One-time purchase is no longer available. Please review this Pass again.", 409);
  if (
    current.selected?.id !== selected.id ||
    current.selected?.kind !== selected.kind ||
    current.selected?.priceCents !== selected.priceCents
  )
    throw unavailable();
  return {
    ...current,
    autoRenewSelected: autoRenew,
    availabilityCheckedAt: checked.checkedAt,
  };
}
