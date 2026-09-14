import db from "../db.server";
import { DomainError } from "../lib/errors.server";
import type { Actor } from "./authorization";
import { issueCoachLogin } from "./coach-auth.server";

export function canTestCoachPortal(actor: Actor, shopDomain: string) {
  return (
    process.env.NODE_ENV === "development" &&
    actor.role === "ADMIN" &&
    shopDomain === "skyra-booking-dev.myshopify.com"
  );
}

// Temporary manual testing entry, never a production coach invitation flow.
export async function coachTestLogin(actor: Actor, coachId: string) {
  const shop = await db.shop.findUnique({ where: { id: actor.shopId } });
  if (
    !shop ||
    shop.status !== "ACTIVE" ||
    !canTestCoachPortal(actor, shop.domain)
  )
    throw new DomainError(
      "FORBIDDEN",
      "Coach test access is only available to development-store admins.",
      403,
    );
  const configured =
    process.env.SHOPIFY_APP_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME
      ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
      : process.env.HOST);
  const url = configured ? new URL(configured) : null;
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new DomainError(
      "APP_URL_REQUIRED",
      "The development App needs its current HTTPS URL before opening the coach portal.",
    );
  const token = await issueCoachLogin(actor, coachId);
  url.pathname = "/coach/login";
  url.hash = new URLSearchParams({ token }).toString();
  return url.href;
}
