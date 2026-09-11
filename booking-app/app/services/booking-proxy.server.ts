import { z } from "zod";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { DomainError } from "../lib/errors.server";
import type { BookingActor } from "./booking.server";

export function bookingJson(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export async function proxyBookingActor(
  request: Request,
): Promise<BookingActor> {
  await authenticate.public.appProxy(request);
  const params = new URL(request.url).searchParams;
  const shops = params.getAll("shop"),
    customers = params.getAll("logged_in_customer_id");
  if (shops.length !== 1 || customers.length > 1)
    throw new DomainError("INVALID_CONTEXT", "Invalid Shopify context.", 400);
  const shop = await db.shop.findUnique({
    where: { domain: shops[0] },
    select: { id: true, status: true },
  });
  if (shop?.status !== "ACTIVE")
    throw new DomainError(
      "NOT_FOUND",
      "Booking is unavailable for this store.",
      404,
    );
  return {
    shopId: shop.id,
    customerGid: /^[1-9]\d*$/.test(customers[0] || "")
      ? "gid://shopify/Customer/" + customers[0]
      : null,
  };
}
export async function bookingRequest(
  request: Request,
  run: (actor: BookingActor, input: unknown) => Promise<unknown>,
) {
  try {
    const actor = await proxyBookingActor(request);
    if (request.method !== "POST")
      return bookingJson({ code: "METHOD_NOT_ALLOWED" }, 405);
    // Require a non-simple request; cross-site forms must not bind another customer's attempt.
    if (
      !request.headers.get("Content-Type")?.startsWith("application/json") ||
      request.headers.get("X-Skyra-Booking") !== "1" ||
      request.headers.get("Sec-Fetch-Site") === "cross-site"
    ) {
      return bookingJson(
        {
          code: "INVALID_REQUEST",
          error: "Use the Booking component to continue.",
        },
        403,
      );
    }
    const body = await request.text();
    if (body.length > 2048)
      return bookingJson({ code: "INVALID_REQUEST" }, 413);
    return bookingJson(await run(actor, JSON.parse(body)));
  } catch (error) {
    if (error instanceof DomainError)
      return bookingJson(
        { code: error.code, error: error.message },
        error.status,
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return bookingJson(
        { code: "VALIDATION", error: "Invalid booking request." },
        400,
      );
    if (error instanceof Response) {
      error.headers.set("Cache-Control", "private, no-store");
      throw error;
    }
    // Do not expose database errors or request bodies/tokens.
    return bookingJson(
      {
        code: "UNAVAILABLE",
        error: "Booking is temporarily unavailable. Please try again.",
      },
      503,
    );
  }
}
