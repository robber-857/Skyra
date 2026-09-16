import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import { databaseNow } from "./booking.server";
import { lockShop } from "./catalog.server";
import type { Actor } from "./authorization";
import {
  sendTransactionalMail,
  transactionalMailReady,
  type TransactionalMail,
  type MailOutcome,
} from "./transactional-mail.server";

const emailInput = z.string().trim().toLowerCase().email().max(254);
function encryptionKey() {
  const raw = process.env.SKYRA_COACH_MAIL_KEY || "";
  if (!/^[a-f0-9]{64}$/.test(raw))
    throw new DomainError(
      "MAIL_NOT_CONFIGURED",
      "Coach email sign-in is not configured.",
      503,
    );
  return Buffer.from(raw, "hex");
}
function seal(value: string, tokenId: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(tokenId));
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
function open(value: string, tokenId: string) {
  const bytes = Buffer.from(value, "base64url");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    bytes.subarray(0, 12),
  );
  cipher.setAAD(Buffer.from(tokenId));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}
function appUrl() {
  const url = new URL(process.env.SHOPIFY_APP_URL || "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new DomainError(
      "MAIL_NOT_CONFIGURED",
      "Coach email sign-in is not configured.",
      503,
    );
  return url;
}
export function coachSelfServiceReady() {
  try {
    encryptionKey();
    appUrl();
    return (
      transactionalMailReady() &&
      /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(
        process.env.SKYRA_COACH_LOGIN_SHOP || "",
      )
    );
  } catch {
    return false;
  }
}

// Admin binds identity explicitly. Notification addresses never grant access.
export async function bindCoachLoginEmail(
  actor: Actor,
  coachId: string,
  raw: string,
) {
  if (actor.role !== "ADMIN")
    throw new DomainError("FORBIDDEN", "Admin access required.", 403);
  const email = raw === "" ? null : emailInput.parse(raw);
  return db.$transaction(async (tx) => {
    await lockShop(tx, actor.shopId);
    const coach = await tx.coach.findFirst({
      where: { id: coachId, shopId: actor.shopId, status: "ACTIVE" },
    });
    if (!coach)
      throw new DomainError("COACH_NOT_FOUND", "Coach not found.", 404);
    if (
      email &&
      (await tx.coach.findFirst({
        where: {
          shopId: actor.shopId,
          loginEmail: email,
          id: { not: coachId },
        },
      }))
    )
      throw new DomainError(
        "EMAIL_ALREADY_BOUND",
        "This login email is already assigned to another coach.",
      );
    if (coach.loginEmail === email) return;
    await tx.coach.update({
      where: { id: coachId },
      data: { loginEmail: email, loginVerifiedAt: null },
    });
    await tx.coachAccessToken.updateMany({
      where: { shopId: actor.shopId, coachId, status: "ACTIVE" },
      data: { status: "REVOKED" },
    });
    await tx.coachLoginDelivery.updateMany({
      where: { shopId: actor.shopId, coachId, status: "PENDING" },
      data: { status: "SUPPRESSED", encryptedPayload: null },
    });
    await tx.auditLog.create({
      data: {
        shopId: actor.shopId,
        actorId: actor.actorId,
        action: "COACH_LOGIN_EMAIL_BOUND",
        entityId: coachId,
      },
    });
  });
}

