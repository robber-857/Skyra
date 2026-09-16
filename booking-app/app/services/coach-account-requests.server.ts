import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { lockShop } from "./catalog.server";
import { databaseNow } from "./booking.server";
import type { Actor } from "./authorization";

// No tenant/coach selector on the public form. Defaults narrowly to the Dev
// shop; another deployment must configure its own public registration shop.
function registrationShop() {
  return (
    process.env.SKYRA_COACH_LOGIN_SHOP || "skyra-booking-dev.myshopify.com"
  );
}
export async function coachRegistrationAvailable() {
  return Boolean(
    await db.shop.findFirst({
      where: { domain: registrationShop(), status: "ACTIVE" },
      select: { id: true },
    }),
  );
}
const requestInput = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();
export async function requestCoachAccount(raw: unknown) {
  const input = requestInput.parse(raw);
  const shop = await db.shop.findFirst({
    where: { domain: registrationShop(), status: "ACTIVE" },
  });
  if (!shop)
    throw new DomainError(
      "REGISTRATION_UNAVAILABLE",
      "Coach registration is unavailable. Contact Skyra.",
      503,
    );
  await db.$transaction(async (tx) => {
    await lockShop(tx, shop.id);
    if (
      await tx.coachAccountRequest.findUnique({
        where: { shopId_email: { shopId: shop.id, email: input.email } },
      })
    )
      return;
    if (
      await tx.coach.findFirst({
        where: { shopId: shop.id, loginEmail: input.email },
      })
    )
      return;
    // Bounded queue; duplicate/approved/unknown addresses get one response.
    if (
      (await tx.coachAccountRequest.count({
        where: { shopId: shop.id, status: "PENDING" },
      })) >= 100
    )
      return;
    const account = await tx.coachAccountRequest.create({
      data: { shopId: shop.id, ...input },
    });
    await tx.auditLog.create({
      data: {
        shopId: shop.id,
        actorId: "PUBLIC_COACH_REQUEST",
        action: "COACH_ACCOUNT_REQUESTED",
        entityId: account.id,
      },
    });
  });
}
export async function reviewCoachAccount(actor: Actor, raw: unknown) {
  if (actor.role !== "ADMIN")
    throw new DomainError("FORBIDDEN", "Admin access required.", 403);
  const input = z
    .discriminatedUnion("decision", [
      z
        .object({
          requestId: z.string().uuid(),
          decision: z.literal("approve"),
          coachId: z.string().uuid(),
        })
        .strict(),
      z
        .object({ requestId: z.string().uuid(), decision: z.literal("reject") })
        .strict(),
    ])
    .parse(raw);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const account = await tx.coachAccountRequest.findFirst({
      where: { id: input.requestId, shopId: actor.shopId },
    });
    if (!account)
      throw new DomainError("NOT_FOUND", "Account request not found.", 404);
    if (account.status !== "PENDING")
      throw new DomainError(
        "ALREADY_REVIEWED",
        "This account request has already been reviewed.",
        409,
      );
    const now = await databaseNow(tx);
    if (input.decision === "approve") {
      const coach = await tx.coach.findFirst({
        where: { id: input.coachId, shopId: actor.shopId, status: "ACTIVE" },
      });
      if (!coach)
        throw new DomainError(
          "COACH_NOT_FOUND",
          "Choose an active coach in this store.",
          404,
        );
      if (coach.loginEmail && coach.loginEmail !== account.email)
        throw new DomainError(
          "COACH_ALREADY_BOUND",
          "This coach already has a login email. Revoke that access before linking a different applicant.",
        );
      if (
        await tx.coach.findFirst({
          where: {
            shopId: actor.shopId,
            loginEmail: account.email,
            id: { not: coach.id },
          },
        })
      )
        throw new DomainError(
          "EMAIL_ALREADY_BOUND",
          "This email is already assigned to another coach.",
        );
      if (!coach.loginEmail) {
        await tx.coach.update({
          where: { id: coach.id },
          data: {
            loginEmail: account.email,
            loginVerifiedAt: null,
            notificationEmail: account.email,
          },
        });
        await tx.coachAccessToken.updateMany({
          where: { shopId: actor.shopId, coachId: coach.id, status: "ACTIVE" },
          data: { status: "REVOKED" },
        });
        await tx.coachLoginDelivery.updateMany({
          where: { shopId: actor.shopId, coachId: coach.id, status: "PENDING" },
          data: { status: "SUPPRESSED", encryptedPayload: null },
        });
      }
      await tx.coachAccountRequest.update({
        where: { id: account.id },
        data: {
          status: "APPROVED",
          approvedCoachId: coach.id,
          reviewedBy: actor.actorId,
          reviewedAt: now,
        },
      });
    } else {
      await tx.coachAccountRequest.update({
        where: { id: account.id },
        data: {
          status: "REJECTED",
          reviewedBy: actor.actorId,
          reviewedAt: now,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        shopId: actor.shopId,
        actorId: actor.actorId,
        action:
          input.decision === "approve"
            ? "COACH_ACCOUNT_APPROVED"
            : "COACH_ACCOUNT_REJECTED",
        entityId: account.id,
      },
    });
    return { email: account.email, approved: input.decision === "approve" };
  });
}
