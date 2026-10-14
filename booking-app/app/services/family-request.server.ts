import { z } from "zod";
import { DomainError } from "../lib/errors.server";
import type { BookingActor } from "./booking.server";
import { resolveFamilyActor } from "./family-accounts.server";

// Member IDs are selection requests, never proof of identity. Keep signed
// Shopify authentication intact and resolve ownership before domain handlers.
export async function familyRequestContext(actor: BookingActor, raw: unknown, enabled = true) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !("familyMemberId" in raw))
    return { actor, input: raw };
  if (!enabled)
    throw new DomainError("VALIDATION", "Use your signed-in account to manage family members.", 400);
  const { familyMemberId, ...input } = raw as Record<string, unknown>;
  const id = z.string().uuid().parse(familyMemberId);
  return { actor: await resolveFamilyActor(actor, id), input };
}