// First verified sign-in activates the existing authorized identity. Unknown
// addresses get the same response but no Coach record, role or credential.
export async function requestCoachEmailLogin(raw: string) {
  const email = emailInput.parse(raw);
  if (!coachSelfServiceReady())
    throw new DomainError(
      "MAIL_NOT_CONFIGURED",
      "Email sign-in is not available yet. Contact Skyra.",
      503,
    );
  const shop = await db.shop.findFirst({
    where: { domain: process.env.SKYRA_COACH_LOGIN_SHOP, status: "ACTIVE" },
  });
  if (!shop) return;
  await db.$transaction(async (tx) => {
    await lockShop(tx, shop.id);
    const coach = await tx.coach.findFirst({
      where: { shopId: shop.id, loginEmail: email, status: "ACTIVE" },
    });
    if (!coach) return;
    const now = await databaseNow(tx);
    const since = new Date(now.getTime() - 3600000);
    const recent = await tx.coachLoginDelivery.findMany({
      where: { shopId: shop.id, coachId: coach.id, createdAt: { gt: since } },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    if (
      recent.length >= 5 ||
      (recent[0] && now.getTime() - recent[0].createdAt.getTime() < 60000)
    )
      return;
    if (
      (await tx.coachLoginDelivery.count({
        where: { shopId: shop.id, createdAt: { gt: since } },
      })) >= 100
    )
      return;
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + 15 * 60000);
    const access = await tx.coachAccessToken.create({
      data: {
        shopId: shop.id,
        coachId: coach.id,
        kind: "LOGIN",
        loginEmail: email,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        createdAt: now,
        expiresAt,
      },
    });
    await tx.coachLoginDelivery.create({
      data: {
        tokenId: access.id,
        shopId: shop.id,
        coachId: coach.id,
        createdAt: now,
        expiresAt,
        encryptedPayload: seal(token, access.id),
      },
    });
  });
}

export async function deliverCoachLogin(
  id: string,
  send: (
    mail: TransactionalMail,
  ) => Promise<MailOutcome> = sendTransactionalMail,
) {
  const now = await databaseNow(db);
  const claimed = await db.coachLoginDelivery.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "SENDING", claimedAt: now },
  });
  if (!claimed.count) return;
  const job = await db.coachLoginDelivery.findUniqueOrThrow({ where: { id } });
  try {
    const access = await db.coachAccessToken.findUniqueOrThrow({
      where: { id: job.tokenId },
    });
    const coach = await db.coach.findFirst({
      where: { shopId: job.shopId, id: job.coachId, status: "ACTIVE" },
    });
    const shop = await db.shop.findFirst({
      where: {
        id: job.shopId,
        status: "ACTIVE",
        domain: process.env.SKYRA_COACH_LOGIN_SHOP,
      },
    });
    if (
      !shop ||
      !coach ||
      access.shopId !== job.shopId ||
      access.coachId !== job.coachId ||
      access.kind !== "LOGIN" ||
      access.expiresAt <= now ||
      !access.loginEmail ||
      coach.loginEmail !== access.loginEmail ||
      access.status !== "ACTIVE" ||
      job.expiresAt <= now ||
      !job.encryptedPayload
    ) {
      await db.coachLoginDelivery.update({
        where: { id },
        data: { status: "SUPPRESSED", encryptedPayload: null },
      });
      return;
    }
    const url = appUrl();
    url.pathname = "/coach/login";
    url.hash = new URLSearchParams({
      token: open(job.encryptedPayload, access.id),
    }).toString();
    const outcome = await send({
      to: access.loginEmail,
      subject: "Your Skyra coach sign-in link",
      text: `Sign in or activate your coach portal:\n${url.href}\n\nThis link works once and expires in 15 minutes. If you did not request it, ignore this email.`,
      idempotencyKey: `skyra-coach-login:${id}`,
    });
    await db.coachLoginDelivery.update({
      where: { id },
      data: {
        status: outcome.status,
        encryptedPayload: null,
        providerMessageId:
          outcome.status === "ACCEPTED" ? outcome.messageId : null,
      },
    });
  } catch {
    await db.coachLoginDelivery.update({
      where: { id },
      data: { status: "UNKNOWN", encryptedPayload: null },
    });
  }
}

export async function sweepCoachLoginMail() {
  const now = await databaseNow(db);
  await db.coachLoginDelivery.updateMany({
    where: {
      status: "SENDING",
      claimedAt: { lt: new Date(now.getTime() - 10 * 60000) },
    },
    data: { status: "UNKNOWN", encryptedPayload: null },
  });
  await db.coachLoginDelivery.updateMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    data: { status: "SUPPRESSED", encryptedPayload: null },
  });
  if (!coachSelfServiceReady()) return;
  const shop = await db.shop.findFirst({
    where: { domain: process.env.SKYRA_COACH_LOGIN_SHOP, status: "ACTIVE" },
  });
  if (!shop) return;
  const jobs = await db.coachLoginDelivery.findMany({
    where: { shopId: shop.id, status: "PENDING", expiresAt: { gt: now } },
    orderBy: { createdAt: "asc" },
    take: 10,
    select: { id: true },
  });
  for (const job of jobs) await deliverCoachLogin(job.id);
}
