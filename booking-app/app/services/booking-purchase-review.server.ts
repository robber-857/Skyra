import db from "../db.server";
import { DomainError } from "../lib/errors.server";
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
  const input = passOptionsInput.parse(raw);
  const options = await bookingPassOptions(actor, input);
  if (!options.selected) return options;
  const selected = options.selected;
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
  if (
    current.selected?.id !== selected.id ||
    current.selected?.kind !== selected.kind ||
    current.selected?.priceCents !== selected.priceCents
  )
    throw unavailable();
  return { ...current, availabilityCheckedAt: checked.checkedAt };
}
