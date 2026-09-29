import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { DomainError } from "../lib/errors.server";
import terms from "../lib/booking-terms.json";

export { terms as bookingTerms };

// Keep consent separate from seat-hold input. Neither a string "true" nor a
// client-provided timestamp or policy URL is evidence of acceptance.
export function requireBookingTerms(raw: unknown) {
  const parsed = z.object({
    termsAcceptance: z.object({
      accepted: z.literal(true),
      version: z.literal(terms.version),
    }).strict(),
  }).passthrough().safeParse(raw);
  if (!parsed.success)
    throw new DomainError("TERMS_REQUIRED", "Please read and agree to the Terms & Conditions before continuing to payment.", 422);
  const input: Record<string, unknown> = { ...parsed.data };
  delete input.termsAcceptance;
  return input;
}

// Call under the existing attempt/session lock, so retries retain one receipt.
export async function recordBookingTerms(
  tx: Prisma.TransactionClient,
  shopId: string,
  customerGid: string,
  checkoutId: string,
  now: Date,
) {
  const existing = await tx.auditLog.findFirst({ where: {
    shopId, entityId: checkoutId, actorId: customerGid,
    action: "CHECKOUT_TERMS_ACCEPTED",
    after: { path: ["version"], equals: terms.version },
  } });
  if (existing) return;
  await tx.auditLog.create({ data: {
    shopId, entityId: checkoutId, actorId: customerGid,
    action: "CHECKOUT_TERMS_ACCEPTED",
    after: { ...terms, accepted: true, acceptedAt: now.toISOString() },
  } });
}
