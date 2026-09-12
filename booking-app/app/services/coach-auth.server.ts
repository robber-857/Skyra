import { createHash, randomBytes } from "node:crypto";
import db from "../db.server";
import { databaseNow } from "./booking.server";
import { requireOperations, type Actor } from "./authorization";
import { DomainError } from "../lib/errors.server";

const cookieName = "skyra_coach_session";
const hash = (token: string) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new DomainError(
      "COACH_LOGIN_REQUIRED",
      "Sign in to your coach portal.",
      401,
    );
  return createHash("sha256").update(token).digest("hex");
};
export type CoachIdentity = {
  shopId: string;
  coachId: string;
  name: string;
  sessionId: string;
};
// Internal invitation primitive. A verified Operations context must select the
// coach; the future email adapter resolves the coach's verified address. Never
// issue a credential from a public coachId/name/email parameter.
export async function issueCoachLogin(actor: Actor, coachId: string) {
  requireOperations(actor);
  const coach = await db.coach.findFirst({
    where: { id: coachId, shopId: actor.shopId, status: "ACTIVE" },
  });
  if (!coach) throw new DomainError("COACH_NOT_FOUND", "Coach not found.", 404);
  const token = randomBytes(32).toString("base64url");
  await db.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    await tx.coachAccessToken.create({
      data: {
        shopId: actor.shopId,
        coachId,
        kind: "LOGIN",
        tokenHash: hash(token),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 15 * 60000),
      },
    });
    await tx.auditLog.create({
      data: {
        shopId: actor.shopId,
        actorId: actor.actorId,
        action: "COACH_LOGIN_ISSUED",
        entityId: coachId,
      },
    });
  });
  return token;
}
export async function exchangeCoachLogin(token: string) {
  const tokenHash = hash(token);
  return db.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const login = await tx.coachAccessToken.findUnique({
      where: { tokenHash },
    });
    if (
      !login ||
      login.kind !== "LOGIN" ||
      login.status !== "ACTIVE" ||
      login.expiresAt <= now
    )
      throw new DomainError(
        "COACH_LINK_EXPIRED",
        "This sign-in link is no longer available.",
        401,
      );
    const coach = await tx.coach.findFirst({
      where: { id: login.coachId, shopId: login.shopId, status: "ACTIVE" },
    });
    const shop = await tx.shop.findFirst({
      where: { id: login.shopId, status: "ACTIVE" },
    });
    if (!coach || !shop)
      throw new DomainError(
        "COACH_LOGIN_REQUIRED",
        "Coach access is unavailable.",
        401,
      );
    const consumed = await tx.coachAccessToken.updateMany({
      where: { id: login.id, status: "ACTIVE", expiresAt: { gt: now } },
      data: { status: "CONSUMED" },
    });
    if (!consumed.count)
      throw new DomainError(
        "COACH_LINK_EXPIRED",
        "This sign-in link was already used.",
        401,
      );
    const sessionToken = randomBytes(32).toString("base64url");
    await tx.coachAccessToken.create({
      data: {
        shopId: login.shopId,
        coachId: login.coachId,
        kind: "SESSION",
        tokenHash: hash(sessionToken),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 8 * 3600000),
      },
    });
    return sessionToken;
  });
}
export async function coachIdentity(token: string): Promise<CoachIdentity> {
  const session = await db.coachAccessToken.findUnique({
    where: { tokenHash: hash(token) },
  });
  if (
    !session ||
    session.kind !== "SESSION" ||
    session.status !== "ACTIVE" ||
    session.expiresAt <= (await databaseNow(db))
  )
    throw new DomainError(
      "COACH_LOGIN_REQUIRED",
      "Sign in to your coach portal.",
      401,
    );
  const coach = await db.coach.findFirst({
    where: { id: session.coachId, shopId: session.shopId, status: "ACTIVE" },
  });
  const shop = await db.shop.findFirst({
    where: { id: session.shopId, status: "ACTIVE" },
  });
  if (!coach || !shop)
    throw new DomainError(
      "COACH_LOGIN_REQUIRED",
      "Coach access is unavailable.",
      401,
    );
  return {
    shopId: shop.id,
    coachId: coach.id,
    name: coach.name,
    sessionId: session.id,
  };
}
export function coachCookie(token: string, logout = false) {
  if (!logout) hash(token);
  return `${cookieName}=${token}; Path=/coach; HttpOnly; SameSite=Lax; Max-Age=${logout ? 0 : 28800}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
export function requestCoachToken(request: Request) {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1) || ""
  );
}
export async function revokeCoachSession(token: string) {
  await db.coachAccessToken.updateMany({
    where: { tokenHash: hash(token), kind: "SESSION" },
    data: { status: "REVOKED" },
  });
}
export function requireCoachFormOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    throw new Response("Invalid form origin.", { status: 403 });
}
