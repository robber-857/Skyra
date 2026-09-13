import { z } from "zod";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { DomainError } from "../lib/errors.server";
import { bookingJson } from "./booking-proxy.server";
import type { BookingActor } from "./booking.server";
const claims = z.object({
  aud: z.string(),
  sub: z.string().regex(/^gid:\/\/shopify\/Customer\/[1-9]\d*$/),
  dest: z.string().min(1).max(255),
  iss: z.string().url().optional(),
  exp: z.number().int(),
  nbf: z.number().int(),
  iat: z.number().int(),
});
export function customerTokenContext(
  raw: unknown,
  clientId: string,
  now = Math.floor(Date.now() / 1000),
) {
  const result = claims.safeParse(raw);
  if (!result.success || !clientId)
    throw new DomainError(
      "CUSTOMER_LOGIN_REQUIRED",
      "Sign in to view your bookings.",
      401,
    );
  const token = result.data;
  let destination: URL, issuer: URL | undefined;
  try {
    // Customer Account tokens document dest as a bare myshopify.com host.
    // Also accept the HTTPS form returned by some Shopify extension surfaces.
    destination = new URL(
      token.dest.startsWith("https://") ? token.dest : `https://${token.dest}`,
    );
    issuer = token.iss ? new URL(token.iss) : undefined;
  } catch {
    throw new DomainError(
      "CUSTOMER_LOGIN_REQUIRED",
      "Invalid account context.",
      401,
    );
  }
  if (
    token.aud !== clientId ||
    token.exp <= now ||
    token.nbf > now + 10 ||
    token.iat > now + 10 ||
    token.exp <= token.iat ||
    destination.protocol !== "https:" ||
    destination.username ||
    destination.password ||
    destination.port ||
    destination.search ||
    destination.hash ||
    destination.pathname !== "/" ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(destination.hostname) ||
    (issuer &&
      (issuer.protocol !== "https:" ||
        issuer.username ||
        issuer.password ||
        issuer.port ||
        issuer.search ||
        issuer.hash ||
        ![destination.hostname, "shopify.com"].includes(issuer.hostname)))
  )
    throw new DomainError(
      "CUSTOMER_LOGIN_REQUIRED",
      "Invalid account context.",
      401,
    );
  return { domain: destination.hostname, customerGid: token.sub };
}
export async function customerAccountRequest(
  request: Request,
  run: (actor: BookingActor, input: unknown) => Promise<unknown>,
) {
  // Shopify verifies the HMAC signature and temporal claims. Its public extension
  // helper skips audience validation; require our exact client ID here as well.
  const { sessionToken, cors } =
    await authenticate.public.customerAccount(request);
  try {
    const context = customerTokenContext(
      sessionToken,
      process.env.SHOPIFY_API_KEY || "",
    );
    const shop = await db.shop.findUnique({
      where: { domain: context.domain },
      select: { id: true, status: true },
    });
    if (shop?.status !== "ACTIVE")
      throw new DomainError(
        "NOT_FOUND",
        "Booking is unavailable for this store.",
        404,
      );
    const actor = { shopId: shop.id, customerGid: context.customerGid };
    if (request.method !== "GET" && request.method !== "POST")
      return cors(bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405));
    let input: unknown;
    if (request.method === "GET")
      input = Object.fromEntries(new URL(request.url).searchParams);
    else {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return cors(bookingJson({ code: "INVALID_REQUEST" }, 415));
      const body = await request.text();
      if (body.length > 2048)
        return cors(bookingJson({ code: "INVALID_REQUEST" }, 413));
      input = JSON.parse(body);
    }
    return cors(bookingJson(await run(actor, input)));
  } catch (error) {
    if (error instanceof DomainError)
      return cors(
        bookingJson({ code: error.code, error: error.message }, error.status),
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return cors(
        bookingJson({ code: "VALIDATION", error: "Invalid request." }, 400),
      );
    return cors(
      bookingJson(
        {
          code: "UNAVAILABLE",
          error: "We could not load your account. Please try again.",
        },
        503,
      ),
    );
  }
}
