import type { ProductMapping } from "@prisma/client";

export function priceInCents(value: string | null | undefined) {
  if (!value || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

export function purchaseMappingReady(
  mapping: ProductMapping | null | undefined,
  owner: { version: number; requestedPriceCents: number },
) {
  return Boolean(
    mapping?.variantGid &&
    mapping.productGid &&
    mapping.syncStatus === "SYNCED" &&
    mapping.productStatus === "ACTIVE" &&
    mapping.shopifyVersion === owner.version &&
    mapping.requestedVersion === owner.version &&
    priceInCents(mapping.publishedPrice) === owner.requestedPriceCents,
  );
}
