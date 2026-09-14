import { z } from "zod";
import { withAttempt, type BookingActor } from "./booking.server";
import { DomainError } from "../lib/errors.server";
export const customerComment = z
  .string()
  .trim()
  .max(1000)
  .refine(
    (v) => Array.from(v).every(c => c.charCodeAt(0)>=32 || [9,10,13].includes(c.charCodeAt(0))),
    "Use plain text.",
  );
const input = z
  .object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    comment: customerComment,
  })
  .strict();
export async function saveBookingComment(actor: BookingActor, raw: unknown) {
  const q = input.parse(raw);
  return withAttempt(actor, q.token, async (tx, attempt, _shop, now) => {
    if (!actor.customerGid || !attempt.customerId)
      throw new DomainError(
        "LOGIN_REQUIRED",
        "Sign in before adding a note.",
        401,
      );
    if (q.comment === attempt.customerComment) return { saved: true };
    if (
      attempt.status !== "STARTED" ||
      attempt.expiresAt <= now ||
      (await tx.bookingHold.findUnique({ where: { attemptId: attempt.id } }))
    )
      throw new DomainError(
        "COMMENT_FROZEN",
        "This booking has already progressed. Its note cannot be changed.",
        409,
      );
    await tx.bookingAttempt.update({
      where: { id: attempt.id },
      data: { customerComment: q.comment },
    });
    // Notes may contain personal fitness information: no note text in audit/outbox/Shopify.
    return { saved: true };
  });
}
