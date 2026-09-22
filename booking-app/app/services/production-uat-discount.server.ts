import { z } from "zod";
import {
  commerceCapabilities,
  isProductionBookingShop,
} from "./commerce-capabilities.server";

const configuration = z
  .object({
    code: z.string().regex(/^[A-Z0-9_-]{8,64}$/),
    customerGid: z.string().regex(/^gid:\/\/shopify\/Customer\/[1-9]\d*$/),
    variantGid: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/[1-9]\d*$/),
    priceCents: z.number().int().positive().safe().multipleOf(100),
    payableCents: z.number().int().positive().safe().optional(),
    discountType: z.enum(["percentage", "fixed_amount"]).default("percentage"),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
  })
  .strict();

// A short-lived, single-customer payment test, not general discount support.
// Shopify separately enforces a one-use code restricted to this customer/product.
export function exactProductionUatDiscount(
  shopDomain: string,
  order: {
    purchasedAt: string | null;
    customerGid: string | null;
    subtotalCents: number;
    finalCents: number;
    totalDiscountsCents: number;
    discountCodes: { code: string; amountCents: number; type: string }[];
  },
  line: { variantGid: string; priceCents: number },
  checkout: { priceCents: number; hold: { purchaseKind: string } } | null,
) {
  if (
    !isProductionBookingShop(shopDomain) ||
    !commerceCapabilities(shopDomain).checkoutAvailable
  )
    return false;
  let raw: unknown;
  try {
    raw = JSON.parse(process.env.SKYRA_BOOKING_UAT_DISCOUNT || "null");
  } catch {
    return false;
  }
  const parsed = configuration.safeParse(raw);
  if (!parsed.success || !checkout || checkout.hold.purchaseKind !== "NEW_PASS")
    return false;
  const config = parsed.data;
  const start = Date.parse(config.startsAt),
    end = Date.parse(config.endsAt);
  const purchased = order.purchasedAt ? Date.parse(order.purchasedAt) : NaN;
  // Evaluate purchase time so delayed delivery of a valid webhook still works.
  if (
    end <= start ||
    end - start > 72 * 60 * 60 * 1000 ||
    !Number.isFinite(purchased) ||
    purchased < start ||
    purchased >= end
  )
    return false;
  const payable = config.payableCents ?? config.priceCents / 100;
  if (payable >= config.priceCents) return false;
  const discount = config.priceCents - payable;
  const code = order.discountCodes[0];
  return (
    order.customerGid === config.customerGid &&
    line.variantGid === config.variantGid &&
    line.priceCents === config.priceCents &&
    checkout.priceCents === config.priceCents &&
    order.subtotalCents === payable &&
    order.finalCents === payable &&
    order.totalDiscountsCents === discount &&
    order.discountCodes.length === 1 &&
    code.code.toUpperCase() === config.code &&
    code.amountCents === discount &&
    code.type === config.discountType
  );
}
